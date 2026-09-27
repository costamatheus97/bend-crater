// Turning a run's checkpoint into its outputs.
//
// While the checks run, crater.ts keeps a checkpoint (cache/checkpoint.json):
// the run so far, and the cells not run yet. finalize() writes the four
// outputs from it: data/results.json, data/history.json, data/timings.json
// and the page. A run that ends normally finalizes itself. So does one that
// is stopped (SIGINT or SIGTERM, as on a cancel or a step timeout) or whose
// harness throws: its cells not run are marked `skipped` with the reason,
// and the run is marked partial. When the crater process is killed outright,
// the workflow runs this file, which finalizes the checkpoint it left:
//
//   bun src/finalize.ts [--cache DIR] [--reason TEXT]
//
// It does nothing when there is no checkpoint or it was already finalized.

import * as fs from "node:fs";
import * as path from "node:path";
import { renderPage } from "./page";
import { analyse, updateTimings, type Timings } from "./perf";
import { brokeIn, historyEntry, label, regressions, type HistoryEntry, type Results } from "./report";
import { log, readJson, ROOT, writeJson } from "./util";

// a run so far: every field of Results that is known before it ends
export type Draft = Omit<Results, "finished" | "seconds" | "regressions" | "brokeIn" | "perf" | "partial">;

export interface Checkpoint {
  draft: Draft;
  t0: number;                  // Date.now() at the start, for `seconds`
  pending: [string, string][]; // [hash, compiler id] of the cells not run yet
  total: number;               // cells the run meant to run
  out: { data: string; page: string; historyKeep: number };
  finalized?: boolean;
}

export const checkpointFile = (cache: string) => path.join(cache, "checkpoint.json");

// writeCheckpoint replaces the file in one rename, so a reader (or a run
// killed mid-write) sees the old checkpoint or the new one, never half.
export function writeCheckpoint(file: string, cp: Checkpoint): void {
  const tmp = file + ".tmp";
  writeJson(tmp, cp);
  fs.renameSync(tmp, file);
}

// finalize writes the outputs. reason is null for a run that ran every
// cell, and says why the rest did not run otherwise.
export function finalize(cp: Checkpoint, reason: string | null, now = new Date()): Results {
  const dataDir = cp.out.data;
  const results = cp.draft.results;
  for (const [h, c] of cp.pending) {
    (results[h] ??= {})[c] = { s: "skipped", x: "not run: " + (reason ?? "the run ended first") };
  }
  const resultsFile = path.join(dataDir, "results.json");
  const prev = readJson<Results | null>(resultsFile, null);
  const res: Results = {
    ...cp.draft,
    finished: now.toISOString(), seconds: Math.round((now.getTime() - cp.t0) / 1000),
    regressions: [], brokeIn: {},
    ...(reason !== null ? { partial: { reason, done: cp.total - cp.pending.length, total: cp.total } } : {}),
  };
  res.brokeIn = brokeIn(res);
  const timingsFile = path.join(dataDir, "timings.json");
  const tm = updateTimings(readJson<Timings | null>(timingsFile, null), res.finished, results);
  writeJson(timingsFile, tm);
  res.perf = analyse(res.compilers, res.packages, results, tm, label);
  res.regressions = regressions(res, prev !== null && prev.schema === 1 ? prev : null);
  writeJson(resultsFile, res);
  const histFile = path.join(dataDir, "history.json");
  const hist = readJson<HistoryEntry[]>(histFile, []);
  hist.push(historyEntry(res));
  writeJson(histFile, hist.slice(-cp.out.historyKeep));
  fs.mkdirSync(path.dirname(cp.out.page), { recursive: true });
  fs.writeFileSync(cp.out.page, renderPage(res, hist.slice(-cp.out.historyKeep)));
  return res;
}

// finalizeFile finalizes the checkpoint in `file` once: false when there is
// none, or it was finalized already.
export function finalizeFile(file: string, reason: string | null): Results | null {
  const cp = readJson<Checkpoint | null>(file, null);
  if (cp === null || cp.finalized) {
    return null;
  }
  const res = finalize(cp, reason);
  cp.finalized = true;
  cp.draft.results = {};
  writeCheckpoint(file, cp);
  return res;
}

if (import.meta.main) {
  let cache = path.join(ROOT, "cache");
  let reason = "the crater process was killed";
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--cache") {
      cache = path.resolve(ROOT, argv[++i]);
    } else if (argv[i] === "--reason") {
      reason = argv[++i];
    } else {
      throw new Error("unknown option " + argv[i]);
    }
  }
  const res = finalizeFile(checkpointFile(cache), reason);
  if (res === null) {
    log("finalize: no unfinished checkpoint, nothing to do");
  } else {
    log(`finalize: wrote a partial run: ${res.partial?.done} of ${res.partial?.total} cells (${reason})`);
  }
}
