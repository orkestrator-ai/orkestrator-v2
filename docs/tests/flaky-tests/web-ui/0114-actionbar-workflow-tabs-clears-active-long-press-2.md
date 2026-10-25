# `ActionBar workflow tabs > clears active long-press click suppression when the action bar unmounts` (`apps/web/src/components/layout/ActionBar.test.tsx`)

- **ID:** 0114
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-c9efefa1-full-tests.log`
- **Worker configuration:** The web workspace package ran `bun test src --parallel=2` while the remaining workspace, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** Testing Library could not find an accessible `dialog` named `Configure code review` at `ActionBar.test.tsx:2474` (duration: 628.67 ms).
- **Suite counts:** Web package: 4,808 total, 4,806 passed, 1 skipped, 1 failed across 210 files.
- **Isolated rerun:** `bun test --cwd apps/web ./src/components/layout/ActionBar.test.tsx --parallel` -> 145 passed, 0 failed, 558 assertions in 15.95 seconds; the target passed in 587.91 ms.
- **Recurrence (attachment-only startup review, 2026-08-15):** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-review-dfc3ad3f-full-tests.log` reproduced the identical signature — no accessible `dialog` named `Configure code review` at `ActionBar.test.tsx:2474` (duration: 608.50 ms) — with the web workspace package running alongside the root, bridge, and protocol-lockfile groups. Web package: 4,851 total, 4,849 passed, 1 skipped, 1 failed across 211 files; every other group passed and Turbo reported `11 successful, 12 total`. The immediate isolated rerun, `bun test --cwd apps/web ./src/components/layout/ActionBar.test.tsx`, passed 145/0 with 558 assertions in 12.79 seconds. Evidence: `/tmp/orkestrator-review-dfc3ad3f-full-tests.log` and `/tmp/orkestrator-review-dfc3ad3f-actionbar-isolated.log`.
- **Hypothesis:** The aggregate-only result shows the expected long-press dialog was absent when queried, while the full owning file recreates it in isolation. Two occurrences now share the same line and a sub-second duration, so the long press is firing but the dialog has not mounted by the time the query runs — consistent with scheduling contention rather than a product failure. No narrower trigger is established; a further recurrence should capture the long-press timer, pointer events, and unmount/remount state before changing the product behavior or assertion.
