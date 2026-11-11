# Tool group fold: a long group's inner viewport shows no entries in time

- **ID:** 9980
- **Status:** open
- **Date observed:** 2026-11-11
- **Base:** `14df965440e658e09a7b3ce03530bc1781ac2b01` (`main`).
- **Observed head:** `aa7b41b35` on branch `fix-failing-ci-fc33ea27615f-r1`.
  The branch changes backend code and tests, two other e2e specs and
  documentation; nothing under `apps/web`, `e2e/fixture` or
  `e2e/ToolGroupFold.spec.ts`.
- **Tests:** `a selection inside a long group's viewport survives nearby inner scrolling`
  (`e2e/ToolGroupFold.spec.ts:373`) and
  `focus inside a long group's viewport survives nearby inner scrolling`
  (`e2e/ToolGroupFold.spec.ts:413`)
- **Browser:** Chromium, `desktop-chromium` project.

## Symptom

After clicking `Show 1500 tool calls`, the poll for more than 2
`[data-tool-group-entry-index]` rows inside `[data-transcript-inner-viewport]`
read 0 for its whole 5 s budget (lines 382 and 420).

## Runs

On beelink (Linux x86_64, Bun 1.4.4, Playwright 1.65.0), host load average
about 3 to 6, other worktrees active:

- `mise run test:logged -- --name chromium-paging-fold -- bunx playwright test --config e2e/playwright.config.ts e2e/TranscriptPaging.spec.ts e2e/ToolGroupFold.spec.ts --workers=2`:
  75 passed, 1 skipped, 2 failed (both tests above, desktop).
- `mise run test:logged -- --name toolgroupfold-alone -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --workers=1`:
  37 passed, 1 failed (the focus test, desktop).
- `mise run test:logged -- --name toolgroupfold-inner -- bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts --grep "survives nearby inner scrolling" --workers=1 --repeat-each=4`:
  16 passed.

The focus test also failed once in the run recorded in case
[0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md).

## Hypothesis

Unconfirmed. A count of 0, not a small one, suggests the inner viewport had
not mounted its list (or had not measured a height) within 5 s of the click,
rather than a scroll race. That would fit a slow first render of a
1500-call group on a loaded host.
