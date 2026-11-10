# Electron specs recover a startup that lost its modules to ERR_NETWORK_CHANGED

## Task analysis

Analysed 2026-11-06 against `main` at `e6c3da899`, with branch
`preview-flakes-1bb27c3be3fd-r1` at `9ef37bfd1`. Found while repairing the
review validation of to-do 0042 task 11. Updated 2026-11-10 against `main` at
`04639b12b`: task 1's code and task 2 are done; task 1's live runs remain.

### Tasks

1. **Use the startup recovery in the other Electron specs**: every spec that
   waits for a development window's first title. Status: open (code done
   2026-11-10; a live run of the specs that need a display remains).
2. **Measure it under forced network churn**: show a real reload recovering a
   startup. Status: done (2026-11-10, a real headless Electron window in a
   private network namespace, 5 of 5 recovered with one reload).

### 1. Use the startup recovery in the other Electron specs

**Problem.** On a Linux host where other builds create and remove Docker
networks, Chromium aborts a development window's Vite module loads with
`net::ERR_NETWORK_CHANGED`, the window stops at "Orkestrator couldn’t connect",
and the spec fails at its first title check
([2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md)).
The 2026-11-06 review validation of to-do 0042 task 11 (`mise run
test:agent:electron`, head `f67ef0666`) had 20 failures, 17 of them at a first
`toHaveTitle`.

