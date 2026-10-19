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

## Transcript-paging final validation — 2026-10-18

The desktop variant repeated the same request-context disposal during
`mise run test:logged -- --name committed-browser-suite -- mise run test:browser`
on commit `3dd86696`. All transcript-paging cases passed; component suite counts
were 359 passed, 80 skipped and one failed (124.8 seconds logged).

The unchanged owner passed both viewport projects alone in 11.7 seconds:

```bash
mise run test:logged -- --name claude-interactions-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1
```

Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.19DYL2/committed-browser-suite.log.gz`.
No interaction test, timeout, assertion or product behavior changed.

## Agent-mail main merge recurrence — 2026-10-19

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.
