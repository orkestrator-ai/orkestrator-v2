# Coordinator browser navigation timeouts during merge validation

- **ID:** 7150
- **Status:** resolved
- **Date observed:** 2026-11-06
- **Files:** `e2e/CoordinatorPaneTree.spec.ts`; `e2e/FloatingNotices.spec.ts`
- **Original command:** `NODE_ENV=development mise run test:logged -- --name merge-browser-targeted -- bunx playwright test --config e2e/playwright.config.ts e2e/FloatingNotices.spec.ts e2e/CoordinatorPaneTree.spec.ts`
- **Workers:** six; the deterministic aggregate and real-backend smoke were also running.
- **Failure:** navigation to the fixture exceeded 30,000 ms; 10 failed, 14 skipped, 12 passed in 121.7 s.
- **Evidence:** `/tmp/orkestrator-test-run.unjRZM/merge-browser-targeted.log.gz`.

Failed pane cases: mobile switcher labels restored panes and keeps hidden composers
mounted; Change agent is visible without hovering the main tab; busy close controls
keep their width and focus; drags a side agent into its own group beside the
coordinator, then back; sortable tab exposes its accessibility attributes and
pointer listener; keyboard focus routes Find and Escape between restored native
composers; drops in the mobile switcher land in the group on screen, not the one
stacked under it.

Failed notice cases: on a phone the notices are pills in the corner; 128px panes
contain long-label pills and their opened cards; hidden mobile coordinator
conversations keep their notices hidden.

The complete unchanged owners passed alone with one worker:

```sh
NODE_ENV=development mise run test:logged -- --name merge-notices-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/FloatingNotices.spec.ts --workers=1
NODE_ENV=development mise run test:logged -- --name merge-pane-owner -- bunx playwright test --config e2e/playwright.config.ts e2e/CoordinatorPaneTree.spec.ts --workers=1
```

Exit 0 in 96.6 s and 97.0 s respectively. Passing logs were deleted; no passing
case counts are inferred. No test, timeout or implementation was changed between
runs. Host contention is a hypothesis; the root cause is unestablished.

## Triage note (2026-11-15)

Class A candidate. A navigation (`page.goto`/`page.reload`) or step used up Playwright's 30 s test deadline, or an assertion hit the 5 s `expect` default, while the host was loaded. The spec has no fixed sleep or ad-hoc wall-clock check of its own on the failing path. Nothing was changed. The fix would be hang-watchdog defaults in `e2e/playwright.config.ts` (`timeout` and `expect.timeout`), but every group's component specs share that config, so it is left for a separate decision rather than changed in a per-group sweep. Not reproduced, because the browser suite was not run. Stays `open`.

## Resolution (2026-11-15)

- **Root cause:** Playwright's default deadlines ran out on a loaded host while the test was waiting on a real signal. Every recorded failure is the 30 s default test timeout (`Test timeout of 30000ms exceeded`, in `page.goto`, `page.reload`, a click or a web-first assertion still in progress) or the 5 s default `expect` budget; none is a value mismatch, crash or lost interaction, and the failing calls pass no smaller timeout of their own. The specs measure no latency, so those defaults were acting as speed checks rather than hang watchdogs.
- **Fix:** the component browser config, `e2e/playwright.config.ts` (`mise run test:browser`), now sets `timeout: 120_000` (was Playwright's 30 s default) and `expect: { timeout: 30_000 }` (was 5 s). Navigations carry no timeout of their own, so they are bounded by the 120 s test timeout. No assertion changed.
- **Reproduced:** no — the recorded failure was not reproduced before the change. The evidence is weaker: a rerun of the component browser specs that had failed in a loaded run, with the new config, gave 112 passed; the one remaining failure there (`ToolGroupFold.spec.ts:127`, [1012](../web-ui/1012-live-tool-fold-threshold-gap.md)) also fails with main's config and is unrelated.
- **Stress:** none beyond that rerun.

A recurrence that hangs until near the new budget (a navigation or assertion timing out at 120 s or 30 s) is a real hang, not this deadline: reopen this case and record it.
