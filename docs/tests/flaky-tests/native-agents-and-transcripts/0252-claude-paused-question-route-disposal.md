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

## Keep-open picker coverage validation — 2026-10-18

- **Original command:** `mise run test:logged -- --name picker-browser -- mise run test:browser`, alongside the full repository suite on macOS.
- **Workers:** nine Playwright workers.
- **Failure:** the mobile paused-question case raised `apiRequestContext.fetch: Target page, context or browser has been closed` from the route callback at line 107 during teardown.
- **Suite counts:** 351 passed, 80 skipped, one failed across 432 cases (144.8 seconds logged). All picker cases passed.
- **Owning-file rerun:** `mise run test:logged -- --name claude-interactions-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1 --output=output/playwright/claude-interactions-owner` passed unchanged (19.5 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.fPWiLQ/picker-browser.log.gz`.
- **Assessment:** confirmed intermittent recurrence; no Claude implementation, assertion, timeout or skip changed. The public-site smoke suite, which the component failure prevented from starting, passed separately.

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

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](../aggregate-validation-runs/0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.

## Setup recovery browser regression validation — 2026-10-20

- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`, alongside the default suite and isolated application browser validation.
- **Workers:** nine Playwright workers.
- **Failure:** mobile paused-question case raised `route.fulfill: Fetch response has been disposed` at line 111.
- **Suite counts:** 367 passed, 80 skipped and three failed across 450 cases (226.6 seconds logged). The other two failures were native branch selection; all four new setup recovery cases passed.
- **Owning-file rerun:** `mise run test:logged -- --name claude-interactions-browser-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1` passed unchanged (exit 0, 14.3 seconds logged).
- **Evidence:** `orkestrator-test-run.t17PN5/browser.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. No implementation, assertion, timeout or skip changed. The public-site suite, blocked by the component failure in the combined task, passed separately (12.0 seconds).

The separate native branch-selection owner rerun also failed unchanged at both viewport widths (two passed, two failed, 21.3 seconds): `mise run test:logged -- --name native-branch-browser-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts --workers=1`. The input remained `rel` instead of `release/2.0`. This observation does not establish a flake for native branch selection. Evidence: `orkestrator-test-run.vQfkZW/native-branch-browser-isolated.log.gz`.

## Transcript scroll smoothness validation — 2026-10-24

- `mise run test:logged -- --name scroll-browser -- mise run test:browser`
  (528 passed, 101 skipped, 3 failed) failed the desktop case with
  `apiRequestContext.fetch: Target page, context or browser has been closed`
  while running a route callback — the same response disposal.
- The unchanged owning file passed alone with one worker on both this branch
  and its base commit `f12cc5a53`:
  `bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts e2e/ClaudeInteractions.spec.ts --workers=1`
  (ClaudeInteractions cases all passed).

## Refresh through 95c9cb46a — 2026-10-24

The desktop paused-question case again raised `apiRequestContext.fetch: Request context disposed` in the route callback at line 107 during the nine-worker `mise run test:logged -- --name refresh-95c9-browser -- mise run test:browser` run (579 passed, five failed, 102 skipped; 254.2 s). The complete unchanged owner passed with one worker in 13.5 s: `ORKESTRATOR_E2E_PORT=64238 mise run test:logged -- --name refresh-95c9-owner-ClaudeInteractions -- bunx playwright test --config e2e/playwright.config.ts ClaudeInteractions.spec.ts --workers=1 --output output/playwright/refresh-95c9-ClaudeInteractions`. Evidence: host temporary artifact `orkestrator-test-run.6yNWW5/refresh-95c9-browser.log.gz`. This confirms a recurrence; no assertion, timeout, skip or implementation changed. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the merge parents and other validation outcomes.


## Codex MCP startup coverage validation — 2026-10-28

- **Original command:** `mise run test:logged -- --name browser -- mise run test:browser`.
- **Failure:** desktop paused-question route callback at line 107 raised `apiRequestContext.fetch: Request context disposed`.
- **Suite:** nine workers; 874 passed, 105 skipped and three failed (630.2 s logged). The other two failures were native branch selection in both viewports.
- **Complete unchanged owner:** `mise run test:logged -- --name browser-claude-recheck -- bunx playwright test --config e2e/playwright.config.ts e2e/ClaudeInteractions.spec.ts --workers=1` passed (16.8 s logged).
- **Evidence:** host temporary artifact `orkestrator-test-run.HOuu35/browser.log.gz`.
- **Assessment:** recurrence of the recorded disposal race. No Claude code, assertions, timeout or skip changed. Native branch selection also failed in its unchanged one-worker owner (two passed, two failed; 23.4 s), so it is not classified as a flake here. Its evidence is `orkestrator-test-run.eQ4vHu/browser-branch-recheck.log.gz`.

## Claude paused-question reload: session history review — 2026-10-31

The nine-worker component run (`mise run test:logged -- --name review-browser -- mise run test:browser`)
repeated this owner's failure: 983 passed, 106 skipped and eleven failed overall.
The complete unchanged owner passed in the subsequent one-worker, multi-owner
run (147 passed, three skipped, two unrelated AgentLaunchDialog failures).
This was a combined owner run, not a new standalone qualification. No assertion,
deadline or implementation changed. Exact commands and evidence are recorded in
[session history validation](../aggregate-validation-runs/1166-session-titles-0006-validation.md#structured-review-fixes--2026-10-31).
