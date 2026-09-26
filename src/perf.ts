// Checker timing: a compact per-cell history across runs, and the flags
// drawn from it.
//
// Each cell is timed once per run, on a shared runner, so one sample means
// little. A change is only flagged when it is large, repeated and not tiny:
//   - the newer compiler's time is at least RATIO times the older
//     compiler's median for that package over the kept runs;
//   - the larger of the two is at least FLOOR_MS after the compiler's own
//     startup time (its smoke check) is taken off, so a 60 ms check that
//     becomes 150 ms, or main's Bun-from-source startup, is not a finding;
//   - the same held in the previous run too. A change seen in one run only
//     is listed as a candidate, not flagged.
// Pairs compared: main against the latest release, and each release
// against the one before it.

import type { Cell, ColInfo, PkgRow } from "./report";
import { cmpVersion } from "./compilers";

export const RATIO = 2;
export const FLOOR_MS = 1000;
export const KEEP = 14;

// Timings keeps, per package hash and compiler id, check_ms for each of the
// last KEEP runs (null: not checked, or no verdict), aligned with `runs`.
export interface Timings {
  runs: string[];
  t: Record<string, Record<string, (number | null)[]>>;
}

export interface PerfRow {
  hash: string;
  pkg: string;
  newer: string;
  older: string;
  newMs: number;      // newer compiler, this run, startup taken off
  oldMs: number;      // older compiler's median, startup taken off
  ratio: number;
  flagged: boolean;   // held in the previous run too
}

export interface PerfPair {
  newer: string;
  older: string;
  slowdowns: PerfRow[];
  speedups: PerfRow[];
  compared: number;
}

export interface Perf {
  ratio: number;
  floorMs: number;
  runsKept: number;
  pairs: PerfPair[];
  slowest: Record<string, { hash: string; pkg: string; ms: number; rss_kb?: number }[]>;
}

const timed = (c: Cell | undefined): number | null =>
  c === undefined || c.s === "timeout" || c.s === "skipped" || c.check_ms === undefined ? null : c.check_ms;

export function updateTimings(prev: Timings | null, finished: string, results: Record<string, Record<string, Cell>>): Timings {
  const old = prev ?? { runs: [], t: {} };
  const n = Math.min(old.runs.length, KEEP - 1);
  const out: Timings = { runs: [...old.runs.slice(old.runs.length - n), finished], t: {} };
  const keys = new Set<string>();
  for (const [h, row] of Object.entries(old.t)) {
    for (const c of Object.keys(row)) {
      keys.add(h + " " + c);
    }
  }
  for (const [h, row] of Object.entries(results)) {
    for (const c of Object.keys(row)) {
      keys.add(h + " " + c);
    }
  }
  for (const k of keys) {
    const [h, c] = k.split(" ");
    const was = old.t[h]?.[c] ?? [];
    const kept = was.slice(Math.max(0, was.length - n));
    while (kept.length < n) {
      kept.unshift(null);
    }
    kept.push(timed(results[h]?.[c]));
    if (kept.some((v) => v !== null)) {
      ((out.t[h] ??= {})[c] = kept);
    }
  }
  return out;
}

function median(xs: number[]): number {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function analyse(cols: ColInfo[], pkgs: PkgRow[], results: Record<string, Record<string, Cell>>, tm: Timings, label: (p: PkgRow) => string): Perf {
  const ok = cols.filter((c) => c.broken === undefined);
  const rel = ok.filter((c) => c.kind === "release").sort((a, b) => cmpVersion(b.version, a.version));
  const main = ok.find((c) => c.kind === "main");
  const pairs: [ColInfo, ColInfo][] = [];
  if (main && rel[0]) {
    pairs.push([main, rel[0]]);
  }
  for (let i = 0; i + 1 < rel.length; i++) {
    pairs.push([rel[i], rel[i + 1]]);
  }
  const base = (c: ColInfo) => c.base_ms ?? 0;
  const adj = (ms: number, c: ColInfo) => Math.max(0, ms - base(c));
  const out: PerfPair[] = pairs.map(([nc, oc]) => {
    const slow: PerfRow[] = [], fast: PerfRow[] = [];
    let compared = 0;
    for (const p of pkgs) {
      const nv = timed(results[p.hash]?.[nc.id]);
      const hist = (tm.t[p.hash]?.[oc.id] ?? []).filter((v): v is number => v !== null);
      if (nv === null || hist.length === 0) {
        continue;
      }
      compared++;
      const newMs = adj(nv, nc);
      const oldMs = adj(median(hist), oc);
      if (Math.max(newMs, oldMs) < FLOOR_MS) {
        continue;
      }
      const ratio = (newMs + 50) / (oldMs + 50);
      const series = tm.t[p.hash]?.[nc.id] ?? [];
      const before = series.length >= 2 ? series[series.length - 2] : null;
      const beforeRatio = before === null ? null : (adj(before, nc) + 50) / (oldMs + 50);
      const row = (flagged: boolean): PerfRow =>
        ({ hash: p.hash, pkg: label(p), newer: nc.id, older: oc.id, newMs, oldMs: Math.round(oldMs), ratio: Math.round(ratio * 100) / 100, flagged });
      if (ratio >= RATIO) {
        slow.push(row(beforeRatio !== null && beforeRatio >= RATIO));
      } else if (ratio <= 1 / RATIO) {
        fast.push(row(beforeRatio !== null && beforeRatio <= 1 / RATIO));
      }
    }
    slow.sort((a, b) => b.ratio - a.ratio);
    fast.sort((a, b) => a.ratio - b.ratio);
    return { newer: nc.id, older: oc.id, slowdowns: slow.slice(0, 10), speedups: fast.slice(0, 10), compared };
  });
  const slowest: Perf["slowest"] = {};
  for (const c of ok) {
    slowest[c.id] = pkgs
      .map((p) => ({ p, cell: results[p.hash]?.[c.id] }))
      .filter((x) => x.cell !== undefined && x.cell.check_ms !== undefined && x.cell.s !== "skipped")
      .sort((a, b) => (b.cell?.check_ms ?? 0) - (a.cell?.check_ms ?? 0))
      .slice(0, 5)
      .map(({ p, cell }) => ({ hash: p.hash, pkg: label(p), ms: cell?.check_ms ?? 0, ...(cell?.rss_kb ? { rss_kb: cell.rss_kb } : {}) }));
  }
  return { ratio: RATIO, floorMs: FLOOR_MS, runsKept: tm.runs.length, pairs: out, slowest };
}
