# Design launch dialog: old-backend reload times out under host load

- **ID:** 9988
- **Status:** open
- **Date observed:** 2026-11-11
- **Test:** `[mobile-chromium] › old backends show upgrade guidance and recover with Check again`
- **File:** `e2e/DesignLaunchDialog.spec.ts:88`
- **Base commit:** `14df96544` (`git merge-base HEAD origin/main` on branch `20261111-141359-de945f872863`, to-dos 0038 and 7440).
- **Original command:** `env -u NODE_ENV ORKESTRATOR_E2E_PORT=1487 mise run test:logged -- --name design-agent-links-spec -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts DesignAgentLinks.spec.ts DesignLaunchDialog.spec.ts`, default workers (8 on this 16-thread host), on beelink2 (Linux) while the design-canvas perf harness ran three Chrome runs in the background and other workers shared the host (load average 55.9 over 5 minutes, 58.8 over 1).
- **Failure:** `Error: page.reload: Test timeout of 30000ms exceeded.` in the mobile project only; the desktop project's copy of the same test passed in the same run.
- **Suite counts:** 11 passed, 1 failed of 14 (the two files, both projects).
- **Isolated rerun:** `env -u NODE_ENV ORKESTRATOR_E2E_PORT=1487 mise run test:logged -- --name design-launch-spec -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts DesignLaunchDialog.spec.ts` passed all 8 tests (27.4 s) a few minutes later.
- **Changed code:** the branch adds a route (`/design-agent-links`) and a fixture file to the shared component fixture app; it does not touch the `/design-launch` route, `DesignLaunchButton` or this spec.
- **Hypothesis:** a 30 s test budget spent on a reload of the Vite dev server's fixture app under heavy host load, as in [6040](6040-static-html-specs-under-host-load.md). Unproven; not reproduced.

## Recurrence — 2026-11-11 (fix round, full browser suite)

On the same branch at `dcffbcf75` (base `14df96544`), the full
`mise run test:logged -- --name browser-rerun -- mise run test:browser`, at
load averages of about 88 to 93 on 16 cores, failed the same mobile case with
the same `page.reload: Test timeout of 30000ms exceeded.` at `:125`. The run
was ended by its 30-minute group deadline at 720 of 1,874 tests with 90
failures across about 30 spec files (case
[9990](../aggregate-validation-runs/9990-design-links-fix-round-browser-suite-under-load.md)).
Rerun alone,
`env -u NODE_ENV mise run test:logged -- --name design-specs-browser -- bun scripts/loopback-network.ts -- bunx playwright test --config e2e/playwright.config.ts e2e/DesignCanvas.spec.ts e2e/DesignLaunchDialog.spec.ts`
passed every `DesignLaunchDialog.spec.ts` case. Status stays open.
