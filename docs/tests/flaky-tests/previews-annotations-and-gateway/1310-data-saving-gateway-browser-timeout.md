# Data-saving gateway browser test times out in the aggregate

- **ID:** 1310
- **Status:** open
- **Date observed:** 2026-10-29
- **Test:** `[mobile-chromium] data saving survives reload, stays client-local and preserves event latency through resume and reconnect`
- **File:** `e2e/DataSavingGateway.spec.ts:18`
- **Revision:** `918d24a7d` on `mail-recipient-environment-name-acf90d0f8be8`; the gateway test and its implementation were unchanged.
- **Original command:** `ORKESTRATOR_E2E_PORT=14572 ORKESTRATOR_PUBLIC_E2E_PORT=14573 mise run test:logged -- --name browser -- mise run test:browser`, using nine Playwright workers.
- **Failure:** The 60,000 ms test deadline expired. Cleanup reported `browserContext.close: Target page, context or browser has been closed` at line 170; this does not establish which earlier operation consumed the deadline. The desktop case passed in the same aggregate.
- **Aggregate result:** 926 passed, 105 skipped, three failed in 15.7 minutes (946.3 s logged). The other two failures were the native branch-selection cases already tracked in [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md). The combined command did not reach the public-site suite; a separate public-site run passed.
- **Failure evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.jirD7q/browser.log.gz`.
- **Isolated rerun:** `ORKESTRATOR_E2E_PORT=14572 mise run test:logged -- --name data-saving-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1 --output output/playwright/data-saving-owner` passed both viewport cases unchanged (exit 0, 45.0 s logged).
- **Assessment:** The aggregate failure followed by an unchanged isolated pass establishes intermittence. Timing under concurrent browser execution is a hypothesis; the root cause remains unconfirmed. No implementation, assertion, timeout, or skip changed.


## Second-backend review fixes — 2026-10-30

The exact `mise run test:logged -- --name browser -- mise run test:browser`
rerun repeated the mobile 60 s deadline and context-close cleanup error with
nine workers (972 passed, 106 skipped, 4 failed; 797.1 s). Evidence:
`orkestrator-test-run.Frb08t/browser.log.gz` under the host temporary directory.
The complete unchanged owner passed both viewports (exit 0, 32.7 s):

```sh
mise run test:logged -- --name data-saving-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1
```

This sequential rerun followed an invalid overlapping owner attempt; see
[1323](../aggregate-validation-runs/1323-second-backend-one-host-0244-validation.md).
No implementation, assertion, timeout or skip changed. The cause is unconfirmed.

## Merge-readiness review — 2026-10-30

Preparation's nine-worker `mise run test:logged -- --name browser -- mise run
test:browser` repeated the mobile 60-second deadline (971 passed, 106 skipped,
seven failed). A nine-worker six-owner diagnostic also repeated it (178 passed,
eight failed in 126.2 s), with evidence in
`orkestrator-test-run.XREdRM/browser-preparation-failures.log.gz`.

The complete unchanged owner passed both viewports alone with one worker
(51.9 s):

```sh
ORKESTRATOR_E2E_PORT=1457 mise run test:logged -- --name pr-review-DataSavingGateway-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1 --output output/playwright/pr-review-DataSavingGateway-owner
```

The default fixture port belonged to another checkout; it was left alone. No
gateway implementation, assertion, timeout or skip changed. This establishes
intermittence; host contention remains a hypothesis. Aggregate follow-up is
recorded in [1254](../aggregate-validation-runs/1254-merge-readiness-review-validation.md).

## Session history review — 2026-10-31

- **Original command:** `mise run test:logged -- --name review-browser -- mise run test:browser`;
  nine workers, 983 passed, 106 skipped and eleven failed. The mobile data-saving
  gateway case repeated its deadline.
- **Complete unchanged owner:** `mise run test:logged -- --name review-data-saving-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1`
  passed, exit 0, in 34.3 seconds.
- **Evidence:** `orkestrator-test-run.MA9mVk/review-browser.log.gz` under the host
  temporary directory; aggregate details in case 1166. No implementation,
  assertion, timeout or skip changed.

## Reviewer start failure (todo 1090) — 2026-11-01

- **Recurrence:** preparation's browser validation on
  `agent-start-failure-28f9b34a1026-r1` reported the mobile case at its
  60-second deadline. The branch does not touch this spec, its fixtures or the
  gateway; the only branch files in the fixture's import graph are additive
  optional fields and validators in `packages/protocol`.
- **Unchanged owner, both branches:** the earlier stage's reruns passed it on
  the branch and on `origin/main` (`93b99bfba`). The `origin/main` rerun used
  two workers alongside AgentLaunchDialog and DesignCanvas (8 tests, 6 passed;
  the two failures were the native branch cases of [0493](../aggregate-validation-runs/0493-component-browser-aggregate-timeout-cluster.md)).
  A nine-worker `--repeat-each=6` run of this owner with DesignCanvas on
  `origin/main` passed 24 of 24 (57.2 s, load average about 11). A nine-worker
  run of the whole component suite on `origin/main`
  (`CI=1 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=9 ORKESTRATOR_REVIEW_VALIDATION=1 bunx playwright test --config e2e/playwright.config.ts`)
  did not hit it: 1029 passed, 108 skipped, one flaky (1249), two failed
  (0493's AgentLaunchDialog cases).
- **Reproduced on `origin/main` under CPU starvation:** in a detached
  `origin/main` worktree, a temporary, uncommitted diagnostic applied CDP
  `Emulation.setCPUThrottlingRate` to both pages right after `newPage()`, then
  `bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1 --repeat-each=2`
  ran. At rate 6 all four passed (79.6 s). At rate 20 one of four failed with
  this case's exact signature: `Test timeout of 60000ms exceeded`, then
  `browserContext.close: Target page, context or browser has been closed` in
  the `finally` block. The other three passed in about 54 s each, against
  roughly 16–25 s unthrottled. Evidence:
  `orkestrator-test-run.34LeNi/main-datasaving-throttle20.log.gz` under the host
  temporary directory.
- **Assessment:** the 60-second budget runs out when the browser is starved of
  CPU. No single step hangs; the whole scenario slows toward the deadline, and
  the step that is running when it expires varies. The context-close error is
  a consequence of the deadline, not a cause. This makes host CPU contention
  the demonstrated mechanism, though it does not prove that contention was the
  cause of each aggregate failure. No implementation, assertion, timeout or
  skip changed.


## Backend logger review repair — 2026-11-02

A one-worker gateway-owner run alongside the four-worker component browser
rerun hit this deadline at both viewport sizes. The cleanup error was again
`browserContext.close: Target page, context or browser has been closed`.
The paired gzip SSE cases passed: two pass, two fail, 143.8 s, exit 1.

```sh
ORKESTRATOR_E2E_PORT=50454 mise run test:logged -- --name review-fix-gateway-browser -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts e2e/SseGzipStreaming.spec.ts --workers=1 --output output/playwright/gateway-review-owner
```

Evidence: host temporary artifact directory `orkestrator-test-run.KR1WWT`,
`review-fix-gateway-browser.log.gz`. After the broad browser run was stopped,
the same four cases passed on a fresh fixture port (four pass, 55.1 s, exit 0):

```sh
ORKESTRATOR_E2E_PORT=59768 mise run test:logged -- --name review-fix-gateway-browser-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts e2e/SseGzipStreaming.spec.ts --workers=1 --output output/playwright/gateway-review-alone
```

The branch changes the two gateway fixtures' logging setup to route diagnostics
to stderr, keeping stdout JSON-only. No browser assertion, timeout or skip
changed between these runs. The passing rerun was after a conflict-free rebase
onto `origin/main` at `38d55ee14`; the backend, protocol and gateway fixture
sources were identical across the rebase.

## Opaque session review — 2026-11-03

Recorded `mise run test:browser` at 27f6d5eba failed the mobile owner at its
60 s deadline (cleanup at line 170); aggregate totals: 29 failed, 24 flaky,
118 skipped, 1109 passed. The complete owner passed unchanged at both
viewports alone with one worker in 38.7 s:

`ORKESTRATOR_E2E_PORT=18473 mise run test:logged -- --name data-saving-gateway -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1`

Original evidence: `.orkestrator/review-artifacts/review-validation-2c183b1f-33d1-45e1-b1fe-0f5647dd9025/validation-05.stderr.txt`.
No assertion or timeout changed. Host contention remains a hypothesis.


## Workflow vocabulary review — 2026-11-04

- **Reviewed head:** `f735aabd0b4cbd3b3c38da602c3aa8b79b8357d0`.
- **Original command:** `ORKESTRATOR_E2E_PORT=55208 mise run test:logged -- --name review-browser-isolated-port -- mise run test:browser`.
- **Worker configuration and result:** nine component Playwright workers; 1,274 passed, 122 skipped and four failed in 24.4 minutes. The public-site stage did not run because the component stage failed.
- **Failure evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.fFxacM/review-browser-isolated-port.log.gz` and the validation summary `output/agent-testing/review-validation-f735aabd0.md`.
- **Failure:** mobile `data saving survives reload, stays client-local and preserves event latency through resume and reconnect` (`e2e/DataSavingGateway.spec.ts:18`) exceeded its 60-second deadline; cleanup at `:170` reported `browserContext.close: Target page, context or browser has been closed`.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=54832 mise run test:logged -- --name review-data-saving-diagnostic -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --project mobile-chromium --workers=1 --output output/playwright/review-data-saving-diagnostic` passed. Passing counts and duration were not retained by the logged wrapper.
- **Assessment:** unchanged isolated passes confirm intermittent recurrence. The cause of this run is unconfirmed; no implementation, assertion, timeout or skip changed in these owners. The original aggregate remains failed.

## Interaction-policy review repair validation — 2026-11-06

The exact preparation retry,
`mise run test:logged -- --name browser -- mise run test:browser`, finished
with 1,499 passes, 128 skips and one failure in 17.2 minutes. The mobile owner
again exceeded its 60-second deadline and failed cleanup at line 170 with
`browserContext.close: Target page, context or browser has been closed`.
The component stage failed, so the chained public-site stage did not run.
All ten changed interaction-policy cases passed in this aggregate, as well
as in the dedicated one-worker run. The gateway owner and its implementation
are unchanged by this branch.

Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.7EYRNh/browser.log.gz`.
The complete unchanged gateway owner passed its one-worker rerun in 106.0 s,
using a separate output directory so concurrent runners could not delete one
another's traces:

