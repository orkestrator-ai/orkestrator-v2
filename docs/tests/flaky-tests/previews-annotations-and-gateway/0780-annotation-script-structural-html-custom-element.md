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
