// Checks a run's outputs before the publish job commits them.
//
// The publish job runs this from its own checkout; the artifact it checks
// comes from the job that ran hub code, so it is data, never code. It
// refuses outputs that do not parse, a run that is not newer than the one
// already committed (for instance when no artifact was downloaded and the
// files on disk are the committed ones), and a run in which almost nothing
// ran. The page is not checked here: the publish job renders it again from
// the checked data.
//
//   bun src/validate.ts --committed FILE    (the committed results.json, or an empty file)
//
// It prints one line per problem and exits 1 on any.

import * as fs from "node:fs";
import * as path from "node:path";
import type { HistoryEntry, Results } from "./report";
import type { Timings } from "./perf";
import { ROOT } from "./util";

const STATUSES = new Set(["pass", "pass-unsafe", "fail-parse", "fail-check", "fail-fetch", "fail-oom", "timeout", "crash", "skipped"]);
// a run must have run at least this share of its cells (and at least one)
export const MIN_RAN = 0.02;

const isTime = (s: unknown) => typeof s === "string" && !Number.isNaN(Date.parse(s));

export function validate(res: unknown, hist: unknown, tm: unknown, committed: Results | null): string[] {
  const bad: string[] = [];
  const r = res as Results;
  if (r === null || typeof r !== "object" || r.schema !== 1) {
    return ["results.json: not a schema 1 result"];
  }
  if (!isTime(r.started) || !isTime(r.finished) || Date.parse(r.finished) < Date.parse(r.started)) {
    bad.push("results.json: started or finished is not a time, or finished comes first");
  }
  if (committed !== null && isTime(committed.started) && !(Date.parse(r.started) > Date.parse(committed.started))) {
    bad.push(`results.json: this run (started ${r.started}) is not newer than the committed one (${committed.started})`);
  }
  if (!Array.isArray(r.compilers) || r.compilers.length === 0 || !Array.isArray(r.packages) || r.packages.length === 0
    || r.results === null || typeof r.results !== "object") {
    return [...bad, "results.json: no compilers, packages or results"];
  }
  let cells = 0, ran = 0;
  for (const row of Object.values(r.results)) {
    for (const cell of Object.values(row ?? {})) {
      cells++;
      if (!STATUSES.has(cell?.s)) {
        bad.push(`results.json: unknown status ${JSON.stringify(cell?.s)}`);
        return bad;
      }
      if (cell.s !== "skipped") {
        ran++;
      }
    }
  }
  if (ran === 0 || ran < cells * MIN_RAN) {
    bad.push(`results.json: only ${ran} of ${cells} cells ran`);
  }
  if (r.partial !== undefined && (typeof r.partial.reason !== "string" || !(r.partial.done <= r.partial.total))) {
    bad.push("results.json: a malformed partial marker");
  }
  const h = hist as HistoryEntry[];
  if (!Array.isArray(h) || h.length === 0 || h[h.length - 1]?.finished !== r.finished) {
    bad.push("history.json: its last entry is not this run");
  }
  const t = tm as Timings;
  if (t === null || typeof t !== "object" || !Array.isArray(t.runs) || t.runs[t.runs.length - 1] !== r.finished) {
    bad.push("timings.json: its last run is not this run");
  }
  return bad;
}

function read(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const at = argv.indexOf("--committed");
  const committed = at >= 0 ? read(argv[at + 1]) as Results | null : null;
  const data = path.join(ROOT, "data");
  const bad = validate(read(path.join(data, "results.json")), read(path.join(data, "history.json")),
    read(path.join(data, "timings.json")), committed);
  for (const b of bad) {
    console.log(b);
  }
  if (bad.length > 0) {
    process.exit(1);
  }
  console.log("outputs look right");
}