```sh
mise run test:logged -- --name data-saving-owner -- bunx playwright test --config e2e/playwright.config.ts DataSavingGateway.spec.ts --workers=1 --output output/playwright/address-data-saving-owner
```

This confirms another intermittent recurrence. No assertion, timeout or skip
changed. The aggregate remains failed; no new cause or fix is claimed.

## Floating-notice repair review — 2026-11-06

- **Original command:** `mise run test:logged -- --name review-browser-suite -- mise run test:browser` (nine component workers).
- **Failure:** mobile `data saving survives reload, stays client-local and preserves event latency through resume and reconnect` exceeded its 60-second test deadline; teardown closed the browser context.
- **Suite counts:** 1503 passed, 135 skipped, 4 failed, 1460.5 s. The other failures were the tab-launch selector in both viewports and desktop pipeline fullscreen Notes scrolling; both also failed in owner-only reruns and are not classified as flakes here. The public-site stage did not run.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.5NH72Y/review-browser-suite.log.gz`.
- **Isolated rerun:** with `ORKESTRATOR_E2E_PORT` set to a free port, `mise run test:logged -- --name data-saving-isolated -- bunx playwright test --config e2e/playwright.config.ts DataSavingGateway.spec.ts --workers=1 --output=output/playwright/data-saving-results` passed, exit 0, 69.1 s. Both viewport cases ran; passing output was deleted by the logged runner.
- **Assessment:** the unchanged owner again passes alone. Host contention is a hypothesis, not an established cause. No assertion, timeout or skip in this owner was changed.

## Transcript restoration review — 2026-11-06

The mobile case again failed to reconnect within its 60 s deadline in
`ORKESTRATOR_E2E_PORT=14827 mise run test:logged -- --name browser -- mise run test:browser`:
1,510 passed, 135 skipped, nine failed, 1,403.5 s. Evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.hIh8H2/browser.log.gz`.
The unchanged complete owner passed alone, exit 0, in 37.6 s:
`ORKESTRATOR_E2E_PORT=14840 mise run test:logged -- --name repair-DataSavingGateway-alone -- bunx playwright test --config e2e/playwright.config.ts --output output/playwright/repair-DataSavingGateway-alone e2e/DataSavingGateway.spec.ts`.
Both viewports ran with the config's default worker allocation. Passing output
was deleted by the logged runner. No assertion, timeout, skip or gateway code
changed; the cause remains unconfirmed.

