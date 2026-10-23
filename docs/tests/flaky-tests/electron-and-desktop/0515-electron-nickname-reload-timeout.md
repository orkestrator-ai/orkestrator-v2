# Electron remote nickname is not observed after renderer reload

- **ID:** 0515
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `remote nicknames refresh all native titles and Window menu entries`
- **Owning file:** `e2e/agent-testing/electron-main.spec.ts:576`
- **Original command:** `mise run test:logged -- --name merge-electron -- mise run test:agent:electron`, merging `origin/main` (`d4171748`) into `5eb444af`. One Playwright worker alongside repository, browser and Docker validation.
- **Failure:** the second renderer reload did not observe `Workstation` through `connections.list()` within the 5,000 ms poll at line 452. This is a later nickname assertion, distinct from the startup title wait fixed in 0470.
- **Suite counts:** 21 passed, one skipped and one failed across 23 cases; exit 1 in 242.2 seconds.
- **Owning-file rerun:** `ORKESTRATOR_AGENT_TEST_RUN_ID=merge-credential-electron-owner-20261021 mise run test:logged -- --name merge-electron-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/electron-main.spec.ts --workers=1` passed the entire unchanged owning file, exit 0 in 35.0 seconds.
- **Evidence:** `orkestrator-test-run.6KF1kK/merge-electron.log.gz` below the host temporary directory; screenshots and trace under `output/agent-testing/electron-smoke/electron/`, rerun results under `output/agent-testing/merge-credential-electron-owner-20261021/electron/`.
- **Hypothesis:** renderer reload and connection-list reconciliation may exceed the polling window under shared host load; the cause is not established.
- **Changes:** evidence only; no implementation, assertion, timeout or skip changed.


## 2026-10-22 main merge recurrence

`main2-electron` (`mise run test:agent:electron` through `test:logged`) finished in 567 seconds with 28 passed, one skipped and the same five-second `Workstation` reload poll failure. The complete unchanged owning file passed in 67.0 seconds with `ORKESTRATOR_AGENT_TEST_RUN_ID=main2-electron-owner-7fac mise run test:logged -- --name main2-electron-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/electron-main.spec.ts --workers=1`. Aggregate evidence: `orkestrator-test-run.G4a2Y0/main2-electron.log.gz` under the host temporary directory. No implementation, assertion, timeout or skip changed.

## Agent-interactions main merge recurrence, 2026-10-22

`mise run test:logged -- --name merge-electron -- mise run test:agent:electron` failed the nickname reload alongside three other cases: 18 passed, 4 failed, 1 skipped, 7 did not run, 846.4 s. `mise run test:logged -- --name merge-electron-owner-electron-main -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts --workers=1 electron-main.spec.ts` passed the entire unchanged owner (32.4 s). Original evidence: `orkestrator-test-run.oTkYDB/merge-electron.log.gz` under the host temporary directory.


## Command-handover validation recurrence, 2026-10-23

`mise run test:logged -- --name electron-tests -- mise run test:agent:electron`
reported 30 passed, one skipped and the same five-second `Workstation` reload
poll failure (481.1 s). The complete unchanged owning file passed (29.4 s) with
`ORKESTRATOR_AGENT_TEST_RUN_ID=handover-electron-owner mise run test:logged -- --name electron-owner -- bunx playwright test --config e2e/agent-testing/playwright.electron.config.ts e2e/agent-testing/electron-main.spec.ts`.
Aggregate evidence: `orkestrator-test-run.DprrE3/electron-tests.log.gz` below the
host temporary directory. The rerun writes to
`output/agent-testing/handover-electron-owner/electron/`. No assertion, timeout
or skip changed.
