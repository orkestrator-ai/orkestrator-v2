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

## Control MCP voice main merge — 2026-10-24

- `mise run test:agent:browser:isolated` on credential-free Codex fixture `qa-browser-a34c7ac6-c9f`, one worker, repeated the narrow maintenance case's missing drawer toggle at its five-second deadline (`browser-gateway.spec.ts:2428`). The same run also missed the moved environment's expected worktree path at the five-second deadline (`:2363`); its browser deadline later ended the run without a complete summary.
- The complete unchanged gateway owner ran separately in fresh credential-free Codex fixture `merge-gateway-0041-fc04c130` with `ORKESTRATOR_AGENT_TEST_PROFILE=merge-gateway-0041-fc04c130 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-gateway-0041-fc04c130 mise run test:logged -- --name merge-gateway-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/browser-gateway.spec.ts --workers=1`: 13 passed, ten skipped and only the narrow host-picker failure (case 0224), 346.0 s. Both maintenance viewports, the environment move and persisted diff passed.
- Evidence: `orkestrator-test-run.E1H1rN/merge-gateway-owner.log.gz` under the host temporary directory, with browser artifacts under `output/agent-testing/qa-browser-a34c7ac6-c9f/browser/` and `output/agent-testing/merge-gateway-0041-fc04c130/browser/`.
- The complete owner remains non-green because of 0224, so this observation does not newly classify the move failure as a flake. No source, assertion, timeout or skip changed for these observations.
