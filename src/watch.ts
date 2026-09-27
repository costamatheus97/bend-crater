// A memory watchdog for the process groups that exec starts.
//
// Every TICK_MS it reads /proc/<pid>/stat for every process, and adds up
// the resident memory of each watched group: the processes in its process
// group or session, and any descendant of those (so a child that calls
// setsid still counts, while it has not been reparented). A group over its
// cap is killed at once. With several groups in flight, the largest one is
// killed when together they pass the total cap.
//
// Why not a limit on address space (ulimit -v, prlimit --as)? Bun reserves
// about 6.5 GB of virtual memory at start, and a Bend native binary reserves
// its heap (about 109 GB) up front, so an address-space cap breaks healthy
// runs. Resident memory is what exhausts a runner. On a system without
// /proc (macOS), there is no watchdog: checks run without a memory cap.

import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

export const TICK_MS = 200;

export interface Watched {
  pgid: number;
  capKb: number;            // 0: no cap of its own
  peakKb: number;           // largest sum seen
  over: "" | "cap" | "total";
  kill: () => void;
}

const groups = new Map<number, Watched>();
let timer: ReturnType<typeof setInterval> | null = null;
let totalCapKb = 0;

let pageKb: number | null | undefined;
export function available(): boolean {
  if (pageKb === undefined) {
    pageKb = null;
    try {
      fs.readFileSync("/proc/self/stat", "utf8");
      let bytes = 4096;
      try {
        bytes = parseInt(execFileSync("getconf", ["PAGESIZE"], { encoding: "utf8" }).trim(), 10) || 4096;
      } catch { /* assume 4 KiB pages */ }
      pageKb = bytes / 1024;
    } catch {
      pageKb = null;
    }
  }
  return pageKb !== null;
}

// memTotalKb is the machine's memory, or 0 when unknown
export function memTotalKb(): number {
  try {
    return parseInt(/^MemTotal:\s+(\d+)/m.exec(fs.readFileSync("/proc/meminfo", "utf8"))?.[1] ?? "0", 10);
  } catch {
    return 0;
  }
}

// setTotalCap caps the sum of all watched groups (0: no total cap)
export function setTotalCap(kb: number): void {
  totalCapKb = kb;
}

export function watch(pgid: number, capKb: number, kill: () => void): Watched {
  const w: Watched = { pgid, capKb, peakKb: 0, over: "", kill };
  if (!available()) {
    return w;
  }
  groups.set(pgid, w);
  if (timer === null) {
    timer = setInterval(tick, TICK_MS);
  }
  return w;
}

export function unwatch(w: Watched): void {
  groups.delete(w.pgid);
  if (groups.size === 0 && timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

export interface ProcStat {
  pid: number;
  ppid: number;
  pgrp: number;
  sid: number;
  rssPages: number;
}

// parseStat reads one /proc/<pid>/stat line. The command name sits in
// parentheses and may itself contain spaces or parentheses, so the fields
// are read after the last ")".
export function parseStat(line: string): ProcStat | null {
  const close = line.lastIndexOf(")");
  if (close < 0) {
    return null;
  }
  const pid = parseInt(line, 10);
  const f = line.slice(close + 2).split(" ");
  // f[0] is the state (field 3); ppid is field 4, pgrp 5, session 6, rss 24
  const n = (i: number) => parseInt(f[i], 10);
  if (f.length < 22 || Number.isNaN(pid)) {
    return null;
  }
  return { pid, ppid: n(1), pgrp: n(2), sid: n(3), rssPages: n(21) };
}

// groupSums adds up resident pages per watched group: members by process
// group or session, then their descendants by parent pid.
export function groupSums(procs: ProcStat[], watched: Iterable<number>): Map<number, number> {
  const want = new Set(watched);
  const owner = new Map<number, number>();
  const kids = new Map<number, ProcStat[]>();
  for (const p of procs) {
    const g = want.has(p.pgrp) ? p.pgrp : want.has(p.sid) ? p.sid : want.has(p.pid) ? p.pid : null;
    if (g !== null) {
      owner.set(p.pid, g);
    }
    const k = kids.get(p.ppid);
    if (k === undefined) {
      kids.set(p.ppid, [p]);
    } else {
      k.push(p);
    }
  }
  const stack = [...owner.keys()];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    for (const c of kids.get(pid) ?? []) {
      if (!owner.has(c.pid)) {
        owner.set(c.pid, owner.get(pid) as number);
        stack.push(c.pid);
      }
    }
  }
  const sums = new Map<number, number>();
  for (const g of want) {
    sums.set(g, 0);
  }
  for (const p of procs) {
    const g = owner.get(p.pid);
    if (g !== undefined) {
      sums.set(g, (sums.get(g) ?? 0) + p.rssPages);
    }
  }
  return sums;
}

function readProcs(): ProcStat[] {
  const out: ProcStat[] = [];
  let names: string[];
  try {
    names = fs.readdirSync("/proc");
  } catch {
    return out;
  }
  for (const d of names) {
    if (d.charCodeAt(0) < 48 || d.charCodeAt(0) > 57) {
      continue;
    }
    try {
      const s = parseStat(fs.readFileSync("/proc/" + d + "/stat", "utf8"));
      if (s !== null) {
        out.push(s);
      }
    } catch { /* it exited */ }
  }
  return out;
}

function tick(): void {
  if (groups.size === 0 || pageKb == null) {
    return;
  }
  const sums = groupSums(readProcs(), groups.keys());
  let total = 0;
  let largest: Watched | null = null;
  for (const w of groups.values()) {
    const kb = (sums.get(w.pgid) ?? 0) * pageKb;
    total += kb;
    w.peakKb = Math.max(w.peakKb, kb);
    if (w.over === "" && w.capKb > 0 && kb > w.capKb) {
      w.over = "cap";
      w.kill();
    }
    if (w.over === "" && (largest === null || kb > (sums.get(largest.pgid) ?? 0) * pageKb)) {
      largest = w;
    }
  }
  if (totalCapKb > 0 && total > totalCapKb && largest !== null) {
    largest.over = "total";
    largest.kill();
  }
}
