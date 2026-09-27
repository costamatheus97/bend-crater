import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { checkpointFile, finalizeFile, stopCrater, writeCheckpoint, type Checkpoint } from "../src/finalize";
import type { HistoryEntry, Results } from "../src/report";
import { validate } from "../src/validate";

function checkpoint(dir: string): Checkpoint {
  const pkgs = ["0xa", "0xb"].map((h) => ({ hash: h, name: "p" + h, version: "1.0.0.0", ts: 0, roots: ["a.bend"], mains: [], foreign: false, deps: [] }));
  return {
    draft: {
      schema: 1, started: "2026-09-27T10:00:00.000Z",
      hub: { url: "", total: 2, named: 2, checked: 2 },
      compilers: [{ id: "main", kind: "main", version: "2.0.31", sha: "abc" }, { id: "2.0.31", kind: "release", version: "2.0.31" }],
      packages: pkgs,
      results: { "0xa": { main: { s: "pass", check_ms: 100 } }, "0xb": {} },
    },
    t0: Date.parse("2026-09-27T10:00:00.000Z"),
    pending: [["0xa", "2.0.31"], ["0xb", "main"], ["0xb", "2.0.31"]],
    total: 4,
    out: { data: path.join(dir, "data"), page: path.join(dir, "docs", "index.html"), historyKeep: 90 },
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "crater-test-"));
const readJ = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

test("a stopped run finalizes as partial: cells not run are skipped with the reason", () => {
  const dir = tmp();
  const file = checkpointFile(dir);
  writeCheckpoint(file, checkpoint(dir));
  const res = finalizeFile(file, "the run was stopped by SIGTERM") as Results;
  expect(res.partial).toEqual({ reason: "the run was stopped by SIGTERM", done: 1, total: 4 });
  const out = readJ(path.join(dir, "data", "results.json")) as Results;
  expect(out.results["0xa"].main.s).toBe("pass");
  expect(out.results["0xb"]["2.0.31"]).toEqual({ s: "skipped", x: "not run: the run was stopped by SIGTERM" });
  const hist = readJ(path.join(dir, "data", "history.json")) as HistoryEntry[];
  expect(hist[hist.length - 1].partial).toBe(true);
  expect(fs.readFileSync(path.join(dir, "docs", "index.html"), "utf8")).toContain("the run was stopped by SIGTERM");
  // a second finalize (the workflow's, after the process already did it) does nothing
  expect(finalizeFile(file, "the crater process was killed")).toBe(null);
  expect((readJ(path.join(dir, "data", "history.json")) as HistoryEntry[]).length).toBe(1);
  // and it validates, against an older committed run
  expect(validate(out, hist, readJ(path.join(dir, "data", "timings.json")), { ...out, started: "2026-09-26T10:00:00.000Z" })).toEqual([]);
});

test("a run that ran every cell is not partial", () => {
  const dir = tmp();
  const cp = checkpoint(dir);
  cp.pending = [];
  cp.total = 1;
  writeCheckpoint(checkpointFile(dir), cp);
  const res = finalizeFile(checkpointFile(dir), null) as Results;
  expect(res.partial).toBe(undefined);
  expect((readJ(path.join(dir, "data", "history.json")) as HistoryEntry[])[0].partial).toBe(undefined);
});

test("no checkpoint: finalize does nothing", () => {
  expect(finalizeFile(checkpointFile(tmp()), "x")).toBe(null);
});

test("validate refuses stale, empty and malformed outputs", () => {
  const dir = tmp();
  writeCheckpoint(checkpointFile(dir), checkpoint(dir));
  finalizeFile(checkpointFile(dir), "stopped");
  const res = readJ(path.join(dir, "data", "results.json")) as Results;
  const hist = readJ(path.join(dir, "data", "history.json"));
  const tm = readJ(path.join(dir, "data", "timings.json"));
  expect(validate(res, hist, tm, null)).toEqual([]);
  // not newer than what is committed: the artifact was missing, or is old
  expect(validate(res, hist, tm, res)[0]).toContain("is not newer");
  // nothing ran
  const none = structuredClone(res);
  none.results["0xa"].main = { s: "skipped" };
  expect(validate(none, hist, tm, null)).toEqual(["results.json: only 0 of 4 cells ran"]);
  // an unknown status, a wrong schema, a history that does not end with this run
  const odd = structuredClone(res);
  (odd.results["0xa"].main as { s: string }).s = "<script>";
  expect(validate(odd, hist, tm, null)[0]).toContain("unknown status");
  expect(validate({ schema: 2 }, hist, tm, null)).toEqual(["results.json: not a schema 1 result"]);
  expect(validate(res, [], tm, null)).toEqual(["history.json: its last entry is not this run"]);
  expect(validate(null, null, null, null)).toEqual(["results.json: not a schema 1 result"]);
});

test("stopCrater signals only a live crater process", async () => {
  expect(await stopCrater(undefined)).toBe("not running");
  expect(await stopCrater(process.pid)).toBe("not running");
  // a live process that is not a crater run is left alone
  const p = Bun.spawn(["sleep", "5"]);
  expect(await stopCrater(p.pid)).toBe("not running");
  expect(p.exitCode).toBe(null);
  p.kill();
});
