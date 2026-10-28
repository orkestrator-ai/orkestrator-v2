# Design canvas times out in the parallel browser suite

- **ID:** 0174
- **Status:** open
- **Date observed:** 2026-09-28
- **Test:** `canvas edits, script isolation, missed events, conflict and reload`
- **File:** `e2e/DesignCanvas.spec.ts:16`
- **Original command:** `mise run test:logged -- --name markdown-browser-suite -- mise run test:browser` (150 tests, six Playwright workers), while the repository suite and other worktrees were running.
- **Failure:** The mobile case reached its 30-second deadline while clicking; the desktop case reached the same deadline while reloading.
- **Isolated rerun:** `mise run test:logged -- --name browser-design-canvas-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1` passed.
- **Second parallel run:** The same full browser command failed both mobile and desktop cases again; the other 99 runnable tests passed, including the new Markdown editor test and the diff viewer cases.
- **Additional run:** Another six-worker browser run timed out in both cases while the repository suite ran on the host; 97 passed, 48 skipped, and 5 failed across 150 cases. The mobile case timed out clicking `Switch tab`, and the desktop case lost its iframe session waiting for `Changed while away`. The owning file passed with two workers. A later browser suite run without the repository suite still timed out in both cases while clicking `Switch tab`; 100 passed, 48 skipped, and 2 failed.
- **2026-09-30 recurrence:** `mise run test:logged -- --name browser -- mise run test:browser` ran 152 cases with six workers while the repository suite was running: 101 passed, 49 skipped, and these two cases failed at the 30-second deadline. The mobile case timed out dispatching the reconnect event at line 206; the desktop case lost its iframe session waiting for `Changed while away` after reload at line 211. Failure evidence: `/tmp/orkestrator-test-run.aD2Vci/browser.log.gz`. `mise run test:logged -- --name design-canvas-recheck -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1` passed both cases (32.1 seconds including runner/server startup). The design canvas code was unchanged; this remains consistent with sensitivity to parallel load.

## Current assessment

The design canvas test appears sensitive to the suite's six-worker parallel load. The design canvas code did not change in this task; investigate the timeout under controlled parallel load.


## Mobile layout follow-up main merge recurrence — 2026-10-16

- **Original command:** `ORKESTRATOR_E2E_PORT=52464 CI=1 mise run test:logged -- --name merge-latest-browser -- mise run test:browser`
  while merging `origin/main` into `mobile-layout-gaps`.
- **Worker configuration:** nine Playwright workers alongside the repository
  suite and other validations on the shared host.
- **Suite counts:** 310 passed, 69 skipped and three failed across 382 cases
  (5.2 minutes). The other failures are recorded in 0173.
