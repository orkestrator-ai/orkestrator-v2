# CLI cascade-removal case cannot find the fixture project's Collapse button

## Task analysis

Analysed 2026-11-06 against `main` at `c1724ab7`. Found during
[0044](../previews-and-annotations/0044-web-annotation-qualification.md)
task 5's isolated browser run; not caused by that change, which touches no
product code and nothing this spec uses.

### Tasks

1. **Make `a CLI-initialized project and its cascade removal reach an open renderer` pass again**: find why the fixture project's `Collapse project <name>` button never appears after its Expand button is clicked, and fix the spec or the sidebar. Status: open.

### 1. Make the cascade-removal case pass again

**Problem.** `e2e/agent-testing/cli-ui.spec.ts:349` fails in `openProject`
(line 233): `getByRole('button', { name: 'Collapse project origin' })` is not
found within 5 s. The `expand.or(collapse)` check just before it passes, so
the Expand button is there and is clicked.

**Context.** Seen twice on beelink on 2026-11-06, Linux, Playwright 1.64.0,
credential-free Codex profiles (`--headless --fixture --no-agent-credentials
--agent-platforms codex`):

- in `mise run test:agent:browser:isolated` (49 passed, 3 failed, 111
  skipped; the other two failures were flake 2340, with
  `net::ERR_NETWORK_CHANGED` in their traces);
- alone, against a fresh profile: `bunx playwright test --config
  e2e/agent-testing/playwright.browser.config.ts cli-ui.spec.ts --grep
  "cascade removal" --workers=1`, failed the same way in 8.6 s.

Its trace has no `net::ERR_NETWORK_CHANGED`, so it is not 2340, and failing
alone makes it deterministic, not a flake. The call log shows the
"Docker containers can't reach Orkestrator" dialog intercepted and closed
before the wait. The case was resolved for a different symptom on 2026-11-04
([0901](../../tests/flaky-tests/web-ui/0901-cli-ui-fixture-project-hydration.md)).

**Investigation.** Not started. One lead, unconfirmed: the sidebar's
project rows changed recently, and
[1302](../../tests/flaky-tests/electron-and-desktop/1302-workspace-realm-startup-points.md)
found a locator that no longer matched a row's accessible name after
that change.

**Decisions.**

- **Fix the spec or the product?**
  - **Read the trace's DOM snapshot after the Expand click first, and fix
    whichever disagrees with the sidebar's documented behaviour
    (recommended).**
    - Pros: does not assume the spec is the stale side.
    - Cons: needs one more run with the trace kept.
  - **Update the locator to whatever the row now exposes.**
    - Pros: quick.
    - Cons: would hide a real regression if expanding a project is what broke.

## Related

- [0044](../previews-and-annotations/0044-web-annotation-qualification.md),
  "Runs on 2026-11-06 (Linux, beelink)".
