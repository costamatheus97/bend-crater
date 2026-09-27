import { expect, test } from "bun:test";
import { cBuild, clangVersion, compare, disagrees, failed, laneDiff, settle } from "../src/lanes";
import { laneCounts } from "../src/report";

test("laneDiff names the first line a lane prints differently", () => {
  expect(laneDiff("1\n2\n", "1\n2\n")).toBe(null);
  expect(laneDiff("1.4414062\n", "1.4414063\n")).toBe("line 1: io '1.4414062', lane '1.4414063'");
  expect(laneDiff("a\nb\n", "a\n")).toBe("line 2: io 'b', lane ''");
  expect(laneDiff("a\n", "a\nb")).toBe("line 2: io '', lane 'b'");
  expect(laneDiff("a", "a\nb")).toBe("line 2: io (end), lane 'b'");
});

test("compare: same, differs, and a note when output was cut at the cap", () => {
  expect(compare({ out: "42\n" }, { out: "42\n" })).toEqual({ s: "same" });
  expect(compare({ out: "42\n" }, { out: "43\n" })).toEqual({ s: "differs", x: "line 1: io '42', lane '43'" });
  expect(compare({ out: "x", truncated: true }, { out: "x", truncated: true })).toEqual({ s: "same", x: "same (compared the first 64 KiB)" });
});

test("settle: a disagreement is nondet only when the reference also varies", () => {
  const lanes = { c: { s: "differs" as const, x: "line 1: io '1', lane '2'" }, js: { s: "same" as const } };
  expect(settle(lanes, "1\n", "1\n")).toEqual(lanes);
  expect(settle(lanes, "1\n", null)).toEqual(lanes);
  const t = settle(lanes, "1\n", "3\n");
  expect(t.c.s).toBe("nondet");
  expect(t.js.s).toBe("same");
  expect(disagrees(lanes)).toBe(true);
  expect(disagrees(t)).toBe(false);
});

test("lane failures are not disagreements", () => {
  const p = { code: 1, signal: null, timedOut: false, err: "", out: "" };
  expect(failed("build", p, "Error: x").s).toBe("build-fail");
  expect(failed("run", p, "boom").s).toBe("run-fail");
  expect(failed("run", { ...p, code: null, timedOut: true }, "").s).toBe("timeout");
  expect(failed("build", { ...p, code: null, oom: "cap" }, "").s).toBe("oom");
  expect(disagrees({ c: failed("build", p, "x"), js: { s: "same" } })).toBe(false);
});

test("the C lane needs clang 14+, and skips window and audio programs", () => {
  expect(clangVersion("Ubuntu clang version 18.1.3 (1ubuntu1)\nTarget: x86_64")).toBe(18);
  expect(clangVersion("clang version 21.1.0\n")).toBe(21);
  expect(clangVersion("Apple clang version 17.0.0")).toBe(17);
  expect(clangVersion("gcc (Ubuntu 13.3.0) 13.3.0")).toBe(null);
  expect(cBuild("clang", "#include <stdio.h>\n")).toEqual(["clang", "-std=c11", "-O3", "m.c", "-lpthread", "-lm", "-o", "m"]);
  expect(typeof cBuild("clang", "#include <X11/Xlib.h>\n")).toBe("string");
});

test("laneCounts counts verdicts across a run", () => {
  const r = { results: { a: { main: { s: "pass" as const, run: [{ f: "m.bend", s: "ok" as const, ms: 1, lanes: { c: { s: "same" as const }, js: { s: "differs" as const } } }] } }, b: { main: { s: "pass" as const } } } };
  expect(laneCounts(r)).toEqual({ same: 1, differs: 1 });
  expect(laneCounts({ results: {} })).toBe(null);
});
