# `ActionBar workflow tabs > opens the review modal after a mobile long press without launching the default review` (`apps/web/src/components/layout/ActionBar.test.tsx`)

- **ID:** 0116
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-full-test.log`
- **Worker configuration:** The web workspace package ran its parallel test pool while the root, bridge, and Codex protocol-lockfile groups ran concurrently.
- **Failure:** Testing Library could not find the accessible `dialog` named `Configure code review` at `ActionBar.test.tsx:2407` after the 575 ms long-press wait (duration: 615.80 ms).
- **Suite counts:** Web package: 4,844 passed, 1 skipped, and 2 failed across 4,847 tests; the other failure was the deterministic AgentNativeTab context-wheel assertion.
- **Isolated rerun:** `bun test --cwd apps/web ./src/components/layout/ActionBar.test.tsx --parallel` -> 145 passed, 0 failed, 558 assertions in 13.24 seconds; the target passed in 598.64 ms.
- **Hypothesis:** The test queried immediately after a real-time sleep, so aggregate scheduling could delay the 550 ms production timer beyond the fixed 575 ms test wait. The owning file passes in isolation, consistent with a timing-sensitive assertion rather than a product failure.
- **Root cause:** The assertion was made immediately after a fixed sleep instead of waiting for the timer-driven dialog state transition.
- **Fix:** Commit `9065ed7f`; wrap the dialog assertion in `waitFor` with a 10-second test budget.
- **Verification:** The owning file passed with 145 tests and 0 failures after the fix; the affected test completed in 620.53 ms. The subsequent `/tmp/orkestrator-final-full-test.log` aggregate passed workspace (4,846 tests), root/agent-support (3,656 tests), bridges, Codex protocol lockfile checks, and iOS (40 tests) with 0 failures.
