# CLI/UI startup connection error during merge validation

- **ID:** 0511
- **Status:** open
- **Date observed:** 2026-10-21
- **Test:** `CLI changes reach an open renderer and survive a reload`
- **File:** `e2e/agent-testing/cli-ui.spec.ts:169`
- **Original command:** `mise run test:logged -- --name merge-isolated-browser -- mise run test:agent:browser:isolated`
- **Worker configuration:** one Playwright worker in the disposable `qa-browser-0a303d2e-7ff` profile; aggregate and component browser validation also ran on the host.
- **Failure:** the test exceeded 120000 ms waiting for the Expand/Collapse project origin button. The retained accessibility snapshot showed the app's “Orkestrator couldn’t connect” startup screen instead.
- **Suite counts:** 28 passed, 38 skipped, one failed across 67 cases (9.1 minutes); the runner stopped and reset its profile.
- **Isolated rerun:** a fresh `merge-cli-4f3a7998` fixture profile was started with `mise run dev:test --profile merge-cli-4f3a7998 --fixture --no-agent-credentials --agent-platforms codex`. `ORKESTRATOR_AGENT_TEST_PROFILE=merge-cli-4f3a7998 ORKESTRATOR_AGENT_TEST_RUN_ID=merge-cli-4f3a7998 mise run test:logged -- --name merge-cli-ui-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/cli-ui.spec.ts` passed the unchanged owning file (exit 0, 6.4 seconds logged). The profile was then stopped and reset with the matching `dev:stop`/`dev:reset` commands.
- **Evidence:** `orkestrator-test-run.xV00m4/merge-isolated-browser.log.gz` under the host temporary directory; failure artifacts under `output/agent-testing/qa-browser-0a303d2e-7ff/browser/`.
- **Hypothesis:** intermittent renderer startup/connection failure before any CLI mutation. Concurrent validation was active, but the cause is unconfirmed. No implementation, assertion, timeout or skip changed.
