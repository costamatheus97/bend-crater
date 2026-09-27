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

## Memory and time limits

- The scheduled run of 2026-09-27 died at cell 571 of 992. Anonymous hash
  `0xce7bfa94c40ded8493cdb39d330add0c` (published 2026-09-26 18:44 UTC)
  has a `PROOF.bend` that closes its laws with `{==}`, and checking it
  grows without bound, at about 450 MB/s, on every release from 2.0.26 to
  2.0.31 and on `main`. The runner had 16 GB. When it ran out, GitHub sent
  the runner a shutdown signal: the step ended with exit 143, and every
  later step was skipped, including the `if: always()` ones.
- `watch.ts` samples `/proc/<pid>/stat` every 200 ms and adds up the RSS of
  each watched group: its process group, its session, and any descendant
  by parent pid. At 450 MB/s, a group overshoots its cap by about 100 MB
  before it is killed.
- An address-space limit is no use here. Bun reserves about 6.5 GB of
  virtual memory at start, and a Bend native binary reserves about 109 GB.
- With `--jobs` above 1, the groups together may use at most 80% of
  `MemTotal`. Past that, the largest group is killed and recorded as `oom`.
- A cell's steps (the check and its retry, the in-place checks, the run
  lane) share one wall-clock limit, `--cell-timeout`. Each step's timeout
  is cut to what is left of it.

## Lane diff

- The reference is the run lane, `bend file.bend`. For an IO `main`, bend
  compiles to JS and runs it in-process (`Comp.io_run`, a `new Function`
  over the emitted JS), so the JS lane shares that emitter. The C lane is
  the independent check for IO programs. For a value `main`, the
  reference is the interpreter (`term_snf`).
- The C lane needs clang: Bend's C uses `__attribute__((musttail))`, which
  gcc rejects. The C compiler is picked as `bend -o` picks it (`$CC`, then
  `clang`, then `clang-NN`, newest first, 14 or newer). The build is
  `-std=c11 -O3 -lpthread -lm`, with no `-DBEND_CUDA` or `-DBEND_METAL`, so
  it is a CPU build, and the binary runs with `--gpu off`. Window and audio
  programs (X11 or ALSA includes) are not built. ubuntu-24.04 has clang
  18.1.3 as `clang`. Locally without clang, `zig cc` (clang 21, from the
  `ziglang` wheel) works as `CC`.
- Each lane builds and runs in its own `mkdtemp` directory. The first
  version reused the run lane's directory, so a `main` that wrote a
  `bunfig.toml` or `.env` there would have changed how the JS lane ran.
- Output is cut at exactly 64 KiB on every lane, so long outputs compare
  their first 64 KiB. The old cap appended whole chunks, which cut each
  process at a different point.
- A disagreement triggers a second reference run. If that differs too, the
  lane is `nondet` (the program's output varies) and is not flagged.
- Lanes run only on `main` and the latest release, to keep within the
  budget.

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
- The run lane executes hub code, so the crater job's artifact contains
  exactly `data/results.json`, `data/history.json`, `data/timings.json` and
  `docs/index.html`,
  and the publish job refuses any other change.
- The restored hub store is re-hashed on every start (about 0.3 s), and any
  package that no longer matches is refetched.
- Partial runs. A killed or cancelled crater step still publishes what it
  ran:
  - `crater.ts` keeps `cache/checkpoint.json` (rewritten at most every
    10 s, in one rename). On SIGINT or SIGTERM (a cancel, or the step's
    `timeout-minutes`), it kills the process groups in flight, marks the
    cells not run as `skipped` with the reason, and finalizes. It does the
    same when the harness throws, or when the budget runs out.
  - If the process is killed outright, the `if: failure() || cancelled()`
    step runs `src/finalize.ts`, which finalizes the checkpoint it left. It
    does nothing when the checkpoint was finalized already.
  - On a cancel, the runner signals the step's shell only. In the first
    cancel test (run 36318734909), bun went on checking for about 50 s,
    was still running when the fallback finalized, and was killed as an
    orphan at job cleanup. The step now `exec`s the crater, so the shell's
    pid is bun's, and `finalize.ts` first stops a crater still running, by
    the pid its checkpoint records and only while that pid's command line
    is a crater run. It sends SIGTERM (the crater then finalizes itself),
    and SIGKILL after 8 s.
  - The artifact is uploaded only when the checkpoint was finalized, so a
    run that died before its checks uploads nothing.
  - `publish` runs on `always()`, and `deploy` on `always()` plus publish's
    `ok`: with a plain `needs:`, a failed crater job skips them both.
    Publish runs `src/validate.ts` from its own checkout. That refuses
    outputs that do not parse, a run no newer than the committed one (when
    the download failed, the files on disk are the committed ones), and a
    run in which fewer than 2% of cells ran. It then renders the page again
    from the checked data, so the served HTML never comes from the job
    that ran hub code.
- None of that helps when the runner itself dies. On 2026-09-27 the runner
  ran out of memory, GitHub shut it down, and every later step was skipped,
  `if: always()` included. So the crater step runs under
  `scripts/scoped.sh`: a transient systemd scope capped at 85% of the
  runner's memory, so the kernel kills inside the scope instead. It tries a
  user scope, then a system scope through passwordless sudo that drops back
  to the runner user, and otherwise runs without one. The per-cell
  watchdog (4 GB) should keep the scope's cap from ever being reached.
- Time budget: the crater stops starting cells after `budgetMin` (300 min
  from its start), and a started cell ends within `cellTimeout` (15 min),
  so the crater is done by about 315 min. The step's `timeout-minutes` is
  325 and the job's is 340, which leaves time to finalize, save the caches
  and upload. The run of 2026-09-27 12:30 UTC (run 36319206708) checked
  1012 cells in 1491 s (25 min). About 11 to 12 min of that is the lane
  diff: 22 runnable programs on two compilers, at 12 to 15 s each for the
  two emits, clang -O3 and the runs. That is estimated from the log's gaps,
  since builds are not timed separately.
- A `workflow_dispatch` with `only` set is a test run: it runs the checks
  and uploads the artifact, and publishes nothing.
- Cache keys:
  - the hub store: `hub-lib-<run_id>`, restored by prefix, so it
    accumulates;
  - releases: keyed by a hash of the release set.
- CI commits as the repo owner's noreply address. No bot identity, no
  trailers.

## Ideas not done yet

- Run packages' laws and tests more fully. Tests are rarely published, so
  this needs each package's source repo, found from `desc` links.
- A per-package badge (an SVG or a shields endpoint JSON).
- A "first compiler it checks on" column, for packages that never passed in
  the window.
