# Pane breakpoint fixtures during parallel browser startup

- **ID:** 0351
- **Status:** open
- **Date observed:** 2026-10-17
- **Test:** `split panes keep terminal output, scroll positions and the draft across the breakpoint`
- **File:** `e2e/PaneBreakpoint.spec.ts:98`
- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`
- **Failure:** Three mobile variants failed their unchanged five-second startup
  checks. The pane-tree `moveBefore` and `appendChild fallback` variants found
  zero `.xterm` elements instead of one; the app-shell `moveBefore` variant
  found no `Projects and environments` dialog.
- **Suite result:** 335 passed, 80 skipped, five failed across 420 cases using
  nine browser workers alongside repository tests and other worktrees.
- **Owning-file rerun:** `mise run test:logged -- --name browser-pane-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts --workers=1`
  passed the entire unchanged file (exit 0, 33.8 seconds). Browser owning-file
  reruns ran sequentially, with no shared output-directory collision.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.iMEuX0/browser.log.gz`.

The isolated pass establishes intermittence. Host contention is a hypothesis,
not a confirmed cause. No assertion, timeout, or skip changed.

## Preview path provenance validation — 2026-10-18

`mise run test:logged -- --name browser -- mise run test:browser` ran 432
cases with nine workers: 348 passed, 80 skipped and four failed in 329.2 s.
Both pane-tree variants (`moveBefore` and `appendChild fallback`) found zero `.xterm` elements at the five-second startup assertion.
Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.kKsMFU/browser.log.gz`.

The unchanged owning files passed sequentially with one worker:
`mise run test:logged -- --name browser-rerun -- bunx playwright test --config e2e/playwright.config.ts e2e/DiffViewerMobile.spec.ts e2e/PaneBreakpoint.spec.ts e2e/CloseRetention.spec.ts --workers=1`
(exit 0, 96.6 s logged). Other worktrees and real-stack checks were active on
the host. Startup contention remains an unconfirmed hypothesis; no assertion
or timeout changed.

## Landing-page main merge recurrence — 2026-10-18

`ORKESTRATOR_E2E_PORT=49295 ORKESTRATOR_PUBLIC_E2E_PORT=49296 mise run test:logged -- --name merge-browser-isolated-ports -- mise run test:browser` reported 303 passed, 80 skipped and 49 failed with nine workers alongside other host validation. This owner failed in:

- `split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, appendChild fallback)`
- `split panes keep terminal output, scroll positions and the draft across the breakpoint (pane tree, moveBefore)`
- `split panes keep terminal output, scroll positions and the draft across the breakpoint (in the app shell, moveBefore)`

All 21 failing owners, including this unchanged file, passed with one worker in 428.8 seconds (exit 0). The complete rerun command, individual failure messages and evidence paths are in [0382](0382-component-browser-parallel-load.md). No timeout, assertion, skip or owning source changed.

## Async question prefix review recurrence — 2026-10-18

The nine-worker component suite again found zero terminal elements at the
five-second startup deadline in both mobile pane-tree variants. The suite
reported 357 passed, 80 skipped and three failed (283.1 seconds logged).
Both unchanged owning files passed sequentially with one worker in 35.4 seconds.
Commands and the aggregate evidence path are recorded in
[0173](0173-diff-viewer-parallel-monaco-startup.md#async-question-prefix-review-recurrence--2026-10-18).
No assertion, timeout or skip changed.

## Agent-mail main merge recurrence — 2026-10-19

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](../aggregate-validation-runs/0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.


## Session lifecycle review recurrence — 2026-10-23

Both mobile pane-tree variants again found zero `.xterm` elements at their five-second startup deadline in the nine-worker component suite. The complete unchanged owner passed with one worker on a separate fixture port. Exact aggregate counts, owner command, duration, and evidence are recorded in [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#session-lifecycle-review-validation--2026-10-23). No assertion, timeout, or skip changed.

## Keyboard shortcuts validation — 2026-10-25

The nine-worker `ORKESTRATOR_E2E_PORT=1447 mise run test:logged -- --name browser-suite-isolated-port -- mise run test:browser` run missed both mobile pane-tree terminal startup deadlines at `PaneBreakpoint.spec.ts:121` (zero `.xterm` elements instead of one). Both complete unchanged owning files then passed sequentially with one worker: `ORKESTRATOR_E2E_PORT=1448 mise run test:logged -- --name browser-failed-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts e2e/ToolGroupFold.spec.ts --workers=1 --output output/playwright/browser-failed-owners` (168.5 seconds logged). No pane implementation, assertion, timeout or skip changed. Initial evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.rMjVIf/browser-suite-isolated-port.log.gz`; screenshots/traces: `output/playwright/test-results/PaneBreakpoint-split-panes-*/`.


## Hidden-resume review recurrence — 2026-10-26

The nine-worker component suite repeated the mobile pane-tree `moveBefore` and `appendChild fallback` missing-terminal assertions and the mobile app-shell `moveBefore` missing-projects-drawer assertion, all at five seconds. The complete unchanged file passed with one worker and its own fixture server: `mise run test:logged -- --name pane-owner-final -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts --workers=1 --output output/playwright/resume-pane-owner-final` (22.5 s). An earlier owner attempt reused the full suite's server and lost it when that suite ended; its desktop connection refusals are a harness interruption. Exact aggregate counts, commands and evidence are in [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md#hidden-resume-review-validation--2026-10-26). No owning source, assertion, timeout or skip changed; cause remains unconfirmed.


## Queued-prompt keyboard review recurrence — 2026-10-28

The same unchanged owner had a different symptom in this preparation:
mobile `pane tree, appendChild fallback` reached the transcript assertion at
line 140 but showed `Transcript message 48.` instead of saved
`Transcript message 49.`. This is an anchor mismatch, not the previously
recorded missing-terminal symptom; its root cause is not established.

