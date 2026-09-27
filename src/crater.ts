// bend-crater: check every BendHub package against a set of Bend compilers
// and write the results, the regressions and the matrix page.
//
//   bun src/crater.ts [--releases N] [--no-main] [--bend PATH]... [--only RE]
//                     [--anon edges|all|none] [--jobs N] [--timeout S]
//                     [--run-timeout S] [--no-run] [--[no-]lane-diff] [--no-nice] [--dry]
//                     [--cache DIR] [--data DIR] [--page FILE]
//                     [--releases-json FILE] [--no-rss] [--budget-min M]
//                     [--mem-cap MB] [--cell-timeout S]
//
// Defaults come from crater.json. See README.md.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureMain, ensureRelease, listReleases, localCompiler, pruneReleases, type Compiler } from "./compilers";
import { listPackages, Store, type HubPackage } from "./hub";
import { checkpointFile, finalize, writeCheckpoint, type Checkpoint } from "./finalize";
import { inspect, type PkgInfo } from "./pkg";
import { label, type Cell, type PkgRow, type Runner, type RunOutcome } from "./report";
import { classify, clean, exec, excerpt, isPass, peakKb, rssTool, stopAll, type ExecOpts, type Proc, type Status } from "./run";
import { cBuild, compare, failed, findClang, LANES, settle, type Lane } from "./lanes";
import { available as watchdog, memTotalKb, setTotalCap } from "./watch";
import { log, readJson, ROOT } from "./util";

type Col = Compiler & { broken?: string; base_ms?: number };

interface Config {
  hub: string;
  releases: number;
  main: boolean;
  mainRef: string;
  bend: string[];
  only: string | null;
  anon: "edges" | "all" | "none";
  jobs: number;
  timeout: number;
  runTimeout: number;
  run: boolean;
  laneDiff: boolean;
  nice: boolean;
  cache: string;
  data: string;
  page: string;
  historyKeep: number;
  releasesJson: string | null;
  rss: boolean;
  budgetMin: number;
  memCapMb: number;
  cellTimeout: number;
  dry: boolean;
}

function config(argv: string[]): Config {
  const file = readJson<Partial<Config>>(path.join(ROOT, "crater.json"), {});
  const c: Config = {
    hub: "https://hub.bend-lang.com", releases: 6, main: true, mainRef: "main", bend: [], only: null,
    anon: "edges", jobs: 1, timeout: 120, runTimeout: 20, run: true, laneDiff: false, nice: !process.env.CI,
    cache: "cache", data: "data", page: "docs/index.html", historyKeep: 90, releasesJson: null, rss: true, budgetMin: 300,
    memCapMb: 4096, cellTimeout: 900, dry: false, ...file,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    switch (a) {
      case "--releases": c.releases = parseInt(v(), 10); break;
      case "--no-main": c.main = false; break;
      case "--main-ref": c.mainRef = v(); break;
      case "--bend": c.bend.push(v()); break;
      case "--only": c.only = v(); break;
      case "--anon": c.anon = v() as Config["anon"]; break;
      case "--jobs": c.jobs = Math.max(1, parseInt(v(), 10)); break;
      case "--timeout": c.timeout = parseInt(v(), 10); break;
      case "--run-timeout": c.runTimeout = parseInt(v(), 10); break;
      case "--no-run": c.run = false; break;
      case "--lane-diff": c.laneDiff = true; break;
      case "--no-lane-diff": c.laneDiff = false; break;
      case "--no-rss": c.rss = false; break;
      case "--budget-min": c.budgetMin = parseInt(v(), 10); break;
      case "--mem-cap": c.memCapMb = parseInt(v(), 10); break;
      case "--cell-timeout": c.cellTimeout = parseInt(v(), 10); break;
      case "--no-nice": c.nice = false; break;
      case "--nice": c.nice = true; break;
      case "--dry": c.dry = true; break;
      case "--cache": c.cache = v(); break;
      case "--releases-json": c.releasesJson = v(); break;
      case "--data": c.data = v(); break;
      case "--page": c.page = v(); break;
      default: throw new Error("unknown option " + a);
    }
  }
  return c;
}

