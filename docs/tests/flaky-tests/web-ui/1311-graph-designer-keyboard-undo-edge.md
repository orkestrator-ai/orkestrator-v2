# Graphs designer builds the design bake-off on the canvas, compiles it clean and saves it

- **ID:** 1311
- **Status:** open
- **Date observed:** 2026-10-29
- **Test:** `Graphs designer builds the design bake-off on the canvas, compiles it clean and saves it`
- **File:** `e2e/agent-testing/graph-designer-editing.spec.ts:223`
- **Original command:** `ORKESTRATOR_AGENT_TEST_PROFILE=graphs-213 ORKESTRATOR_AGENT_TEST_RUN_ID=graphs-213 mise run test:logged -- --name graphs-213-designer-e2e -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts graph-designer.spec.ts graph-designer-editing.spec.ts --workers=1`, against an isolated `dev:test --fixture --no-agent-credentials --agent-platforms codex` profile, run right after `graph-designer-mock.spec.ts` on the same profile (branch `graphs-213-mock`, item 213).
- **Failure:** After Control+Z the canvas still showed the same edge count (`expect.poll(draftEdgeCount).toBe(withBriefs - 1)`: expected 1, received 2) within the five-second poll.
- **Suite counts:** one passed (`graph-designer.spec.ts`), one failed.
- **Isolated rerun:** `ORKESTRATOR_AGENT_TEST_PROFILE=graphs-213 ORKESTRATOR_AGENT_TEST_RUN_ID=graphs-213 mise run test:logged -- --name graphs-213-editing-e2e -- bunx playwright test --config e2e/agent-testing/playwright.browser.config.ts graph-designer-editing.spec.ts --workers=1` passed the complete unchanged owning file (17.7 s) on the same profile.
- **Evidence:** `orkestrator-test-run.rkSCrN` below the host temporary directory; artifacts under `output/agent-testing/graphs-213/browser/artifacts/` (not committed).
- **Hypothesis:** The window-level undo shortcut only acts when the key event's target is inside the designer or the document body; right after the "Connect to…" dialog closes, focus may still be in transit, so the keypress is ignored. Not confirmed; no assertion, timeout or skip changed.

- **Recurrence (2026-10-30):** The experimental-graphs review preparation
  repeated the same edge-count failure. Explicitly focusing the designer's
  Connect button before Undo passed once in the complete isolated suite and
  once in the focused graph-spec run, but the next complete isolated run
  failed the same assertion even after `toBeFocused()` passed. Focus alone
  therefore does not establish the cause; that attempted test change was
  reverted. The assertions and timeout remain unchanged. Evidence:
  `orkestrator-test-run.ukaJle/isolated-browser-final.log.gz` under the host
  temporary directory and
  `output/agent-testing/qa-browser-733773a3-88d/browser/artifacts/`.
