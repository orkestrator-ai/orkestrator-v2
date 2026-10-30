# Graph mock browser page closes during startup

- **ID:** 1315
- **Status:** open
- **Date observed:** 2026-10-30
- **Test:** `Graphs designer starts a mock run: no provider, no pull request, would-have-run records`
- **File:** `e2e/agent-testing/graph-designer-mock.spec.ts:60`

The focused graph-spec run on the disposable `graphs-switch-off-regression`
profile failed before opening the designer. `ensureProjectExpanded` was waiting
for the fixture project's Expand/Collapse control when Playwright reported
`Target page, context or browser has been closed`. The other three scenarios,
including the switch-off regression, passed. The cause is unconfirmed.

The complete unchanged owner passed alone (exit 0, 26.1 s):

```sh
ORKESTRATOR_AGENT_TEST_PROFILE=graphs-switch-off-regression mise run test:logged -- --name graph-mock-owner -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts graph-designer-mock.spec.ts --workers=1
```

The original command selected `graph-designer.spec.ts`,
`graph-designer-editing.spec.ts` and `graph-designer-mock.spec.ts` with one worker
and the same profile. Failure log: `orkestrator-test-run.Py4Ecz/graph-browser-owners.log.gz`
under the host temporary directory; sanitized browser artifacts:
`output/agent-testing/graphs-switch-off-regression/browser/artifacts/`.
No assertion, timeout or skip changed for this startup failure.
