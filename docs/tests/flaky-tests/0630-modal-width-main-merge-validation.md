# Modal-width main-merge validation

- **ID:** 0630
- **Status:** open
- **Observed:** 2026-10-21
- **Merge baseline:** `1a365c12069dc8f8b2333a9cc608434378e28f8c`
- **Merged main:** `4608d8299`
- **Scope:** All 311 merged paths changed from the pre-merge HEAD, plus this validation record.
- **Conflict:** `PreviewServiceDialog.tsx` retains `sm:max-w-md` and main's
  `onCloseAutoFocus` callback. No test assertion, timeout or skip was changed.

## Confirmed flakes

The complete repository command (`mise run test`, through `test:logged`)
finished in 1023 seconds. Bridge and protocol-lockfile groups passed; workspace
and root/support groups failed on the five cases discussed below. No group
hit its watchdog or output bound. The workspace package results were: protocol
1721 passed, public web 41 passed, desktop 1105 passed, toolchain 91 passed,
CLI 148 passed, web 8618 passed/1 failed, and backend 9903 passed/2 failed.
The root/support group reported 3171 passed, 1 skipped, 2 failed and one error
associated with the disk-report timeout.

The component browser command used dedicated ports because port 1422 belonged
to another checkout:

```sh
ORKESTRATOR_E2E_PORT=21422 ORKESTRATOR_PUBLIC_E2E_PORT=24423 mise run test:logged -- --name merge-browser-owned-port -- mise run test:browser
```

It reported 367 passed, 80 skipped and seven mobile failures: one DesignCanvas
timeout, three PaneBreakpoint startup failures, two SetupRecovery missing-overlay
failures, and one TerminalCornerToolbar touch-history failure. Every complete,
unchanged owning file then passed sequentially with one worker (74.6 seconds):

```sh
ORKESTRATOR_E2E_PORT=21422 mise run test:logged -- --name merge-browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts e2e/PaneBreakpoint.spec.ts e2e/SetupRecovery.spec.ts e2e/TerminalCornerToolbar.spec.ts --workers=1
```

The public-site suite, which the initial component failure prevented from
starting, passed separately with `ORKESTRATOR_PUBLIC_E2E_PORT=24423` and
`--config e2e/public-site/playwright.config.ts --workers=1` (18.4 seconds).
Related existing cases are 0174, 0342, 0351 and 0237.

The repository aggregate also reported these failures whose unchanged owners
passed on rerun:

| Owner | Aggregate failure | Rerun |
| --- | --- | --- |
| `tests/unit/disk-report.test.ts` | Five-second timeout, subprocess status null | Passed in a sequential two-owner run with Pi vendoring; the Pi case still failed. Related case 0259. |
| `apps/web/src/components/chat/rich-transcript.long-fixture.test.tsx` | `bounded concurrency and queues; caches converge within bounds over 20 scroll/expand cycles` exceeded 120 seconds | Whole owner passed alone in 44.1 seconds. |
| `apps/backend/tests/tmux-commands.test.ts` | `generated blocking hooks use an integer timeout and fail closed on expiry` expected three timeout records, observed two | Whole owner passed alone in 16.2 seconds. Related case 0141. |
| `apps/backend/src/core/agent-accounts.test.ts` | `the same login cannot be added twice` left an extra account directory | Whole owner passed alone in 8.8 seconds. Related case 0239. |

Reruns used `mise run test:logged` and `bun test` with explicit file paths and
`--parallel=1 --only-failures`; the backend owner used the Node-only preload.
Host contention is a hypothesis, not an established cause.

The isolated-stack browser command reported 28 passed, 42 skipped and one
failure in `browser-gateway.spec.ts`: the narrow host-picker case could not
click Repository settings within 15 seconds. Its disposable profile
`qa-browser-d853a9d5-266` was stopped and reset by the runner. The complete,
unchanged gateway owner then passed alone on a fresh credential-free fixture
profile in 188.1 seconds:

```sh
ORKESTRATOR_AGENT_TEST_PROFILE=merge-modal-gateway-173c590 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-modal-gateway-173c590 mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1
```

That profile was stopped and reset after the rerun. This occurrence is a
confirmed flake; earlier unresolved gateway observations remain in case 0623.

## Pi vendoring reruns

