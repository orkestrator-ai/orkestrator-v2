# Streaming transcript find convergence times out in the component aggregate

- **ID:** 0767
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `scrollbar departure after find stays put when streaming reapplies highlights`, desktop Chromium, `e2e/StreamingTranscript.spec.ts:361`.
- **Merge parents:** `37ecb753fa8da75ae546984af7c72ba5e166d503` and `a3111c7c67e3423b161b77156c070cd105c6a489`.
- **Original command:** `ORKESTRATOR_E2E_PORT=58417 mise run test:logged -- --name main-refresh-browser -- mise run test:browser`, nine component workers alongside repository and isolated-stack validation.
- **Failure:** at line 371 the find operation's `lastOutcome` remained `unresolved` instead of `converged` for the five-second assertion deadline. The component suite reported 581 passed, 102 skipped and three failed across 686 cases (318.4 s logged); the other two failures were the already-recorded native branch suggestions.
- **Complete unchanged owner:** `ORKESTRATOR_E2E_PORT=53198 mise run test:logged -- --name main-refresh-streaming-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/StreamingTranscript.spec.ts --workers=1 --output output/playwright/main-refresh-streaming-owner` passed (44.6 s logged).
- **Evidence:** host temporary artifact `orkestrator-test-run.qIrBtp/main-refresh-browser.log.gz`; passing owner summary `orkestrator-test-run.FUNJwm/summary.json`. Original trace under `output/playwright/test-results/StreamingTranscript-scroll-bd9d1-eaming-reapplies-highlights-desktop-chromium/`.
- **Assessment:** the complete unchanged owner pass confirms an intermittent observation on the merged tree. Aggregate contention or delayed find reconciliation is a hypothesis; the cause is not established. No implementation, assertion, timeout or skip changed.

## Triage 2026-10-25

- **Disposition:** open.
- **Evidence:** single observation, in the nine-worker component suite.
- **Next step:** run the owner with two workers and `--repeat-each=5` to see whether it reproduces without the nine-worker suite; if not, and it does not recur, reclassify it as environmental (see [0382](../web-ui/0382-component-browser-parallel-load.md)).
