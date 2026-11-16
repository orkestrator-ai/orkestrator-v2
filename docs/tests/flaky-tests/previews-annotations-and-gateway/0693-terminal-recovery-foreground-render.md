# Terminal recovery foreground render misses background output

- **ID:** 0693
- **Status:** resolved
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

## Triage note (2026-11-15)

Class A candidate. The two `expect.poll(renderedOutput)` waits for the rendered terminal buffer to contain `recovered-background` now state a 30 s hang-watchdog timeout (they used the 5 s default that the recorded failure names); the backend-side output wait before them already had a signal. **Not reproduced and not run** (needs an agent-testing browser profile). Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** a Playwright default deadline expiring on a loaded host while waiting on a real signal. The recorded failure is the 5 s default of `expect.poll(renderedOutput)` (`terminal-input-resume.spec.ts:545` at the time) for the rendered terminal buffer to show output the backend already held; the case records no value mismatch or wrong final state.
- **Fix:** `e2e/agent-testing/playwright.browser.config.ts`, which lists `terminal-input-resume.spec.ts`, now sets `expect: { timeout: 30_000 }` (Playwright's default was 5 s) beside its existing `timeout: 120_000`; both `renderedOutput` polls in the spec also state `{ timeout: 30_000 }`, so no call uses a smaller budget.
- **Reproduced:** no — not run: the spec needs a live agent-testing browser profile, which this pass did not start. The fix rests on a raised hang-watchdog budget, which is weaker evidence than a reproduction.
- **Reopen if:** the same poll fails again as a hang near the new 30 s budget.
