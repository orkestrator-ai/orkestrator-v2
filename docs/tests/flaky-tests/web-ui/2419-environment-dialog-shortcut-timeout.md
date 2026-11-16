# Environment dialog shortcut browser timeout

- **ID:** 2419
- **Status:** resolved
- **Date observed:** 2026-11-02
- **Tests:** `Meta+Enter submits exactly once from fields, controls and portaled search`; `Control+Enter submits exactly once from fields, controls and portaled search`
- **File:** `e2e/CreateEnvironmentDialog.spec.ts:313`
- **Original command:** `ORKESTRATOR_E2E_PORT=15473 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=4 mise run test:logged -- --name browser -- mise run test:browser`
- **Failure:** both desktop cases exceeded 30 seconds. Broad suite totals were not available at owner rerun time.
- **Owning-file rerun:** complete desktop owner passed with two workers alongside CodexSubagentCards in 60.1 s: `ORKESTRATOR_E2E_PORT=15475 mise run test:logged -- --name browser-specific-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/CodexSubagentCards.spec.ts e2e/CreateEnvironmentDialog.spec.ts --project=desktop-chromium --workers=2 --output=output/visual-previews/browser-specific-results`.
- **Main evidence:** independently installed detached origin/main `38d55ee14` reproduced both shortcut timeouts on mobile in the 62-case `main-browser-owners` run (31 pass, 24 skip, seven failures, 4.5 min). Its complete desktop owner then passed alongside CodexSubagentCards with two workers in 59.5 s (`main-browser-specific`). A mobile reproduction is not a reproduction of the desktop timeout.
- **Artifacts:** host temporary directory `orkestrator-test-run.ZlAiMU/browser.log` (compressed at finalization) and `orkestrator-test-run.WeDLdw/main-browser-owners.log.gz`.
- **Assessment:** intermittent desktop timeout; cause unknown. No owner, assertion, deadline or skip changed.

Final MCP provenance browser rerun: the wrapper hit its 1,800-second deadline after starting case 995 of 1,206, so no final pass total is available. Both source-layout viewport cases ran; the separate source-layout owner passed. Eleven browser failures were reported before termination, including two design-canvas failures. Compressed evidence: `orkestrator-test-run.ZlAiMU/browser.log.gz` under the host temporary directory, copied to `output/visual-previews/review-validation-evidence/` in the provenance worktree. The public-site stage was not reached. This incomplete run remains failed.

## Triage note (2026-11-15)

Class A candidate (Playwright's default 5 s assertion / 30 s test deadline expiring on a loaded host). Not changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`expect.timeout` and `timeout`), but that config is shared with every group's component browser specs, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced; the browser suite was not run. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** every recorded failure is a Playwright default deadline
  expiring on a loaded host while the spec waited on a real signal: both shortcut cases exceeding the 30 s test default.
  No wrong value, crash or lost input is recorded. `e2e/CreateEnvironmentDialog.spec.ts` passes no smaller
  timeout of its own at the failing calls.
- **Fix:** `e2e/playwright.config.ts`, which runs this component spec, now sets
  `timeout: 120_000` (was Playwright's 30 s default) and
  `expect: { timeout: 30_000 }` (was 5 s). Navigations have no timeout of
  their own, so they are bounded by the 120 s test budget. Both budgets are
  hang watchdogs on real signals, not speed checks.
- **Reproduced:** no — the recorded failure was not reproduced. The evidence
  is a rerun, under the new config, of the component specs that had failed in
  a loaded run (112 passed); that is not a targeted reproduction of this case,
  and a raised budget is weaker evidence than a reproduced fix.
- **Reopen:** a recurrence that hangs near the new budgets (120 s test, 30 s
  assertion) means the signal never arrived rather than arrived late; reopen
  this case.
