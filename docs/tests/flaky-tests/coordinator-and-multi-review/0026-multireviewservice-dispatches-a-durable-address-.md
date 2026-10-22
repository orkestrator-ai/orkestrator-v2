# `MultiReviewService dispatches a durable address intent without a renderer` (`apps/backend/src/core/multi-review-service.test.ts:603`)

- **ID:** 0026
- **Status:** resolved
- **Date observed:** 2026-08-27
- **Original command:** seven focused `bun test` file invocations launched
  concurrently, including `bun test ./src/core/multi-review-service.test.ts`
  from `apps/backend`.
- **Worker configuration:** seven independent Bun processes ran backend and web
  test files in parallel on the same host.
- **Failure:** after the durable address dispatch cleared
  `addressPromptPending`, the environment's `multi-review` activity source was
  still `working` instead of `idle` (duration: 154.63 ms).
- **Suite counts:** owning file — 89 total, 88 passed, 1 failed.
- **Isolated rerun:** `bun test ./src/core/multi-review-service.test.ts` from
  `apps/backend` -> 89 passed, 0 failed; the target passed in 72.48 ms.
- **Hypothesis:** the assertion observes the activity projection immediately
  after a separate durable field becomes settled. The same activity transition
  passed in isolation, so the evidence currently supports a scheduling-sensitive
  observation under cross-process contention but does not identify which async
  boundary is late. A recurrence should capture the save and activity write
  ordering before changing the expectation.
- **Recurrence:** on 2026-08-29, `bun run test` from `apps/backend` ran 18 Bun
  workers and reported this case failed after 533.29 ms. The aggregate reported
  2,334 passed and 2 failed across 2,336 tests; the other failure was a new
  deterministic build-pipeline test corrected in the same working tree. The
  aggregate capture did not retain this case's assertion detail. An immediate
  isolated rerun, `bun test src/core/multi-review-service.test.ts`, passed all
  100 tests; the affected case passed in 44.92 ms.
- **Recurrence:** on 2026-08-31, `bun run test` ran the four groups concurrently
  and the backend workspace used two Bun workers. The case failed after 105.70
  ms with the same expected `idle` / received `working` activity mismatch. The
  backend package reported 2,357 passed and 1 failed across 2,358 tests. An
  immediate isolated rerun, `cd apps/backend && bun test --preload
  ../../tests/setup-node.ts src/core/multi-review-service.test.ts`, passed all
  100 tests; the affected case passed in 50.84 ms.
- **Recurrence:** on 2026-08-31, `bun run --cwd apps/backend test` ran the
  backend suite with 18 Bun workers. The case failed after 583.72 ms; the
  aggregate capture retained the test name but not its assertion detail. The
  package reported 2,358 passed and 1 failed across 2,359 tests. The immediate
  isolated rerun, `bun --cwd=apps/backend test --preload
  ../../tests/setup-node.ts src/core/multi-review-service.test.ts`, passed all
  100 tests and 446 assertions in 4.92 s; the affected case passed in 37.45 ms.
