// Re-renders docs/index.html from data/ without running the crater.
import * as fs from "node:fs";
import * as path from "node:path";
import { renderPage } from "./page";
import type { HistoryEntry, Results } from "./report";
import { readJson, ROOT } from "./util";

const res = readJson<Results | null>(path.join(ROOT, "data", "results.json"), null);
if (res === null) {
  throw new Error("no data/results.json: run bun src/crater.ts first");
}
const hist = readJson<HistoryEntry[]>(path.join(ROOT, "data", "history.json"), []);
fs.writeFileSync(path.join(ROOT, "docs", "index.html"), renderPage(res, hist));