// runnerInfo describes the machine, since every time depends on it
function runnerInfo(rss: boolean): Runner {
  let cpu = os.cpus()[0]?.model ?? "?";
  try {
    cpu = /^model name\s*:\s*(.+)$/m.exec(fs.readFileSync("/proc/cpuinfo", "utf8"))?.[1] ?? cpu;
  } catch { /* not Linux */ }
  const img = process.env.ImageOS ? `${process.env.ImageOS} ${process.env.ImageVersion ?? ""}`.trim() : `${os.type()} ${os.release()}`;
  return { ci: !!process.env.CI, cpu: cpu.trim(), nproc: os.availableParallelism(), os: img, bun: Bun.version, rss };
}

// pool runs tasks with at most n in flight, and starts none once stop()
async function pool<T>(items: T[], n: number, stop: () => boolean, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length && !stop()) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}

// the run's checkpoint once the checks start, so a harness error can still
// finalize what ran
let active: { cp: Checkpoint; file: string } | null = null;

function finish(reason: string | null): void {
  if (active === null || active.cp.finalized) {
    return;
  }
  const { cp, file } = active;
  const res = finalize(cp, reason);
  cp.finalized = true;
  cp.draft.results = {};
  writeCheckpoint(file, cp);
  log(`wrote ${path.relative(ROOT, path.join(cp.out.data, "results.json"))}, history.json, timings.json and ${path.relative(ROOT, cp.out.page)} in ${res.seconds} s`
    + (res.partial ? ` (partial: ${res.partial.done} of ${res.partial.total} cells; ${res.partial.reason})` : ""));
  log(`${res.regressions.length} regressions`);
  const flagged = (res.perf?.pairs ?? []).flatMap((p) => [...p.slowdowns, ...p.speedups]).filter((x) => x.flagged);
  log(`timing: ${flagged.length} flagged changes; slowest: ` + Object.entries(res.perf?.slowest ?? {})
    .map(([c, xs]) => `${c} ${xs[0]?.pkg ?? "-"} ${xs[0]?.ms ?? 0} ms`).join(", "));
}

