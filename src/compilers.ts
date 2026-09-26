// The compilers a run checks against: the last N GitHub releases of
// bendlang/bend (release tarballs, unpacked once into the cache), `main`
// (a fresh shallow clone each run, run from source with Bun), and any local
// `bend` binary given on the command line.

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { get, log, sha256 } from "./util";

export const UPSTREAM = "bendlang/bend";

export interface Compiler {
  id: string;              // "2.0.29", "main", "local"
  kind: "release" | "main" | "local";
  version: string;         // what the compiler calls itself
  sha?: string;            // main's commit
  date?: string;           // release date, or main's commit date
  cmd: string[];           // argv prefix: cmd + [file, ...flags]
}

interface GhRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  published_at: string;
  assets: { name: string; browser_download_url: string; digest?: string | null }[];
}

const semver = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
export function cmpVersion(a: string, b: string): number {
  const x = semver(a), y = semver(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) {
      return (x[i] ?? 0) - (y[i] ?? 0);
    }
  }
  return 0;
}

function platform(): string {
  const o = process.platform === "darwin" ? "darwin" : "linux";
  const a = os.arch() === "arm64" ? "arm64" : "x64";
  return o + "-" + a;
}

function ghHeaders(): Record<string, string> {
  const tok = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return { accept: "application/vnd.github+json", ...(tok ? { authorization: "Bearer " + tok } : {}) };
}

// releases answers the newest `count` stable 2.x releases, newest first
// (from a saved copy of GitHub's release list when one is given, so CI can
// fetch it with a token in a step that runs nothing else).
export async function listReleases(count: number, saved?: string): Promise<GhRelease[]> {
  let list: GhRelease[];
  if (saved) {
    list = JSON.parse(fs.readFileSync(saved, "utf8")) as GhRelease[];
  } else {
    const res = await get(`https://api.github.com/repos/${UPSTREAM}/releases?per_page=100`, ghHeaders());
    if (!res.ok) {
      throw new Error("GitHub's release list answered " + res.status);
    }
    list = (await res.json()) as GhRelease[];
  }
  const all = list
    .filter((r) => !r.draft && !r.prerelease && /^v2\.\d+\.\d+$/.test(r.tag_name))
    .sort((a, b) => cmpVersion(b.tag_name, a.tag_name));
  return all.slice(0, count);
}

export async function ensureRelease(cache: string, rel: GhRelease): Promise<Compiler> {
  const ver = rel.tag_name.slice(1);
  const dir = path.join(cache, "releases", ver);
  const bin = path.join(dir, "bend", "bin", "bend");
  if (!fs.existsSync(bin)) {
    const name = `bend-${ver}-${platform()}.tar.gz`;
    const asset = rel.assets.find((a) => a.name === name);
    if (asset === undefined) {
      throw new Error(`release ${rel.tag_name} has no ${name}`);
    }
    log(`downloading ${asset.browser_download_url}`);
    const res = await get(asset.browser_download_url);
    if (!res.ok) {
      throw new Error(`${asset.browser_download_url} answered ${res.status}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const want = asset.digest?.startsWith("sha256:") ? asset.digest.slice(7) : null;
    if (want !== null && sha256(buf) !== want) {
      throw new Error(`${name} does not match GitHub's sha256 for it`);
    }
    const tmp = dir + ".tmp";
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, name), buf);
    execFileSync("tar", ["-xzf", name], { cwd: tmp, stdio: ["ignore", "ignore", "ignore"] });
    fs.rmSync(path.join(tmp, name));
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  }
  return { id: ver, kind: "release", version: ver, date: rel.published_at, cmd: [bin] };
}

// pruneReleases drops unpacked releases no longer in the window
export function pruneReleases(cache: string, keep: string[]): void {
  const dir = path.join(cache, "releases");
  if (!fs.existsSync(dir)) {
    return;
  }
  for (const v of fs.readdirSync(dir)) {
    if (!keep.includes(v)) {
      fs.rmSync(path.join(dir, v), { recursive: true, force: true });
    }
  }
}

export function ensureMain(cache: string, ref = "main"): Compiler {
  const dir = path.join(cache, "main");
  fs.rmSync(dir, { recursive: true, force: true });
  log(`cloning ${UPSTREAM}@${ref}`);
  execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", ref,
    `https://github.com/${UPSTREAM}.git`, dir], { stdio: ["ignore", "ignore", "inherit"] });
  const git = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" }).trim();
  const src = fs.readFileSync(path.join(dir, "bend2", "main.ts"), "utf8");
  const ver = /const VERSION\s*=\s*"([^"]+)"/.exec(src)?.[1] ?? "?";
  const bun = process.execPath;
  return { id: "main", kind: "main", version: ver, sha: git("rev-parse", "HEAD"),
    date: git("log", "-1", "--format=%cI"), cmd: [bun, path.join(dir, "bend2", "main.ts")] };
}

export function localCompiler(bin: string): Compiler {
  const out = execFileSync(bin, ["version"], { encoding: "utf8", env: { ...process.env, BEND_NO_TELEMETRY: "1" } });
  const ver = /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? "?";
  return { id: "local-" + ver, kind: "local", version: ver, cmd: [path.resolve(bin)] };
}
