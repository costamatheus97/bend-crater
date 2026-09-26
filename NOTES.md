# Design notes

These are working notes on how the harness is built and why. Users should
read the README instead.

## Hub API (as of 2026-09-26)

- `GET /packages.json?sort=new&limit=100&after=N`: `{ total, packages: [...] }`.
  The page size is capped at 100, and `after` is an offset, which is how
  `hub.js` pages it. Each entry has `hash`, `name`, `version`, `ts`,
  `files` (path → bytes), `bytes`, `desc`, `dependents` and `license`.
  Each named version appears once, on its hash.
- `GET /0x<hash>/manifest` lists `<sha256> <path>` lines. The package hash is
  the first 32 hex digits of the manifest's sha256.
- `GET /0x<hash>/<path>` returns the raw file.
- `GET /name/<name>@<version>` returns `0x<hash>`, or 410 if the name was
  taken down.
- None of these need a login. Only publish, link and register do.

## Offline checks

- Compilers get a hub URL on 127.0.0.1 that answers 404 to everything.
  Pointing them at a closed port (`127.0.0.1:9`) hung Bun's fetch for
  minutes on WSL, while a local 404 fails in milliseconds.
- `HOME` is a sandbox whose `.bend/lib` is a symlink to the store, and
  `BEND_LIB` is set as well, so a release that reads either finds it.
- `BEND_NO_TELEMETRY=1` stops the daily version ping.
- `main` runs as `bun bend2/main.ts` with its cwd in the work directory. Run
  from a checkout, Bun reads any `bunfig.toml` or `.env` in the cwd, and the
  work directory has neither.

## Classification

- Exit 0 counts as a pass. "unsafe or foreign" (2.0.x) or "unsafe
  annotation" (older) in the verdict makes it `pass-unsafe`.
- The wrapper defines nothing, so its verdict never lists unsafe or foreign
  reliance, since the verdict walks from the checked file's own defs. After
  a wrapper pass, each entry is therefore checked in place
  (`bend $LIB/0x<hash>/<entry> --check-only`), and that verdict decides
  between `ok` and `ok*`. A failure of the in-place check is ignored,
  because in place the entry sits in the root namespace, which no user of
  the package does.
- `err_show` prints `Location:<def>`. A parse or load error carries no def
  and no `Context:`, while a check error names its def. That is the only
  structural difference, so it decides `parse` against `check`.
- `fetch` is a "a file at … hashing to", "a package named … on" or
  "no such file: $LIB/" error.
- One exception is when the package bend asks for is already in the store.
  bend re-asks the hub when a path under a stored package is missing, so
  the real cause is an unresolvable import (for example, `name@version` on
  2.0.24–2.0.25, which reads it as a path). Those cases count as `parse`.
- Hub packages with a UTF-8 BOM: bend's `res.text()` drops the BOM before
  hashing, so the hash no longer matches and bend can't fetch them.
  `hub.ts` mirrors this, and the error message says so. One anonymous hash
  hit this on 2026-09-26.
- The error shows the line but not the file. `where()` finds the one
  package or dependency file whose line N matches and prefixes the excerpt
  with `at <file>:N`.

## Regressions

- Cells are keyed by compiler id: the version for releases, `main` for main.
  "Since last run" therefore compares a release with itself (which catches
  harness or hub changes) and `main` with the previous `main`.
- "New release" fires only when the latest release differs from the
  previous run's latest.
- `brokeIn` is computed within one run, across the release window.

## CI

- The crater job has `contents: read`, and checkout keeps no credentials.
  The GitHub token is used in one step, which only lists releases into
  `cache/releases.json`.
- Commit and Pages run in separate jobs with their own permissions.
- Cache keys:
  - the hub store: `hub-lib-<run_id>`, restored by prefix, so it
    accumulates;
  - releases: keyed by a hash of the release set.
- CI commits as the repo owner's noreply address. No bot identity, no
  trailers.

## Ideas not done yet

- Run packages' laws and tests more fully. Tests are rarely published, so
  this needs each package's source repo, found from `desc` links.
- Lane checks: build with `-o x.c` and `-o x.js`, then run both and compare
  outputs (differential).
- A per-package badge (an SVG or a shields endpoint JSON).
- A "first compiler it checks on" column, for packages that never passed in
  the window.
