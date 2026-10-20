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
