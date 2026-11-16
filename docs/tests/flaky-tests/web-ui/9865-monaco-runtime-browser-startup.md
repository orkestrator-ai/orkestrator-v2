# Monaco runtime fixture startup deadline

- **ID:** 9865
- **Status:** resolved
- **Date observed:** 2026-10-21
- **Test:** `real Monaco defaults and every Vite worker route initialize in Chromium`
- **File:** `e2e/MonacoRuntime.spec.ts:3`
- **Failure:** the desktop fixture's `.monaco-editor` was absent at the five-second deadline (line 25).

## Command-node review validation recurrence — 2026-10-21

- `ORKESTRATOR_E2E_PORT=45673 ORKESTRATOR_PUBLIC_E2E_PORT=45674 mise run test:logged -- --name review-browser-confirm -- mise run test:browser` reported 369 passed, 80 skipped, and three failures in 414.1 seconds while repository and isolated browser validation also ran.
- This unchanged owning file failed at its existing deadline. All three unchanged owners then passed sequentially with one worker: `ORKESTRATOR_E2E_PORT=45673 ORKESTRATOR_PUBLIC_E2E_PORT=45674 mise run test:logged -- --name review-browser-three-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/PaneBreakpoint.spec.ts e2e/DesignCanvas.spec.ts e2e/MonacoRuntime.spec.ts --workers=1` (exit 0, 85.5 seconds).
- Evidence: private compressed logs under the host temporary directory `orkestrator-test-run.tj4puK`. The pane case found no `.xterm` at line 121; the desktop canvas exceeded 30 seconds; the desktop Monaco fixture found no editor within five seconds.
- Host scheduling or fixture startup contention is a hypothesis. No implementation, assertion, deadline, or skip in these owners changed.

## Transcript-scroll main merge validation — 2026-10-21

- `mise run test:logged -- --name merge-browser -- mise run test:browser` ran nine workers and reported 373 passed, 81 skipped and two failures in 427.3 s. The desktop Monaco editor was absent at the five-second deadline (`e2e/MonacoRuntime.spec.ts:25`).
- The same unchanged owner failed both the one-worker combined rerun with DesignCanvas (36.4 s logged, one pass/one failure) and `mise run test:logged -- --name merge-monaco-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/MonacoRuntime.spec.ts --project=desktop-chromium --workers=1` (one failure, 20.2 s logged). Those focused reruns still failed at the same deadline.
- Evidence: host temporary directories `orkestrator-test-run.2Itj5O`, `orkestrator-test-run.SL0qW8` and `orkestrator-test-run.PRdnBF`. No source, assertion, timeout or skip changed.
- After the complete aggregate ended, the unchanged owner passed: `mise run test:logged -- --name merge-monaco-after-aggregate -- bunx playwright test --config e2e/playwright.config.ts e2e/MonacoRuntime.spec.ts --project=desktop-chromium --workers=1` (exit 0, 3.9 s logged). Shared-host or startup contention remains a hypothesis.

## Sidebar main-merge validation — 2026-10-22

- `mise run test:logged -- --name merge-browser -- mise run test:browser` ran nine workers against the initial `c17f1c8d5` merge: 399 passed, 81 skipped, two failed (362.5 s). The desktop editor was absent at the five-second deadline at line 25.
- After refreshing the pending merge to `7e051d955`, `mise run test:logged -- --name merge-monaco-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/MonacoRuntime.spec.ts --workers=1` passed the complete unchanged owner, exit 0 in 4.0 s.
- Evidence: `orkestrator-test-run.mgE8Fb/merge-browser.log.gz` under the host temporary directory. No assertion, deadline or skip changed; startup or host contention remains a hypothesis.


## Repository-sidebar review validation — 2026-10-22

- **Original command:** `mise run test:logged -- --name browser-suite -- mise run test:browser`, nine workers alongside repository validation on the shared host. The component suite reported 437 passed, 85 skipped and four failed in 9.4 minutes. The desktop Monaco editor was absent at the existing five-second deadline; both canvas viewport cases and a sidebar test reload wait were the other failures.
- **Complete unchanged owner:** `mise run test:logged -- --name monaco-runtime-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/MonacoRuntime.spec.ts --workers=1 --output=output/playwright/monaco-owner` passed both viewport cases, exit 0 in 6.2 seconds.
- **Evidence:** host temporary directory `orkestrator-test-run.QC9tF3/browser-suite.log.gz`; original trace under `output/playwright/test-results/MonacoRuntime-*`. Sidebar fixes are commit `6d6f9b83f` and the final focused sidebar browser rerun passed all 30 cases.
- **Assessment:** confirmed intermittent recurrence. Host or fixture startup contention remains a hypothesis. No Monaco implementation, assertion, timeout or skip changed; the original aggregate remains failed.


## Runtime-state ownership main merge — 2026-10-24

`ORKESTRATOR_E2E_PORT=61933 mise run test:logged -- --name merge-components-bounded -- bunx playwright test --config e2e/playwright.config.ts --workers=2` ran all 682 cases: 575 passed, 102 skipped and five failed (1188.3 s logged), alongside other validating worktrees. Evidence: host temporary artifact `orkestrator-test-run.Qvr7ev/merge-components-bounded.log.gz`. The desktop editor was absent at the five-second deadline. `ORKESTRATOR_E2E_PORT=61933 mise run test:logged -- --name merge-monaco-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/MonacoRuntime.spec.ts --workers=1 --output output/playwright/merge-monaco-owner` passed the complete unchanged owner (7.0 s logged). This confirms a recurrence; no assertion, timeout or skip changed.


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

The desktop Monaco fixture missed its startup deadline.

## Environment-list UI main merge — 2026-10-24

The aggregate recurrence passed in the complete unchanged owning-file rerun. Exact commands, durations, merge parents, aggregate results and evidence are retained in [0790](../aggregate-validation-runs/0790-environment-list-main-merge-validation.md). No implementation, assertion, timeout or skip changed.

## Triage note (2026-11-15)

Class A candidate (Playwright's default 5 s assertion / 30 s test deadline expiring on a loaded host). Not changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`expect.timeout` and `timeout`), but that config is shared with every group's component browser specs, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced; the browser suite was not run. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** every recorded failure is a Playwright default deadline
  expiring on a loaded host while the spec waited on a real signal: `.monaco-editor` not visible within the 5 s `expect` default (line 25) while Monaco started.
  No wrong value, crash or lost input is recorded. `e2e/MonacoRuntime.spec.ts` passes no smaller
  timeout of its own at the failing calls.
- **Fix:** `e2e/playwright.config.ts`, which runs this component spec, now sets
  `timeout: 120_000` (was Playwright's 30 s default) and
  `expect: { timeout: 30_000 }` (was 5 s). Navigations have no timeout of
  their own, so they are bounded by the 120 s test budget. Both budgets are
  hang watchdogs on real signals, not speed checks.
- **Reproduced:** no — the recorded failure was not reproduced. The evidence
  is a rerun, under the new config, of the component specs that had failed in
  a loaded run (112 passed); that is not a targeted reproduction of this case,
  and a raised budget is weaker evidence than a reproduced fix.
- **Reopen:** a recurrence that hangs near the new budgets (120 s test, 30 s
  assertion) means the signal never arrived rather than arrived late; reopen
  this case.
