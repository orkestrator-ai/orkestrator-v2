# `MultiReviewService fails recoverably when the consolidation session is missing` (`apps/backend/src/core/multi-review-service.test.ts:550`)

- **ID:** 0028
- **Status:** resolved
- **Date observed:** 2026-08-27
- **Original command:** `bun run test` (complete concurrent cross-platform
  suite).
- **Worker configuration:** `scripts/test-all.ts` ran four test groups
  concurrently; the backend workspace package used two Bun workers.
- **Failure:** after the missing consolidation session was converted to a
  recoverable workflow failure, the environment's `multi-review` activity
  source was expected to be `idle` but remained `working` (duration: 102.14 ms).
- **Suite counts:** backend workspace group — 2,194 total, 2,192 passed, 2
  failed. The other failure was the related persisted-address recurrence above.
- **Isolated rerun:** `bun test src/core/multi-review-service.test.ts --only-failures`
  from `apps/backend` -> 79 passed, 0 failed in 5.08 s.
- **Hypothesis:** the failure has the same aggregate-only stale activity-source
  shape as the persisted-address case. The available output establishes that
  workflow failure state settled before the environment activity write became
  observable, but does not yet identify whether the cause is a delayed write or
  cross-test state; a recurrence should trace those activity-source updates.
