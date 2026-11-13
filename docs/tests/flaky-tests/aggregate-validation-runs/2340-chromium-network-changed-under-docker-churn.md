# Environmental, not flaky: Chromium browser suites beside Docker network churn on a Linux host

- **ID:** 2340
- **Status:** environmental
- **Date observed:** 2026-11-01
- **Host:** beelink, Linux 7.1.8 (Arch-based), Intel Core Ultra 9 285H (16
  logical CPUs), Docker Engine 29.9.2 (rootful), Playwright 1.64.0 with its
  Chromium 156. Other worktrees' builds were creating and removing Docker
  networks and containers throughout (load averages 3–46).
- **Observation:** pages served from loopback (the component fixture's Vite
  server, or a profile's backend proxying the renderer's Vite server) lose
  module requests part-way through loading. The browser console shows
  `Failed to load resource: net::ERR_NETWORK_CHANGED` for a Vite module (for
  example `packages/protocol/src/graphs/system-contract.ts`), or the request
  ends with status -1 while the backend logs
  `[RemoteGateway] Proxy client disconnected; aborting upstream request`. The
  app then renders partly or not at all, and whichever assertion comes next
  times out:
  - `e2e/DesignCanvas.spec.ts` (desktop, 8x CPU throttle run for 0174): the
    reloaded canvas never showed the frame's heading (line 210,
    "element(s) not found" after 5 s); the module above failed with
    `ERR_NETWORK_CHANGED` right after `page.reload()`.
  - `e2e/agent-testing/design-canvas.spec.ts` "private canvases survive
    reload…": a blank dark page after the first `page.reload()`, failing in
    `ensureProjectExpanded` (line 341) three times in a row, with about 200
    module requests ending at status -1 in each trace.
  - The same `ERR_NETWORK_CHANGED` errors are the "blank fixture pages" in
    [0826](9891-scheduled-jobs-review-validation.md#browser-infrastructure),
    whose cause was not established.
- **Cause, reproduced:** on Linux, Chromium's network change notifier aborts
  in-flight requests, loopback included, with `ERR_NETWORK_CHANGED` when a
  network interface or address appears or disappears. Docker creates a bridge
  for every user network and a veth for every container start, and removes
  them again. A probe page loading 60 scripts from a loopback Bun server, each
  answered after 400 ms, 15 loads per run with Playwright's Chromium:
  - no churn of mine (other builds still active): 915 requests, 0 failed
    (65 s);
  - while `docker network create` and `docker network rm` of a labelled
    network ran every 0.5 s: 797 of 915 requests failed with
    `net::ERR_NETWORK_CHANGED` (9 s).
  - `ip monitor link address` on this host shows bridge and veth events every
    few seconds while other builds run; interface indexes were past 1,600
    after a day of uptime.
  - The probe's networks carried a throwaway `orkestrator-owner` label and
    were removed by that label afterwards.
- **Confirmation:** with its Vite module requests fetched through Playwright
  (`page.route` with `route.fetch()`, which bypasses Chromium's network
  stack), the private-canvas case's app loaded in six of seven runs on the
  same busy host (in the seventh, one routed fetch was reset) and passed
  twice. Those diagnostic runs also dismissed the container-fixture
  profile's Docker firewall warning and held the picker's first listing for
  [0208](../design-canvas-and-artifacts/0208-design-canvas-private-import-picker-disabled-in-suite.md);
  none of that was committed. No product or test code was changed for this
  case.
- **Not affected:** macOS with Docker Desktop, whose bridges live inside its
  VM, and CI runners, unless a job runs Docker work beside a browser suite.
  No Chromium switch to ignore these changes was found (the binary's strings
  name the notifier but no switch for it).
- **Also seen (2026-11-02):** `e2e/agent-testing/design-canvas-electron.spec.ts`
  run headless on beelink (`ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`,
  Electron 45.0.0) failed twice in a row at `openDesignWindow`: the
  Vite-served renderer showed "Orkestrator couldn't connect", the title check
  timed out after 150 s, and the diagnostics held 138
  `net::ERR_NETWORK_CHANGED` lines while other builds' containers connected
  and disconnected. The same journey against the packaged app
  (`design-canvas-packaged-electron.spec.ts`) passed in between: its renderer
  loads from `file://`, which this notifier does not abort.
- **Guidance:** on a Linux host, a browser failure whose trace shows
  `net::ERR_NETWORK_CHANGED`, or many requests ending at status -1, while other
  work starts or stops containers is this case, not a flake of the owning
  test. Rerun when no Docker work is starting or stopping, or route the
  page's module requests through `route.fetch()` for a diagnostic run. Do not
  add a new flake entry for the owning test unless its trace has neither
  symptom.

## 2026-11-03: project-home approval review

The six-worker `mise run test:logged -- --name review-browser -- mise run
 test:browser` rerun overlapped an origin/main Docker qualification on the same
Linux host. A separate one-worker `ProjectHomeMessageApproval.spec.ts` run had
three failures and one pass: blank pages never displayed the dialog. Its mobile
approve trace contains repeated `net::ERR_NETWORK_CHANGED` failures for local
Vite modules (including `SettingsMachineStrip.tsx` and
`VirtualizedMessageList.tsx`). This matches the cause above, rather than an
approval assertion rejecting rendered content. The broad run was interrupted
with SIGINT to its recorded Playwright child after 436.6 seconds so it could be
rerun without Docker churn. Evidence is retained under
`output/agent-testing/home-mail-review-fix/evidence/` in the review workspace.

After the Docker profile was stopped and reset, the one-worker approval spec
passed all four cases (22.8 s): approve and decline at mobile and desktop widths,
including Escape and keyboard assertions. The exact broad browser command was
rerun, but stopped after 25.3 minutes with 34 failures and 587 passes; it is not a
green aggregate result. Several unrelated cases reproduced on detached main;
others remain unresolved. An additional concurrent PipelineFlow owner run also
encountered `ENOENT` for trace files because these component-suite invocations
share `output/playwright/test-results`; that run is not reliable isolation
proof. Future component reruns must be serialized within one checkout as well
as kept separate from Docker network churn.

## 2026-11-03: a private network namespace avoids it

While validating to-do 2921 task 3 (branch
`close-retention-cases-4142aaf8cd0b-r1`, head `08e817a45`), the desktop Cursor
cases of `e2e/CloseRetention.spec.ts` failed twice in a row on beelink (load
average 63–87, about ten builds running), 5 failed and 1 passed each time.
Every failure except one waited for `New agent tab` after `page.reload()`, and
each of those traces held 111–359 `net::ERR_NETWORK_CHANGED` module requests;
`ip monitor all` showed veth and bridge events from other builds' containers
(interface indexes past 4,600).

The same command then passed, run inside a new user and network namespace that
has only loopback, so Chromium never sees the host's interfaces change:

```sh
unshare -rn sh -c 'ip link set lo up && ORKESTRATOR_E2E_PORT=<free port> mise run test:logged -- --name <name> -- bunx playwright test --config e2e/playwright.config.ts e2e/CloseRetention.spec.ts --project desktop-chromium --grep Cursor'
```

It passed all six Cursor cases (51.3 s), and the whole file in both projects
passed too (71.6 s). It only works for suites that need nothing beyond
loopback: the component fixture server, its fixture hosts and fake engines.
Inside the namespace the process is uid 0 in its own user namespace, which
Playwright's default (`chromiumSandbox: false`) already tolerates. It is not a
fix for suites that reach Docker or the network. No product or test code was
changed for this.

## 2026-11-04: subork review validation, component and Electron suites

Branch `subork-agent-command-19d44fc3d0c3-r1` on beelink, beside other
pipelines' Docker work.

- `e2e/SuborkGroup.spec.ts` had intermittent blank starts in its full-file
  runs (8 passed, 2 failed in the last of them), with
  `net::ERR_NETWORK_CHANGED` on fixture module imports in the trace. Rerun on
  its own port (`ORKESTRATOR_E2E_PORT=1478`, `--repeat-each=5`) it passed all
  50 cases (31.0 s); inside `unshare -rn` (port 1479, `--repeat-each=3`) it
  passed all 30 (20.0 s).
- `mise run test:agent:electron` (review validation for commit `fe32ed945`)
  failed 16 of 62 cases (23 passed, 1 skipped, 22 did not run; 18.5 min).
  Thirteen failed at the first `toHaveTitle` with the window still titled
  `Orkestrator AI`; each one's `electron-diagnostics` attachment holds 56–139
  `net::ERR_NETWORK_CHANGED` lines and
  `renderer.load-failed ... Failed to fetch dynamically imported module
  .../src/renderer-entry.tsx`. `connection-outage-electron.spec.ts` failed at
  the same title check. The branch changes nothing under `apps/desktop/` or
  `e2e/agent-testing/`. The two remaining failures were native-view
  assertions (`web-annotations-electron.spec.ts`, open case 1400, and
  `service-preview-electron.spec.ts` "a crashed service renderer reports the
  failure and recovers on reload") and are not attributed to this case.
- `ip monitor link address route` for 30 s in the same session showed a
  Docker veth created and removed at interface index 7009; the journal held
  1,886 veth and bridge lines between 03:40 and 04:05 UTC, the window of the
  Electron run.
- The Electron suite was not rerun: those specs open windows on the host
  display, which on beelink is the user's live desktop. Follow-up was task 5
  of to-do 4340 (retired; in Git history at `14d8ce8db`): on 2026-11-13 the suite
  was rerun on a Mac with no Docker network churn and no failure had an
  `ERR_NETWORK_CHANGED` line (43 passed, 4 failed for other recorded causes:
  flakes 9863, 0272 and 1303, and a missing production bundle).

## 2026-11-04: the to-do 2181 qualification, and a measured way past it

The isolated browser run for to-do
[2181](../../../todo/cross-cutting/2181-dev-test-electron-opens-on-the-linux-desktop.md)
(44 passed, 6 failed, 94 skipped, at `b16b51da1`) lost four cases to this, each
ending on the "Orkestrator couldn't connect" screen, which is what a browser client
shows when its modules fail to load. Their traces held these counts of
`net::ERR_NETWORK_CHANGED`: `headless-profile.spec.ts` 33,
`design-canvas.spec.ts:16` 82, `graph-designer.spec.ts:239` 119 and
`graph-run-view.spec.ts:48` 133. `docker network ls` afterwards showed a network from
another owner created at 01:33:45 UTC, about a second after the first aborts in the
graph-designer case; the profile's own reset removed no networks. The other two failures in that run had no such requests
and were spec problems; see the to-do.

Reproduced on beelink at load average about 1, on a `--headless --fixture` profile,
with `headless-profile.spec.ts --repeat-each=3 --workers=1`:

- A `docker run --rm` of a labelled container every 0.3 s (veth churn on the default
  bridge, about 75 link and address events per second by `ip monitor`): the previous
  spec passed 3 of 3 with no aborts. Veth churn alone does not reproduce this.
- `docker network create` and `rm` of a labelled network every 0.3 s, with an explicit
  `--subnet` so the daemon's default address pools were not used: the previous spec
  failed 3 of 3, with 127, 12 and 96 aborts in its traces.
- The same network churn with the spec's module requests going through
  `route.fetch()`: passed 3 of 3 at about 2.7 s each. The previous spec took about
  1.8 s each when nothing aborted it.

`headless-profile.spec.ts` now does this, because that case is about what the profile
serves. No other spec changed then; see below for the whole suite.

A run's output now names the failed cases whose trace has this error
(`e2e/agent-testing/network-churn-report.ts`). The suite's result does not change.

## The whole browser suite, 2026-11-05 (to-do 4222 task 3)

The isolated browser suite's specs now take `test` from
`e2e/agent-testing/browser-test.ts`. Its `context` fixture fetches every loopback
script and stylesheet with `route.fetch()` and keeps the responses in memory for that
context. Specs that open another context call `fetchModulesOutsideChromium` on it.
`browser-gateway.spec.ts` and `client-outage.spec.ts` stay on Chromium's own path,
because the browser's network path is what they test. `browser-test.test.ts` holds
both lists. `headless-profile.spec.ts` uses the shared fixture instead of its own copy.

The in-memory copy matters. Routing turns Chromium's HTTP cache off, and without it
every reload fetched about 1,100 modules through the test process again: on beelink at
load average 50 to 75, a median of about 450 ms each and up to 8 s, still arriving 16
to 20 s after the reload. `design-canvas.spec.ts:16` then failed 3 of 3 at its
check after the last reload, where it had passed 2 of 2 with the base specs. With the
cache, `design-canvas.spec.ts:16` and `graph-run-view.spec.ts:48` passed 3 of 3
each in 247 s.

These runs used a credential-free `--headless --fixture` profile, because the build
was not allowed to read the host's agent credentials. On it, some cases fail the same
way with the base specs as with the shared fixture, behind the "Claude Code Is Not
Logged In" modal or the "Checking CLI tools installation" overlay:
`graph-designer.spec.ts:239` (2 of 2 each), `headless-profile.spec.ts` (2 of 2 each,
though it passed 2 of 2 with the fixture on an earlier Claude-only profile), both
`pull-request-pane.spec.ts` cases, `sidebar-width-consumers.spec.ts:119` and
`web-annotations-gateway.spec.ts`'s desktop-capture case. `graph-designer-mock`,
`graph-designer-editing` and `backend-owned-state` passed with the fixture.

Not measured: a run under artificial network churn. That build was not allowed to
create Docker networks on beelink, and `ip monitor link address` recorded 2 to 12
events in each 10-minute run, so these runs show the fixture costs nothing that
breaks a case, not that it removes this failure from the whole suite. The single-spec
measurement above (0 of 3 before, 3 of 3 after under network churn) is the evidence
for the mechanism. Record a recurrence here if a browser-suite case still fails with
`net::ERR_NETWORK_CHANGED` in its trace. That suite-wide run was done on 2026-11-06; see the next section.

## Static HTML review repair, 2026-11-05

At base commit `d52652aed`, the owning spec command below ran with two workers
and returned **39 passed, 5 failed** in 117.4 seconds. All five failures had
`net::ERR_NETWORK_CHANGED` console events in their retained traces:

| Project | Exact test name | Network-change console events |
| --- | --- | --- |
| mobile-chromium | content is responsive and stays vector | 192 |
| mobile-chromium | a native disclosure opens and closes, and the frame follows both ways | 145 |
| desktop-chromium | authored code never runs and nothing is fetched | 279 |
| desktop-chromium | opening and closing repeatedly converges and never reloads a frame | 26 |
| desktop-chromium | static documents do not touch the single interactive host | 76 |

All cases belong to `e2e/StaticHtmlArtifact.spec.ts`. The missing frames timed
out at 30 seconds, except the two-frame count assertion, which timed out at
5 seconds. Both new forced-`appendChild` regression cases passed.
The failure log is
`/tmp/orkestrator-test-run.mC54EI/static-html-browser.log.gz`.

Original command and owning-file rerun command (identical):

```bash
ORKESTRATOR_E2E_PORT=15482 NODE_ENV=test mise run test:logged -- --name static-html-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/StaticHtmlArtifact.spec.ts --workers=2
```

The trace evidence matches this existing environmental case; no assertions or
timeouts were loosened.

The identical owning-file rerun returned **39 passed, 5 failed** in 128.6
seconds, with failure log
`/tmp/orkestrator-test-run.FCB7FI/static-html-browser.log.gz`.
Its failing cases also all had network-change console events:

| Project | Exact test name | Network-change console events |
| --- | --- | --- |
| mobile-chromium | publishes as real document content with no preview worker or live host | 187 |
| mobile-chromium | fallback layout moves remount an open report with a fresh identity | 293 |
| desktop-chromium | authored code never runs and nothing is fetched | 251 |
| desktop-chromium | opening and closing repeatedly converges and never reloads a frame | 2 |
| desktop-chromium | a frame in a hidden tab keeps its last height | 1 |

The forced-move mobile case failed before its initial document rendered, so the
move itself was never exercised in that rerun. This is still environmental,
rather than a test declared flaky from a passing isolated rerun.

The new move regression was then run alone, serially, and passed **2/2** at
desktop and narrow viewports (12.3 seconds):

```bash
ORKESTRATOR_E2E_PORT=15482 NODE_ENV=test mise run test:logged -- --name static-html-move-regression -- bunx playwright test --config e2e/playwright.config.ts e2e/StaticHtmlArtifact.spec.ts --grep 'fallback layout' --workers=1
```

Alternate-engine qualification was attempted with:

```bash
ORKESTRATOR_E2E_BROWSER=webkit ORKESTRATOR_E2E_PORT=15482 NODE_ENV=test mise run test:logged -- --name static-html-webkit -- bunx playwright test --config e2e/playwright.config.ts e2e/StaticHtmlArtifact.spec.ts --grep 'fallback layout|content is responsive|unexpected reload' --workers=2
```

All six selected cases failed to launch: the installed WebKit binary lacks host
libraries (`libicu74`, `libxml2`, `libflite1`). No WebKit behavior was tested.
Log: `/tmp/orkestrator-test-run.WPpVnX/static-html-webkit.log.gz`.
This launch failure is separate from Chromium's network-change failures.

## Recurrence: an Electron spec's own window (2026-11-05)

- **Test:** `a real window sends its startup markers to the main process and none
  of its logger lines`, `e2e/agent-testing/renderer-log-boundary-electron.spec.ts`.
- **Command:** `mise run test:logged -- --name e16-log-boundary-1 -- bunx playwright
  test --config e2e/agent-testing/playwright.electron.config.ts
  renderer-log-boundary-electron.spec.ts --workers=1 --retries=0`, one worker, at
  `525c3c589` before its rebase, Electron on headless Ozone. Other worktrees' Docker
  and Electron work was running.
- **Failure:** `toHaveTitle` timed out after 60 s on "Orkestrator AI", with the
  "Orkestrator couldn't connect" screen, `[DesktopStartup] renderer-load-failed` and
  `net::ERR_NETWORK_CHANGED` module loads. Containers joined Docker's `bridge` at
  22:00:44 and 22:00:45 and left at 22:00:50 and 22:00:51; the aborts came at about
  22:00:50. The spec's own boot reachability probe was running then. Which run owned
  those containers was not established.
- **Rerun:** with `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, the next four runs had no
  `ERR_NETWORK_CHANGED`, although bridge events still occurred during at least two.
  Those four failed later, for an unrelated reason
  ([6303](../../../todo/cross-cutting/6303-window-close-during-request-throws.md)).
- **Change:** the spec launches with the probe off. Its module loads still go through
  Chromium, so other Docker work on the host can still cause this.

## The whole browser suite under churn, 2026-11-06 (to-do 4222 task 3, closed)

Beelink, branch based on `main` at `e6c3da899`. Every isolated run is
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off mise run test:agent:browser:isolated`
(its default credential-free Codex `--headless --fixture` profile, one worker).
"Self-made churn" is `docker network create` and `rm` of one network with a
unique `ork4222-churn-<run>-<hex>` name, an `orkestrator-owner` label of the same
name and an explicit `--subnet` (10.242.42.0/24, or 10.242.43.0/24 for the
component runs), every 0.3 s, removed by that exact name afterwards; `docker
network ls` showed none left after any run. Events are bridge and veth lines from
`ip monitor link address` during the run, other builds' included. Runs 5 and 6
overlapped component runs A and B, so their hosts carried both churns and a load
average of 40 to 60.

| Run | Code | Churn (cycles / events) | Passed / failed / skipped | Failures and attribution |
| --- | --- | --- | --- | --- |
| 1 | base (`e6c3da899`) | natural (— / 990) | 48 / 3 / 98 | Churn: host picker narrow (177 module aborts; `browser-gateway.spec.ts` loaded through Chromium). Defect: environment move answered 500 `claude-tmux cleanup incomplete` (to-do [7020](../../../todo/cross-cutting/7020-browser-suites-after-network-churn-qualification.md) task 1). Spec race: `cli-ui` "a CLI-initialized project…" (flake [0901](../web-ui/0901-cli-ui-fixture-project-hydration.md), fixed) |
| 2 | base | self-made (2,209 / 13,433) | 35 / 16 / 98 | Churn: all 15 `browser-gateway.spec.ts` failures (58 to 336 module aborts each). Spec race: the same `cli-ui` case. Every spec on the shared fixture passed |
| 3 | `browser-gateway.spec.ts` on the shared fixture, one direct case, helper fix | self-made (1,627 / 11,041) | 51 / 1 / 98 | The new direct case counted Chromium's own `304` revalidations as failures (fixed: `moduleStatusFailure`) |
| 4 | + 304 fix | self-made (1,664 / 10,651) | 50 / 2 / 98 | Churn on navigations: `page.reload` (`browser-gateway.spec.ts` signed-out Codex) and `page.goto` (`web-annotations-gateway.spec.ts` count bound) failed with `net::ERR_NETWORK_CHANGED` (fixed: `retryNavigationsOnNetworkChange`) |
| 5 | + navigation retry | self-made, plus component run A's (1,593 / 20,142) | 51 / 1 / 98 | Churn: the direct case's page lost 201 modules and showed neither the app nor its error, so its wait failed (fixed: such a load is classified and retried) |
| 6 | + blank-load retry | self-made, plus component run B's (2,183 / 26,379) | 49 / 3 / 98 | Churn, by design: the direct case lost modules on all 4 loads and says so. Load (no network error): capped file tree at its 30 s `hidden.o` wait (flake [2930](../previews-annotations-and-gateway/2930-capped-file-tree-exceeds-test-budget.md)); graph designer title (flake [1311](../web-ui/1311-graph-designer-keyboard-undo-edge.md)) |
| 7 | final | natural (— / 362) | 52 / 0 / 98 | None |

The component suite (`mise run test:browser`'s Playwright half,
`e2e/playwright.config.ts`, eight workers, `ORKESTRATOR_E2E_PORT=15422` on the host):

| Run | How | Churn (cycles / events) | Result |
| --- | --- | --- | --- |
| A | host network | self-made (3,438 / 32,205) | Stopped by `test:logged`'s 30-minute deadline at 1,024 of 1,618; 851 failed. 850 of the 854 failure traces hold `net::ERR_NETWORK_CHANGED`; the other four are three ExpandedViewers cases killed at the deadline and the DataSavingGateway mobile case, whose spec turns traces off (flake 1310) |
| B | `unshare -rn` by hand | self-made (2,304 / 27,171) | 1,475 passed, 15 failed, 128 skipped (25.1 min); no failure trace holds `net::ERR_NETWORK_CHANGED`. The 15 are ToolGroupFold, TranscriptPaging, VirtuosoFollow, GitHubCliSetup and DesignCanvas cases at load average 50 to 60 (open flakes 0382, 0793, 0153, 1602, 0483) |
| C | `mise run test:browser` as committed (`scripts/loopback-network.ts`) | self-made (2,200 / 13,222) | The wrapper printed "running in a private loopback-only network namespace". 1,479 passed, 11 failed, 128 skipped (23.4 min); none of the 41 failure directories holds `net::ERR_NETWORK_CHANGED`. The 11 are ToolGroupFold, TranscriptPaging and VirtuosoFollow cases, as in B. The public-site suite did not start because the component suite failed; run alone inside the namespace it passed (16.6 s) |

What changed, so this case no longer explains a failure in these suites:

- `browser-gateway.spec.ts` takes `test` from `browser-test.ts`. Only "the gateway
  serves the renderer's modules to Chromium's own network stack" sets
  `modulesThroughChromium` and loads through Chromium; it makes up to four
  loads in all when its modules were lost only to network changes; under very
  heavy churn its error names this case.
- Every routed context retries a `goto` or `reload` that Chromium aborted with
  `net::ERR_NETWORK_CHANGED`, up to three attempts in all (two retries). A spent
  one-shot login link is renewed before retrying. Navigations are not routed
  through `route.fetch()`, because they carry the login redirect and cookie.
- `mise run test:browser` runs both suites in a private user and network namespace
  with only loopback raised; a host that cannot create one runs them on the host
  network and prints why, and `ORKESTRATOR_E2E_HOST_NETWORK=1` does that on purpose.

Still exposed: `client-outage.spec.ts` (opt-in; it tests the browser's own network
path), the direct case above under heavy churn, and any page navigation started by a
click rather than `goto` or `reload`. None of these failed in runs 3 to 7.

## Recurrence: the service-preview Electron specs at review validation (2026-11-06)

- **Run:** review validation of to-do 0042 task 11 (branch
  `preview-flakes-1bb27c3be3fd-r1`, head `f67ef0666`),
  `mise run test:logged -- --name agent-electron -- mise run test:agent:electron`,
  one worker, beside other builds' Docker work. 20 failed, 8 passed, 40 did not
  run.
- **Failure:** `service-preview-electron.spec.ts` "the tunnel is advertised and a
  service loads through its credentialed loopback ingress" (and, the same way,
  `service-preview-seeded-electron.spec.ts` case 1) failed in `beforeAll` at
  `launchElectron`'s first title check, before any test body: the window stayed
  `Orkestrator AI` for 60 s with `[DesktopStartup] renderer-load-failed`,
  `Failed to fetch dynamically imported module .../src/renderer-entry.tsx` and
  about 70 `net::ERR_NETWORK_CHANGED` lines. The spec already launches with
  `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`, so the aborts came from other Docker
  work on the host, not from its own backend. Serial mode then left the rest of
  each file unrun. 17 of that run's 20 failures were a first title check
  (`toHaveTitle`). Several other failing cases' attached
  `electron-diagnostics.txt` also hold `net::ERR_NETWORK_CHANGED` and
  `renderer-load-failed` lines, but that buffer spans the worker rather than
  one test, so they are not attributed here; the review's triage left them
  undetermined.
- **Change (`9ef37bfd1`):** the service-preview launcher
  (`e2e/agent-testing/service-preview-electron-launch.ts`) waits for the title
  through `waitForRendererStart` (`e2e/agent-testing/electron-startup-recovery.ts`).
  It reloads the window, at most three times within 90 s, only when the window
  shows "Orkestrator couldn’t connect" and the console since the last load holds
  both a failed module import and `net::ERR_NETWORK_CHANGED`; any other startup
  failure fails as before. Console lines are collected on the application's
  context straight after launch, because the first load reports its aborts
  before `firstWindow()` resolves. Every module and request still goes through
  Chromium and main's request hooks, so the 0622 window-close path keeps its
  coverage; routing modules through `route.fetch()`, as the browser suite does,
  would have bypassed those hooks. A reload is recorded in the Electron
  diagnostics and printed as `[startup-recovery]`, which lands in the run's
  `results.json`. Unit tests: `e2e/agent-testing/electron-startup-recovery.test.ts`
  (12), in the root group of `mise run test`.
- **Runs after the change** (beelink, headless, no private network namespace,
  load average 10 to 35, other builds running, 2026-11-06 01:58–02:05 UTC):
  keyboard picker test 10/10 and multi-backend test 10/10 (`--repeat-each=10`),
  the complete owner without the legacy URL tab case
  ([to-do 7061, retired 2026-11-10](../../../architecture/browser-previews.md#desktop-tunnel))
  21/21, `service-preview-seeded-electron.spec.ts` 6/6, and the tunnel case in
  10 separate invocations (10 cold launches) 10/10. No `[startup-recovery]`
  line was printed in any of them: no network change hit a startup in that
  window, so the reload itself is proven by the unit tests, not by a live
  recurrence. This build did not create Docker networks to force one, because
  that churn would abort other builds' Chromium loads on the same host.
- Other Electron specs that wait on their first title (`electron-main.spec.ts`,
  `local-gateway-transport-electron.spec.ts` and the rest of that run's
  failures) were not changed; extending the helper to them is
  [to-do 7062](../../../todo/cross-cutting/7062-electron-specs-recover-network-changed-startup.md).

## 2026-11-06: the annotation Electron spec on beelink (to-do 0044 tasks 5 and 8)

Branch `web-annotation-qualification-a80b5e3582bd-r1` from `main` at
`c1724ab74`; Electron 45.0.0, Playwright 1.64.0, headless
(`ORKESTRATOR_AGENT_TEST_HEADLESS_ELECTRON=1`, display variables removed), one
worker, load average 20–80 with other pipelines' containers starting and
stopping.

- In the host network namespace, `web-annotations-electron.spec.ts` failed in
  its `beforeAll` three times out of three: the first window's title stayed
  `Orkestrator AI` (60 s) with 60 to 120 `net::ERR_NETWORK_CHANGED` lines in
  its Electron diagnostics. Two of those runs selected only the container
  cases.
- Inside a loopback-only namespace, nested so Electron runs as the invoking
  uid (`unshare -rn sh -c "ip link set lo up && exec unshare --user
  --map-user=$(id -u) --map-group=$(id -g) …"`), the whole spec passed: 14
  passed and 1 skipped (175 s) before that branch's new cases, then 16 passed
  and 2 skipped (105 s) with them. The two skips are the container opt-ins,
  which cannot use the namespace because container ports are published in the
  host's. The command is in
  [agent-testing.md](../../../development/agent-testing.md#electron-specs-and-their-display).
- The spec's launcher then adopted `waitForRendererStart` (to-do
  [7062](../../../todo/cross-cutting/7062-electron-specs-recover-network-changed-startup.md)
  task 1). In the host namespace both container cases passed (50 s), each
  after one startup reload for `ERR_NETWORK_CHANGED`. The whole spec there
  still failed once after a recovered startup: 72 `ERR_NETWORK_CHANGED` lines
  and 6 failed module imports when the Kanban view loaded, so the Home
  preview case's `visiblePreview` stayed `true`. Startup recovery does not
  cover later lazy loads.

## 2026-11-06: a Docker spec that needs no UI (to-do 7081 task 1)

Observed on beelink (Linux Engine) on branch
`container-shell-cleanup-9caa78b55d24-r1`, base `ee2cc8423`, one worker,
while other pipelines' containers were starting and stopping.
`e2e/agent-testing/container-terminal-close.spec.ts` (new) failed 2 of its
first 6 single-file runs in `loadAppWithDevRetry`: the project tree did not
render within 30 s, before any terminal command ran. The second failure's trace
holds two `net::ERR_NETWORK_CHANGED` aborts; the first one's artifacts were
overwritten by its passing rerun. The spec drives only backend commands, so it
now signs in through the browser context's request client (the login exchange,
no page navigation), which Chromium's network-change abort cannot reach. It
then passed 6 of 6 under the same churn. Not counted as a recurrence: the
cause was this case's known one, and the fix removes the spec from it.