## Bridge authority review repairs — 2026-11-06

At `451fccdf1`, the nine-worker command
`mise run test:logged -- --name repair-browser -- mise run test:browser`
reported 1,513 passed, 135 skipped and six failed (1,654 cases; 1,225.3 s).
Evidence: host temporary artifact
`orkestrator-test-run.C3ovaT/repair-browser.log.gz`. The browser implementation
and this test are unchanged by the bridge-authority branch.

The mobile case exceeded its 60 s deadline and cleanup reported a closed
browser context at line 170. The complete unchanged owner passed both viewports
alone (exit 0, 45.8 s):

```sh
mise run test:logged -- --name isolate-data-saving -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1 --output output/agent-testing/address-browser-reruns/data-saving
```

The isolated pass confirms intermittence; the cause remains unconfirmed. Status
stays open. No assertion, timeout or skip changed.


## Native chat review repair validation — 2026-11-09

- **Observing branch base:** `448e9fffb992c3b6306aa6562c88e23c59fb74d8`; repair commits `4817327b8` and `852481f2f`.
- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`.
- **Worker configuration:** nine component-browser workers, with focused browser checks running alongside the aggregate. The gateway owner was unchanged.
- **Failure:** mobile `data saving survives reload, stays client-local and preserves event latency through resume and reconnect` exceeded its 60-second test deadline; context teardown reported `Target page, context or browser has been closed`.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.53aGI2/browser.log.gz` (1,585 passed, 152 skipped and three failed across 1,740 component cases in 1,574.2 seconds; the public-site stage did not run).
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=1467 mise run test:logged -- --name gateway-isolated-final -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1 --output output/playwright/gateway-isolated-final` passed both viewport cases, exit 0, in 57.4 seconds. Passing raw output was deleted by the logged runner.
- **Recurrence check:** `mise run flaky:recurrence -- 1310 --base 448e9fffb992c3b6306aa6562c88e23c59fb74d8` reported the case open.
- **Assessment:** intermittent deadline failure; the cause remains unconfirmed. No gateway implementation, assertion, timeout or skip changed.

The subsequent exact complete browser rerun repeated the mobile 60-second deadline
and context-close error. It had 1,586 passes, 152 skips and two failures across
1,740 component cases in 1,281.6 seconds; the other failure was case 1249.
Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.fSAO2z/browser.log.gz`.
The unchanged two-viewport owner had already passed in 57.4 seconds above.
No gateway code, assertion, deadline or skip changed; the aggregate remains red.

