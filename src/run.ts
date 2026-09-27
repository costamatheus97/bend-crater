// Running one compiler on one file under a timeout, and reading the verdict.

import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { unwatch, watch } from "./watch";

export type Status =
  | "pass" | "pass-unsafe"
  | "fail-parse" | "fail-check" | "fail-fetch" | "fail-oom"
  | "timeout" | "crash" | "skipped";

export interface Proc {
  code: number | null;
  signal: string | null;
  out: string;
  err: string;
  ms: number;
  timedOut: boolean;
  rssKb?: number;           // GNU time's peak RSS of the largest process
  oom?: "cap" | "total";    // the watchdog killed it: over its own cap, or the largest when all were over the total
  peakKb?: number;          // the watchdog's peak for the whole group (sampled)
  stopped?: boolean;        // killed because the run is stopping
  truncated?: boolean;      // stdout or stderr passed CAP and was cut there
}

// GNU time reports a child's peak RSS (-f %M, in KB). It is used when
// /usr/bin/time exists and understands -f -o (GNU, as on ubuntu runners);
// otherwise no RSS is recorded.
let TIME: string | null | undefined;
export function rssTool(): string | null {
  if (TIME === undefined) {
    TIME = null;
    try {
      const out = path.join(os.tmpdir(), "crater-rss-" + process.pid);
      const r = spawnSync("/usr/bin/time", ["-f", "%M", "-o", out, "true"], { stdio: "ignore" });
      if (r.status === 0 && /^\d+\s*$/m.test(fs.readFileSync(out, "utf8"))) {
        TIME = "/usr/bin/time";
      }
      fs.rmSync(out, { force: true });
    } catch {
      TIME = null;
    }
  }
  return TIME;
}
let rssSeq = 0;

export const CAP = 64 * 1024;

export interface ExecOpts {
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  nice: boolean;
  rss?: boolean;
  memCapKb?: number;        // kill the group when its resident memory passes this (0 or unset: no cap)
}

// the process groups in flight, so a stopping run can kill them all
const live = new Map<number, () => void>();
let stopping = false;

// stopAll kills every group in flight and makes later execs return at once
// as stopped (the run is being cancelled).
export function stopAll(): void {
  stopping = true;
  for (const kill of live.values()) {
    kill();
  }
}

// exec runs argv in its own process group and kills the whole group when
// the timeout passes, when the group's resident memory passes memCapKb, or
// when the run stops, so a compiler's workers go with it. Output past CAP
// is cut at exactly CAP bytes, so two runs of the same program cut alike.
export function exec(argv: string[], opts: ExecOpts): Promise<Proc> {
  if (stopping) {
    return Promise.resolve({ code: null, signal: null, out: "", err: "", ms: 0, timedOut: false, stopped: true });
  }
  const time = opts.rss ? rssTool() : null;
  const rssFile = time === null ? null : path.join(os.tmpdir(), `crater-rss-${process.pid}-${rssSeq++}`);
  const timed = time === null ? argv : [time, "-f", "%M", "-o", rssFile as string, ...argv];
  const full = opts.nice ? ["nice", "-n", "19", ...timed] : timed;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const ch = spawn(full[0], full.slice(1), { cwd: opts.cwd, env: opts.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [], err: Buffer[] = [];
    let outN = 0, errN = 0, truncated = false, timedOut = false, stopped = false;
    const take = (buf: Buffer[], n: number, d: Buffer): number => {
      if (n < CAP) {
        buf.push(d.length > CAP - n ? d.subarray(0, CAP - n) : d);
      }
      if (n + d.length > CAP) {
        truncated = true;
      }
      return n + d.length;
    };
    ch.stdout.on("data", (d: Buffer) => { outN = take(out, outN, d); });
    ch.stderr.on("data", (d: Buffer) => { errN = take(err, errN, d); });
    const kill = () => {
      try { process.kill(-(ch.pid as number), "SIGKILL"); } catch { /* gone */ }
    };
    const pid = ch.pid;
    const w = pid !== undefined && opts.memCapKb !== undefined ? watch(pid, opts.memCapKb, kill) : null;
    if (pid !== undefined) {
      live.set(pid, () => { stopped = true; kill(); });
    }
    const timer = setTimeout(() => { timedOut = true; kill(); }, opts.timeoutMs);
    let spawnErr = "";
    ch.on("error", (e) => { spawnErr += String(e); });
    ch.on("close", (code, signal) => {
      const ms = Math.round(performance.now() - t0);
      clearTimeout(timer);
      kill();
      if (pid !== undefined) {
        live.delete(pid);
      }
      if (w !== null) {
        unwatch(w);
      }
      let rssKb: number | undefined;
      if (rssFile !== null) {
        try {
          const last = fs.readFileSync(rssFile, "utf8").trim().split("\n").pop() ?? "";
          rssKb = /^\d+$/.test(last) ? parseInt(last, 10) : undefined;
        } catch { /* killed before time wrote it */ }
        fs.rmSync(rssFile, { force: true });
      }
      const oom = w !== null && w.over !== "" ? w.over : undefined;
      // under GNU time, a child killed by a signal shows as exit 128+n
      const sig = signal ?? (time !== null && code !== null && code > 128 && !timedOut ? "exit " + code : null);
      resolve({
        code, signal: sig, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") + spawnErr, ms, timedOut,
        ...(rssKb !== undefined ? { rssKb } : {}),
        ...(w !== null && w.peakKb > 0 ? { peakKb: w.peakKb } : {}),
        ...(oom !== undefined ? { oom } : {}),
        ...(stopped ? { stopped } : {}),
        ...(truncated ? { truncated } : {}),
      });
    });
  });
}

