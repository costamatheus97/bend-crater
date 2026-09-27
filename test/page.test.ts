import { expect, test } from "bun:test";
import { renderPage } from "../src/page";
import type { Results } from "../src/report";

// The page is one template literal: an escape written for the page's own
// script ("\\n") must survive it, or the script does not parse and the page
// shows nothing. Parse every inline script of a rendered page.
test("the rendered page's script parses, with lanes, oom and a partial run", () => {
  const res: Results = {
    schema: 1, started: "2026-09-27T10:00:00Z", finished: "2026-09-27T10:10:00Z", seconds: 600,
    hub: { url: "", total: 1, named: 1, checked: 1 },
    compilers: [{ id: "main", kind: "main", version: "2.0.31", sha: "abc" }],
    packages: [{ hash: "0xa", name: "p", version: "1.0.0.0", ts: 0, roots: ["m.bend"], mains: ["m.bend"], foreign: false, deps: [] }],
    results: { "0xa": { main: { s: "pass", check_ms: 5, run: [{ f: "m.bend", s: "ok", ms: 3, lanes: { c: { s: "differs", x: "line 1: io '1', lane '2'" }, js: { s: "same" } } }] } } },
    regressions: [], brokeIn: {}, partial: { reason: "the run was stopped by SIGTERM", done: 1, total: 2 },
  };
  const html = renderPage(res, []);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  expect(scripts.length).toBeGreaterThan(0);
  for (const src of scripts) {
    expect(() => new Function(src)).not.toThrow();
  }
  expect(html).toContain("Lane agreement");
});
