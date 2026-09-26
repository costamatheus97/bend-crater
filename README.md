# bend-crater

Checks every package on [BendHub](https://hub.bend-lang.com) against recent
[Bend](https://github.com/bendlang/bend) compilers, every night, and
publishes the result as a compatibility matrix:

**https://costamatheus97.github.io/bend-crater/**

Bend releases often, and a release sometimes breaks code that checked the
day before. Hub packages are permanent (a package is its content hash) and
record no compiler version, so a package that stops checking stays on the hub
as it is. The matrix shows which packages still check, on which compilers,
and when each one broke. It also checks Bend's `main` branch, so a change
that would break a package shows up before it ships in a release.

The name and the idea come from Rust's
[crater](https://github.com/rust-lang/crater). This project is unaffiliated
with it.

This is a community project. It is not part of Bend and is not maintained by
the Bend authors. The results are informational: a failing cell can be the
package's fault, the compiler's, or this harness's. Please read the error
before filing anything upstream.

## What a run does

1. **Lists the hub.** It pages through `GET /packages.json?sort=new&limit=100&after=N`.
   This returns every published hash, and a name and version for the named
   ones.
2. **Fetches each package once.** It fetches `GET /0x<hash>/manifest`, then
   each file at `GET /0x<hash>/<path>`. It checks them the way `bend` does:
   the manifest's sha256 must start with the hash, and each file must match
   its manifest line. The files go into a store laid out like `~/.bend/lib`.
   Hashes never change, so a package is fetched once and then comes from the
   cache. The fetches run one at a time, with a pause between requests and
   the User-Agent `bend-crater (+https://github.com/costamatheus97/bend-crater)`.
   The packages a package imports (`0x<hash>/…` or `name@version/…`) are
   fetched the same way.
3. **Gets the compilers:**
   - the last 6 releases, from their GitHub release tarballs;
   - `main`, from a fresh shallow clone, run from source with Bun;
   - optionally, a local `bend` binary.
4. **Checks each package on each compiler:** `bend <wrapper> --check-only`,
   with a 600 s cap, and records the check's time.
   - The wrapper imports the package's entry files by hash, as a user of the
     package would: `import 0x<hash>/<entry>.bend as R0`. The hub does not
     record which file is the entry. `bend --publish` uploads exactly the
     files the loader reached from the file it was given, so the entry is the
     `.bend` file that no other file of the package imports. If a package has
     several such roots, all of them are checked.
   - The compilers run offline. They get their own `HOME` and `BEND_LIB`
     (the verified store), and a `BEND_HUB` that answers 404. A compiler
     never reaches the real hub, so a missing dependency shows up as `fetch`.
   - If a check passes, its entry defines `main`, and the package has no
     foreign (`.c`/`.js`) effects, `main` is run once in an empty directory
     with a 20 s timeout. The cell is then marked ▸, or ▸! if that run exited
     non-zero or timed out. The run does not change the check's status.
   - A crash or fetch failure is retried once. A timeout is not retried.
5. **Compares.** Regressions are listed at the top of the page:
   - **next release:** passes on the latest release, fails on `main`;
   - **new release:** passed on the release before, fails on a release that
     came out since the last run;
   - **since last run:** the same compiler passed last run and fails now. For
     `main`, this compares against the previous run's `main`.
6. **Writes:**
   - `data/results.json`: this run;
   - `data/history.json`: a summary of each of the last 90 runs;
   - `data/timings.json`: check times for the last 14 runs;
   - `docs/index.html`: the page.

Anonymous hashes (published without a name) are checked on `main` and the
latest release only, to keep the run short. `--anon all` checks them on
every compiler.

## Reading the matrix

There is one row per package version. Named packages come first, and the
anonymous hashes are behind a checkbox. There is one column per compiler,
newest first. Click a cell to see the error lines.

| cell | meaning |
|-|-|
| `ok` | `All terms check.` |
| `ok*` | Checks, but some defs rely on `@unsafe` or foreign code. This is recorded, not treated as a failure. |
| `parse` | Failed to parse or load: a syntax or import error, with a location but no def. This includes an import the compiler cannot resolve, such as a `name@version` import on a release before 2.0.26. |
| `check` | Failed to check: a type error, an undefined name or an unfilled law. |
| `fetch` | A package or dependency could not be fetched, or was taken down. |
| `time` | No verdict within the timeout. |
| `crash` | The compiler exited without an `Error:` block, from a signal, or with a stack overflow. |
| `skip` | The compiler failed the harness's own smoke check. |
| `·` | Not run on this compiler. Anonymous hashes are checked only on `main` and the latest release. |

**broke in** names the first release in the window that fails a package
which passed on the release before it.

## Checker timing

Checker speed can change a lot between compilers: one proof library took
1804 s on 2.0.28 and 7.4 s with an open upstream PR. So each cell also
records how long its check took.

- **In each cell:** the wall time of the `--check-only` run appears under
  the status. It is underlined from 1 s and double-underlined from 10 s. A
  check has a cap of 600 s, and one that reaches it shows `>600 s`.
  "Slowest first" reorders the matrix. Click a cell to see its time and, on
  Linux with GNU `time`, its peak RSS.
- **In the JSON:** each cell has `check_ms` and, when available, `rss_kb`.
  `data/timings.json` keeps each cell's `check_ms` for the last 14 runs.
  `results.json` records the runner's CPU model, thread count and OS image.
- **The "Checker performance" section** compares `main` with the latest
  release, and each release with the one before it. A change is **flagged**
  only when it meets all of these conditions:
  - the newer compiler takes at least 2× the older compiler's **median**
    for that package over the kept runs (or at most half, for a speedup);
  - the larger of the two is at least **1 s**, after each compiler's own
    startup time is taken off. The startup time is the fastest of three
    checks of an empty file. `main` runs from source through Bun, so it
    starts slower than a release binary;
  - it held in the **previous run too**. A change seen in a single run is
    listed as a candidate.
  - both checks **passed**. A failing check stops at its first error, so its
    time is not comparable.
  The section also lists, for each pair, the biggest movers below those
  thresholds (from 0.2 s after startup and 1.2×), marked "below threshold"
  for context, and the slowest passing checks for each compiler.

**Caveats:**
- GitHub's shared runners are noisy, and their CPU model varies between
  runs.
- Each cell is a single sample per night, run while nothing else runs.
- Most hub packages check in well under a second, where startup dominates.
- The thresholds exist so that noise does not raise flags, which also
  means small real changes go unflagged.
- Treat a flag as a lead to reproduce locally, not as a measurement.

## Run it locally

You need [Bun](https://bun.sh) and git. Linux or macOS, x64 or arm64.

```sh
git clone https://github.com/costamatheus97/bend-crater
cd bend-crater
bun src/crater.ts                              # the full run, as CI does it
bun src/crater.ts --releases 1 --no-main       # just the latest release
bun src/crater.ts --only '^bend-datetime$'     # one package (a regex on the name or hash)
bun src/crater.ts --bend ~/.bend/bin/bend      # add your installed bend as a column
```

Options (defaults in `crater.json`):

| option | default | |
|-|-|-|
| `--releases N` | 6 | how many recent releases to check |
| `--no-main` / `--main-ref REF` | main | check `main` (or another branch) from source |
| `--bend PATH` | | add a local `bend` binary as a column (repeatable) |
| `--anon edges\|all\|none` | edges | anonymous hashes: on `main` and the latest release, on every compiler, or not at all |
| `--jobs N` | 1 | checks at a time |
| `--timeout S` / `--run-timeout S` | 600 / 20 | per check (not retried on timeout), per `main` run |
| `--budget-min M` | 300 | stop starting checks after M minutes; the rest are marked `skip` |
| `--no-rss` | | do not wrap checks in GNU `time` |
| `--no-run` | | skip the run lane |
| `--nice` / `--no-nice` | nice locally | run compilers under `nice -n 19` |
| `--cache DIR` `--data DIR` `--page FILE` | `cache` `data` `docs/index.html` | where things go |

The cache (`cache/`) holds the hub store (about 20 MB), the unpacked
releases (about 45 MB each) and the `main` clone. A first run fetches the
whole hub once, which takes a while because the fetches run one at a time.
Later runs fetch only new packages. The checks themselves take a few minutes.

## Limits

- **CPU only.** There are no GPU lanes (Metal, CUDA), and no C or JS build
  lanes. A package is checked, not compiled.
- **Checks, plus cheap runs.** Laws and proofs are checked, because checking
  is what `--check-only` does. Tests are rarely published to the hub, and
  only an entry file's `main` is run. There is no differential testing
  between lanes.
- **Entry-file guess.** The entry is inferred from the import graph. A
  package whose entry is imported by another of its own files would be
  checked through that file instead. The check still covers the same files.
- **Parse or check** is decided from the shape of the error, because `bend`
  prints no category. Load errors, such as a bad import line, count as
  `parse`.
- **Runner noise.** Timings come from shared CI runners. A slow check near
  the timeout can flip between `ok` and `time`.

## Layout

```
src/crater.ts     the run: list, fetch, compilers, checks, output
src/hub.ts        BendHub client and the verified package store
src/pkg.ts        import graph, entry files, dependencies
src/compilers.ts  releases, main and local compilers
src/run.ts        process runner with timeouts, and the verdict classifier
src/report.ts     regressions, "broke in", history
src/perf.ts       timing history and the slowdown/speedup flags
src/render.ts     re-render the page from data/ without a run
src/page.ts       the static matrix page
crater.json       defaults
data/             results.json, history.json and timings.json, committed by CI
docs/index.html   the page, deployed to GitHub Pages by CI
.github/workflows/crater.yml   nightly run, plus a manual trigger
```

## License

Apache-2.0, the same as Bend. See [LICENSE](LICENSE).