// peakKb is the best peak we have for a process: the watchdog's sample of
// the whole group, or GNU time's largest process, whichever is larger.
export const peakKb = (p: Proc): number | undefined =>
  p.rssKb === undefined && p.peakKb === undefined ? undefined : Math.max(p.rssKb ?? 0, p.peakKb ?? 0);

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export function clean(s: string, subs: [string, string][]): string {
  let t = s.replace(ANSI, "").replace(/\r/g, "");
  for (const [from, to] of subs) {
    t = t.split(from).join(to);
  }
  return t;
}

// excerpt keeps the first lines of the error block, trimmed, so the stored
// results stay small.
export function excerpt(text: string, lines = 8, width = 160): string {
  const all = text.split("\n");
  const at = all.findIndex((l) => l.startsWith("Error"));
  const from = at < 0 ? all.filter((l) => l.trim() !== "") : all.slice(at);
  return from.slice(0, lines).map((l) => (l.length > width ? l.slice(0, width - 1) + "…" : l)).join("\n").trimEnd();
}

// classify reads bend's verdict. A clean check prints "All terms check."; a
// check that leans on @unsafe or foreign defs prints "All terms check, but N
// defs rely on unsafe or foreign code" (older releases: "with N unsafe
// annotations"). Both exit 0. Errors print an "Error:" block on stderr; a
// parse or load error has a Location with no def and no Context, while a
// check error names the def it is in.
export function classify(p: Proc, text: string): Status {
  // the watchdog kills with SIGKILL, so this comes before the signal test
  if (p.oom !== undefined) {
    return "fail-oom";
  }
  if (p.timedOut) {
    return "timeout";
  }
  if (p.code === 0) {
    return /unsafe or foreign|unsafe annotation/.test(text) ? "pass-unsafe" : "pass";
  }
  if (p.signal !== null || !/^Error/m.test(text) || /stack overflowed/.test(text)) {
    return "crash";
  }
  if (/a file at \S+ hashing to|a package named \S+ on |no such file: \$LIB\//.test(text)) {
    return "fail-fetch";
  }
  const loc = /^Location:(.*)$/m.exec(text);
  if (loc !== null && loc[1].trim() === "" && !/^Context:/m.test(text)) {
    return "fail-parse";
  }
  return "fail-check";
}

export const isPass = (s: string | undefined) => s === "pass" || s === "pass-unsafe";
export const isFail = (s: string | undefined) => s !== undefined && !isPass(s) && s !== "skipped";