Pi runtime vendoring timed out in the aggregate and the first two unchanged owner
reruns, including one after the component and isolated-stack browser suites
finished. The latter reported three passed and one failed in 31.8 seconds.
After the entire repository aggregate finished, the complete unchanged owner
passed alone in 10.9 seconds:

```sh
mise run test:logged -- --name merge-pi-owner-after-aggregate -- bun test ./tests/unit/pi-bridge-vendor.test.ts --parallel=1 --only-failures
```

This final rerun establishes a flake for this occurrence (related cases 0178
and 0514). No Pi implementation, dependency or assertion changed during this
merge. Every failing owning file eventually passed unchanged; the original
aggregate and browser suite exit statuses remain failed.

## Evidence

Private artifacts under the host temporary directory:

- `orkestrator-test-run.SO82HY/merge-browser-owned-port.log.gz`
- `orkestrator-test-run.jDNmj8/`: repository aggregate group logs.
- `orkestrator-test-run.LnLLy3/merge-root-failed-owners.log.gz`: disk-report
  passed, Pi runtime staging still hit its 30-second deadline (8 passed, 1 failed).
- `orkestrator-test-run.B5TowQ/merge-pi-owner-after-browser.log.gz`: Pi staging
  remained non-green on the second owner rerun, before the final passing rerun.
- `orkestrator-test-run.P7rIlw/merge-real-stack-browser.log.gz`: isolated-stack
  browser failure and successful profile cleanup.

Passing checks also included both frozen dependency installations, version drift,
formatting after the imported ActionBar prose was formatted, lint, all typechecks,
all workspace builds, focused modal regression tests and the complete Electron
suite. iOS, Docker opt-in and billed-provider suites were outside this merge's
validation scope.

## Subsequent main refresh — 2026-10-21

Merged `40dd964b1` into pre-merge HEAD `26004e12e`. The only conflict was the
index: main and this branch had independently allocated 0626. Both records
were retained; this record became 0627. The register test also caught the
missing `Status` field in this earlier record; adding it made the complete
unchanged `tests/unit/flaky-tests-index.test.ts` owner pass (1.5 seconds).
That was a documentation defect, not a flake.

The 49 changed paths, including automatically merged source and tests, were
included in validation. Formatting, lint, all typechecks and focused renderer
owners passed. No runtime code, assertion, timeout or skip was changed to
address the observations below.

- `main-refresh-browser` (`mise run test:browser`, dedicated ports 21422 and
  24423) reported 373 passed, 81 skipped and 16 failures. All complete affected
  owners passed unchanged sequentially with one worker in 150.6 seconds:
  `AgentUsage`, `DesignCanvas`, `GitHubCliSetup`, `NativeHeldSend`,
  `PaneBreakpoint`, `SetupRecovery`, `ClaudeInteractions`, `GlobalStyles` and
  `MonacoRuntime` under `e2e/`. Public-site browser coverage passed separately
  with one worker in 33.0 seconds.
- The isolated full browser suite reported 27 passed, 42 skipped and two
  failures: the narrow gateway picker and the design-canvas hidden-file pane
  persistence assertion (the latter matches case 0380). The complete gateway
  owner passed unchanged on fresh profile `merge-main-refresh-173c590` in
  272.2 seconds. The complete design owner passed through
  `mise run test:agent:design:isolated` in 69.3 seconds. All three disposable
  profiles were stopped and reset.
- The aggregate fake Codex subprocess probe exceeded five seconds; its complete
  unchanged owner passed alone with the Node preload in 0.4 seconds (case 0210).
- Disk-report timed out at five seconds; its complete unchanged owner passed
  alone in 5.2 seconds.
- The long-transcript fixture exceeded 120 seconds; its complete unchanged
  owner passed alone in 43.5 seconds.
- OpenCode execution-policy conformance exceeded 20 seconds and the Mermaid
  watchdog exceeded its nine-second elapsed bound. Both complete unchanged
  backend owners passed sequentially with the Node preload in 47.2 seconds.
- Pi runtime vendoring exceeded 30 seconds in the aggregate; its complete
  unchanged owner passed alone after the aggregate finished in 10.8 seconds.

The complete aggregate finished in 1151.9 seconds. Its original workspace,
root/support and bridge group exits remained failed; the protocol lockfile
check passed. Every failing test passed on a complete owning-file rerun;
the registry metadata case required the correction described above, and all
other owners passed unchanged. The initial concurrent `build:all` also hit
ENOENT reading a generated renderer asset during precompression; this was
tracked separately from test failures. The final standalone `build:all` passed
after the other jobs ended (cached production builds were restored).

