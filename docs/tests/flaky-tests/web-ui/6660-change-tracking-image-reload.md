# Change tracking image fallback after reload

- **ID:** 6660
- **Status:** resolved
- **Date observed:** 2026-11-05
- **Test:** `an unreachable image stream retries base64 and releases its capability`
- **File:** `e2e/ChangeTracking.spec.ts:137`
- **Browser:** mobile Chromium

During coordinator C3 review fixes, the component suite failed at line 189:
after reload, the image with accessible name `image.png` was absent instead of
having its base64 source. The test exceeded 30 seconds.

Original command:
`ORKESTRATOR_E2E_PORT=15427 ORKESTRATOR_PUBLIC_E2E_PORT=15428 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=2 mise run test:logged -- --name browser -- mise run test:browser`.
The run was stopped after three reported failures and 82 started cases; there
is no complete pass count. Two other failures were the mobile AgentUsage cases
tracked in 0749. Evidence: `/tmp/orkestrator-test-run.PDmU8s/browser.log.gz`.

Owner rerun:
`ORKESTRATOR_E2E_PORT=15429 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=2 mise run test:logged -- --name browser-findings-isolated -- bunx playwright test --config e2e/playwright.config.ts e2e/AgentUsage.spec.ts e2e/ChangeTracking.spec.ts`.
All eight unchanged ChangeTracking cases passed across both viewports; all four
AgentUsage cases failed. Total: 8 passed, 4 failed in 182.5 seconds.
Evidence: `/tmp/orkestrator-test-run.J1rBxn/browser-findings-isolated.log.gz`.

The default suite was running concurrently on this shared host. No cause has
been established. No image implementation, assertion, timeout or skip changed.

## File-only follow-up

A further run of only the owner file used
`ORKESTRATOR_E2E_PORT=15430 ORKESTRATOR_VALIDATION_GRANTED_WORKERS=2 mise run test:logged -- --name change-tracking-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/ChangeTracking.spec.ts`.
It passed seven cases, including the fallback case above on both viewports,
but failed the mobile `live images decode, refresh, recover after missed edits,
and fall back on deletion or corrupt bytes` case at line 37: `page.reload`
exceeded 30 seconds waiting for load. Total: 7 passed, 1 failed, 112.9 seconds.
Evidence: `/tmp/orkestrator-test-run.VM1uHH/change-tracking-owner.log.gz`.
This additional failure is unclassified; no cause or isolated pass for it is
established. The browser check remains non-green.

## Triage note (2026-11-15)

Class A candidate (Playwright's default 5 s assertion / 30 s test deadline expiring on a loaded host). Not changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`expect.timeout` and `timeout`), but that config is shared with every group's component browser specs, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced; the browser suite was not run. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** every recorded failure is a Playwright default deadline
  expiring on a loaded host while the spec waited on a real signal: the reloaded image not yet carrying its base64 `src` when the 30 s test default expired (line 189), and `page.reload` exceeding the 30 s test default (line 37).
  No wrong value, crash or lost input is recorded. `e2e/ChangeTracking.spec.ts` passes no smaller
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
