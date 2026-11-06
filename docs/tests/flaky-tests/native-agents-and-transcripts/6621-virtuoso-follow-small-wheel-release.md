# Small wheel release does not re-engage follow at the bottom

- **ID:** 6621
- **Status:** open
- **Date observed:** 2026-11-05
- **Test:** `a small wheel release stays unfollowed through growth inside the bottom band`.
- **File:** `e2e/VirtuosoFollow.spec.ts:57`.
- **Original command:** `mise run test:logged -- --name transcript-specs -- bunx playwright test -c e2e/playwright.config.ts <13 transcript specs> --project=desktop-chromium --reporter=line --workers=3`, while validating to-do 6280.
- **Worker configuration:** three Playwright workers on one fixture server.
- **Failure:** at `:86`, `expect(getByTestId('virtuoso-follow-decision')).toHaveText("auto")` received `"false"` for the whole 5 s, after the test scrolled back to the end and appended a message.
- **Suite counts:** 100 passed, 1 failed, 1 skipped.
- **Owning-file rerun:** this is not the usual pattern, because the test also fails alone. `bunx playwright test -c e2e/playwright.config.ts e2e/VirtuosoFollow.spec.ts:57 --project=desktop-chromium --repeat-each=8 --workers=1` failed 5 of 8 on `41f9eb638` with no other change, and 4 of 8 with the 6280 change applied.
- **Evidence:** the `/virtuoso-follow` fixture renders `<Virtuoso>` directly (`VirtuosoFollowFixture` in `e2e/fixture/main.tsx`), not through `VirtualizedMessageList`, so 6280's list change does not reach it.
- **Hypothesis:** the follow decision read after `scrollTo` depends on when Virtuoso reports the end of the list relative to the append. Not confirmed.