All commands used `test:logged`; direct Bun reruns used explicit paths and
`--parallel=1 --only-failures`. Private failure artifacts:
`orkestrator-test-run.Xf0fAN` (aggregate groups),
`orkestrator-test-run.zj23KS` (component browser), and
`orkestrator-test-run.TV7Wnr` (isolated browser), below the host temporary
directory. Electron, Docker opt-in, iOS and billed-provider suites were not
rerun because this refresh changed none of their owning code.

## ScheduleWakeup follow-up main merge — 2026-10-21

Merged main `01752fea471465b65eb79a442f111c968093a2d0` into pre-merge
HEAD `6976195373e3cbbb0683128269b0f9bacb05d2ca`. Reviewed every merged path
relative to that baseline, including the attachment geometry cache, review
columns, browser fixtures/tests and flake records. Conflict resolutions retain
both branches' Pi observations and index history; the streaming-selection case
was renumbered to 0631 because main already uses 0628. Main's modal-width case
rename to 0630 is retained. No product or test source was edited during resolution.

- `mise run format:check`, `mise run lint`, `mise run typecheck`, and production `mise run build` passed. Lint retained warnings with no errors.
- Focused complete owners `NativeMessage.test.tsx`, `image-preview-cache.test.ts` and `StructuredReviewReportView.test.tsx` passed (`merge-ui-owners`, 3.3 seconds). The flake-index contract, changed-document local links and tracked-file conflict-marker scans passed.
- The testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-full-tests -- mise run test` completed in 575.5 seconds. Bridges and protocol regeneration passed. Web passed 8702 tests, desktop 1105, protocol 1722, public web 41, CLI 148 and toolchain 91. Backend reported 9894 passed, 80 skipped and one failed across 9975 tests; root reported 3186 passed, one skipped and one failed across 3188 tests.
- Both repository failures passed their complete unchanged owners: the firewall GitHub-range deadline in 32.3 seconds (`merge-firewall-owner`, case 0192), and the cooperative validation-worker `incomplete` result in 40.3 seconds (`merge-validation-worker-owner`, case 0227). No assertion, timeout or skip changed. The aggregate exit remains failed.
- `ORKESTRATOR_E2E_PORT=21521 ORKESTRATOR_PUBLIC_E2E_PORT=24521 mise run test:logged -- --name merge-browser -- mise run test:browser` reported 398 passed, 81 skipped and one failed (268.4 seconds). The changed attachment and review-layout cases passed at both viewport sizes.
- The mobile native branch-picker test in `e2e/AgentLaunchDialog.spec.ts:7` expected `release/2.0` but retained `rel` after its five-second wait. Its complete unchanged owner reproduced the same failure with `ORKESTRATOR_E2E_PORT=21521 mise run test:logged -- --name merge-branch-picker-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1` (three passed, one failed; 17.8 seconds logged). This is an unresolved validation limitation, not a confirmed flake. The branch-picker test and implementation were not changed by this merge.
- Public-site browser coverage passed separately with `ORKESTRATOR_PUBLIC_E2E_PORT=24521 mise run test:logged -- --name merge-public-browser -- bunx playwright test --config e2e/public-site/playwright.config.ts` (12.2 seconds), because the component failure prevented the combined task from reaching it.
- `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated` passed (516.1 seconds). Its credential-free profile `qa-browser-4f5142bf-dbe` was stopped and reset by the runner. Provider scenarios unavailable without credentials remain explicit skips. No live launcher for this profile remains.

Evidence below the host temporary directory: `orkestrator-test-run.d10zQ4/`
contains the complete group logs and summary; outer full-suite evidence is
`orkestrator-test-run.ARLkL2/merge-full-tests.log.gz`. Component browser evidence
is `orkestrator-test-run.FX8kG3/merge-browser.log.gz`; persistent branch-picker
owner evidence is `orkestrator-test-run.98Ltem/merge-branch-picker-owner.log.gz`.
Passing isolated-suite summary is in `orkestrator-test-run.OjQyhR/summary.json`.

Dedicated Electron, Docker lifecycle, billed provider and iOS qualification
were not selected: the incoming code changes affect attachment/review layout,
with no Electron, Docker lifecycle or iOS implementation changes. Browser
coverage includes transcript remount geometry and the isolated app flows.