Preparation's `mise run test:browser` ran 1,006 cases using nine workers,
alongside `mise run test`: 897 passed, 105 skipped and four failed (478.7 s).
Evidence: `.orkestrator/review-artifacts/review-validation-23a7a6f9-6912-45a3-b66d-327817cf8f1d/validation-05.stdout.txt`.

The complete unchanged pane, tool-group and native branch owners ran
sequentially with one worker (133.8 s):

```sh
mise run test:logged -- --name recorded-browser-owners -- bunx playwright test --config e2e/playwright.config.ts AgentLaunchDialog.spec.ts PaneBreakpoint.spec.ts ToolGroupFold.spec.ts --workers=1
```

All pane and tool-group cases passed. The run reported 49 passed, one skipped
and the two established native branch failures (`rel` instead of
`release/2.0`). Compressed evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.t9A9Lw/recorded-browser-owners.log.gz`.
No pane code, assertion, deadline or skip changed.


The exact original browser command was rerun after the queue fixes:

```sh
mise run test:logged -- --name review-repair-browser -- mise run test:browser
```

It reported 904 passed, 105 skipped and three failed in 490.7 s with nine
workers: both known native branch-suggestion cases and the desktop waiting
tool-group overflow case (704 instead of zero). All new queue regressions
passed in both viewports; the pane owner passed. The public-site stage was
not reached because the component suite failed. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.my4kyi/review-repair-browser.log.gz`.


## Account usage sorting review — 2026-10-29

Preparation's nine-worker browser run failed the mobile pane-tree `moveBefore`
and app-shell `appendChild fallback` variants at `PaneBreakpoint.spec.ts:140`:
expected first visible `Transcript message 36.`, received message 35. The exact
aggregate rerun and complete unchanged one-worker PaneBreakpoint owner passed
these cases. This confirms an intermittent anchor mismatch; it does not establish
a startup failure or a root cause. No assertion, deadline, skip or owning code
changed. Commands, suite counts, durations and evidence are recorded in
[0747's account usage review](0747-tool-group-overflow-follow.md#account-usage-sorting-review--2026-10-29).

## Provider-upgrade review — 2026-10-30

The exact `mise run test:browser` rerun repeated the mobile pane-tree
`moveBefore` one-row anchor mismatch (`Transcript message 36.` expected,
message 35 received). Aggregate: 981 passed, 106 skipped, five failed,
8.4 min. Evidence: `orkestrator-test-run.x5T4jf/review-browser-suite.log.gz`
under the host temporary directory. The complete unchanged owner passed
alone with one worker (23.2 s):

```sh
mise run test:logged -- --name review-browser-pane-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts --workers=1
```

No source, assertion, timeout or skip changed; the root cause is not established.


## MCP provenance review — 2026-11-02

The four-worker `ORKESTRATOR_E2E_PORT=15473 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=4 mise run test:logged -- --name browser -- mise run test:browser` run repeated the mobile app-shell `appendChild fallback` anchor mismatch at line 140: expected `Transcript message 49.`, received message 48. The complete unchanged owner passed alone with two workers in 77.7 s:

```sh
ORKESTRATOR_E2E_PORT=15475 mise run test:logged -- --name pane-owning-rerun -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts --workers=2 --output=output/visual-previews/pane-owning-results
```

A separately installed detached `origin/main` at `38d55ee14` also passed the complete owner with two workers in 85.8 s (port 15476, logged name `main-pane-breakpoint`). This confirms intermittence, not a main reproduction of the failure. Aggregate evidence: host temporary directory `orkestrator-test-run.ZlAiMU/browser.log` (compressed at finalization). No pane code, assertion, timeout or skip changed.

Final MCP provenance browser rerun: the wrapper hit its 1,800-second deadline after starting case 995 of 1,206, so no final pass total is available. Both source-layout viewport cases ran; the separate source-layout owner passed. Eleven browser failures were reported before termination, including two design-canvas failures. Compressed evidence: `orkestrator-test-run.ZlAiMU/browser.log.gz` under the host temporary directory, copied to `output/visual-previews/review-validation-evidence/` in the provenance worktree. The public-site stage was not reached. This incomplete run remains failed.

## Auto-pipeline editing review — 2026-11-09

Observed on `review-pipeline-acb77a487d3d-r1`, whose base is
`448e9fffb992c3b6306aa6562c88e23c59fb74d8`. The read-only
`mise run flaky:recurrence -- 0351 --base 448e9fffb` check returned `open`.

The exact command `mise run test:logged -- --name browser -- mise run test:browser`
ran 1,726 component cases with nine workers alongside repository validation:
1,572 passed, 151 skipped and three failed (1,404.3 seconds logged).
The mobile case `split panes keep terminal output, scroll positions and the draft across the breakpoint (in the app shell, appendChild fallback)`
failed at `e2e/PaneBreakpoint.spec.ts:145`: expected first visible
`Transcript message 36.`, received `Transcript message 35.`. The other two
failures were the repeatable remote-sidebar keyboard case in both viewports.
The public-site stage was not reached because the component suite failed.

The complete unchanged pane owner passed alone with one worker in 107.8 seconds:

```sh
mise run test:logged -- --name pane-breakpoint-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts --workers=1 --output output/playwright/auto-pipeline-pane-owner
```

Aggregate evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.0EWA6D/browser.log.gz`.
Failure trace:
`output/playwright/test-results/PaneBreakpoint-split-panes-c1009-shell-appendChild-fallback--mobile-chromium/trace.zip`.
No pane source, assertion, timeout or skip changed. The isolated pass confirms
intermittence; it does not establish the cause of the anchor mismatch.
