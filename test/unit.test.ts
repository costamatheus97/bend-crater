import { expect, test } from "bun:test";
import { imports } from "../src/pkg";
import { brokeIn, regressions, type Results } from "../src/report";
import { classify, type Proc } from "../src/run";

const proc = (code: number | null, extra: Partial<Proc> = {}): Proc =>
  ({ code, signal: null, out: "", err: "", ms: 1, timedOut: false, ...extra });

test("classify reads bend's verdicts", () => {
  expect(classify(proc(0), "All terms check.")).toBe("pass");
  expect(classify(proc(0), "All terms check, but 2 defs rely on unsafe or foreign code:\n- f")).toBe("pass-unsafe");
  expect(classify(proc(0), "All terms check, with 3 unsafe annotations.")).toBe("pass-unsafe");
  expect(classify(proc(1), "Error:\n- expected : a name (words joined by dots, got 'Date.leap.100')\n- observed : '('\nLocation:\n10>| def Date.leap.100(")).toBe("fail-parse");
  expect(classify(proc(1), "Error:\n- expected : Bool\n- observed : U32\nContext:\n- x : U32\nLocation: f\n4>|   x")).toBe("fail-check");
  expect(classify(proc(1), "Error:\n- message  : a file at $HUB/0x00/manifest hashing to 00\nLocation:\n1>| import")).toBe("fail-fetch");
  expect(classify(proc(1), "Error:\n- message  : a package named foo@1.0.0.0 on $HUB\nLocation:\n1>| import")).toBe("fail-fetch");
  expect(classify(proc(null, { timedOut: true }), "")).toBe("timeout");
  expect(classify(proc(null, { signal: "SIGSEGV" }), "")).toBe("crash");
  expect(classify(proc(1), "panic: something")).toBe("crash");
  expect(classify(proc(1), "Error: the machine stack overflowed (a deep recursion)")).toBe("crash");
});

test("imports stops at the first line that is not an import", () => {
  const src = "# a comment\nimport Base\nimport ./a.bend as A\n\nimport 0xab/b.bend as B # note\ndef x() -> U32:\nimport ./c.bend as C\n";
  expect(imports(src)).toEqual(["./a.bend", "0xab/b.bend"]);
});

function results(cells: Record<string, Record<string, string>>, main = "abc"): Results {
  const ids = ["main", "2.0.3", "2.0.2", "2.0.1"];
  return {
    schema: 1, started: "", finished: "", seconds: 0,
    hub: { url: "", total: 0, named: 0, checked: 0 },
    compilers: ids.map((id) => id === "main"
      ? { id, kind: "main" as const, version: "2.0.3", sha: main }
      : { id, kind: "release" as const, version: id }),
    packages: Object.keys(cells).map((h) => ({ hash: h, name: "p" + h, version: "1.0.0.0", ts: 0, roots: [], mains: [], foreign: false, deps: [] })),
    results: Object.fromEntries(Object.entries(cells).map(([h, r]) =>
      [h, Object.fromEntries(Object.entries(r).map(([c, s]) => [c, { s: s as never, check_ms: 0 }]))])),
    regressions: [], brokeIn: {},
  };
}

test("regressions: main against the latest release, and against the last run", () => {
  const prev = results({ a: { main: "pass", "2.0.3": "pass" }, b: { main: "pass", "2.0.3": "pass" } }, "old");
  const cur = results({
    a: { main: "fail-check", "2.0.3": "pass", "2.0.2": "pass", "2.0.1": "pass" },
    b: { main: "pass", "2.0.3": "pass", "2.0.2": "pass", "2.0.1": "pass" },
    c: { main: "fail-parse", "2.0.3": "fail-parse", "2.0.2": "fail-parse", "2.0.1": "pass" },
  });
  const got = regressions(cur, prev).map((g) => g.pkg + " " + g.kind);
  expect(got).toEqual(["pa@1.0.0.0 next-release", "pa@1.0.0.0 since-last-run"]);
  expect(brokeIn(cur)).toEqual({ c: "2.0.2" });
  expect(regressions(cur, null).map((g) => g.kind)).toEqual(["next-release"]);
});

test("a new latest release that breaks a package is listed once", () => {
  const prev = results({ a: { "2.0.2": "pass" } });
  prev.compilers = prev.compilers.filter((c) => c.id !== "2.0.3");
  const cur = results({ a: { main: "fail-check", "2.0.3": "fail-check", "2.0.2": "pass" } });
  expect(regressions(cur, prev).map((g) => g.kind)).toEqual(["new-release"]);
});

test("timing: only large, repeated changes above the floor are flagged", async () => {
  const { analyse, updateTimings } = await import("../src/perf");
  const cols = [
    { id: "main", kind: "main" as const, version: "2.0.3", base_ms: 300 },
    { id: "2.0.3", kind: "release" as const, version: "2.0.3", base_ms: 100 },
  ];
  const pkgs = ["a", "b", "c"].map((h) => ({ hash: h, name: h, version: "1.0.0.0", ts: 0, roots: [], mains: [], foreign: false, deps: [] }));
  const run = (a: number, b: number, c: number) => ({
    a: { main: { s: "pass" as const, check_ms: a }, "2.0.3": { s: "pass" as const, check_ms: 5100 } },
    b: { main: { s: "pass" as const, check_ms: b }, "2.0.3": { s: "pass" as const, check_ms: 400 } },
    c: { main: { s: "pass" as const, check_ms: c }, "2.0.3": { s: "pass" as const, check_ms: 3100 } },
  });
  const lab = (p: { name: string | null }) => p.name ?? "";
  // run 1: a is 3x slower on main (candidate), b is tiny, c is 2x faster
  let tm = updateTimings(null, "r1", run(15300, 1200, 1300));
  let perf = analyse(cols, pkgs, run(15300, 1200, 1300), tm, lab);
  expect(perf.pairs[0].slowdowns.map((x) => [x.pkg, x.level])).toEqual([["a", "candidate"], ["b", "below"]]);
  expect(perf.pairs[0].speedups.map((x) => [x.pkg, x.level])).toEqual([["c", "candidate"]]);
  // run 2: the same again, so both are flagged
  tm = updateTimings(tm, "r2", run(15300, 1200, 1300));
  perf = analyse(cols, pkgs, run(15300, 1200, 1300), tm, lab);
  expect(perf.pairs[0].slowdowns.map((x) => [x.pkg, x.level])).toEqual([["a", "flagged"], ["b", "below"]]);
  expect(perf.pairs[0].speedups.map((x) => [x.pkg, x.level])).toEqual([["c", "flagged"]]);
  expect(tm.t.a.main).toEqual([15300, 15300]);
  expect(perf.slowest.main[0]).toEqual({ hash: "a", pkg: "a", ms: 15300 });
});
