# Paused Claude question test races request-context disposal

- **ID:** 0252
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `[mobile-chromium] a paused Claude question stays paused across a reload, then resumes and answers`
- **Owning file:** `e2e/ClaudeInteractions.spec.ts:100` (route callback at `:107`)
- **Original command:** `ORKESTRATOR_E2E_PORT=1496 mise run test:logged -- --name merge-browser -- mise run test:browser` on `multi-review-flow-graph-followups` while merging `origin/main`.
- **Worker configuration:** 9 Playwright workers; repository tests were also running on the shared host.
- **Failure:** `apiRequestContext.fetch: Request context disposed` while the route callback fetched a session snapshot; Playwright reported a request still in flight during teardown.
- **Suite counts:** 298 passed, 63 skipped, 1 failed across 362 cases (2.7 minutes; logged command 161.7 seconds).
- **Isolated owning-file rerun:** `ORKESTRATOR_E2E_PORT=1496 mise run test:logged -- --name merge-browser-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1` passed unchanged (23.2 seconds).
- **Evidence:** `/tmp/orkestrator-test-run.N9elob/merge-browser.log.gz`.
- **Hypothesis:** a snapshot request remains in flight when the test disposes its request context; parallel load may widen the teardown race. Not established.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.
