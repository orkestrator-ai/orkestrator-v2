# Small wheel release does not re-engage follow at the bottom

- **ID:** 6621
- **Status:** resolved
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

## Triage note (2026-11-15)

Left `open` by the Playwright default-deadline triage. The test fails alone (5 of 8 and 4 of 8 under `--repeat-each=8`) with `false` instead of `auto` for the whole deadline, a wrong state; a longer assertion budget does not address it.

## Resolution — 2026-11-19

- **Root cause:** the test, not the follow logic. Both return-to-the-end steps
  used a DOM-only `scrollTo`. `TranscriptScrollController.handleScroll`
  re-arms follow only during reader input (`INPUT_ARM_MS`, 250 ms after the
  last wheel or key), by design. When the `scrollTo` landed after the earlier
  `-10` wheel's window had expired, follow stayed off and the append decided
  `false`. How late it landed depended on the host, hence 4–5 failures in 8.
- **Fix:** already on `main` in `c28f1bd05` (2026-11-06, the day after this
  case was recorded; see the "Transcript restoration repair" section of
  [0153](0153-virtuoso-follow-parallel-scroll-release.md)): both return steps
  are now a real wheel gesture (`page.mouse.wheel(0, 100_000)`). No assertion,
  deadline or product code changed. This case was not closed at the time.
- **Reproduced on demand:** the pre-fix spec (`git show c28f1bd05^:e2e/VirtuosoFollow.spec.ts`)
  with `page.waitForTimeout(1_000)` before each DOM-only return (so the input
  window has certainly expired) failed 4 of 4, with the recorded symptom
  (`Expected: "auto"`, `Received: "false"`):
  `ORKESTRATOR_E2E_PORT=14731 mise run test:logged -- --name repro-6621-delay -- bunx playwright test -c e2e/playwright.config.ts VirtuosoFollowOldRepro -g "small wheel release" --project=desktop-chromium --repeat-each=4 --workers=1`
  (temporary copy, deleted afterwards).
- **Fix under the same condition:** the current spec with the same 1 s wait
  before each wheel return passed both desktop cases 10 times each (20/20,
  81.8 s, temporary copy, deleted).
- **Stress:** the unchanged current case passed 8/8
  (`--repeat-each=8 --workers=1`, 28.5 s) and 30/30 under
  `bun scripts/test-under-contention.ts --burners 4` (98.7 s, macOS, so the
  burners were unpinned). No `false`/`auto` failure of this spec has been
  recorded since 2026-11-06.
