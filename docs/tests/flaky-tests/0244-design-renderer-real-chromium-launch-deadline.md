# Real-Chromium design renderer case misses its launch deadline on GitHub Actions

- **ID:** 0244
- **Status:** open
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

## Current assessment

The cause is not confirmed. On the runner, `resolveDesignChromiumPath` finds no
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
real browser, not launch speed. The production launch deadline is covered by
the fake-launcher cases in the same file. So the case now:

- gives its renderer a 45 s launch budget (`REAL_CHROMIUM_LAUNCH_MS`), and the
  overall budget extended by the same amount. The production defaults
  (`DEFAULT_DESIGN_RENDER_BUDGETS`) are unchanged.
- wraps `chromium.launch` and, on failure, prints how the launch ended:
  `[real Chromium] launch started after N ms` or `failed after N ms: …`, with
  Playwright's call log and the browser's stderr. A forced hang with a fake
  executable printed the `<launching>` line and the browser's stderr.

## To resolve

Watch the next `main` runs. If the case passes three in a row, resolve this
entry as a cold-start budget. If it fails, the printed launch log shows whether
the browser hung or was only slow. Fix that cause rather than raising the
budget further.
