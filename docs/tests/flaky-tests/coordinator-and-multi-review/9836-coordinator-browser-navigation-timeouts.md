# Coordinator browser navigation timeouts during merge validation

- **ID:** 9836
- **Status:** open
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
