# Terminal recovery foreground render misses background output

- **ID:** 0693
- **Status:** open
- **Date observed:** 2026-10-22
- **Tests:** `a stopped shell is automatically replaced after terminal-only http-sse recovery` and the corresponding `websocket recovery` case.
- **File:** `e2e/agent-testing/terminal-input-resume.spec.ts:300`
- **Original command:** `mise run test:logged -- --name isolated-browser -- mise run test:agent:browser:isolated`, one Playwright worker, fresh credential-free Codex fixture `qa-browser-eee2ec83-1a5`, alongside aggregate validation.
- **Failure:** background PTY output contained `recovered-background`, but the foreground rendered output remained empty at the five-second predicate deadline (`terminal-input-resume.spec.ts:545`).
- **Suite counts:** 26 passed, 51 skipped, three failed across 80 cases (428.0 s including lifecycle). The third failure was the known narrow repository picker (0224).
- **Fresh profile rerun:** both terminal cases passed in the complete gateway/terminal owner command on `inherited-settings-qa-20daf002` (16 passed, 10 skipped, one unrelated picker failure; 155.8 s).
- **Owning-file-only rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=inherited-settings-qa-20daf002 mise run test:logged -- --name terminal-recovery-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/terminal-input-resume.spec.ts --workers=1` passed all three unchanged tests (exit 0, 33.4 s).
- **Evidence:** `orkestrator-test-run.VhN1Q9/isolated-browser.log.gz` and `orkestrator-test-run.pQu4zt/gateway-terminal-owners.log.gz` under the host temporary directory; sanitized traces under `output/agent-testing/<profile>/browser/`.
- **Hypothesis:** foreground terminal reconciliation after switching back races rendering under load; unconfirmed. No terminal implementation, assertion, deadline or skip changed. Both disposable profiles were stopped and reset.
