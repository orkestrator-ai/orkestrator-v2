# Graph run view page stays blank after a reload under host load

- **ID:** 3610
- **Status:** open
- **Date observed:** 2026-11-03
- **Test:** `the Graphs designer lists the environment's runs from the backend`
- **File:** `e2e/agent-testing/graph-run-view.spec.ts:48`

During the to-do 2922 task 4 work (branch `sidebar-environment-3c8942d7b108-r1`,
based on `main` at `7b48c23fb`), a focused run of the graph journeys on the
disposable `graph-sidebar-2922` profile (`dev:test --fixture
--no-agent-credentials --agent-platforms codex --headless-electron`) failed this
case in `ensureProjectExpanded`: the fixture project's Expand/Collapse control
never appeared within 30 s after `page.reload()`. The failure screenshot is an
empty dark page and the error-context snapshot is empty, so the renderer had not
mounted. A throwaway probe on the same profile minutes earlier reached the
renderer's "Orkestrator couldn't connect" alert after a reload. The host load
average was about 56 (about ten builds running on beelink). The cause is
unconfirmed; host load starving the gateway or Vite during startup is the
working hypothesis.

The same case passed in the previous run of the same command, and the complete
owner passed alone straight afterwards (exit 0; the file's opt-in restart case
skips without `ORKESTRATOR_AGENT_TEST_GRAPH_RESTART=1`):

```sh
ORKESTRATOR_AGENT_TEST_PROFILE=graph-sidebar-2922 ORKESTRATOR_AGENT_TEST_RUN_ID=graph-sidebar-2922 mise run test:logged -- --name graph-run-view -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts e2e/agent-testing/graph-run-view.spec.ts --workers=1 --retries=0
```

The original command selected `graph-designer.spec.ts`, `graph-run-view.spec.ts`
and `graph-designer-editing.spec.ts` with `--workers=1 --retries=0` on the same
profile: 5 passed, 1 failed (this case, 34.2 s), 1 skipped. Sanitized browser
artifacts were under `output/agent-testing/graph-sidebar-2922/browser/artifacts/`
in that worktree. No assertion, timeout or skip changed for this failure.

## Renderer error ring review — 2026-11-11

Branch `renderer-error-ring-e3a48fce2746-r1` (to-dos 6300 and 6301), base
`498b68766`; `mise run flaky:recurrence -- 3610 --base 498b68766` reported
`open`. The spec and the Graphs designer are unchanged on the branch. Review
preparation's `mise run test:agent:browser:isolated` failed this case:
`locator('[data-graph-designer]')` was not visible within 5 s. The case alone on
fresh credential-free profile `e3a4-ring-r1` (`--agent-platforms claude`,
`ORKESTRATOR_HOST_REACHABILITY_CHECK=off`) passed:
`mise run test:logged -- --name agent-browser-owners -- mise run test:agent:browser -- e2e/agent-testing/browser-gateway.spec.ts:2859 e2e/agent-testing/graph-run-view.spec.ts:48`
(the two `browser-gateway` cases in that run are recorded in 0484). No assertion,
timeout or skip changed.
