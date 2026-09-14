# `MultiReviewReviewerTab > keeps the transcript full-height and does not overlap slow refreshes` (`apps/web/src/components/review/MultiReviewTab.test.tsx`)

- **ID:** 0071
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-fix-review-full-tests.log`
- **Worker configuration:** The web workspace package ran `bun test src --parallel` while the remaining workspace, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** The test timed out after 1,029.86 ms waiting for Virtuoso to expose the completed `Reviewer report` article. The failure DOM showed the article after the timed-out query snapshot, so the production request had completed and rendered but missed the test's one-second polling window under aggregate load.
- **Suite counts:** Web package: 5,647 total, 5,645 passed, 1 skipped, 1 failed across 231 files. All other aggregate groups passed.
- **Isolated rerun:** The owning file had passed before the aggregate run (6 passed, 0 failed). After the test fix, `bun test --cwd apps/web src/components/review/MultiReviewTab.test.tsx --rerun-each 10` passed all 60 executions with 290 assertions in 841 ms.
- **Root cause:** The concurrency test coupled its completion signal to Virtuoso's deferred item rendering even though the behavior under test was request serialization. Aggregate scheduling could delay that unrelated render past Testing Library's one-second wait.
- **Fix:** Resolve and await the controlled transcript request inside asynchronous `act()`, then wait for the instrumented active-request count to reach zero and assert its maximum remained one. The existing rendering test continues to cover the report UI separately.
- **Verification:** Ten consecutive owning-file repetitions passed with zero failures. The subsequent aggregate result is recorded in this change's validation handoff.
