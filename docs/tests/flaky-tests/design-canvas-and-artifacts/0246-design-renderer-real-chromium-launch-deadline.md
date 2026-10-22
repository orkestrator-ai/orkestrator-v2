# Real-Chromium design renderer case misses its launch deadline on GitHub Actions

- **ID:** 0246
- **Status:** resolved
- **Date observed:** 2026-10-15
- **Test:** `DesignRenderer with real Chromium > blocks authored scripts and remote images while capturing a PNG`
- **File:** `apps/backend/src/core/design/renderer.test.ts`
- **Original command:** the "Unit and integration tests" job of `lint.yml`
  (`mise run test`) on GitHub Actions `ubuntu-latest` (four vCPUs). The
  workspace group had one worker slot, so the backend package ran its files in
  path order on one Bun worker, concurrently with the root, bridge and protocol
  groups.
- **Failure:** the renderer's launch timer fired at 15,002 ms (`launch-deadline`)
  and the first `run` rejected with `DesignError: Design renderer did not start
  in time` after 15,008 ms. The failure had the same signature each time:
  - run 38775238998 (`main`, `cefcaf69`, #999)
  - run 38776050153 (#1001 pull request)
  - run 38784461548 (`main`, `7ccb193e`)

  It passed on run 38778314321 (`main`, `5c7517eb`) and on both #999
  pull-request runs. Until #999 the backend suite never finished on CI, so
  earlier runs could not show this. The case has not changed since #844
  (2026-09-25).
- **Isolated rerun:** the owning file passes locally in about 1 s with
  Playwright's Chrome for Testing (`bun test --preload ../../tests/setup-node.ts
  ./src/core/design/renderer.test.ts --parallel=1` from `apps/backend`). A
  local launch takes about 150 ms idle and about 180 ms with 72 busy loops on
  18 cores.

## Assessment on 2026-10-15 (superseded by "Root cause" below)

The cause was not confirmed. On the runner, `resolveDesignChromiumPath` finds no
Playwright-managed browser, so it falls back to a system Chromium or Google
Chrome. That browser's first start in the job is this case. CPU contention
alone looks unlikely: four-times oversubscription barely moved the local
launch time. The remaining candidates are a cold first start (font cache, disk
cache) under memory or I/O pressure, and a start-up stall specific to that
binary. Nothing was captured, because the renderer's deadline fires just ahead
of Playwright's own launch timeout and drops its error. The renderer's warnings
are deliberately content-free.

A Linux reproduction was attempted in a `oven/bun:1.4.2-debian` container
with Debian's Chromium, but Docker Desktop on the host could not start
containers at the time.

## Change (2026-10-15)

The case proves script blocking, blocked remote images and PNG capture in a
real browser, not launch speed. The fake-launcher cases cover deterministic
deadline, cleanup and recovery behavior. The functional case now:

- gives its renderer a 45 s launch budget (`REAL_CHROMIUM_LAUNCH_MS`), and the
  overall budget extended by the same amount. The production defaults
  (`DEFAULT_DESIGN_RENDER_BUDGETS`) are unchanged.
- wraps `chromium.launch` and, on failure, prints how the launch ended:
  `[real Chromium] launch started after N ms` or `failed after N ms: …`, with
  Playwright's call log and the browser's stderr. A forced hang with a fake
  executable printed the `<launching>` line and the browser's stderr.

A separate real-Chromium case runs first, without budget overrides, so a cold
browser still exercises the production 15 s launch budget. It asserts either
a successful render and ready state, or a launch timeout and an unavailable,
empty renderer. Non-timeout Playwright errors and failures in context creation
or rendering fail the test. A timeout emits a warning referencing this entry;
it is accepted as the production failure contract, not evidence that cold
startup meets the budget. This preserves the default-budget integration check
without making the functional security/capture case depend on startup speed.

Local verification on 2026-10-15: the owning file passed with real Chromium
in 1.9 s. A temporary executable wrapper delaying startup by 20 s exercised
the production-budget timeout branch; the focused case passed in 15.1 s.
These checks do not reproduce or explain the GitHub runner's cold-start cause.

## CI evidence after #1008 (2026-10-17)

- The functional case has not failed on any `lint.yml` run whose commit
  contains #1008 (`40c6c66e1`). All 17 failed runs since 2026-10-15T22:12Z
  were checked with `gh run view <id> --log-failed`. The only renderer failure
  in that window, run 38822238444 (`release-channels/02-in-app-update`,
  `16de9697`), was on a commit without #1008. Runs 38808307355, 38784461548
  and 38775238998 (`main`) also predate #1008.
- The production-budget case timed out on every run where the backend
  group's output was visible: `main` runs 38826459927, 38831468664,
  38893184821 and 38904091991, plus pull-request runs 38820059736,
  38823168366 and 38893136380. Each logged `launch-deadline { elapsedMs:
  15002–15003 }` and `production launch timed out after 15000 ms (0246)`. In
  the same job, the functional case's later launch then passed under its 45 s
  budget. So the first Chromium start in a job always exceeded 15 s, and a
  later start did not. The case accepted that outcome, so it could not detect
  a real launch regression on CI.
- On `ubuntu-latest`, `resolveDesignChromiumPath` resolves `/usr/bin/chromium`.
  The runner image links it to a Chromium snapshot unpacked in
  `/usr/local/share/chromium/chrome-linux` (`install-google-chrome.sh` in
  `actions/runner-images`). The job never runs that binary before this file.

## Root cause

The first start of Chromium on the host reads roughly 340 MB of browser
binary and resources from disk. On a fresh runner, the page cache is cold and
the disk is shared with three concurrent test groups. At about 20 MB/s, that
read alone takes longer than the renderer's 15 s production launch budget.
Later starts read from the page cache and take about 50 ms. CPU contention is
not the cause, and nothing in the renderer's launch path is either.

Reproduced on Linux in the `orkestrator-v2:latest` image. The image provides
Playwright Chromium 1248, which is the same build that `playwright-core`
1.64.0 expects. The container ran with `--cpus=4`, `drop_caches` before each
run, and `--device-read-bps /dev/vda:<rate>`. Measurements with a standalone
probe:

| Disk read limit | First launch | Second launch |
| --- | --- | --- |
| unthrottled, cold | 206 ms | 71 ms |
| 20 MB/s, cold | 17,183 ms | 51 ms |
| 10 MB/s, cold | 34,421 ms | 54 ms |

Under 20 MB/s with a cold cache, the file reproduces the CI behavior exactly:

- The current file timed out the production-budget case at
  `launch-deadline { elapsedMs: 15002 }`, and the functional case passed in
  5.0 s, which is the remainder of the cold read.
- The pre-#1008 file (`40c6c66e1^`) failed the functional case with `Design
  renderer did not start in time` at 15,014 ms.

The disk throughput of the GitHub runner was not measured directly. The new
warm-up prints the cold-start duration on CI (see below), which records it in
each failing run's test log artifact.

## Fix

`apps/backend/src/core/design/renderer.test.ts` (this branch):

- A `beforeAll` in the real-Chromium `describe` pays the cold start once,
  outside the renderer. It calls `chromium.launch` with the resolved executable
  and a 120 s bound, renders and screenshots one page, then closes the browser.
  It warns `[real Chromium] cold start took N ms before the cases (0246)` when
  that takes more than 5 s. If the browser cannot start at all, the hook fails.
- The production-budget case is now strict. It is renamed "starts a loaded
  browser within the production launch budget". It must render with the
  default budgets, launch with a 15 s Playwright timeout, and report `ready`.
  A launch timeout no longer passes.
- The functional case (this entry) drops the 45 s launch override and runs
  under `DEFAULT_DESIGN_RENDER_BUDGETS`. It keeps the launch-outcome log on
  failure.
- The timeout and recovery contract stays covered by the fake-launcher cases
  under "DesignRenderer lifecycle deadlines". Production budgets are unchanged.

This does not hide launch regressions. A browser that starts slowly every time
now fails both real-Chromium cases. Before this change, the production-budget
case accepted any launch timeout. Checked with a wrapper executable that sleeps
20 s before every start: the warm-up took 21.3 s and passed, and both cases
failed with `Design renderer did not start in time` (the functional case
printed `launch failed after 15000 ms`).

## Verification (2026-10-17)

- macOS, from `apps/backend`: `bun test --preload ../../tests/setup-node.ts
  ./src/core/design/renderer.test.ts --rerun-each 20` → 500 pass, 0 fail.
- The same file with `--rerun-each 10` under 36 `yes` busy loops on 18 cores
  → 250 pass, 0 fail.
- Linux container, `--cpus=4`, cold cache:
  - 20 MB/s read limit: 25 pass. The warm-up took 19.9 s. The cases took
    201 ms and 353 ms.
  - 10 MB/s read limit: 25 pass. The warm-up took 39.7 s. The cases took
    213 ms and 522 ms.
  - 20 MB/s read limit plus eight busy loops, `--rerun-each 5`: 125 pass,
    0 fail.
- `bun test --preload ../../tests/setup-node.ts src/core/design --parallel=2`
  → 189 pass, 0 fail.
- `oxfmt --check`, `oxlint` and `apps/backend` `typecheck` pass.

If this reopens, compare the CI warm-up warning with the case durations. A
slow warm-up with fast cases is the expected cold disk. A slow case after a
warm-up points to the renderer's launch path.
