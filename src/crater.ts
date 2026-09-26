// bend-crater: check every BendHub package against a set of Bend compilers
// and write the results, the regressions and the matrix page.
//
//   bun src/crater.ts [--releases N] [--no-main] [--bend PATH]... [--only RE]
//                     [--anon edges|all|none] [--jobs N] [--timeout S]
//                     [--run-timeout S] [--no-run] [--no-nice] [--dry]
//                     [--cache DIR] [--data DIR] [--page FILE]
//                     [--releases-json FILE]
//
// Defaults come from crater.json. See README.md.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ensureMain, ensureRelease, listReleases, localCompiler, pruneReleases, type Compiler } from "./compilers";
import { listPackages, Store, type HubPackage } from "./hub";
import { renderPage } from "./page";
import { inspect, type PkgInfo } from "./pkg";
import {
  brokeIn, historyEntry, label, regressions,
  type Cell, type HistoryEntry, type PkgRow, type Results, type RunOutcome,
} from "./report";
import { classify, clean, exec, excerpt, isPass, type Status } from "./run";
import { log, readJson, ROOT, writeJson } from "./util";

type Col = Compiler & { broken?: string };

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
  nice: boolean;
  cache: string;
  data: string;
  page: string;
  historyKeep: number;
  releasesJson: string | null;
  dry: boolean;
}

