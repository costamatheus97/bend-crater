// Results, regressions and the run history.

import type { Compiler } from "./compilers";
import { cmpVersion } from "./compilers";
import type { Perf } from "./perf";
import { isFail, isPass, type Status } from "./run";

export interface RunOutcome {
  f: string;                 // the root whose main ran
  s: "ok" | "fail" | "timeout" | "oom";
  ms: number;
  x?: string;
}

export interface Cell {
  s: Status;
  check_ms?: number;         // wall time of the --check-only run (the last attempt)
  rss_kb?: number;           // its peak RSS: GNU time's, or the memory watchdog's for the whole group
  x?: string;                // first error lines
  run?: RunOutcome[];
}

export interface PkgRow {
  hash: string;
  name: string | null;
  version: string | null;
  ts: number;
  roots: string[];
  mains: string[];
  foreign: boolean;
  deps: string[];
  fetch?: string;            // why the package could not be fetched
}

export interface ColInfo extends Omit<Compiler, "cmd"> {
  broken?: string;           // the compiler failed its own smoke check
  base_ms?: number;          // its smoke check's time: the startup cost in every cell
}

export interface Runner {
  ci: boolean;
  cpu: string;
  nproc: number;
  os: string;
  bun: string;
  rss: boolean;
}

export interface Regression {
  hash: string;
  pkg: string;               // name@version, or the hash
  kind: "next-release" | "since-last-run" | "new-release";
  from: string;              // compiler id and status it passed on
  to: string;                // compiler id and status it fails on
  s: Status;
  x?: string;
}

export interface Results {
  schema: 1;
  started: string;
  finished: string;
  seconds: number;
  hub: { url: string; total: number; named: number; checked: number };
  compilers: ColInfo[];
  packages: PkgRow[];
  results: Record<string, Record<string, Cell>>;
  regressions: Regression[];
  brokeIn: Record<string, string>;   // hash -> first release it fails on after passing
  runner?: Runner;
  timeoutS?: number;
  memCapMb?: number;         // the memory cap on each cell (0: none)
  cellTimeoutS?: number;     // the wall-clock limit on each cell
  perf?: Perf;
  // a run that did not run every cell: why, and how many it ran. Its cells
  // not run are `skipped`, with the reason.
  partial?: { reason: string; done: number; total: number };
}

export interface HistoryEntry {
  finished: string;
  partial?: boolean;
  cpu?: string;
  flagged?: { pkg: string; newer: string; older: string; ratio: number }[];
  compilers: { id: string; version: string; sha?: string }[];
  counts: Record<string, Record<string, number>>;
  regressions: { pkg: string; kind: string; from: string; to: string }[];
}

export const label = (p: PkgRow) => (p.name !== null ? p.name + "@" + p.version : p.hash);

// releasesAsc is the release columns, oldest first
export function releasesAsc(cols: ColInfo[]): ColInfo[] {
  return cols.filter((c) => c.kind === "release" && c.broken === undefined)
    .sort((a, b) => cmpVersion(a.version, b.version));
}

// brokeIn finds, per package, the first release in the window it fails on
// right after passing on the one before.
export function brokeIn(r: Pick<Results, "compilers" | "packages" | "results">): Record<string, string> {
  const rel = releasesAsc(r.compilers);
  const out: Record<string, string> = {};
  for (const p of r.packages) {
    const row = r.results[p.hash] ?? {};
    for (let i = rel.length - 1; i > 0; i--) {
      if (isFail(row[rel[i].id]?.s) && isPass(row[rel[i - 1].id]?.s)) {
        out[p.hash] = rel[i].id;
        break;
      }
    }
  }
  return out;
}

// regressions lists what went from pass to fail:
// - next-release: passes on the latest release, fails on main;
// - new-release: passed on the release before the latest, fails on it
//   (so a new release that broke a package shows once, at the top);
// - since-last-run: the same compiler (same release, or main against the
//   previous run's main) passed last run and fails now.
export function regressions(cur: Results, prev: Results | null): Regression[] {
  const out: Regression[] = [];
  const rel = releasesAsc(cur.compilers);
  const latest = rel[rel.length - 1];
  const before = rel[rel.length - 2];
  const main = cur.compilers.find((c) => c.kind === "main" && c.broken === undefined);
  const prevLatest = prev === null ? undefined : releasesAsc(prev.compilers).pop();
  for (const p of cur.packages) {
    const row = cur.results[p.hash] ?? {};
    const add = (kind: Regression["kind"], from: string, fromS: string | undefined, to: string, cell: Cell) =>
      out.push({ hash: p.hash, pkg: label(p), kind, from: from + " " + fromS, to: to, s: cell.s, x: cell.x });
    if (main && latest && isPass(row[latest.id]?.s) && isFail(row.main?.s)) {
      add("next-release", latest.id, row[latest.id].s, "main", row.main);
    }
    if (latest && before && isPass(row[before.id]?.s) && isFail(row[latest.id]?.s)
      && prevLatest !== undefined && prevLatest.id !== latest.id) {
      add("new-release", before.id, row[before.id].s, latest.id, row[latest.id]);
    }
    const old = prev?.results[p.hash];
    if (old !== undefined) {
      for (const c of cur.compilers) {
        const was = old[c.id]?.s;
        const now = row[c.id];
        if (now !== undefined && isPass(was) && isFail(now.s)) {
          const pc = prev?.compilers.find((x) => x.id === c.id);
          const tag = c.kind === "main" && pc?.sha && c.sha ? `main@${pc.sha.slice(0, 7)}→${c.sha.slice(0, 7)}` : c.id;
          add("since-last-run", tag + " (last run)", was, c.id, now);
        }
      }
    }
  }
  return out;
}

export function counts(r: Results): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const c of r.compilers) {
    const n: Record<string, number> = {};
    for (const p of r.packages) {
      const s = r.results[p.hash]?.[c.id]?.s;
      if (s !== undefined) {
        n[s] = (n[s] ?? 0) + 1;
      }
    }
    out[c.id] = n;
  }
  return out;
}

export function historyEntry(r: Results): HistoryEntry {
  return {
    finished: r.finished,
    ...(r.partial ? { partial: true } : {}),
    compilers: r.compilers.map((c) => ({ id: c.id, version: c.version, ...(c.sha ? { sha: c.sha } : {}) })),
    counts: counts(r),
    ...(r.runner ? { cpu: r.runner.cpu } : {}),
    flagged: (r.perf?.pairs ?? []).flatMap((p) => [...p.slowdowns, ...p.speedups])
      .filter((x) => x.flagged).map((x) => ({ pkg: x.pkg, newer: x.newer, older: x.older, ratio: x.ratio })),
    regressions: r.regressions.map((g) => ({ pkg: g.pkg, kind: g.kind, from: g.from, to: g.to })),
  };
}
