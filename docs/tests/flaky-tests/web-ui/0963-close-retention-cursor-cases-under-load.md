# Cursor close-retention cases fail under browser-suite load

- **ID:** 0963
- **Status:** open
- **Date observed:** 2026-10-26
- **Owning file:** `e2e/CloseRetention.spec.ts`.
- **Change under test:** todo 0035 on branch
  `todo-0035-mobile-layout-gaps-49509c5f9933` (head `87a6751fd`). It touches
  the ActionBar, the projects drawer, fullscreen settings and their specs,
  not Cursor transcripts, steering or close retention.
- **Aggregate failure:** `mise run test:logged -- --name browser -- mise run test:browser`
  (754 passed, 102 skipped, 4 failed in 11.6 minutes, host load average about
  40 on 18 cores). In `desktop-chromium`, `steering a Cursor turn whose steer
  history is full is refused, the turn carries on and the draft survives`
  (line 693) failed at line 719: `expect(filled.error).toBeUndefined()`
  received `"The Cursor session has no running turn to steer"`. The other
  failures were [0153](../native-agents-and-transcripts/0153-virtuoso-follow-parallel-scroll-release.md)
  and the known native branch picker in `e2e/AgentLaunchDialog.spec.ts`
  ([0825](../aggregate-validation-runs/0825-dependency-upgrades-0032-validation.md)).
- **Owning-file rerun:** `mise run test:logged -- --name browser-owners -- bunx playwright test --config e2e/playwright.config.ts e2e/CloseRetention.spec.ts e2e/VirtuosoFollow.spec.ts --workers=1 --output output/playwright/owners-0035`
  passed the steering case in both projects, but failed a different case:
  21 passed, 1 failed (2.8 minutes). The failure was `a Cursor transcript shed
  from persistence comes back truncated after a bridge restart, on the same
  conversation` (line 801, `desktop-chromium`) at line 823:
  `expect(page.getByText("Answer to: <first turn>")).toHaveCount(0)` received 1.
- **Targeted rerun:** `mise run test:logged -- --name close-retention-801 -- bunx playwright test --config e2e/playwright.config.ts e2e/CloseRetention.spec.ts:801 --workers=1 --repeat-each=3 --output output/playwright/owners-0035b`
  passed six of six (both projects, 26.1 s).
- **Evidence:** the browser log in `orkestrator-test-run.sKTHlZ/` and the
  owner log in `orkestrator-test-run.9Cr6B8/`, below the host temporary
  directory. Traces are under
  `output/playwright/test-results/CloseRetention-steering-a--97b0b-*` and
  `output/playwright/owners-0035/CloseRetention-a-Cursor-tr-50c8e-*`.
- **Hypothesis:** both cases race the fixture's Cursor turn lifecycle. The
  steer arrives after the turn has ended, and the truncated transcript is
  read before the shed is applied. Load seems to widen both races. Not
  confirmed. No assertion, timeout or skip changed.