## Dock notice review repairs — 2026-11-09

- **Observing branch:** `fix-error-message-d954c85349a7-r1`, head `46a098de1cf920de3f4db6a14718a1831b22e87e`, base `448e9fffb9` (2.37.1-beta). This branch does not change this owner or the gateway.
- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`, nine component workers. Result: 1,582 passed, 151 skipped, three failed in 1,385.8 seconds. The chained public-site stage did not run.
- **Failure:** mobile `data saving survives reload, stays client-local and preserves event latency through resume and reconnect` (`e2e/DataSavingGateway.spec.ts:18`) exceeded its 60,000 ms deadline; cleanup at line 170 reported `browserContext.close: Target page, context or browser has been closed`.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.0XExwN/browser.log.gz`. The other two browser failures were `SidebarCrossMachineSelect.spec.ts:150` at both viewports; those also failed in their complete owning-file rerun and are not classified as flakes.
- **Complete unchanged owner:** after the aggregate and sidebar diagnostic finished, `mise run test:logged -- --name data-saving-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1 --output output/playwright/data-saving-isolated` passed both viewport cases, exit 0, in 38.0 seconds.
- **Recurrence check:** `mise run flaky:recurrence -- 1310 --base 448e9fffb` reported the case open and instructed recording this observation. Status remains open.
- **Assessment:** the unchanged isolated pass confirms intermittence. Host contention is a hypothesis for this observation; no new root cause is established. No implementation, assertion, timeout or skip changed in this owner.


