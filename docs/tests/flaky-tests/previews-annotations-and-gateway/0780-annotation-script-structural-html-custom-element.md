# Structural HTML keeps custom element text (apps/desktop/tests/browser-preview-annotation-script.test.ts)

- **ID:** 0780
- **Status:** open
- **Date observed:** 2026-10-24
- **Test:** `bounded, sanitized evidence > structural HTML drops handlers, values, scripts, srcdoc, javascript: URLs, and token parameters` (`apps/desktop/tests/browser-preview-annotation-script.test.ts:349`)
- **Original command:** `mise run test:logged -- --name desktop-cap -- bun test --cwd apps/desktop browser-preview preload-api --parallel=4 --only-failures`
- **Worker configuration:** `--parallel=4` (implies `--isolate`), 14 files
- **Failure:** `expect(html).toContain("<custom-widget>Widget</custom-widget>")`; the received structural HTML ended in `<custom-widget></custom-widget></div><!-- truncated -->`, so the custom element's text was dropped and the evidence was cut at its bound (duration: 37.63 ms)
- **Suite counts:** 213 total, 212 passed, 1 failed
- **Isolated rerun:** `bun test tests/browser-preview-annotation-script.test.ts` from `apps/desktop` → 28 passed. The same parallel group then passed three times in a row.
- **Context:** Seen on the 0043 known-limitations branch, which does not change `browser-preview-annotation-script.ts` or this test file.
- **Hypothesis:** The structural HTML walk in `browser-preview-anchor-script.ts` spends a traversal budget that also checks a wall-clock deadline every 32 visits (`spend`). The received HTML stops exactly before the custom element's text node and ends in `<!-- truncated -->`, which is what an exhausted budget produces. Under four parallel workers the deadline likely elapsed mid-walk. Not yet reproduced on demand; a fix would make the test's budget deadline generous (or inject the clock) rather than loosen the assertion.

## Triage 2026-10-25

- **Disposition:** open. This case now also covers [0791](0791-annotation-semantic-context-budget.md) (duplicate).
- **Evidence:** both failures come from the anchor script's wall-clock budgets: `createBudget` deadlines of 5 to 25 ms (`browser-preview-anchor-script.ts:187`, checked in `spend` at line 195). When `now()` passes the deadline, the HTML walk truncates (this case) or the resolver returns `too-complex` (0791: `page-side anchor resolver > a reordered card resolves by surrounding context, not by its old structural position`, 2026-10-24 aggregate, passed alone in 0.4 s). The owner passed alone today (28/28, 0.9 s; Bun 1.4.4).
- **Next step:** let tests inject `now` (or scale the deadlines) so the budgets run out only by visit count; keep the production deadlines.
