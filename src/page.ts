// The matrix page: one static HTML file with the run's results embedded as
// JSON and a little script that draws them. Every string from a package or
// a compiler reaches the page through textContent, never as HTML.

import type { HistoryEntry, Results } from "./report";

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(new RegExp("\\u2028", "g"), "\\u2028").replace(new RegExp("\\u2029", "g"), "\\u2029");

export function renderPage(r: Results, hist: HistoryEntry[]): string {
  const trend = hist.slice(-30).map((h) => ({ t: h.finished, c: h.counts, n: h.regressions.length }));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bend-crater</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22%3E%3Crect width=%2216%22 height=%2216%22 rx=%223%22 fill=%22%23b45309%22/%3E%3Ccircle cx=%228%22 cy=%228%22 r=%224%22 fill=%22%23fff%22/%3E%3C/svg%3E">
<meta name="description" content="Which BendHub packages still check on which Bend compiler: a nightly community compatibility matrix.">
<style>
:root {
  --bg: #fbfbfa; --fg: #1d1d1b; --mut: #6b6b66; --line: #e3e2de; --card: #ffffff; --head: #f3f2ef;
  --pass: #d9f2dd; --pass-fg: #14532d; --unsafe: #dcecf7; --unsafe-fg: #0c4a6e;
  --parse: #fbdada; --parse-fg: #7f1d1d; --check: #fde6cf; --check-fg: #7c2d12;
  --fetch: #ece3f8; --fetch-fg: #4c1d95; --timeout: #fbefc4; --timeout-fg: #713f12;
  --crash: #f6d3e4; --crash-fg: #831843; --skip: #eeeeec; --skip-fg: #57534e;
  --oom: #e4e9f5; --oom-fg: #1e3a8a;
  --accent: #b45309; --link: #1d4ed8;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #141413; --fg: #e8e6e1; --mut: #9c9a93; --line: #2d2c29; --card: #1b1b19; --head: #22211f;
    --pass: #173a22; --pass-fg: #a7e3b6; --unsafe: #133246; --unsafe-fg: #a9d6f2;
    --parse: #481c1c; --parse-fg: #f7b4b4; --check: #4a2a12; --check-fg: #f8c79d;
    --fetch: #33204f; --fetch-fg: #d6c2f5; --timeout: #45380f; --timeout-fg: #f2dc92;
    --crash: #4a1932; --crash-fg: #f5b3d3; --skip: #2a2926; --skip-fg: #a8a29e;
    --oom: #1f2a4a; --oom-fg: #b9c8f5;
    --accent: #f59e0b; --link: #93b4ff;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #141413; --fg: #e8e6e1; --mut: #9c9a93; --line: #2d2c29; --card: #1b1b19; --head: #22211f;
  --pass: #173a22; --pass-fg: #a7e3b6; --unsafe: #133246; --unsafe-fg: #a9d6f2;
  --parse: #481c1c; --parse-fg: #f7b4b4; --check: #4a2a12; --check-fg: #f8c79d;
  --fetch: #33204f; --fetch-fg: #d6c2f5; --timeout: #45380f; --timeout-fg: #f2dc92;
  --crash: #4a1932; --crash-fg: #f5b3d3; --skip: #2a2926; --skip-fg: #a8a29e;
  --oom: #1f2a4a; --oom-fg: #b9c8f5;
  --accent: #f59e0b; --link: #93b4ff;
  color-scheme: dark;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1180px; margin: 0 auto; padding: 24px 16px 64px; }
a { color: var(--link); }
code, pre, .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin: 32px 0 10px; }
.sub { color: var(--mut); margin: 0 0 16px; max-width: 70ch; }
.meta { display: flex; flex-wrap: wrap; gap: 6px 18px; color: var(--mut); font-size: 13px; }
.meta b { color: var(--fg); font-weight: 600; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 16px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.card .k { font-weight: 600; }
.card .v { font-size: 12px; color: var(--mut); }
.bar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; margin-top: 8px; background: var(--skip); }
.bar span { display: block; height: 100%; }
.partial { margin-top: 14px; background: var(--timeout); color: var(--timeout-fg); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 8px; padding: 10px 14px; }
.partial[hidden] { display: none; }
.reg { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--accent); border-radius: 8px; padding: 12px 14px; }
.reg ul { margin: 6px 0 0; padding-left: 18px; }
.reg li { margin: 6px 0; }
.reg .none { color: var(--mut); }
.reg pre { margin: 4px 0 0; white-space: pre-wrap; word-break: break-word; color: var(--mut); }
.tools { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; margin: 8px 0 10px; }
.tools input[type=search] { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); min-width: 0; width: 220px; max-width: 100%; }
.tools label { font-size: 14px; white-space: nowrap; }
.wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; background: var(--card); }
table { border-collapse: separate; border-spacing: 0; width: 100%; font-size: 13px; }
th, td { padding: 5px 8px; border-bottom: 1px solid var(--line); text-align: left; white-space: nowrap; }
thead th { position: sticky; top: 0; background: var(--head); font-weight: 600; z-index: 2; }
thead th .v { display: block; font-weight: 400; color: var(--mut); font-size: 11px; }
tbody th { position: sticky; left: 0; background: var(--card); font-weight: 500; z-index: 1; max-width: 46vw; overflow: hidden; text-overflow: ellipsis; }
thead th:first-child { left: 0; z-index: 3; }
tbody th .h { display: block; color: var(--mut); font-size: 11px; font-weight: 400; }
tr.grp th { background: var(--head); font-weight: 600; }
td.c { text-align: center; padding: 3px 4px; }
td.c button { font: 600 12px/1 ui-monospace, Menlo, Consolas, monospace; border: 0; border-radius: 4px; padding: 5px 6px 4px; min-width: 52px; cursor: pointer; }
td.c button small { display: block; font-weight: 400; font-size: 10px; margin-top: 3px; opacity: .8; }
td.c button small.t1 { opacity: 1; font-weight: 700; text-decoration: underline; }
td.c button small.t2 { opacity: 1; font-weight: 700; text-decoration: underline double; }
.perf { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; font-size: 14px; }
.perf table { width: auto; font-size: 13px; margin: 4px 0 10px; }
.perf td, .perf th { padding: 3px 10px 3px 0; border: 0; white-space: normal; }
.perf .muted { color: var(--mut); }
.perf .flag { color: var(--accent); font-weight: 700; }
.tools select { font: inherit; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--fg); }
td.c button:focus-visible { outline: 2px solid var(--link); outline-offset: 1px; }
.s-pass { background: var(--pass); color: var(--pass-fg); }
.s-pass-unsafe { background: var(--unsafe); color: var(--unsafe-fg); }
.s-fail-parse { background: var(--parse); color: var(--parse-fg); }
.s-fail-check { background: var(--check); color: var(--check-fg); }
.s-fail-fetch { background: var(--fetch); color: var(--fetch-fg); }
.s-timeout { background: var(--timeout); color: var(--timeout-fg); }
.s-crash { background: var(--crash); color: var(--crash-fg); }
.s-fail-oom { background: var(--oom); color: var(--oom-fg); }
.s-skipped { background: var(--skip); color: var(--skip-fg); }
.na { color: var(--mut); }
.broke { color: var(--accent); font-size: 12px; }
.legend { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 12px; margin: 10px 0; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { font: 600 11px/1 ui-monospace, Menlo, Consolas, monospace; font-style: normal; padding: 4px 6px; border-radius: 4px; }
#detail { position: fixed; inset: auto 0 0 0; max-height: 60vh; overflow: auto; background: var(--card); border-top: 1px solid var(--line); box-shadow: 0 -8px 24px rgba(0,0,0,.18); padding: 14px 16px 18px; z-index: 10; display: none; }
#detail.open { display: block; }
#detail .in { max-width: 1180px; margin: 0 auto; }
#detail pre { white-space: pre-wrap; word-break: break-word; background: var(--head); padding: 10px; border-radius: 6px; margin: 8px 0 0; }
#detail .x { float: right; font: inherit; background: none; border: 1px solid var(--line); border-radius: 6px; color: var(--fg); padding: 2px 10px; cursor: pointer; }
.theme { font: inherit; font-size: 13px; background: none; border: 1px solid var(--line); border-radius: 6px; color: var(--fg); padding: 2px 10px; cursor: pointer; }
footer { margin-top: 40px; color: var(--mut); font-size: 13px; }
</style>
</head>
<body>
<main>
<div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
  <div>
    <h1>bend-crater</h1>
    <p class="sub">Every package on <a href="https://hub.bend-lang.com">BendHub</a>, checked against recent Bend releases and <code>main</code>. A community project, inspired by Rust's crater; not affiliated with or maintained by the Bend authors.</p>
  </div>
  <button class="theme" id="theme" type="button" aria-label="Toggle dark mode">theme</button>
</div>
<div class="meta" id="meta"></div>
<div class="partial" id="partial" role="status" hidden></div>
<div class="cards" id="cards"></div>

<h2>Regressions</h2>
<div class="reg" id="reg"></div>

<h2>Checker performance</h2>
<div class="perf" id="perf"></div>

<h2>Matrix</h2>
<div class="legend" id="legend"></div>
<div class="tools">
  <input type="search" id="q" placeholder="Filter packages" aria-label="Filter packages">
  <label><input type="checkbox" id="failing"> failing somewhere</label>
  <label>order <select id="order"><option value="name">by name</option><option value="slow">slowest first</option></select></label>
  <label><input type="checkbox" id="anon"> anonymous hashes</label>
</div>
<div class="wrap"><table id="m"></table></div>
<noscript><p>The matrix needs JavaScript. The raw results are in <a href="https://github.com/costamatheus97/bend-crater/blob/main/data/results.json">data/results.json</a>.</p></noscript>

<footer>
  <p>Each cell runs <code>bend &lt;wrapper&gt; --check-only</code>, where the wrapper imports the package's entry file by hash, under a timeout. Checks run offline against a verified copy of the hub. A package whose entry defines <code>main</code> and has no foreign effects also has <code>main</code> run once (marked ▸). No GPU lanes. Click a cell for its error lines.</p>
  <p><a href="https://github.com/costamatheus97/bend-crater">Source, raw JSON and history</a> · Apache-2.0 · Results are informational: a failure can be the package's, the compiler's or this harness's.</p>
</footer>
</main>
<div id="detail" role="dialog" aria-modal="false" aria-labelledby="dt"><div class="in"><button class="x" id="dx" type="button">close</button><div id="dc"></div></div></div>
<script type="application/json" id="data">${json(r)}</script>
<script type="application/json" id="trend">${json(trend)}</script>
<script>
(function () {
  var R = JSON.parse(document.getElementById("data").textContent);
  var root = document.documentElement;
  try { var t = localStorage.getItem("crater-theme"); if (t) root.dataset.theme = t; } catch (e) {}
  document.getElementById("theme").onclick = function () {
    var dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("crater-theme", root.dataset.theme); } catch (e) {}
  };
  var SHORT = { "pass": "ok", "pass-unsafe": "ok*", "fail-parse": "parse", "fail-check": "check", "fail-fetch": "fetch", "fail-oom": "oom", "timeout": "time", "crash": "crash", "skipped": "skip" };
  var LONG = { "pass": "passes", "pass-unsafe": "passes, relies on unsafe or foreign code", "fail-parse": "fails to parse or load", "fail-check": "fails to check", "fail-fetch": "a dependency could not be fetched", "fail-oom": "went over the memory cap", "timeout": "no verdict before the timeout", "crash": "the compiler crashed", "skipped": "not run" };
  var ORDER = ["pass", "pass-unsafe", "fail-parse", "fail-check", "fail-fetch", "fail-oom", "timeout", "crash"];
  var COLOR = { "pass": "var(--pass-fg)", "pass-unsafe": "var(--unsafe-fg)", "fail-parse": "var(--parse-fg)", "fail-check": "var(--check-fg)", "fail-fetch": "var(--fetch-fg)", "fail-oom": "var(--oom-fg)", "timeout": "var(--timeout-fg)", "crash": "var(--crash-fg)" };
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    for (var k in attrs || {}) { if (k === "text") e.textContent = attrs[k]; else if (k === "cls") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
    return e;
  }
  function when(iso) { var d = new Date(iso); return isNaN(d) ? iso : d.toISOString().replace("T", " ").slice(0, 16) + " UTC"; }
  function ago(iso) { var s = (Date.now() - new Date(iso)) / 1000; return s < 3600 ? Math.round(s / 60) + " min ago" : s < 172800 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago"; }
  function colName(c) { return c.kind === "main" ? "main" : c.id; }
  function colSub(c) { return c.kind === "main" ? (c.sha ? c.sha.slice(0, 7) : "") + " (" + c.version + ")" : c.kind === "release" ? (c.date || "").slice(0, 10) : "local"; }
  function pkgLabel(p) { return p.name ? p.name + "@" + p.version : p.hash; }
  function secs(cell) {
    if (cell.s === "timeout") return ">" + (cell.check_ms != null ? Math.round(cell.check_ms / 1000) : R.timeoutS || "?") + " s";
    var ms = cell.check_ms != null ? cell.check_ms : cell.ms;
    if (ms == null || cell.s === "skipped") return "";
    return (ms < 10000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)) + " s";
  }
  var isPass = function (s) { return s === "pass" || s === "pass-unsafe"; };
  var isFail = function (s) { return s && !isPass(s) && s !== "skipped"; };

  var meta = document.getElementById("meta");
  [["Last run", when(R.finished) + " (" + ago(R.finished) + ")"], ["Took", R.seconds < 120 ? R.seconds + " s" : Math.round(R.seconds / 60) + " min"],
   ["Hub", R.hub.total + " packages, " + R.hub.named + " named versions"], ["Checked", R.hub.checked + " packages"]]
    .forEach(function (kv) { meta.appendChild(el("span", {}, [kv[0] + ": ", el("b", { text: kv[1] })])); });

  if (R.partial) {
    var pt = document.getElementById("partial");
    pt.hidden = false;
    pt.appendChild(el("b", { text: "Partial run: " }));
    pt.appendChild(document.createTextNode(R.partial.done + " of " + R.partial.total + " checks ran: " + R.partial.reason + ". The rest show as skip, and the regressions and timings cover only the checks that ran."));
  }

  var cards = document.getElementById("cards");
  R.compilers.forEach(function (c) {
    var n = {}, tot = 0, an = 0, aok = 0;
    R.packages.forEach(function (p) {
      var s = ((R.results[p.hash] || {})[c.id] || {}).s;
      if (!s || s === "skipped") return;
      if (!p.name) { an++; if (isPass(s)) aok++; return; }
      n[s] = (n[s] || 0) + 1; tot++;
    });
    var ok = (n["pass"] || 0) + (n["pass-unsafe"] || 0);
    var bar = el("div", { cls: "bar" });
    ORDER.forEach(function (s) { if (n[s]) { var sp = el("span", { title: s + ": " + n[s] }); sp.style.width = (100 * n[s] / tot) + "%"; sp.style.background = COLOR[s]; bar.appendChild(sp); } });
    var link = c.kind === "main" && c.sha ? el("a", { href: "https://github.com/bendlang/bend/commit/" + c.sha, text: colName(c) }) : c.kind === "release" ? el("a", { href: "https://github.com/bendlang/bend/releases/tag/v" + c.id, text: c.id }) : el("span", { text: colName(c) });
    cards.appendChild(el("div", { cls: "card" }, [el("div", { cls: "k" }, [link]), el("div", { cls: "v", text: c.broken ? "harness could not run it" : ok + " / " + tot + " named pass" + (an ? " · anonymous " + aok + " / " + an : "") }), el("div", { cls: "v", text: colSub(c) }), bar]));
  });

  var reg = document.getElementById("reg");
  var groups = [["next-release", "Pass on the latest release, fail on main (would break in the next release)"], ["new-release", "Broken by the newest release"], ["since-last-run", "Passed last run, fail now"]];
  var any = false;
  groups.forEach(function (g) {
    var list = R.regressions.filter(function (x) { return x.kind === g[0]; });
    if (!list.length) return;
    any = true;
    reg.appendChild(el("div", {}, [el("b", { text: g[1] + " (" + list.length + ")" })]));
    var ul = el("ul");
    list.forEach(function (x) {
      ul.appendChild(el("li", {}, [el("span", { cls: "mono", text: x.pkg }), " — " + x.from + " → " + x.to + ": " + (LONG[x.s] || x.s), x.x ? el("pre", { text: x.x }) : null]));
    });
    reg.appendChild(ul);
  });
  if (!any) reg.appendChild(el("div", { cls: "none", text: "No regressions: nothing that passes on the latest release fails on main, and nothing that passed in the previous run fails now." }));
  var broke = Object.keys(R.brokeIn || {}).length;
  if (broke) reg.appendChild(el("div", { cls: "v", style: "margin-top:8px;color:var(--mut);font-size:13px", text: broke + " package" + (broke === 1 ? "" : "s") + " passed on one release in the window and fail on the next: see the “broke in” column." }));

  var perf = document.getElementById("perf"), P = R.perf;
  if (!P) { perf.appendChild(el("div", { cls: "muted", text: "No timing data in this run." })); }
  else {
    var rn = R.runner || {};
    perf.appendChild(el("div", { cls: "muted", text: "Each cell is one --check-only run, timed once per night on " + (rn.ci ? "a shared GitHub runner" : "a local machine") + (rn.cpu ? " (" + rn.cpu + ", " + rn.nproc + " threads, " + rn.os + ")" : "") + ". A change is flagged only when the newer compiler takes at least " + P.ratio + "× the older one's median for that package over the last " + P.runsKept + " run(s), the larger side is at least " + (P.floorMs / 1000) + " s after each compiler's startup (" + R.compilers.filter(function (c) { return c.base_ms != null; }).map(function (c) { return colName(c) + " " + c.base_ms + " ms"; }).join(", ") + ") is taken off, and the same held in the previous run. One-run changes are listed as candidates. The biggest movers below the thresholds (from " + ((P.showMs || 200) / 1000) + " s after startup) are listed for context and flag nothing." }));
    var flagged = [], any = false;
    P.pairs.forEach(function (pr) {
      var rowsP = pr.slowdowns.map(function (x) { return [x, "slower"]; }).concat(pr.speedups.map(function (x) { return [x, "faster"]; }));
      if (!rowsP.length) return;
      any = true;
      perf.appendChild(el("div", { style: "margin-top:10px" }, [el("b", { text: pr.newer + " against " + pr.older })]));
      var t = el("table");
      rowsP.forEach(function (xr) {
        var x = xr[0];
        if (x.flagged) flagged.push(x);
        var tr = el("tr");
        tr.appendChild(el("td", { cls: "mono", text: x.pkg }));
        var lvl = x.level || (x.flagged ? "flagged" : "candidate");
        tr.appendChild(el("td", { cls: lvl === "flagged" ? "flag" : lvl === "below" ? "muted" : "", text: (xr[1] === "slower" ? x.ratio.toFixed(1) + "× slower" : (1 / x.ratio).toFixed(1) + "× faster") + " (" + (lvl === "below" ? "below threshold" : lvl) + ")" }));
        tr.appendChild(el("td", { cls: "muted", text: (x.oldMs / 1000).toFixed(1) + " s → " + (x.newMs / 1000).toFixed(1) + " s" }));
        t.appendChild(tr);
      });
      perf.appendChild(t);
    });
    if (!any) perf.appendChild(el("div", { style: "margin-top:8px", text: "No check moved by 1.2× or more between main and " + (P.pairs[0] ? P.pairs[0].older : "the latest release") + ", or between consecutive releases (" + (P.pairs[0] ? P.pairs[0].compared : 0) + " packages compared on main)." }));
    perf.appendChild(el("div", { style: "margin-top:12px" }, [el("b", { text: "Slowest passing checks per compiler" })]));
    var st = el("table");
    R.compilers.forEach(function (c) {
      var xs = (P.slowest || {})[c.id] || [];
      if (!xs.length) return;
      var tr = el("tr");
      tr.appendChild(el("td", { text: colName(c) }));
      tr.appendChild(el("td", { cls: "mono", text: xs.slice(0, 3).map(function (x) { return x.pkg.length > 30 ? x.pkg.slice(0, 14) + "…" : x.pkg; }).join(", ") }));
      tr.appendChild(el("td", { cls: "muted", text: xs.slice(0, 3).map(function (x) { return (x.ms / 1000).toFixed(1) + " s" + (x.rss_kb ? " / " + Math.round(x.rss_kb / 1024) + " MB" : ""); }).join(", ") }));
      st.appendChild(tr);
    });
    perf.appendChild(st);
  }

  var legend = document.getElementById("legend");
  ORDER.concat(["skipped"]).forEach(function (s) { legend.appendChild(el("span", {}, [el("i", { cls: "s-" + s, text: SHORT[s] }), LONG[s]])); });
  legend.appendChild(el("span", {}, [el("i", { cls: "na", text: "·" }), "not run on this compiler"]));

  var cols = R.compilers;
  var table = document.getElementById("m");
  var thead = el("thead"), hr = el("tr");
  hr.appendChild(el("th", { text: "package" }));
  cols.forEach(function (c) { hr.appendChild(el("th", { scope: "col" }, [colName(c), el("span", { cls: "v", text: colSub(c) })])); });
  hr.appendChild(el("th", { text: "broke in" }));
  thead.appendChild(hr); table.appendChild(thead);
  var tbody = el("tbody"); table.appendChild(tbody);
  var rows = [];
  var lastName = null;
  R.packages.forEach(function (p) {
    var row = R.results[p.hash] || {};
    var tr = el("tr");
    var th = el("th", { scope: "row", title: pkgLabel(p) + "\\n" + p.hash }, [p.name ? p.name + "@" + p.version : p.hash.slice(0, 14) + "…", el("span", { cls: "h", text: p.name ? p.hash.slice(0, 12) + " · " + new Date(p.ts).toISOString().slice(0, 10) : new Date(p.ts).toISOString().slice(0, 10) + " · " + p.roots.join(", ") })]);
    tr.appendChild(th);
    var failing = false, slowMs = 0;
    cols.forEach(function (c) {
      var cell = row[c.id], td = el("td", { cls: "c" });
      if (!cell) { td.appendChild(el("span", { cls: "na", text: "·" })); }
      else {
        if (isFail(cell.s)) failing = true;
        var runBad = cell.run && cell.run.some(function (r) { return r.s !== "ok"; });
        var t = secs(cell);
        if (cell.check_ms != null && cell.check_ms > slowMs) slowMs = cell.check_ms;
        if (cell.s === "timeout") slowMs = Infinity;
        var b = el("button", { type: "button", cls: "s-" + cell.s, "aria-label": pkgLabel(p) + " on " + colName(c) + ": " + LONG[cell.s] + (t ? ", " + t : ""), title: t },
          [SHORT[cell.s] + (cell.run ? (runBad ? " ▸!" : " ▸") : ""), t ? el("small", { cls: cell.s === "timeout" || cell.check_ms >= 10000 ? "t2" : cell.check_ms >= 1000 ? "t1" : "", text: t }) : null]);
        b.onclick = function () { show(p, c, cell); };
        td.appendChild(b);
      }
      tr.appendChild(td);
    });
    tr.appendChild(el("td", { cls: "broke", text: (R.brokeIn || {})[p.hash] || "" }));
    rows.push({ tr: tr, p: p, failing: failing, slow: slowMs, text: (pkgLabel(p) + " " + p.hash + " " + p.roots.join(" ")).toLowerCase() });
  });

  var order = document.getElementById("order");
  var q = document.getElementById("q"), fOnly = document.getElementById("failing"), fAnon = document.getElementById("anon");
  var anonCount = R.packages.filter(function (p) { return !p.name; }).length;
  fAnon.parentNode.lastChild.textContent = " anonymous hashes (" + anonCount + ")";
  function draw() {
    var s = q.value.trim().toLowerCase();
    tbody.textContent = "";
    var group = null, shown = 0;
    var list = order.value === "slow" ? rows.slice().sort(function (a, b) { return (!a.p.name) - (!b.p.name) || b.slow - a.slow; }) : rows;
    list.forEach(function (r) {
      if (!r.p.name && !fAnon.checked) return;
      if (fOnly.checked && !r.failing) return;
      if (s && r.text.indexOf(s) < 0) return;
      var g = r.p.name ? "Named packages" : "Anonymous hashes (checked on main and the latest release)";
      if (g !== group) { group = g; var gr = el("tr", { cls: "grp" }); var gth = el("th", { colspan: String(cols.length + 2), text: g }); gr.appendChild(gth); tbody.appendChild(gr); }
      tbody.appendChild(r.tr); shown++;
    });
    if (!shown) { var tr = el("tr"); tr.appendChild(el("td", { colspan: String(cols.length + 2), cls: "na", text: "No package matches." })); tbody.appendChild(tr); }
  }
  q.oninput = draw; fOnly.onchange = draw; fAnon.onchange = draw; order.onchange = draw;
  draw();

  var detail = document.getElementById("detail"), dc = document.getElementById("dc");
  document.getElementById("dx").onclick = function () { detail.classList.remove("open"); };
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") detail.classList.remove("open"); });
  function show(p, c, cell) {
    dc.textContent = "";
    dc.appendChild(el("div", { id: "dt" }, [el("b", { cls: "mono", text: pkgLabel(p) }), " on ", el("b", { text: colName(c) + (c.kind === "main" ? " @ " + (c.sha || "").slice(0, 7) : "") }), ": " + LONG[cell.s] + " (" + (secs(cell) || "not timed") + (cell.rss_kb ? ", peak RSS " + Math.round(cell.rss_kb / 1024) + " MB" : "") + ")"]));
    dc.appendChild(el("div", { cls: "mono", style: "color:var(--mut);margin-top:4px", text: p.hash + " · entry " + p.roots.join(", ") + (p.deps.length ? " · imports " + p.deps.join(", ") : "") }));
    if (cell.x) dc.appendChild(el("pre", { text: cell.x }));
    (cell.run || []).forEach(function (r) {
      dc.appendChild(el("div", { style: "margin-top:8px", text: "▸ ran main in " + r.f + ": " + (r.s === "ok" ? "exited 0" : r.s === "timeout" ? "still running at the timeout" : r.s === "oom" ? "went over the memory cap" : "exited non-zero") + " (" + (r.ms / 1000).toFixed(1) + " s)" }));
      if (r.x) dc.appendChild(el("pre", { text: r.x }));
    });
    detail.classList.add("open");
  }
})();
</script>
</body>
</html>
`;
}