## Main merge validation — 2026-11-09

- **Observing branch:** `impeccable-init-f5f64aff930f-r1`, pre-merge head `51fe8c87bf8ac436d6439650255781e05dcc0c85`, base `448e9fffb992c3b6306aa6562c88e23c59fb74d8`, merging `origin/main` at `7074cb4779070bf7c6dbc0dbf619f8b67ebbe883`.
- **Original command:** `mise run test:logged -- --name merge-browser -- mise run test:browser`, nine component-browser workers, alongside the default deterministic suite. The gateway owner and implementation were unchanged by this merge resolution.
- **Failure:** mobile `data saving survives reload, stays client-local and preserves event latency through resume and reconnect` (`e2e/DataSavingGateway.spec.ts:18`) exceeded its 60,000 ms deadline; cleanup at line 170 reported `browserContext.close: Target page, context or browser has been closed`.
- **Suite counts:** 1,651 passed, 152 skipped and one failed across 1,804 component cases in 1,533.42 seconds. The chained public-site stage did not run.
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.lQx9VV/merge-browser.log.gz`.
- **Complete unchanged owner:** after the aggregate finished, `mise run test:logged -- --name merge-gateway-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/DataSavingGateway.spec.ts --workers=1 --output output/playwright/merge-gateway-isolated` passed both viewport cases, exit 0, in 37.6 seconds. Passing raw output was deleted by the logged runner.
- **Recurrence check:** `mise run flaky:recurrence -- 1310 --base 448e9fffb992c3b6306aa6562c88e23c59fb74d8` reported the case open.
- **Assessment:** the unchanged isolated pass confirms intermittence. The cause remains unconfirmed. No gateway implementation, assertion, timeout or skip changed; the aggregate remains red.

## Auto-pipeline address validation — 2026-11-10

Observed on `autopipeline-text-boxes-7182fc46ef5e-r1` at `944b37af1`, based on
`8d0ae2764e0a5875144d15ee0f526608e6c1c1e8`. The reviewed commit `02f72782c` remains in history.

- **Original command:** `ORKESTRATOR_E2E_PORT=15182 ORKESTRATOR_PUBLIC_E2E_PORT=15183 mise run test:logged -- --name browser -- mise run test:browser`.
- **Aggregate result:** incomplete at the 1,800 s runner deadline; 69 named failures,
  last progress 1,194/1,814, with no final pass/skip totals. Public-site tests were not reached.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.pcV7xY/browser.log.gz`.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=15210 mise run test:logged -- --name address-datasavinggateway-alone -- bunx playwright test --config e2e/playwright.config.ts --workers=1 --output output/agent-testing/address-datasavinggateway-alone e2e/DataSavingGateway.spec.ts`; exit 0, exit 0, one worker and both viewport projects.
- **Recurrence check:** `mise run flaky:recurrence -- 1310 --base 8d0ae2764e0a5875144d15ee0f526608e6c1c1e8 --registry-ref origin/main` reported `open`.

| Project | Location | Exact test |
| --- | --- | --- |
| mobile-chromium | `e2e/DataSavingGateway.spec.ts:18` | data saving survives reload, stays client-local and preserves event latency through resume and reconnect |

The owning spec and its implementation were unchanged. No assertion, deadline,
retry or skip was changed. This establishes intermittency, not its cause.
The full run and remaining undetermined failures are recorded in
[9924](../aggregate-validation-runs/9924-auto-pipeline-fix-browser-owners.md).

## Launch-override marker review repair — 2026-11-11

On `launch-override-marker-043a84998c41-r1` (base `498b68766`), the mobile case
exceeded its 60 s deadline in the component browser suite (load average about
42) and again in a four-owner multi-worker rerun; the complete unchanged owner
passed with one worker (61.3 s, with `PaneBreakpoint.spec.ts`).
`flaky:recurrence 1310` reported `open`. Full run: [9953](../aggregate-validation-runs/9953-launch-override-marker-browser-owners.md).
