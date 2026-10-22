# `ActionBar workflow tabs > opens the PR modal after a mobile long press without launching a default PR` (`apps/web/src/components/layout/ActionBar.test.tsx`)

- **ID:** 0115
- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `bun --cwd=apps/web test --parallel=4`
- **Worker configuration:** The whole web package ran as one four-worker pool (216 files); the root, bridge, and protocol groups were not running concurrently.
- **Failure:** Testing Library could not find an accessible `dialog` named `Configure pull request` at `ActionBar.test.tsx:2586` after the fixed 575 ms long-press wait (duration: 735.93 ms; also observed at 741.62 ms and 747.05 ms).
- **Suite counts:** Web package: 4,928 passed, 1 skipped, 1 failed across 4,930 tests in 216 files. Reproduced on 3 of 6 aggregate runs; the other 3 runs passed 4,929/0.
- **Isolated rerun:** `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx` -> 156 passed, 0 failed in 18.68 s; the target passed every time.
- **Hypothesis:** This is the PR-modal twin of the code-review case resolved below, and it was the only long-press dialog assertion in the file still querying immediately after the fixed sleep instead of through `waitFor` (compare `ActionBar.test.tsx:2673` and `:2712`, both already wrapped). Under aggregate scheduling the 550 ms production timer can land after the 575 ms test sleep, so the query runs before the dialog mounts. The failure predates the change under which it was observed; it is a timing-sensitive assertion, not a product defect.
- **Root cause:** The assertion was made immediately after a fixed sleep instead of waiting for the timer-driven dialog state transition — identical to the resolved twin below, which was missed when that fix was applied.
- **Fix:** Wrap the `Configure pull request` dialog assertion in `waitFor` with a 10-second budget, matching the twin's remedy from commit `9065ed7f`.
- **Verification:** `bun --cwd=apps/web test src/components/layout/ActionBar.test.tsx` -> 156 passed, 0 failed; the target completed in 660.98 ms. Two subsequent full web-package aggregates (`bun --cwd=apps/web test --parallel=4`) passed 4,929/0 across 216 files.