- **Failure:** The desktop case `canvas edits, script isolation, missed events, conflict and reload` exhausted its 30000 ms budget at `page.reload()` (line 190).
- **Owning-file rerun:** `ORKESTRATOR_E2E_PORT=52464 CI=1 mise run test:logged -- --name merge-latest-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts e2e/DiffViewerMobile.spec.ts --workers=1`
  passed both unchanged owning files (exit 0, 51.6 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.r2KR91/merge-latest-browser.log.gz`.
- **Disposition:** parallel-only recurrence matching the existing case. Host
  contention remains a hypothesis; no assertion, timeout or skip changed.

## Unread-toast main merge recurrence — 2026-10-16

- **Original command:** `mise run test:logged -- --name merge-browser -- mise run test:browser`, nine Playwright workers alongside the full non-iOS suite and isolated browser checks.
- **Failure:** The desktop `canvas edits, script isolation, missed events, conflict and reload` case exceeded its 30000 ms deadline.
- **Suite counts:** 320 passed, 69 skipped, three failed across 392 cases (294.6 s).
- **Owning-file rerun:** `mise run test:logged -- --name merge-design-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1` passed the unchanged file in 23.7 s (exit 0).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.o1XC99/merge-browser.log.gz`.
- **Disposition:** confirmed recurrence. Earlier overlapping focused browser invocations shared an output directory and are discarded as invalid evidence; the successful rerun ran sequentially. Host contention remains an unconfirmed hypothesis.

## Ordering review (2026-10-16)

Reviewed with the backend design flakes 0193, 0215 and 0218, which were test
artefacts, not ordering bugs. The backend hint order this spec relies on is
now pinned in `core/design/sync.test.ts`: per-canvas commit order, and status
hints that never overtake their commit. This case was not rerun. Its symptoms
(Playwright action timeouts, a disabled picker, an unmounted page) are client
or profile timing, and nothing here implicates the design change feed. It
stays open; see the follow-up in
[0036-design-canvas-qualification.md](../../../todo/design-canvas/0036-design-canvas-qualification.md).

## Execution-policy conformance main merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name merge-browser -- mise run test:browser`; nine Playwright workers alongside the non-iOS suite.
- **Failure:** Both mobile and desktop cases exceeded 30000 ms. The desktop case was waiting for the export button.
- **Suite counts:** 323 passed, 69 skipped, four failed across 396 cases (247.6 seconds). The native branch-picker failure also failed alone and is not classified as a flake.
- **Owning-file rerun:** `mise run test:logged -- --name merge-design-browser-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1` passed the unchanged file (exit 0) in 15.9 seconds. Browser reruns ran sequentially.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.2CnKQx/merge-browser.log.gz`.
- **Assessment:** intermittent under the aggregate browser run; root cause remains unconfirmed. No assertion, timeout or skip changed.

## Pane reset review recurrence — 2026-10-17

`mise run test:logged -- --name renderer-browser -- mise run test:browser`
(nine workers, alongside repository/live Docker validation) timed out in the
mobile case at 30 seconds while clicking the `text-align` center option.
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.8XBgi1/renderer-browser.log.gz`.

The first focused rerun overlapped another Playwright invocation using the
same artifact directory and failed during trace close with ENOENT; that
harness collision does not establish a product failure or an isolated pass.
`mise run test:logged -- --name design-browser-final -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1 --output output/playwright/pane-reset-design`
then passed both unchanged viewport cases in 27.9 seconds. No assertion,
timeout or skip changed.

## Agent-test credential review recurrence — 2026-10-17

The nine-worker `mise run test:browser` run timed out in the unchanged mobile
case at 30000 ms (335 passed, 80 skipped, five failures across 420 cases).
`mise run test:logged -- --name browser-design-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1`
then passed the owning file in 27.2 seconds. Browser reruns ran sequentially.
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.iMEuX0/browser.log.gz`.


## Public landing-page review recurrence — 2026-10-18

The desktop `canvas edits, script isolation, missed events, conflict and reload`
case timed out after 30000 ms in `mise run test:logged -- --name browser -- mise run test:browser`
(nine workers, alongside the full unit suite and other worktrees on macOS arm64).
The component run finished with 339 passed, 80 skipped and 11 failed; nine
failures were trace-file ENOENT errors caused by an overlapping rerun sharing
its output directory, separate from the Monaco and canvas timeouts.
Evidence: `orkestrator-test-run.OwH8yL/browser.log.gz` under the host temporary directory.

`ORKESTRATOR_E2E_PORT=1443 mise run test:logged -- --name canvas-browser-rerun -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1 --output=output/playwright/canvas-rerun`
passed both unchanged viewport cases (27.2 seconds logged). This confirms
intermittence for the canvas timeout. Shared-host contention remains a hypothesis;
no canvas source, assertion, timeout, or skip changed.

The two files affected by the artifact collision also passed unchanged with
one worker and separate output directories: `e2e/AgentUsage.spec.ts` in 27.5 s
(`--output=output/playwright/usage-rerun`) and
`e2e/BackgroundTaskOutcome.spec.ts` in 43.5 s
(`--output=output/playwright/background-rerun`). Both used
`mise run test:logged -- --name <label> -- bunx playwright test --config e2e/playwright.config.ts <owning-file> --workers=1 --output=<directory>`.
These ENOENT failures were caused by the overlapping validation commands,
not evidence of intermittent product behavior.


## Landing-page main merge recurrence — 2026-10-18

`ORKESTRATOR_E2E_PORT=49295 ORKESTRATOR_PUBLIC_E2E_PORT=49296 mise run test:logged -- --name merge-browser-isolated-ports -- mise run test:browser` reported 303 passed, 80 skipped and 49 failed with nine workers alongside other host validation. This owner failed in:

- `canvas edits, script isolation, missed events, conflict and reload`
- `canvas edits, script isolation, missed events, conflict and reload`

All 21 failing owners, including this unchanged file, passed with one worker in 428.8 seconds (exit 0). The complete rerun command, individual failure messages and evidence paths are in [0382](../web-ui/0382-component-browser-parallel-load.md). No timeout, assertion, skip or owning source changed.

## CLI matrices second main merge — 2026-10-18

The desktop canvas case timed out at 30 seconds in the aggregate, and both mobile and desktop canvas cases timed out in the unchanged one-worker owner. This observation remains unresolved. Full commands, 339-pass/80-skip/13-failure aggregate and 96-pass/15-skip/three-failure focused counts, and evidence paths are in [0382](../web-ui/0382-component-browser-parallel-load.md). No implementation, assertion, timeout or skip changed.

## Keep-open picker verification recurrence — 2026-10-18

- **Original observation:** verification of the keep-open model picker branch ran the full component browser suite: 351 passed, 80 skipped, and this case timed out at 30 seconds. A single detached `origin/main` run passed it, so the timeout was not yet reproduced on the target branch.
- **Target-branch reproduction:** `CI=1 ORKESTRATOR_E2E_PORT=<port> bunx playwright test --config e2e/playwright.config.ts` was run concurrently on detached `origin/main` (`62c5c696`, port 1531) and on the branch (port 1532), nine workers each, on an 18-core host.
  - `origin/main`: 359 passed, 80 skipped, one failed (4.5m). `[mobile-chromium]` exceeded 30000 ms, waiting on `expect.poll(...).toBe(8)` at `e2e/DesignCanvas.spec.ts:244`.
  - Branch: 350 passed, 80 skipped, two failed (4.4m). Both viewport cases exceeded 30000 ms at the same line 244 poll.
- **Uncontended runs:** `origin/main` alone passed the full browser suite (360 passed, 80 skipped, 2.4m), and passed the owning file with `--repeat-each=12 --workers=12` (24 passed, 46.9 s). The branch owning file passed alone (two passed, 12.4 s).
- **Evidence:** `/tmp/ork-main-repro.X5W2/ab-main.log.gz` and `/tmp/ork-main-repro.X5W2/ab-branch.log.gz`.
- **Disposition:** the timeout reproduces on unchanged `origin/main` under the same contention. The branch changes only the agent model picker, which this fixture does not render. No canvas source, assertion, timeout, or skip changed.

## Agent-mail review validation recurrence — 2026-10-19

- `mise run test:logged -- --name browser -- mise run test:browser` timed out both unchanged viewport cases in the five-worker run alongside repository and isolated-browser validation (346 passed, 80 skipped, six failed in 7.5 minutes).
- The unchanged owning file passed alone: `mise run test:logged -- --name browser-design-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1 --output output/playwright/mail-review-design` (exit 0, 19.2 seconds). Browser owner reruns ran sequentially.
- Evidence: `/var/folders/w0/qhqx9hyx0kz0625nb35b7vv40000gq/T/orkestrator-test-run.xmUT5O/browser.log.gz`.
- No timeout, assertion or skip changed. Host contention is a possible contributor, not an established cause.

## Agent-mail main merge recurrence — 2026-10-19

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](../aggregate-validation-runs/0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.

## Command-node review validation recurrence — 2026-10-21

- `ORKESTRATOR_E2E_PORT=45673 ORKESTRATOR_PUBLIC_E2E_PORT=45674 mise run test:logged -- --name review-browser-confirm -- mise run test:browser` reported 369 passed, 80 skipped, and three failures in 414.1 seconds while repository and isolated browser validation also ran.
- This unchanged owning file failed at its existing deadline. All three unchanged owners then passed sequentially with one worker: `ORKESTRATOR_E2E_PORT=45673 ORKESTRATOR_PUBLIC_E2E_PORT=45674 mise run test:logged -- --name review-browser-three-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts e2e/DesignCanvas.spec.ts e2e/MonacoRuntime.spec.ts --workers=1` (exit 0, 85.5 seconds).
- Evidence: private compressed logs under the host temporary directory `orkestrator-test-run.tj4puK`. The pane case found no `.xterm` at line 121; the desktop canvas exceeded 30 seconds; the desktop Monaco fixture found no editor within five seconds.
- Host scheduling or fixture startup contention is a hypothesis. No implementation, assertion, deadline, or skip in these owners changed.

## Transcript-scroll main merge validation — 2026-10-21

- `mise run test:logged -- --name merge-browser -- mise run test:browser` ran nine workers and reported 373 passed, 81 skipped and two failures in 427.3 s; the desktop canvas exceeded its 30-second deadline. The other failure was Monaco startup (0517).
- The unchanged desktop owner passed with one worker in `mise run test:logged -- --name merge-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts e2e/MonacoRuntime.spec.ts --project=desktop-chromium --workers=1` (one passed, Monaco failed, 36.4 s logged).
- Evidence: host temporary directories `orkestrator-test-run.2Itj5O` and `orkestrator-test-run.SL0qW8`. Shared-host load is a hypothesis; no source, assertion, timeout or skip changed.

## Controlled-load reproduction attempt — 2026-10-22

Branch `todo-0036-design-canvas-qualification-1477f37ca3cf` from `b83ae534`, on an Apple M5 Max (18 cores) shared with other worktrees and a production Orkestrator instance.

- **Command:** `ORKESTRATOR_E2E_PORT=47371 bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts e2e/DesignCanvasAccessibility.spec.ts --workers=6 --repeat-each=3`.
  - Run three times at host load averages 41–64.
  - Run once more with 18 `yes` busy processes added (load about 60).
- **Result:** this case passed in every run, 24 in total across both viewports, along with the full nine-worker `mise run test:browser` runs. The only failures were in the new accessibility spec, and were fixed in the same change (see [0036](../../../todo/design-canvas/0036-design-canvas-qualification.md#accessibility)).
- **Assessment:** host CPU contention alone did not reproduce the timeout, so there is still no basis for choosing between a client wait on an observable state and a product fix. The case stays open. No implementation, assertion, timeout or skip changed.

## Sidebar main-merge validation — 2026-10-22

- `mise run test:logged -- --name merge-browser -- mise run test:browser` ran nine workers against the initial `c17f1c8d5` merge: 399 passed, 81 skipped, two failed (362.5 s). The desktop canvas exceeded 30 s while clicking Switch tab at line 234; Monaco was the other failure.
- `mise run test:logged -- --name merge-canvas-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1` passed the complete unchanged owner, exit 0 in 14.0 s.
- Evidence: `orkestrator-test-run.mgE8Fb/merge-browser.log.gz` under the host temporary directory. No assertion, deadline or skip changed; host contention remains a hypothesis.


## Repository-sidebar review validation — 2026-10-22

- **Original command:** `mise run test:logged -- --name browser-suite -- mise run test:browser`, nine workers alongside repository validation on the shared host. The component suite reported 437 passed, 85 skipped and four failed in 9.4 minutes. Both unchanged canvas viewport cases exceeded the 30-second test deadline. The other failures were Monaco startup and a new sidebar test's reload synchronization, corrected in the same change.
- **Complete unchanged owner:** `mise run test:logged -- --name design-canvas-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1 --output=output/playwright/design-owner` passed both viewport cases, exit 0 in 39.9 seconds.
- **Evidence:** host temporary directory `orkestrator-test-run.QC9tF3/browser-suite.log.gz`; original traces under `output/playwright/test-results/DesignCanvas-*`. The sidebar fixes are commit `6d6f9b83f`; its final focused browser rerun passed all 30 cases.
- **Assessment:** confirmed intermittent recurrence. Host or fixture contention remains a hypothesis. No canvas implementation, assertion, timeout or skip changed; the original aggregate remains failed.


## Leaf coordinator review validation — 2026-10-24

- `mise run test:logged -- --name browser-tests -- mise run test:browser` ran nine workers alongside repository checks: 537 passed, 101 skipped and four failed (282.4 s). The unchanged mobile canvas case could not find Element inspector at line 98 within five seconds. The other failures were mobile design history and both native branch-suggestion cases; see [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md).
- The complete unchanged owner passed both viewport cases alone: `ORKESTRATOR_E2E_PORT=14373 mise run test:logged -- --name canvas-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1 --output=output/playwright/canvas-owner` (exit 0, 16.3 s).
- Evidence: host temporary artifact `orkestrator-test-run.E4tM8D/browser-tests.log.gz`. No canvas implementation, assertion, timeout or skip changed. Shared-host or fixture contention remains a hypothesis; the original aggregate remains failed.


## Leaf grouping main merge — 2026-10-24

- `ORKESTRATOR_E2E_PORT=53444 ORKESTRATOR_PUBLIC_E2E_PORT=53445 mise run test:logged -- --name merge-browser -- mise run test:browser` ran nine workers alongside repository validation on the shared host: 544 passed, 102 skipped and six failed in 9.4 minutes. Both canvas viewport cases exceeded the 30-second deadline; mobile was waiting to click Close inspector.
- `ORKESTRATOR_E2E_PORT=59580 mise run test:logged -- --name merge-design-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1 --output=output/agent-testing/merge-design-owner` passed the complete unchanged owner, exit 0 in 34.3 s.
- Evidence: host temporary artifact `orkestrator-test-run.EtTM9R/merge-browser.log.gz`; original traces under `output/playwright/test-results/`. No implementation, assertion, timeout or skip changed. The original aggregate remains failed; see [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md) for the other owners.


## Mixed-version compatibility main merge — 2026-10-24

Both viewport cases exceeded the 30-second deadline in the nine-worker component aggregate (565 passed, 102 skipped, 15 failed). The complete unchanged owner passed with one worker on port 55723 in 45.7 s. Full commands, worker configuration, original failures and artifacts are recorded in [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#mixed-version-compatibility-main-merge--2026-10-24). No assertion, timeout or skip changed.

## Agent accounts main merge — 2026-10-24

`mise run test:logged -- --name merge-browser-fixed -- mise run test:browser`
(nine workers) reported 577 passed, 102 skipped and seven failed in 694.4 s.
The complete unchanged owner passed in the sequential one-worker command
`mise run test:logged -- --name merge-browser-owners -- bunx playwright test --config e2e/playwright.config.ts AgentUsage.spec.ts DesignCanvas.spec.ts PaneBreakpoint.spec.ts AgentLaunchDialog.spec.ts MonacoRuntime.spec.ts VirtuosoFollow.spec.ts --workers=1`.
That combined command reported twenty passed, four skipped and two failures
(127.0 s), both in AgentLaunchDialog; this owner had no failures. Evidence:
`orkestrator-test-run.BIyzun/merge-browser-fixed.log.gz` and
`orkestrator-test-run.ngoXeT/merge-browser-owners.log.gz` below the host temporary
directory. No assertion, timeout, skip or implementation changed in this owner.

The mobile canvas reached 30 seconds while clicking Switch tab.

## Design-agent links refresh through d6ed0717d — 2026-10-24

The nine-worker `mise run test:browser` run repeated failures in this owner; the complete unchanged owner passed across both viewports with one worker in 23.0 s. Command: `ORKESTRATOR_E2E_PORT=52890 mise run test:logged -- --name design-links-browser-owner-design -- bunx playwright test --config e2e/playwright.config.ts DesignCanvas.spec.ts --workers=1 --output output/playwright/design-links-owner-design`. The aggregate had 496 passes, 89 failures and 101 skips. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the parents and original evidence. No assertion, deadline or skip changed.

## Selected-machine settings validation — 2026-10-24

`ORKESTRATOR_E2E_PORT=15374 ORKESTRATOR_PUBLIC_E2E_PORT=15375 mise run test:logged -- --name settings-browser-components -- mise run test:browser`
used nine component workers while repository and isolated-stack validation were
also running. The mobile owner hit the 30-second deadline at line 245: the
replacement iframe element's display was empty rather than `inline-block`.
The aggregate reported 584 passed, 102 skipped and six failed (546.9 s logged).
Two failures were new settings fixtures corrected in this change; two were the
known native branch-suggestion failures, which also remained non-green in a
one-worker owner run, and the other was the recorded scroll-follow recurrence.

The complete unchanged canvas owner passed both viewports alone in 16.5 s:
`ORKESTRATOR_E2E_PORT=15376 mise run test:logged -- --name settings-design-canvas-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1 --output output/playwright/settings-design-canvas-owner`.
Evidence: host temporary directory
`orkestrator-test-run.xfA2Oh/settings-browser-components.log.gz` and
`output/playwright/test-results/DesignCanvas-canvas-edits--cfd2e--events-conflict-and-reload-mobile-chromium/`.
No canvas implementation, assertion, timeout or skip changed.

## Resume cleanup coverage validation — 2026-10-25

The mobile replacement-iframe assertion exceeded the 30 s test deadline in the five-worker component run. Both unchanged owner viewport cases passed in the sequential one-worker owner rerun.

The original component run reported 734 passed, 102 skipped and six failed. The six complete owning files ran sequentially with one worker: 80 passed, one skipped and three failed (307.4 s). Exact commands, per-owner results and artifact paths are in [0822](../aggregate-validation-runs/0822-resume-cleanup-coverage-validation.md). No owning implementation, assertion, deadline or skip changed.

## Root cause and fix — 2026-10-25

Reproduced without host load through `ORKESTRATOR_E2E_DESIGN_CPU_THROTTLE`
(CDP `Emulation.setCPUThrottlingRate` on the page, added to the spec), with
`bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts
--workers=1`:

- Rate 4, `--repeat-each=5`: 2 of 10 failed at the 30 s deadline, both late
  (the export dialog's **Done**, line 278).
- Rate 8, `--repeat-each=5`: 10 of 10 failed at the deadline, each at a
  different step (lines 147–202).
- Rate 4, `--repeat-each=3 --timeout=120000`: four runs took 29.6–38.8 s; two
  stalled for the full 120 s clicking **Apply styles** (line 209) with
  "element is not enabled".

The test filled a style, then landed another client's edit through the Bun
service, then clicked **Apply styles** expecting a revision conflict. When the
edit's live hint reached the page before the click, the inspector did the
right thing and disabled Apply styles for the stale selection, so the click
waited until the deadline. On a loaded host that wait, or plain slowness,
spent the 30 s budget at whichever step came next, which is why the reported
failing step varied.

Fix (test only, every assertion kept): the other client's edit now lands
inside the page's `design_prepare` for Apply styles, before the command is
forwarded, so the server always moves on while this edit is in flight. After
the fix: rate 4 passed 10 of 10 (24.3–38.3 s, 120 s deadline) and the
unthrottled file passed 6 of 6 at the default deadline (7.2–11.7 s). The
8x failures are the 30 s budget under emulated slowdown well beyond the
suite's and were not chased. A quiet nine-worker `mise run test:browser` run
to confirm no recurrence is listed in
[0036](../../../todo/design-canvas/0036-design-canvas-qualification.md).


## Shared Codex state review fixes — 2026-10-26

Reopened for a recurrence after the 2026-10-25 fix. Both viewport cases reached their deadlines in the nine-worker component browser suite on `74841142b`; the mobile case was waiting for the replacement iframe element's `display: inline-block`. The complete unchanged owner passed both viewport cases with one worker in 60.6 s: `ORKESTRATOR_E2E_PORT=62459 mise run test:logged -- --name codex-auth-owner-designcanvas -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts --workers=1 --output output/playwright/codex-auth-owner-designcanvas`. This does not establish that the earlier Apply styles race returned; the new stall's cause remains unknown. The original command and broader results are in [0995](../aggregate-validation-runs/0995-agent-accounts-sign-in-0003-qualification.md). No implementation, assertion, timeout or skip changed in this owner.


## Uniform app shortcuts review recurrence — 2026-10-28

The nine-worker component aggregate reported this case again (both 30-second
DesignCanvas deadlines for 0174, and mobile unrendered-frame selection for
1249). The complete unchanged DesignCanvas, DesignCanvasAccessibility and
SetupRecovery owners passed sequentially with one worker: 20 passed, exit 0,
77.0 seconds. Command:

```sh
mise run test:logged -- --name design-and-layer-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts e2e/DesignCanvasAccessibility.spec.ts e2e/SetupRecovery.spec.ts --workers=1
```

No assertion, timeout or skip changed. The cause remains unestablished; this
case stays open. Aggregate counts and artifact paths are recorded in
[0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#uniform-app-shortcut-review-repairs--2026-10-28).
