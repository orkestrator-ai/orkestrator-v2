# Container settings rebuild preview meets a preceding operation

- **ID:** 0506
- **Status:** open
- **Date observed:** 2026-10-20
- **Test:** `Docker fixture container settings show backend state and rehydrate (desktop)`
- **Owner:** `e2e/agent-testing/container-settings.spec.ts:79`

## Main merge validation

- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-docker-0f4cfe ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-docker-0f4cfe mise run test:logged -- --name merge-docker -- mise run test:agent:docker`.
- **Configuration:** one Playwright worker; isolated local/container fixture; workspace-specific development image rebuilt from the merged tree. The non-iOS aggregate and browser/Electron checks ran alongside this suite.
- **Failure:** the desktop case did not find `Rebuild container and keep its files?` within 30 seconds at line 113. The saved accessibility snapshot instead showed `Rebuild unavailable` and `Another container operation is running for this environment. Nothing was changed.` The preceding rebuild-cycle case passed.
- **Aggregate result:** six passed, one live-provider opt-in skipped, one failed; exit 1 in 170.4 seconds.
- **Owning-file rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-docker-0f4cfe ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-docker-owner-0f4cfe ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name merge-container-settings-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts container-settings.spec.ts --workers=1`.
- **Isolated result:** both unchanged desktop/narrow cases passed, exit 0 in 18.1 seconds, against the same profile after the aggregate.
- **Evidence:** `orkestrator-test-run.Qw5tXW/merge-docker.log.gz` below the host temporary directory; screenshot, accessibility snapshot and trace under `output/agent-testing/merge-main-docker-0f4cfe/browser/`.
- **Assessment:** confirmed intermittent failure; a lifecycle operation remaining pending after the preceding rebuild scenario is supported by the refusal text, but its exact settlement race is unproven. No source, assertions, deadlines or skips changed. The profile was stopped and reset after the owning-file rerun.


## Design qualification main merge — 2026-10-21

- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-20261021-dab5ea29 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-20261021-dab5ea29 mise run test:logged -- --name merge-docker -- mise run test:agent:docker`, merging `origin/main` (`d4171748`) into `a3423ada`.
- **Configuration:** one Playwright worker, rebuilt workspace development image, credential-free local/container fixture, alongside repository/browser/Electron validation and other worktrees. Host load averages reached 132 on 18 logical cores.
- **Failure:** the desktop case could not find Resources within five seconds at `container-settings.spec.ts:106`. The preceding rebuild case also failed to open its confirmation, recorded in [0518](0518-design-rerun-main-merge-docker-preview.md). No implementation or assertions changed.
- **Original result:** seven passed, two skipped, two failed; exit 1 in 573.2 seconds.
- **Owning-file rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=merge-main-20261021-dab5ea29 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-main-settings-owner-dab5ea29 ORKESTRATOR_AGENT_TEST_DOCKER=1 mise run test:logged -- --name merge-settings-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts container-settings.spec.ts --workers=1` passed all three unchanged cases, exit 0 in 111.7 seconds, including desktop, narrow and withheld-login switch/reload coverage.
- **Evidence:** `orkestrator-test-run.I1jejv/merge-docker.log.gz` below the host temporary directory; sanitized artifacts under `output/agent-testing/merge-main-20261021-dab5ea29/browser/` and `output/agent-testing/merge-main-settings-owner-dab5ea29/browser/`.
- **Assessment:** confirmed intermittent recurrence. The exact cause remains unproven; no timeout or skip changed.

- **Cleanup (2026-10-21 merge):** `dev:stop` and `dev:reset` completed for `merge-main-20261021-dab5ea29`, removing two exact-owner containers, four volumes, one network and disposable profile state. The one-shot browser runner stopped/reset its own `qa-browser-c5dc6bca-3dd` profile. No manual profile state was retained.
