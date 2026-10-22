# Gateway maintenance navigation and diff tooltip fail late in the suite

- **ID:** 0484
- **Status:** open
- **Date observed:** 2026-10-18
- **Tests:** `host maintenance rehydrates task completion while Settings is closed (390px)` and `persisted diff baselines keep Files, the badge and diff tabs aligned after background changes and reload`.
- **File:** `e2e/agent-testing/browser-gateway.spec.ts:2013`, `:2091`.
- **Original command:** `mise run test:logged -- --name merge-agent-browser -- mise run test:agent:browser:isolated`, credential-free Codex fixture `qa-browser-f53bd46a-35f`, one Playwright worker alongside component tests, the non-iOS aggregate and other worktrees.
- **Failures:** the narrow case could not find the drawer toggle at its 5000 ms deadline; the diff case could not find the current-baseline tooltip at its 5000 ms deadline. The host-picker case also failed (0224).
- **Suite disposition:** the isolated runner reached its 900000 ms test deadline after starting case 53 of 63, before a complete Playwright summary; exit 1 in 933.4 s including startup and cleanup.
- **Owning-file rerun:** fresh `dev:test --profile merge-paging-gateway-owner-1018 --fixture --no-agent-credentials --agent-platforms codex`; `ORKESTRATOR_AGENT_TEST_PROFILE=merge-paging-gateway-owner-1018 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-paging-gateway-owner-1018 mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1` passed the complete unchanged file (14 passed, six skipped, exit 0; 199.5 s logged).
- **Evidence:** `orkestrator-test-run.h4wMTk/merge-agent-browser.log.gz` below the host temporary directory; browser artifacts under `output/agent-testing/qa-browser-f53bd46a-35f/browser/` and passing statistics in `output/agent-testing/merge-paging-gateway-owner-1018/browser/results.json`.
- **Assessment:** confirmed intermittent observations; cumulative profile state and shared-host timing remain hypotheses. Both profiles were stopped and reset. No source, assertion, timeout or skip changed.
