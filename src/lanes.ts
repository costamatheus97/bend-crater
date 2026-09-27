// Lane diff: a main that ran cleanly is also built for the C lane and the
// JS lane, and each lane's stdout is compared with the reference run's.
//
// The reference is `bend file.bend`, the run lane. For a main that returns
// a value, that is Bend's interpreter (it normalizes the term). For a main
// that returns IO, bend compiles the program to JS and runs it in-process,
// so the JS lane shares its emitter, and the C lane is the independent one.
//
// The C lane builds as `bend -o bin` does, on the CPU only: the emitted C is
// compiled with clang 14 or newer ($CC, else the newest clang on PATH),
// -std=c11 -O3, without -DBEND_CUDA or -DBEND_METAL, and the binary runs with
// --gpu off. gcc cannot build Bend's C (it uses clang's musttail).

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { CAP, excerpt } from "./run";

export type LaneStatus =
  | "same"          // printed exactly what the reference printed
  | "differs"       // printed something else: a disagreement
  | "nondet"        // differs, but so did a second reference run: the program's output varies
  | "build-fail"    // bend -o or the C compiler failed
  | "run-fail"      // the built program exited non-zero
  | "timeout" | "oom"
  | "unavailable";  // the lane cannot run here (no clang, or a window or audio program)

export interface Lane {
  s: LaneStatus;
  x?: string;       // the first differing line, or why the lane did not compare
  ms?: number;      // the lane program's run time
}

export const LANES = ["c", "js"] as const;

// clangVersion reads the major version from `cc --version`, or null when
// cc is not clang
export function clangVersion(versionText: string): number | null {
  const m = /^(?:Apple |\w+ )?clang version (\d+)/m.exec(versionText);
  return m === null ? null : parseInt(m[1], 10);
}

// findClang picks the C compiler for the C lane, as bend's own build does:
// $CC, then clang, then every clang-NN on PATH, newest first; the first
// that is clang 14 or newer. null when there is none.
export function findClang(env: Record<string, string | undefined>): { cc: string; version: number } | null {
  const dirs = (env.PATH ?? "").split(path.delimiter).filter((d) => d !== "");
  const nums = [...new Set(dirs.flatMap((d) => {
    try {
      return fs.readdirSync(d).filter((f) => /^clang-\d+$/.test(f));
    } catch {
      return [];
    }
  }))].sort((a, b) => Number(b.slice(6)) - Number(a.slice(6)));
  for (const cc of [...(env.CC ? [env.CC] : []), "clang", ...nums]) {
    const r = spawnSync(cc, ["--version"], { encoding: "utf8", env: { PATH: env.PATH ?? "", HOME: env.HOME ?? "" } });
    const v = clangVersion(r.stdout ?? "");
    if (v !== null && v >= 14) {
      return { cc, version: v };
    }
  }
  return null;
}

// cBuild is the C compiler's argv for m.c, or a reason the lane cannot run
export function cBuild(cc: string, src: string): string[] | string {
  if (/#include <(X11|alsa)\//.test(src)) {
    return "a window or audio program: not built here";
  }
  return [cc, "-std=c11", "-O3", "m.c", "-lpthread", "-lm", "-o", "m"];
}

// laneDiff compares a lane's stdout with the reference's: null when they
// are the same, else the first line that differs, as "line N: io 'a', lane
// 'b'". A lane that prints more or less than the reference differs at the
// first line one of them lacks.
export function laneDiff(io: string, got: string, width = 60): string | null {
  if (io === got) {
    return null;
  }
  const a = io.split("\n"), b = got.split("\n");
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) {
    i++;
  }
  const q = (l: string | undefined) => l === undefined ? "(end)"
    : "'" + (l.length > width ? l.slice(0, width - 1) + "…" : l) + "'";
  return `line ${i + 1}: io ${q(a[i])}, lane ${q(b[i])}`;
}

// compare turns a lane's output into its verdict. Both outputs are cut at
// exactly CAP bytes by exec, so a long output compares its first CAP bytes.
export function compare(io: { out: string; truncated?: boolean }, lane: { out: string; truncated?: boolean }): Lane {
  const cut = io.truncated || lane.truncated ? ` (compared the first ${CAP / 1024} KiB)` : "";
  const d = laneDiff(io.out, lane.out);
  return d === null ? (cut ? { s: "same", x: "same" + cut } : { s: "same" }) : { s: "differs", x: d + cut };
}

// settle marks disagreements as nondeterministic when a second reference
// run printed something else than the first
export function settle(lanes: Record<string, Lane>, io: string, again: string | null): Record<string, Lane> {
  if (again === null || again === io) {
    return lanes;
  }
  const why = "the reference printed something else on a second run too (" + laneDiff(io, again) + ")";
  return Object.fromEntries(Object.entries(lanes).map(([k, l]) =>
    [k, l.s === "differs" ? { ...l, s: "nondet" as const, x: l.x + "; " + why } : l]));
}

// failed describes a lane step that did not succeed
export function failed(step: "build" | "run", p: { code: number | null; signal: string | null; timedOut: boolean; oom?: string; err: string; out: string }, text: string): Lane {
  if (p.oom !== undefined) {
    return { s: "oom", x: `the ${step} went over the memory cap` };
  }
  if (p.timedOut) {
    return { s: "timeout", x: `the ${step} timed out` };
  }
  return { s: step === "build" ? "build-fail" : "run-fail", x: `the ${step} exited ${p.code ?? p.signal}: ` + excerpt(text, 3) };
}

// disagrees: a lane printed something else, and the program is not known
// to vary by itself. Only this is flagged; a lane that could not build or
// run is listed, not flagged.
export const disagrees = (lanes: Record<string, Lane> | undefined) =>
  lanes !== undefined && Object.values(lanes).some((l) => l.s === "differs");