async function main(): Promise<void> {
  const cfg = config(process.argv.slice(2));
  const t0 = Date.now();
  const started = new Date().toISOString();
  const cache = path.resolve(ROOT, cfg.cache);
  const dataDir = path.resolve(ROOT, cfg.data);
  // a checkpoint from an earlier run is never finalized into this one
  fs.rmSync(checkpointFile(cache), { force: true });
  const store = new Store(path.join(cache, "lib"), cfg.hub);

  const dropped = store.verify();
  if (dropped > 0) {
    log(`${dropped} stored packages no longer matched their hash and will be refetched`);
  }

  // 1. The hub's packages, and what the names point at.
  log("listing hub packages");
  const listed = await listPackages(cfg.hub);
  for (const p of listed) {
    if (p.name !== null && p.version !== null) {
      store.setName(p.name + "@" + p.version, p.hash);
    }
  }
  const only = cfg.only === null ? null : new RegExp(cfg.only);
  const chosen = listed.filter((p) => (p.name !== null || cfg.anon !== "none")
    && (only === null || only.test(p.name ?? "") || only.test(p.hash)));
  chosen.sort((a, b) => (a.name === null) !== (b.name === null) ? (a.name === null ? 1 : -1)
    : a.name !== null && b.name !== null && a.name !== b.name ? a.name.localeCompare(b.name)
    : b.ts - a.ts);
  const named = listed.filter((p) => p.name !== null).length;
  log(`${listed.length} packages on the hub (${named} named versions); checking ${chosen.length}`);

  // 2. Fetch each chosen package and, transitively, what it imports.
  const info = new Map<string, PkgInfo>();
  const fetchErr = new Map<string, string>();
  const want = chosen.map((p) => p.hash);
  const seen = new Set<string>();
  while (want.length > 0) {
    const h = want.shift() as string;
    if (seen.has(h)) {
      continue;
    }
    seen.add(h);
    const fresh = !store.has(h);
    const err = await store.ensure(h).catch((e) => String(e));
    if (err !== null) {
      fetchErr.set(h, err);
      log(`fetch failed: ${h}: ${err}`);
      continue;
    }
    if (fresh) {
      log(`fetched ${h} (${store.fetched} new)`);
    }
    const pi = inspect(store, h);
    info.set(h, pi);
    want.push(...pi.hashDeps);
    for (const nv of pi.nameDeps) {
      const dh = await store.resolve(nv).catch(() => null);
      if (dh !== null) {
        want.push(dh);
      }
    }
  }
  log(`store ready: ${store.fetched} packages fetched this run`);

  // 3. The compilers.
  const cols: Col[] = [];
  if (cfg.main) {
    try {
      cols.push(ensureMain(cache, cfg.mainRef));
    } catch (e) {
      log("main: " + String(e));
    }
  }
  if (cfg.releases > 0) {
    const rels = await listReleases(cfg.releases, cfg.releasesJson ?? undefined);
    for (const r of rels) {
      try {
        cols.push(await ensureRelease(cache, r));
      } catch (e) {
        log(`${r.tag_name}: ${String(e)}`);
      }
    }
    pruneReleases(cache, rels.map((r) => r.tag_name.slice(1)));
  }
  for (const b of cfg.bend) {
    cols.push(localCompiler(b));
  }
  log("compilers: " + cols.map((c) => c.id + (c.sha ? "@" + c.sha.slice(0, 7) : "")).join(", "));
  if (cfg.dry) {
    return;
  }

  // 4. A sandbox: its own HOME whose ~/.bend/lib is the store (releases that
  // ignore BEND_LIB read it there), and a hub that answers 404 to anything,
  // so a compiler never reaches the real hub and a dependency that is not in
  // the store fails fast as fail-fetch.
  const work = path.join(cache, "work");
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(path.join(work, "home", ".bend"), { recursive: true });
  fs.mkdirSync(path.join(work, "w"), { recursive: true });
  fs.symlinkSync(store.lib, path.join(work, "home", ".bend", "lib"));
  const fake = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("bend-crater: offline\n", { status: 404 }) });
  const hubUrl = `http://127.0.0.1:${fake.port}`;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: path.join(work, "home"),
    BEND_LIB: store.lib,
    BEND_HUB: hubUrl,
    BEND_ORIGIN: hubUrl,
    BEND_NO_TELEMETRY: "1",
    NO_COLOR: "1",
    TERM: "dumb",
    TMPDIR: os.tmpdir(),
  };
  const subs: [string, string][] = [[fs.realpathSync(store.lib), "$LIB"], [store.lib, "$LIB"], [hubUrl, "$HUB"],
    [fs.realpathSync(work), "$WORK"], [work, "$WORK"]];

  // Every process a cell starts runs under a memory cap on its process
  // group (see watch.ts). With several jobs, the groups together may use
  // at most 80% of the machine's memory; past that, the largest is killed.
  const memCapKb = cfg.memCapMb * 1024;
  if (!watchdog()) {
    log("no /proc: checks run without a memory cap");
  } else {
    log(`memory cap: ${cfg.memCapMb} MB per cell` + (cfg.jobs > 1 ? `, ${Math.round(memTotalKb() * 0.8 / 1024)} MB for all cells together` : ""));
    if (cfg.jobs > 1) {
      setTotalCap(Math.round(memTotalKb() * 0.8));
    }
  }

  // The lane diff builds C with clang 14 or newer, as bend -o does.
  const clang = cfg.laneDiff ? findClang(process.env) : null;
  if (cfg.laneDiff) {
    log(clang === null ? "lane diff: no clang 14 or newer, so the C lane is marked unavailable"
      : `lane diff: C lane with ${clang.cc} (clang ${clang.version}); lanes run on main and the latest release`);
  }

  // Each compiler first checks a file with no imports but Base; one that
  // cannot is marked broken rather than failing every package.
  const smoke = path.join(work, "w", "smoke.bend");
  fs.writeFileSync(smoke, "import Base\n");
  // Its fastest of three smoke checks is its startup cost, which the
  // timing flags take off every cell (main runs from source through Bun).
  for (const c of cols) {
    for (let i = 0; i < 3 && c.broken === undefined; i++) {
      const p = await exec([...c.cmd, smoke, "--check-only"], { cwd: work, env, timeoutMs: 120_000, nice: cfg.nice, memCapKb });
      if (p.code !== 0) {
        c.broken = excerpt(clean(p.err + p.out, subs), 4) || `exit ${p.code} ${p.signal ?? ""}`;
        log(`compiler ${c.id} failed its smoke check: ${c.broken}`);
      } else {
        c.base_ms = Math.min(c.base_ms ?? Infinity, p.ms);
      }
    }
  }
  const rss = cfg.rss && rssTool() !== null;
  if (cfg.rss && !rss) {
    log("no GNU /usr/bin/time: peak RSS is not recorded");
  }

  // 5. The matrix. Anonymous hashes run only on the newest release and main
  // unless --anon all.
  const rels = cols.filter((c) => c.kind === "release");
  const edge = new Set([cols.find((c) => c.kind === "main")?.id, rels[0]?.id, ...cols.filter((c) => c.kind === "local").map((c) => c.id)]);
  const rows: PkgRow[] = chosen.map((p: HubPackage) => {
    const pi = info.get(p.hash);
    return {
      hash: p.hash, name: p.name, version: p.version, ts: p.ts,
      roots: pi?.roots ?? [], mains: pi?.mains ?? [], foreign: pi?.foreign ?? false,
      deps: pi === undefined ? [] : [...pi.hashDeps, ...pi.nameDeps],
      ...(fetchErr.has(p.hash) ? { fetch: fetchErr.get(p.hash) } : {}),
    };
  });
  const results: Record<string, Record<string, Cell>> = {};
  const tasks: [PkgRow, Col][] = [];
  // Each package takes the compilers in a rotated order, so no compiler is
  // always the first to touch a package (and pay for a cold disk cache).
  rows.forEach((r, i) => {
    results[r.hash] = {};
    const k = cols.length === 0 ? 0 : i % cols.length;
    for (const c of [...cols.slice(k), ...cols.slice(0, k)]) {
      if (r.name === null && cfg.anon === "edges" && !edge.has(c.id)) {
        continue;
      }
      if (c.broken !== undefined) {
        results[r.hash][c.id] = { s: "skipped", x: "compiler failed its smoke check" };
      } else if (r.fetch !== undefined) {
        results[r.hash][c.id] = { s: "fail-fetch", x: r.fetch };
      } else {
        tasks.push([r, c]);
      }
    }
  });
  for (const r of rows) {
    if (r.fetch === undefined && r.roots.length > 0) {
      fs.writeFileSync(path.join(work, "w", r.hash + ".bend"),
        r.roots.map((f, i) => `import ${r.hash}/${f} as R${i}\n`).join(""));
    }
  }
  log(`${tasks.length} checks on ${cols.filter((c) => !c.broken).length} compilers, ${cfg.jobs} at a time`);

  // The checkpoint: the run so far, rewritten at most every 10 s, and
  // finalized into the outputs at the end, on SIGINT or SIGTERM, or when
  // the harness throws. Cells not run by then are marked skipped, with why.
  const pending = new Map<string, [string, string]>(tasks.map(([r, c]) => [r.hash + " " + c.id, [r.hash, c.id]]));
  const cp: Checkpoint = {
    draft: {
      schema: 1, started,
      hub: { url: cfg.hub, total: listed.length, named, checked: rows.length },
      compilers: cols.map(({ cmd: _cmd, ...c }) => c),
      packages: rows, results,
      runner: runnerInfo(rss), timeoutS: cfg.timeout,
      memCapMb: watchdog() ? cfg.memCapMb : 0, cellTimeoutS: cfg.cellTimeout,
    },
    t0, pending: [], total: tasks.length, pid: process.pid,
    out: { data: dataDir, page: path.resolve(ROOT, cfg.page), historyKeep: cfg.historyKeep },
  };
  const cpFile = checkpointFile(cache);
  let saved = 0;
  const save = () => {
    cp.pending = [...pending.values()];
    writeCheckpoint(cpFile, cp);
    saved = Date.now();
  };
  save();
  active = { cp, file: cpFile };
  let stopped: string | null = null;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (stopped === null) {
        stopped = `the run was stopped by ${sig}`;
        log(`${sig}: stopping the checks in flight, then writing a partial run`);
        stopAll();
      }
    });
  }

  let done = 0;
  const budgetEnd = t0 + cfg.budgetMin * 60_000;
  await pool(tasks, cfg.jobs, () => stopped !== null || Date.now() > budgetEnd, async ([r, c]) => {
    const cell = await checkOne(r, c);
    if (cell === null) {
      return;   // stopped: the cell stays pending
    }
    results[r.hash][c.id] = cell;
    pending.delete(r.hash + " " + c.id);
    done++;
    if (done % 25 === 0 || !isPass(cell.s)) {
      log(`[${done}/${tasks.length}] ${label(r)} on ${c.id}: ${cell.s} (${cell.check_ms ?? "-"} ms)`);
    }
    if (Date.now() - saved > 10_000) {
      save();
    }
  });
  fake.stop(true);
  save();
  finish(stopped ?? (pending.size > 0 ? `the run passed its ${cfg.budgetMin} min budget` : null));
  if (stopped !== null) {
    process.exit(1);
  }

  // where names the file an error points at: bend prints the line but not
  // the file, so find the package (or dependency) file with that line there.
  function where(r: PkgRow, text: string): string {
    const m = /^\s*(\d+)>\| ?(.*)$/m.exec(text);
    if (m === null) {
      return "";
    }
    const n = parseInt(m[1], 10);
    const hits: string[] = [];
    for (const h of [r.hash, ...r.deps.filter((d) => d.startsWith("0x"))]) {
      if (!store.has(h)) {
        continue;
      }
      for (const f of store.files(h).filter((f) => f.endsWith(".bend"))) {
        if (store.read(h, f).split("\n")[n - 1] === m[2]) {
          hits.push((h === r.hash ? "" : h + "/") + f + ":" + n);
        }
      }
    }
    return hits.length === 1 ? "at " + hits[0] + "\n" : "";
  }

  // oomText says how a process went over the memory cap
  function oomText(p: Proc): string {
    const peak = Math.round((peakKb(p) ?? 0) / 1024);
    return p.oom === "total"
      ? `killed after ${(p.ms / 1000).toFixed(1)} s at ${peak} MB: the cells in flight passed 80% of the machine's memory together, and this was the largest`
      : `over the ${cfg.memCapMb} MB memory cap: killed after ${(p.ms / 1000).toFixed(1)} s at ${peak} MB (sampled every 200 ms)`;
  }

  // checkOne runs every step of one cell (the check, the in-place checks,
  // the run lane) under the cell's memory cap and within one wall-clock
  // limit for the whole cell, cfg.cellTimeout: each step's own timeout is
  // cut to what is left, and a step with nothing left does not start.
  // A cell whose process was killed because the run is stopping is null.
  async function checkOne(r: PkgRow, c: Col): Promise<Cell | null> {
    if (r.roots.length === 0) {
      return { s: "fail-parse", x: "the package has no .bend file" };
    }
    const end = Date.now() + cfg.cellTimeout * 1000;
    const left = () => end - Date.now();
    const lim = (capS: number, cwd = work, withRss = false): ExecOpts =>
      ({ cwd, env, timeoutMs: Math.max(1, Math.min(capS * 1000, left())), nice: cfg.nice, memCapKb, rss: withRss && rss });
    const wall = `the cell reached its ${cfg.cellTimeout} s wall limit`;
    const wrapper = path.join(work, "w", r.hash + ".bend");
    let cell: Cell | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const capped = cfg.timeout * 1000 > left();
      const p = await exec([...c.cmd, wrapper, "--check-only"], lim(cfg.timeout, work, true));
      if (p.stopped) {
        return null;
      }
      const text = clean(p.err + "\n" + p.out, subs);
      let s: Status = classify(p, text);
      // bend asks the hub again when a path under a stored package does not
      // exist. When that package is in the store, nothing failed to fetch:
      // the compiler read an import as a path the package does not have
      // (a name@version import on a release without named imports, say).
      const asked = /a file at \$HUB\/(0x[0-9a-f]{32})\/manifest/.exec(text);
      if (s === "fail-fetch" && asked !== null && store.has(asked[1])) {
        s = "fail-parse";
      }
      const pk = peakKb(p);
      cell = {
        s, check_ms: p.ms, ...(pk !== undefined ? { rss_kb: pk } : {}),
        ...(isPass(s) ? {} : {
          x: s === "fail-oom" ? oomText(p)
            : s === "timeout" ? (capped ? `no verdict before ${wall}` : `no verdict in ${cfg.timeout} s`)
            : where(r, text) + excerpt(text),
        }),
      };
      // a crash or a fetch failure is retried once; a timeout is not, since
      // at the cap one slow package would cost the run an hour, and neither
      // is a check that went over the memory cap
      if ((s !== "crash" && s !== "fail-fetch") || left() <= 0) {
        break;
      }
    }
    const out = cell as Cell;
    const note = (msg: string) => { out.x = (out.x ? out.x + "\n" : "") + msg; };
    // A check through the wrapper reports no unsafe or foreign reliance,
    // since the wrapper defines nothing. Checking each entry file in place
    // does; if that check passes with the unsafe verdict, so is the cell.
    // (If it fails, the wrapper's verdict stands: in place, the entry sits
    // in the root namespace, which a user of the package never does.)
    if (out.s === "pass") {
      for (const f of r.roots) {
        if (left() <= 0) {
          note(`${wall}: the in-place check of ${f} did not run`);
          break;
        }
        const p = await exec([...c.cmd, path.join(store.lib, r.hash, f), "--check-only"], lim(cfg.timeout));
        if (p.stopped) {
          return null;
        }
        const text = clean(p.out, subs);
        if (p.code === 0 && classify(p, text) === "pass-unsafe") {
          out.s = "pass-unsafe";
          note((r.roots.length > 1 ? f + ": " : "") + excerpt(text, 6));
        }
      }
    }
    // The run lane: a root that defines main, in a package with no foreign
    // effects, runs once with a short timeout in an empty directory.
    if (cfg.run && isPass(out.s) && r.mains.length > 0 && !r.foreign) {
      out.run = [];
      for (const f of r.mains) {
        if (left() <= 0) {
          out.run.push({ f, s: "timeout", ms: 0, x: `not run: ${wall}` });
          continue;
        }
        const cwd = fs.mkdtempSync(path.join(work, "run-"));
        const p = await exec([...c.cmd, path.join(store.lib, r.hash, f)], lim(cfg.runTimeout, cwd));
        if (p.stopped) {
          fs.rmSync(cwd, { recursive: true, force: true });
          return null;
        }
        const text = clean(p.err + "\n" + p.out, subs);
        const ro: RunOutcome = { f, s: p.oom ? "oom" : p.timedOut ? "timeout" : p.code === 0 ? "ok" : "fail", ms: p.ms };
        if (ro.s !== "ok") {
          ro.x = ro.s === "oom" ? oomText(p) : ro.s === "timeout" ? `main ran past ${Math.round(p.ms / 1000)} s` : excerpt(text, 5);
        }
        fs.rmSync(cwd, { recursive: true, force: true });
        if (ro.s === "ok" && cfg.laneDiff && edge.has(c.id)) {
          const ls = await lanes(c, path.join(store.lib, r.hash, f), p, lim);
          if (ls === null) {
            return null;
          }
          ro.lanes = ls;
        }
        out.run.push(ro);
      }
    }
    return out;
  }

  // lanes builds main for the C lane and the JS lane, each in a fresh
  // directory (so what the reference run or another lane wrote there cannot
  // change it), runs it, and compares its stdout with the reference's (see
  // lanes.ts). Every step is under the cell's memory cap and deadline: the
  // builds under the check's timeout, the runs under the run's. When a lane
  // printed something else, the reference runs once more, to tell a
  // disagreement from a program whose output varies. null: the run stopped.
  async function lanes(c: Col, file: string, io: Proc, lim: (capS: number, cwd?: string) => ExecOpts): Promise<Record<string, Lane> | null> {
    const got: Record<string, Lane> = {};
    for (const lane of LANES) {
      if (lane === "c" && clang === null) {
        got[lane] = { s: "unavailable", x: "no clang 14 or newer to build the C (gcc cannot)" };
        continue;
      }
      const dir = fs.mkdtempSync(path.join(work, "lane-"));
      try {
        const emit = await exec([...c.cmd, file, "-o", lane === "c" ? "m.c" : "m.js"], lim(cfg.timeout, dir));
        if (emit.stopped) {
          return null;
        }
        if (emit.code !== 0 || emit.timedOut || emit.oom) {
          got[lane] = failed("build", emit, clean(emit.err + "\n" + emit.out, subs));
          continue;
        }
        if (lane === "c") {
          const argv = cBuild((clang as { cc: string }).cc, fs.readFileSync(path.join(dir, "m.c"), "utf8"));
          if (typeof argv === "string") {
            got[lane] = { s: "unavailable", x: argv };
            continue;
          }
          const cc = await exec(argv, lim(cfg.timeout, dir));
          if (cc.stopped) {
            return null;
          }
          if (cc.code !== 0 || cc.timedOut || cc.oom) {
            got[lane] = failed("build", cc, clean(cc.err + "\n" + cc.out, subs));
            continue;
          }
        }
        // the C binary runs on the CPU only, whatever the machine has
        const run = await exec(lane === "c" ? ["./m", "--gpu", "off"] : [process.execPath, "m.js"], lim(cfg.runTimeout, dir));
        if (run.stopped) {
          return null;
        }
        got[lane] = run.code !== 0 || run.timedOut || run.oom
          ? failed("run", run, clean(run.err + "\n" + run.out, subs))
          : { ...compare(io, run), ms: run.ms };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    if (Object.values(got).some((l) => l.s === "differs")) {
      const dir = fs.mkdtempSync(path.join(work, "run-"));
      const again = await exec([...c.cmd, file], lim(cfg.runTimeout, dir));
      fs.rmSync(dir, { recursive: true, force: true });
      if (again.stopped) {
        return null;
      }
      return settle(got, io.out, again.code === 0 && !again.timedOut && !again.oom ? again.out : null);
    }
    return got;
  }
}

main().catch((e) => {
  log(String(e?.stack ?? e));
  try {
    finish("the harness failed: " + String(e?.message ?? e).split("\n")[0]);
  } catch (e2) {
    log("could not write a partial run: " + String(e2));
  }
  process.exit(1);
});
