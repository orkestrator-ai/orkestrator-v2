# Graphs designer builds the design bake-off on the canvas, compiles it clean and saves it

- **ID:** 1311
- **Status:** resolved
- **Date observed:** 2026-10-29
- **Test:** `Graphs designer builds the design bake-off on the canvas, compiles it clean and saves it`
- **File:** `e2e/agent-testing/graph-designer-editing.spec.ts:223`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=graphs-213 ORKESTRATOR_AGENT_TEST_RUN_ID=graphs-213 mise run test:logged -- --name graphs-213-designer-e2e -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts graph-designer.spec.ts graph-designer-editing.spec.ts --workers=1`, against an isolated `dev:test --fixture --no-agent-credentials --agent-platforms codex` profile, run right after `graph-designer-mock.spec.ts` on the same profile (branch `graphs-213-mock`, item 213).
- **Failure:** After Control+Z the canvas still showed the same edge count (`expect.poll(draftEdgeCount).toBe(withBriefs - 1)`: expected 1, received 2) within the five-second poll.
- **Suite counts:** one passed (`graph-designer.spec.ts`), one failed.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=graphs-213 ORKESTRATOR_AGENT_TEST_RUN_ID=graphs-213 mise run test:logged -- --name graphs-213-editing-e2e -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts graph-designer-editing.spec.ts --workers=1` passed the complete unchanged owning file (17.7 s) on the same profile.
- **Evidence:** `orkestrator-test-run.rkSCrN` below the host temporary directory; artifacts under `output/agent-testing/graphs-213/browser/artifacts/` (not committed).
- **Hypothesis:** The window-level undo shortcut only acts when the key event's target is inside the designer or the document body; right after the "Connect to…" dialog closes, focus may still be in transit, so the keypress is ignored. Not confirmed; no assertion, timeout or skip changed.

- **Resolution (2026-10-30):** The browser test now explicitly focuses the
  designer's Connect button and verifies focus before sending the Undo
  shortcut. This establishes which component should receive the keyboard
  action after the portal dialog closes. The edge-count assertions are
  unchanged. The owning scenario passed in the complete isolated browser
  rerun and again in the focused graph-spec run.