function config(argv: string[]): Config {
  const file = readJson<Partial<Config>>(path.join(ROOT, "crater.json"), {});
  const c: Config = {
    hub: "https://hub.bend-lang.com", releases: 6, main: true, mainRef: "main", bend: [], only: null,
    anon: "edges", jobs: 1, timeout: 120, runTimeout: 20, run: true, nice: !process.env.CI,
    cache: "cache", data: "data", page: "docs/index.html", historyKeep: 90, releasesJson: null, dry: false, ...file,
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

// pool runs tasks with at most n in flight
async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}

async function main(): Promise<void> {
  const cfg = config(process.argv.slice(2));
  const t0 = Date.now();
  const started = new Date().toISOString();
  const cache = path.resolve(ROOT, cfg.cache);
  const dataDir = path.resolve(ROOT, cfg.data);
  const store = new Store(path.join(cache, "lib"), cfg.hub);

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

  // Each compiler first checks a file with no imports but Base; one that
  // cannot is marked broken rather than failing every package.
  const smoke = path.join(work, "w", "smoke.bend");
  fs.writeFileSync(smoke, "import Base\n");
  for (const c of cols) {
    const p = await exec([...c.cmd, smoke, "--check-only"], { cwd: work, env, timeoutMs: cfg.timeout * 1000, nice: cfg.nice });
    if (p.code !== 0) {
      c.broken = excerpt(clean(p.err + p.out, subs), 4) || `exit ${p.code} ${p.signal ?? ""}`;
      log(`compiler ${c.id} failed its smoke check: ${c.broken}`);
    }
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
  for (const r of rows) {
    results[r.hash] = {};
    for (const c of cols) {
      if (r.name === null && cfg.anon === "edges" && !edge.has(c.id)) {
        continue;
      }
      if (c.broken !== undefined) {
        results[r.hash][c.id] = { s: "skipped", ms: 0, x: "compiler failed its smoke check" };
      } else if (r.fetch !== undefined) {
        results[r.hash][c.id] = { s: "fail-fetch", ms: 0, x: r.fetch };
      } else {
        tasks.push([r, c]);
      }
    }
  }
  for (const r of rows) {
    if (r.fetch === undefined && r.roots.length > 0) {
      fs.writeFileSync(path.join(work, "w", r.hash + ".bend"),
        r.roots.map((f, i) => `import ${r.hash}/${f} as R${i}\n`).join(""));
    }
  }
  log(`${tasks.length} checks on ${cols.filter((c) => !c.broken).length} compilers, ${cfg.jobs} at a time`);
  let done = 0;
  await pool(tasks, cfg.jobs, async ([r, c]) => {
    const cell = await checkOne(r, c);
    results[r.hash][c.id] = cell;
    done++;
    if (done % 25 === 0 || !isPass(cell.s)) {
      log(`[${done}/${tasks.length}] ${label(r)} on ${c.id}: ${cell.s} (${cell.ms} ms)`);
    }
  });
  fake.stop(true);

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

  async function checkOne(r: PkgRow, c: Col): Promise<Cell> {
    if (r.roots.length === 0) {
      return { s: "fail-parse", ms: 0, x: "the package has no .bend file" };
    }
    const wrapper = path.join(work, "w", r.hash + ".bend");
    let cell: Cell | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const p = await exec([...c.cmd, wrapper, "--check-only"], { cwd: work, env, timeoutMs: cfg.timeout * 1000, nice: cfg.nice });
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
      cell = { s, ms: p.ms, ...(isPass(s) ? {} : { x: s === "timeout" ? `no verdict in ${cfg.timeout} s` : where(r, text) + excerpt(text) }) };
      if (s !== "timeout" && s !== "crash" && s !== "fail-fetch") {
        break;
      }
    }
    const out = cell as Cell;
    // A check through the wrapper reports no unsafe or foreign reliance,
    // since the wrapper defines nothing. Checking each entry file in place
    // does; if that check passes with the unsafe verdict, so is the cell.
    // (If it fails, the wrapper's verdict stands: in place, the entry sits
    // in the root namespace, which a user of the package never does.)
    if (out.s === "pass") {
      for (const f of r.roots) {
        const p = await exec([...c.cmd, path.join(store.lib, r.hash, f), "--check-only"], { cwd: work, env, timeoutMs: cfg.timeout * 1000, nice: cfg.nice });
        const text = clean(p.out, subs);
        if (p.code === 0 && classify(p, text) === "pass-unsafe") {
          out.s = "pass-unsafe";
          out.x = (out.x ? out.x + "\n" : "") + (r.roots.length > 1 ? f + ": " : "") + excerpt(text, 6);
        }
      }
    }
    // The run lane: a root that defines main, in a package with no foreign
    // effects, runs once with a short timeout in an empty directory.
    if (cfg.run && isPass(out.s) && r.mains.length > 0 && !r.foreign) {
      out.run = [];
      for (const f of r.mains) {
        const cwd = fs.mkdtempSync(path.join(work, "run-"));
        const p = await exec([...c.cmd, path.join(store.lib, r.hash, f)], { cwd, env, timeoutMs: cfg.runTimeout * 1000, nice: cfg.nice });
        fs.rmSync(cwd, { recursive: true, force: true });
        const text = clean(p.err + "\n" + p.out, subs);
        const ro: RunOutcome = { f, s: p.timedOut ? "timeout" : p.code === 0 ? "ok" : "fail", ms: p.ms };
        if (ro.s !== "ok") {
          ro.x = ro.s === "timeout" ? `main ran past ${cfg.runTimeout} s` : excerpt(text, 5);
        }
        out.run.push(ro);
      }
    }
    return out;
  }

  // 6. Results, regressions, history, page.
  const resultsFile = path.join(dataDir, "results.json");
  const prev = readJson<Results | null>(resultsFile, null);
  const res: Results = {
    schema: 1, started, finished: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    hub: { url: cfg.hub, total: listed.length, named, checked: rows.length },
    compilers: cols.map(({ cmd: _cmd, ...c }) => c),
    packages: rows, results, regressions: [], brokeIn: {},
  };
  res.brokeIn = brokeIn(res);
  res.regressions = regressions(res, prev !== null && prev.schema === 1 ? prev : null);
  writeJson(resultsFile, res);
  const histFile = path.join(dataDir, "history.json");
  const hist = readJson<HistoryEntry[]>(histFile, []);
  hist.push(historyEntry(res));
  writeJson(histFile, hist.slice(-cfg.historyKeep));
  const page = path.resolve(ROOT, cfg.page);
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(page, renderPage(res, hist.slice(-cfg.historyKeep)));
  log(`wrote ${path.relative(ROOT, resultsFile)}, ${path.relative(ROOT, histFile)}, ${path.relative(ROOT, page)} in ${res.seconds} s`);
  log(`${res.regressions.length} regressions`);
}

main().catch((e) => {
  log(String(e?.stack ?? e));
  process.exit(1);
});