**Context.** `e2e/agent-testing/electron-startup-recovery.ts` reloads a window,
at most three times, only when the startup screen failed and that load's
console holds both a failed module import and `net::ERR_NETWORK_CHANGED`. On
2026-11-06 only `service-preview-electron-launch.ts` and
`web-annotations-electron.spec.ts` used it. Since 2026-11-10 it also offers
`watchElectronStartup(app)`: install it straight after `electron.launch()`,
then `waitForTitle(window, title)` wherever a spec waited for a title. It keeps
console lines per window (a later window is never reloaded on an earlier
window's aborts), takes a string or a pattern, and records a recovery as a
`startup-recovery` annotation and a `[startup-recovery]` line.

Specs that now use it, at every wait for a Vite-served window's title,
including second windows and waits after a spec's own `reload()`:

- `artifact-host-electron.spec.ts`, `connection-outage-electron.spec.ts`,
  `scope-proof-electron.spec.ts`;
- `electron-main.spec.ts` (`testIndependentWindows`: the first and the second
  window);
- `local-gateway-transport-electron.spec.ts` (`runScenario`: the first window,
  after its reload, the extra window and the relay's second window);
- `pull-request-pane-electron.spec.ts` (first window and after its reload);
- `relayed-events-electron.spec.ts` (first and second window; it also keeps
  `fetchModulesOutsideChromium`);
- `terminal-input-resume-electron.spec.ts` (first window and after its
  reload);
- `design-canvas-electron-journey.ts` (`openDesignWindow` with
  `title: "document"`, the Vite-served journey; the packaged journey reads the
  native title from a `file:` renderer and does not need it).

Left as they are, on purpose:

- `renderer-log-boundary-electron.spec.ts`: it counts the startup markers a
  window sends and asserts that main receives no renderer logger lines; a
  reload would change what it measures.
- `electron-main.spec.ts`'s missing-preload case, which expects the window to
  reach the failure screen, and its other cases that load no Vite renderer.
- `application-menu-electron.spec.ts` (its own fixture page, no Vite) and the
  packaged specs (`file:` renderer).
- `workspace-realm-electron.spec.ts:139`, named in the 2026-11-06 analysis, is
  no longer in the tree.
- `service-preview-electron-launch.ts` and `web-annotations-electron.spec.ts`
  keep their direct `waitForRendererStart` calls; they record a recovery their
  own way and their behaviour is unchanged.

**Investigation.** Running a whole headless Electron window under churn
(task 2) showed that the earlier failure check, `getByText(...).isVisible()`,
never fires in a headless window: headless Ozone ignores a window's
constructor size, the window stays 1x1 until a spec calls `setSize`, and the
startup heading (`px-8` padding in `desktop-startup.ts`) then has no box. The
check now asks whether the heading is present (`count() > 0`); the renderer
adds that text only when start fails. With `isVisible()` the live case timed
out with the heading attached but hidden; with `count()` it recovered.

Run on beelink2 on 2026-11-10 (headless, no display):

- `design-canvas-electron.spec.ts` through `playwright.electron-headless.config.ts`
  with `ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`: 1 passed (36 s). No
  recovery was needed.
- `web-annotations-electron.spec.ts:902` (a capture survives renderer reload
  and backend restart), the same way: 1 passed (33 s).
- `playwright test --list` for `playwright.electron.config.ts` loads all 16
  specs (74 tests).

Not run: the seven migrated specs that need a display (all but the design
canvas journey). This ticket allowed headless runs only, with no Xvfb, and
`electron-display-setup.ts` refuses those specs without `DISPLAY` or
`WAYLAND_DISPLAY`.

**Decisions.**

- **Where to apply it?**
  - **Each spec's own launch, through one small shared watcher, skipping the
    cases that assert on startup failure (recommended, done).**
    - Pros: the same narrow rule as the service-preview launcher; a case about
      startup keeps seeing the first load; one call per site.
    - Cons: a dozen call sites, each needing a look at what its case asserts.
  - **One shared launch helper for every Electron spec.**
    - Pros: one place.
    - Cons: the specs launch with different environments and profiles today;
      merging them is a larger refactor than this needs.
  - **Route modules through `route.fetch()` as the browser suite does.**
    - Pros: no reload at all.
    - Cons: those loads skip main's webRequest hooks, which several Electron
      specs exist to exercise (flake 0622's cause was in one).

### 2. Measure it under forced network churn

**Problem.** The service-preview runs after `9ef37bfd1` printed no
`[startup-recovery]` line: no network change hit a startup then. The reload was
proven by unit tests, not by a live recurrence.

**Context.** 2340 reproduced the aborts with a labelled network created and
removed every 0.3 s. On a shared host that churn aborts every other build's
Chromium loads too.

**Investigation.** Done in a private network namespace, so no other build saw
the churn. `electron-startup-recovery.integration.test.ts` runs two cases under
`unshare --user --map-root-user --net`, each refusing to touch an interface
unless its namespace differs from the parent's:

- real Playwright Chromium and the module fan-out fixture
  (`electron-startup-recovery-live-fixture.ts`, from 2026-11-06), now through
  the per-window collector;
- a real headless Electron window (`electron-startup-recovery-electron-fixture.ts`),
  launched with the specs' switches plus the headless switches and
  `--no-sandbox` (uid 0 in the namespace), and watched exactly as the specs
  watch theirs: `watchElectronStartup` straight after `electron.launch()`,
  `firstWindow()`, then `waitForTitle`.

Both add and remove a bridge while a 1,000-module dynamic-import fan-out loads,
require a real `requestfailed` with `net::ERR_NETWORK_CHANGED` and the failure
screen, then exactly one reload to the title; the Electron case also requires
the `[startup-recovery]` line. Results on beelink2, 2026-11-10: the test file
passed (2 of 2), and five direct runs of the Electron fixture each reported
`{"networkChanged":true,"reloads":1}` with 1,030 to 1,055 module requests and a
1x1 viewport.

```bash
mise run test:logged -- --name startup-live -- bun test ./e2e/agent-testing/electron-startup-recovery.integration.test.ts --parallel=1
```

This qualifies the helper in a real Electron window with a small module
fixture. The complete Orkestrator app was not run inside the namespace: its
backend, Vite and bridges would all have to start there, and the fixture
already exercises everything the helper reads (the context's console, the
window, its reload).

**Decisions.**

- **How to measure?**
  - **Force churn inside a private network namespace by adding and removing a
    bridge there, so only the run sees it (recommended, done).**
    - Pros: no effect on other builds; needs no Docker; repeatable.
    - Cons: a fixture page, not the full app.
  - **Labelled Docker network churn on a quiet host.**
    - Pros: the exact recorded trigger, against the full app.
    - Cons: needs a host with no other builds running.

## Current state

Every Electron spec that waits for a Vite-served window's title uses
`watchElectronStartup` (list above); the rule is described in
[agent-testing.md](../../development/agent-testing.md#electron-specs-and-their-display).
Unit tests (`electron-startup-recovery.test.ts`) cover the step rule, the
per-window collector and the watcher (a reload, a later window judged on its
own console, the reload budget). The opt-in live qualification passes in
Chromium and in headless Electron.

## Outstanding work

- Run `mise run test:agent:electron` on a host with a disposable display and
  check the migrated specs pass; read any `[startup-recovery]` lines in the
  run's `results.json`. Not done here: this ticket allowed headless runs only
  and no Xvfb.
- Startup recovery does not cover a later lazy load (the Kanban view in
  `web-annotations-electron.spec.ts`, 2026-11-06). That is a separate failure
  mode; record a new to-do if it recurs.

## Assumptions and decisions

### Task 1: the failure check reads presence, not visibility (2026-11-10)

`pageStartupWindow` now treats the startup heading as shown when it is in the
DOM. Visibility was never what the rule meant (the renderer creates the
heading only on failure), and the headless qualification showed visibility
cannot be relied on before a spec sizes the window. The step rule is
unchanged: a reload still needs the failure plus both console signatures.

### Task 1: one watcher per launch, lines kept per window (2026-11-10)

Later windows and post-`reload()` waits reuse the launch's watcher, so the
collector keeps lines per window (`ConsoleMessage.page()`), and lines no window
claims are consumed by the first window to drain them. Without that, an earlier window's aborts could
license a reload of a later window that failed for another reason.

### Task 1: the watch is left to end with the app (2026-11-10)

Specs dispose the watch after their last title wait where that is a single
line; where the last wait sits deep in a scenario
(`local-gateway-transport-electron.spec.ts`) the console listener ends with the
application's context when the spec closes the app. Its memory is bounded to
one line per signature per window.

### Task 2: a headless Electron fixture rather than the full app (2026-11-10)

See task 2's decision. It also caught the 1x1 viewport problem above, which a
Chromium-only fixture could not.

### Task 1: discard prior-document signals on navigation (review repair, 2026-11-10)

Main-frame navigation requests clear that page's retained signatures and any
unclaimed lines before the new document can report failures. Subframe requests
do not clear the parent window's signals. Clearing at the next title wait would
lose valid signals emitted while an explicit reload is awaited. The regression
covers a successful wait, stale lazy-import signatures, explicit navigation, and
a different startup failure that must fail without an automatic reload.

### Task 2: review-stage qualification evidence (2026-11-10)

The explicit integration run reached both the Chromium and headless Electron
cases. Electron passed on the first run, but subsequent runs were inconsistent:
Chromium recovered with two reloads instead of the asserted one, and Electron
sometimes observed no abort or needed two reloads. The qualification remains
open; the exact-one-reload assertions have not been weakened. Failure artifacts
from this repair stage include `/tmp/orkestrator-test-run.JXl8Ui` and
`/tmp/orkestrator-test-run.rZ0pKa`. Full migrated-spec and terminal-owner runs
still require the documented display, Docker and outage setup.

## Related

- [2340](../../tests/flaky-tests/aggregate-validation-runs/2340-chromium-network-changed-under-docker-churn.md)
- [to-do 0042](../previews-and-annotations/0042-service-preview-rollout.md)
  (task 11, D24)
- [7020](7020-browser-suites-after-network-churn-qualification.md), the browser
  suites' qualification under network churn
