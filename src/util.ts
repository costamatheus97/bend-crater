// Small shared helpers: paths, the User-Agent, hashing, a polite fetch.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const ROOT = path.resolve(import.meta.dir, "..");
export const UA = "bend-crater (+https://github.com/costamatheus97/bend-crater)";

export function sha256(text: string | Uint8Array): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function log(msg: string): void {
  process.stderr.write(msg + "\n");
}

// get fetches a URL with our User-Agent and retries a few times on network
// errors and 5xx answers, backing off between tries. It never retries a 4xx.
export async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  let last: unknown = null;
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA, ...headers }, signal: AbortSignal.timeout(60_000) });
      if (res.status < 500) {
        return res;
      }
      last = new Error(url + " answered " + res.status);
    } catch (e) {
      last = e;
    }
    await sleep(1000 * 2 ** i);
  }
  throw last;
}

export function readJson<T>(file: string, dflt: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return dflt;
  }
}

export function writeJson(file: string, value: unknown, pretty = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, pretty ? 1 : undefined) + "\n");
}
