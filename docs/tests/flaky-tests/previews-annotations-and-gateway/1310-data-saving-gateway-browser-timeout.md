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
