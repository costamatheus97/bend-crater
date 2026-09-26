// BendHub client: lists packages, and fetches a package's files by hash into
// a local store laid out as bend's own BEND_LIB (0x<hash>/<path>, and
// names/<name>@<version> holding the hash). Fetching needs no login.
//
// Endpoints (read from bend2/bend.ts and hub.bend-lang.com/hub.js):
//   GET /packages.json?sort=new&limit=100&after=N   one page of the list
//   GET /0x<hash>/manifest                           "<sha256> <path>" lines
//   GET /0x<hash>/<path>                             one file
//   GET /name/<name>@<version>                       the hash a name points at
//
// A package's hash is the first 32 hex digits of the manifest's sha256, and
// each file's sha256 is its manifest line; both are checked here exactly as
// bend's hub_get checks them, so the store holds only verified bytes. A
// package directory appears in the store in one rename, so a directory that
// exists is complete. Requests go one at a time with a short pause.

import * as fs from "node:fs";
import * as path from "node:path";
import { get, log, sha256, sleep } from "./util";

export interface HubPackage {
  hash: string;
  name: string | null;
  version: string | null;
  ts: number;
  files: Record<string, number>;
  bytes: number;
  desc?: string;
  dependents?: number;
  license?: string | null;
}

const PAUSE_MS = 150;
const HASH = /^0x[0-9a-f]{32}$/;
const NAMED = /^[a-z][a-z0-9-]{0,63}@(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*)){3}$/;

export async function listPackages(hub: string): Promise<HubPackage[]> {
  const out: HubPackage[] = [];
  const seen = new Set<string>();
  for (let after = 0; ; after += 100) {
    const res = await get(hub + "/packages.json?sort=new&limit=100&after=" + after);
    if (!res.ok) {
      throw new Error("the hub's package list answered " + res.status);
    }
    const page = (await res.json()) as { total: number; packages: HubPackage[] };
    for (const p of page.packages) {
      if (HASH.test(p.hash) && !seen.has(p.hash)) {
        seen.add(p.hash);
        out.push(p);
      }
    }
    if (page.packages.length === 0 || after + 100 >= page.total) {
      if (out.length < page.total) {
        log(`warning: the hub reports ${page.total} packages, listed ${out.length}`);
      }
      return out;
    }
    await sleep(PAUSE_MS);
  }
}

// safePath is a manifest path that stays inside its package directory.
function safePath(p: string): boolean {
  return p.length > 0 && !p.startsWith("/") && path.posix.normalize(p) === p
    && !p.split("/").some((s) => s === ".." || s === "." || s === "");
}

export class Store {
  fetched = 0;
  constructor(readonly lib: string, readonly hub: string) {
    fs.mkdirSync(path.join(lib, "names"), { recursive: true });
  }

  has(hash: string): boolean {
    return fs.existsSync(path.join(this.lib, hash));
  }

  // verify re-hashes every stored package the way --publish hashes it (the
  // sorted "<sha256> <path>" lines, then the first 32 hex digits of their
  // sha256) and drops any that no longer match, so a store restored from a
  // cache that code under test could have touched is refetched, not trusted.
  verify(): number {
    let bad = 0;
    for (const h of fs.readdirSync(this.lib)) {
      const dir = path.join(this.lib, h);
      if (h.startsWith(".tmp-")) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (!HASH.test(h)) {
        continue;
      }
      const man = this.files(h).map((p) => sha256(this.read(h, p)) + " " + p + "\n").join("");
      if (!sha256(man).startsWith(h.slice(2))) {
        fs.rmSync(dir, { recursive: true, force: true });
        bad++;
      }
    }
    return bad;
  }

  // ensure puts a package in the store, fetching it once; it answers null on
  // success, or why the package could not be fetched.
  async ensure(hash: string): Promise<string | null> {
    if (!HASH.test(hash)) {
      return "not a package hash: " + hash;
    }
    if (this.has(hash)) {
      return null;
    }
    const base = this.hub + "/" + hash;
    const mres = await get(base + "/manifest");
    if (!mres.ok) {
      return `GET ${base}/manifest answered ${mres.status}`;
    }
    const man = await mres.text();
    if (!sha256(man).startsWith(hash.slice(2))) {
      return `the manifest of ${hash} does not hash to it`;
    }
    const lines = man.trim().split("\n").map((l) => l.split(" "));
    const tmp = path.join(this.lib, ".tmp-" + hash);
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [sum, p] of lines) {
      if (!/^[0-9a-f]{64}$/.test(sum ?? "") || !safePath(p ?? "")) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return `the manifest of ${hash} has a bad line: ${sum} ${p}`;
      }
      await sleep(PAUSE_MS);
      const res = await get(base + "/" + p);
      const raw = res.ok ? new Uint8Array(await res.arrayBuffer()) : new Uint8Array();
      // bend reads a hub file with res.text(), which decodes UTF-8 and drops
      // a leading byte-order mark, then hashes that; do the same, so a
      // package bend cannot fetch is not fetched here either.
      const src = new TextDecoder().decode(raw);
      if (!res.ok || sha256(src) !== sum) {
        fs.rmSync(tmp, { recursive: true, force: true });
        return `GET ${base}/${p} ${!res.ok ? "answered " + res.status
          : sha256(raw) === sum ? "matches its manifest hash only as raw bytes: bend reads it as text, which drops its UTF-8 byte-order mark, so bend cannot fetch this package"
          : "does not match its manifest hash"}`;
      }
      const at = path.join(tmp, p);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.writeFileSync(at, src);
    }
    fs.renameSync(tmp, path.join(this.lib, hash));
    this.fetched++;
    return null;
  }

  // name records what a name@version points at, as bend's own cache does
  setName(nv: string, hash: string): void {
    if (NAMED.test(nv) && HASH.test(hash)) {
      fs.writeFileSync(path.join(this.lib, "names", nv), hash + "\n");
    }
  }

  getName(nv: string): string | null {
    try {
      const h = fs.readFileSync(path.join(this.lib, "names", nv), "utf8").trim();
      return HASH.test(h) ? h : null;
    } catch {
      return null;
    }
  }

  // resolve answers the hash a name@version points at, asking the hub on a
  // miss (a name taken down answers 410).
  async resolve(nv: string): Promise<string | null> {
    if (!NAMED.test(nv)) {
      return null;
    }
    const old = this.getName(nv);
    if (old !== null) {
      return old;
    }
    await sleep(PAUSE_MS);
    const res = await get(this.hub + "/name/" + nv);
    const got = res.ok ? (await res.text()).trim() : "";
    if (!HASH.test(got)) {
      return null;
    }
    this.setName(nv, got);
    return got;
  }

  // files lists a stored package's files, relative to its directory
  files(hash: string): string[] {
    const dir = path.join(this.lib, hash);
    const out: string[] = [];
    const walk = (d: string, pre: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = pre === "" ? e.name : pre + "/" + e.name;
        if (e.isDirectory()) {
          walk(path.join(d, e.name), rel);
        } else {
          out.push(rel);
        }
      }
    };
    walk(dir, "");
    return out.sort();
  }

  read(hash: string, rel: string): string {
    return fs.readFileSync(path.join(this.lib, hash, rel), "utf8");
  }
}
