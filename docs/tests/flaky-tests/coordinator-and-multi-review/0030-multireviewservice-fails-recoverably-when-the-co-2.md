# `MultiReviewService fails recoverably when the consolidation session is missing` (`apps/backend/src/core/multi-review-service.test.ts:550`)

- **ID:** 0030
- **Status:** resolved
- **Date observed:** 2026-08-27
- **Original command:** `bun run test` (complete four-group repository suite).
- **Worker configuration:** `scripts/test-all.ts` ran workspace, root,
  bridges, and protocol-lockfile groups concurrently. The backend workspace
  used `--parallel=2` inside Turbo while the other groups were active.
- **Failure:** the workflow correctly reached `failed` with the missing-session
  error and cleared its address bookkeeping, but the environment's
  `agentActivitySources["multi-review"].state` was still `working` instead of
  `idle` at the final assertion (duration: 148.09 ms).
- **Suite counts:** backend workspace — 2,220 passed, 1 failed, 8,141
  assertions across 93 files in 51.09 s. The root, bridges, and protocol
  lockfile groups passed.
- **Isolated rerun:** `bun test ./src/core/multi-review-service.test.ts
  --test-name-pattern "fails recoverably when the consolidation session is
  missing"` from `apps/backend` -> 1 passed, 78 filtered out, 7 assertions in
  88 ms; the target passed in 62.16 ms.
- **Relationship to sibling entries:** this is the same file and final
  environment activity-source transition as the two open Multi Review address
  entries above. The workflow state assertions passed before the activity
  projection lagged, so this joins that timing cluster.
- **Hypothesis:** aggregate scheduling can leave the asynchronous environment
  activity projection one write behind the already-durable workflow failure.
  The isolated case exercises the same missing-session and cleanup path
  successfully. A fix should establish or await the activity-write ordering;
  the assertion should not be loosened.
