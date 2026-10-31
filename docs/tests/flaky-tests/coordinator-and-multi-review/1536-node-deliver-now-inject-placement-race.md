# Node coordinator request still pending-inject after the held turn finished

- **ID:** 1536
- **Status:** open
- **Date observed:** 2026-10-31
- **Test:** `a command node's deliverNow on this leaf > node coordinator requests stay pending while held, until injection`
- **File:** `apps/backend/src/core/nodes/node-coordination.test.ts:316` (the `held` variant; assertion at `:348`)
- **Original command:** `mise run test:logged -- --name t0030-full -- mise run test`
  on branch `todo-0030-test-and-ci-health-569000e33dd1` (Arch Linux, Bun
  1.4.4, all four groups together, beside other worktrees' suites).
- **Failure:** after `retryAgentMailInject` and `finishTurn`, the message
  read back with `placement: "pending-inject"` instead of `"injected"`
  (61.60 ms). Artifact: `/tmp/orkestrator-test-run.QMGGh4/` (workspace log).
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts --parallel=1 src/core/nodes/node-coordination.test.ts`
  from `apps/backend`: 24 pass, 0 fail.
- **Earlier sighting:** the same "inject placement race" in
  [1324](../aggregate-validation-runs/1324-storage-test-split-0930-validation.md),
  without its own case.
- **Hypothesis:** the assertion reads the message before the asynchronous
  inject that `finishTurn` releases has written its placement. Not
  established. Next step: wait for the inject's completion signal (or poll the
  placement) instead of reading once, after confirming that production
  completes the inject on that edge. Load was 9 / 26 / 34 (1, 5, 15 min) just after the run. No assertion, timeout or skip changed.
