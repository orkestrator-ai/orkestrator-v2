# `MultiReviewService keeps a provider alive while a transcript read overlaps fix execution` (`apps/backend/src/core/multi-review-service.test.ts`)

- **ID:** 0084
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun run test 2>&1 | tee /tmp/orkestrator-picker-fixes-full-tests.log`
- **Worker configuration:** The backend workspace ran `bun test src tests --parallel` while the web, root, bridge, and protocol-lockfile groups ran concurrently.
- **Failure:** After the overlapping transcript read completed and fix execution reached `completed`, the provider had one disposal instead of the expected two (`Expected: 2`, `Received: 1`) at `multi-review-service.test.ts:278` (duration: 183.68 ms).
- **Suite counts:** Backend package: 1,684 total, 1,682 passed, 2 failed across 55 files. Root/agent-support and the protocol lockfile passed; the bridge group had one separate aggregate-only failure.
- **Isolated rerun:** `bun test ./src/core/multi-review-service.test.ts --parallel` from `apps/backend` -> 32 passed, 0 failed in 3.16 seconds; the target passed in 56.74 ms. Evidence: `/tmp/orkestrator-picker-fixes-isolated-multi-review.log`.
- **Hypothesis:** The workflow reached its durable completed phase before the asynchronous provider-disposal observation became visible under aggregate scheduling. The isolated run proves the production path can satisfy the assertion, but this occurrence does not establish whether the test needs an explicit disposal boundary or the service is publishing completion before cleanup settles.
- **Root cause:** Same overlapping-fix-execution teardown race as the entry above. Address-all no longer starts that supervised turn.
- **Fix:** Same replacement case as the entry above.
- **Verification:** Owning-file coverage for the rewritten handoff case is included in this change's Multi Review test run.
