// Re-renders docs/index.html from data/ without running the crater.
import * as fs from "node:fs";
import * as path from "node:path";
import { renderPage } from "./page";
import { analyse, type Timings } from "./perf";
import { label, type HistoryEntry, type Results } from "./report";
import { readJson, ROOT } from "./util";

const res = readJson<Results | null>(path.join(ROOT, "data", "results.json"), null);
if (res === null) {
  throw new Error("no data/results.json: run bun src/crater.ts first");
}
const hist = readJson<HistoryEntry[]>(path.join(ROOT, "data", "history.json"), []);
// recompute the timing analysis, so a change to it can be seen without a run
const tm = readJson<Timings | null>(path.join(ROOT, "data", "timings.json"), null);
if (tm !== null) {
  res.perf = analyse(res.compilers, res.packages, res.results, tm, label);
}
fs.writeFileSync(path.join(ROOT, "docs", "index.html"), renderPage(res, hist));
