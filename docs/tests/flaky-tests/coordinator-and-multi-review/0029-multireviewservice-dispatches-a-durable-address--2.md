# `MultiReviewService dispatches a durable address intent without a renderer` (`apps/backend/src/core/multi-review-service.test.ts:603`)

- **ID:** 0029
- **Status:** resolved
- **Date observed:** 2026-08-27
- **Original command:** `bun run test` (complete concurrent cross-platform
  suite), on branch `update-environment-modal`.
- **Worker configuration:** `scripts/test-all.ts` ran four groups concurrently;
  this failure was in the backend workspace package, whose own script uses
  `--parallel=${ORKESTRATOR_TEST_WORKERS:-2}` under turbo alongside the web,
  desktop, web-public, CLI and protocol packages.
- **Failure:** 2,202 passed, 1 failed across 92 files in 42.2 s. The failing
  assertion is one of the environment activity-source transitions this test
  makes around the durable address dispatch.
- **Isolated reruns:** `bun run test:logged -- --name mr-isolate -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  src/core/multi-review-service.test.ts --only-failures` -> exit 0 in 4.9 s.
  The single test alone with `-t` -> 1 passed. The whole backend `src` suite was
  then run three more times at `--parallel=2`: 2,190 passed, 0 failed each time.
- **Relationship to the sibling entry:** this is the same file and the same
  `agentActivitySources["multi-review"]` timing shape as
  `MultiReviewService resumes a persisted address attempt after restart`,
  recorded above on 2026-08-26. Treat the two as one cluster.
- **Attribution:** the change under review refactored this service's reviewer
  fan-out into the shared `review-fanout.ts`, so this file is *not* untouched
  and the usual "unrelated diff" argument does not apply on its own. What does
  apply: the test reaches the `ready` phase — meaning the reviewer path it
  shares with the refactor completed successfully — before the assertions that
  failed, and `address`, `advanceAddressPrompt` and `syncWorkflowActivity`,
  which own those assertions, were not modified. The sibling entry predates the
  change. A recurrence should capture the activity-source writes around
  `address()` and the dispatch callback rather than the reviewer pass.
- **Recurrence (multi-model build lifecycle fixes, 2026-08-27):**
  `bun run --cwd apps/backend test` ran 18 Bun workers and reported this case
  failed after 188.74 ms; the backend package finished with 2,220 passed and 1
  failed across 93 files in 15.21 s. The captured aggregate tail did not retain
  the assertion detail. The immediate isolated rerun, `bun test
  ./src/core/multi-review-service.test.ts` from `apps/backend`, passed all 79
  cases and 335 assertions in 4.58 s; this target passed in 37.84 ms. The
  lifecycle changes in this pass do not touch `address()`, its dispatch
  callback, or `syncWorkflowActivity`, so the evidence remains consistent with
  the existing activity-source timing cluster rather than a deterministic
  reviewer-fan-out regression.
- **Recurrence (remote-client data efficiency review fixes, 2026-09-05):** `bun
  run test:logged -- --name backend-all-2 -- bun run --cwd apps/backend test`
  reported 2,470 passed and this case failed after 183.00 ms across 106 files
  in 15.08 s, under the package script's own parallel worker pool. The
  assertion is the same one as the cluster above: the environment snapshot read
  after the durable address intent cleared did not match
  `agentActivitySources: { "multi-review": { state: "idle" } }`
  (`multi-review-service.test.ts:800`). The isolated rerun, `bun --cwd=apps/backend
  test src/core/multi-review-service.test.ts`, passed 106 cases with zero
  failures. The change in flight fixed native-agent projection sync defects and
  split a backend test file; it touches neither `address()`, its dispatch
  callback, nor `syncWorkflowActivity`. A code review of the same working tree
  observed this case failing in its own backend run on the same day and did not
  rerun the owner alone; that reading is now closed out by the isolated pass
  recorded here.
- **Reproduction recipe (2026-09-05):** worker count, not the aggregate itself,
  is what surfaces this. `apps/backend`'s `test` script uses bare `--parallel`
  (one worker per core, 18 on this host) while its `test:workspace` script —
  the one `bun run test` drives through turbo — pins `--parallel=2`. Against
  the same working tree, `bun --cwd=apps/backend test --preload
  ../../tests/setup-node.ts src tests --parallel` failed this case in four of
  five consecutive runs (183.00 ms, 215.78 ms, 185.10 ms, and one earlier run),
  while the same command at `--parallel=2` passed 2,471 tests with zero
  failures and the complete `bun run test` passed every group. That gives the
  cluster the reliable trigger it has been missing: the next attempt should run
  the high-worker command and capture the `agentActivitySources` writes around
  `address()` and its dispatch callback, rather than trying to provoke it from
  an aggregate run.
- **Recurrence (native steering bridge qualification, 2026-08-28):** a command
  intended to select one projection file appended that path to the backend
  package script instead, so Bun ran the complete backend suite with its
  default parallel worker pool. This case again observed
  `agentActivitySources["multi-review"].state` as `working` instead of `idle`
  after the durable address intent cleared (205.46 ms); that run reported 2,247
  passing and 3 failing tests across 93 files, with the other two failures both
  deterministic assertions in the new projection test and subsequently fixed.
  The correctly isolated rerun,
  `bun run test:logged -- --name steer-multi-review-isolated-3 -- bun test
  --cwd apps/backend --preload ../../tests/setup-node.ts
  ./src/core/multi-review-service.test.ts`, passed. The steering changes do not
  touch Multi Review activity writes, so this remains evidence for the existing
  aggregate-only activity-projection timing cluster.
