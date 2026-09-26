// What a stored package is made of: its import graph, its entry files and
// the hub packages it depends on.
//
// The hub records no entry file. `bend --publish` uploads exactly the files
// the loader reached from the file it was given, so that entry is the .bend
// file no other file of the package imports. A package with several such
// roots (rare) has all of them checked. Import lines are read the way bend's
// loader reads them: blank and # lines skipped, and the first line that is
// not an import ends the header.

import * as path from "node:path";
import type { Store } from "./hub";

const IMPORT = /^import\s+(\S+)(?:\s+as\s+([A-Za-z_]\w*))?\s*(?:#.*)?$/;

export interface PkgInfo {
  bend: string[];          // .bend files
  roots: string[];         // entry files, checked through a hash import
  mains: string[];         // roots that define main
  foreign: boolean;        // carries .c or .js effect files
  hashDeps: string[];      // 0x<hash> packages imported
  nameDeps: string[];      // name@version packages imported
}

export function imports(src: string): string[] {
  const out: string[] = [];
  for (const raw of src.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    if (!/^import(\s|$)/.test(line)) {
      break;
    }
    const m = IMPORT.exec(line);
    if (m !== null && m[1] !== "Base") {
      out.push(m[1]);
    }
  }
  return out;
}

export function inspect(store: Store, hash: string): PkgInfo {
  const files = store.files(hash);
  const bend = files.filter((f) => f.endsWith(".bend"));
  const internal = new Set<string>();
  const hashDeps = new Set<string>();
  const nameDeps = new Set<string>();
  for (const f of bend) {
    for (const imp of imports(store.read(hash, f))) {
      const hx = /^(0x[0-9a-f]+)\//.exec(imp);
      const nv = /^([^/]*@[^/]*)\//.exec(imp);
      if (hx !== null) {
        if (hx[1] === hash) {
          internal.add(imp.slice(hx[1].length + 1));
        } else {
          hashDeps.add(hx[1]);
        }
      } else if (nv !== null) {
        nameDeps.add(nv[1]);
      } else {
        internal.add(path.posix.normalize(path.posix.join(path.posix.dirname(f), imp)));
      }
    }
  }
  let roots = bend.filter((f) => !internal.has(f));
  if (roots.length === 0) {
    roots = bend.slice();
  }
  const mains = roots.filter((f) => /^def\s+main\s*\(/m.test(store.read(hash, f)));
  return {
    bend,
    roots,
    mains,
    foreign: files.some((f) => f.endsWith(".c") || f.endsWith(".js")),
    hashDeps: [...hashDeps].sort(),
    nameDeps: [...nameDeps].sort(),
  };
}
