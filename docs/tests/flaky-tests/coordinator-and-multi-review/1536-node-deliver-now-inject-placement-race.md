# Node coordinator request still pending-inject after the held turn finished

- **ID:** 1536
- **Status:** resolved
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

## Further sightings

- **2026-11-01**, branch `visual-change-image-05b2937be199-r1` (shared agent
  instructions across providers; no change near node coordination):
  aggregate `mise run test`, all four groups together. The same assertion at
  `:348` read `placement: "pending-inject"` instead of `"injected"` (30.53 ms);
  it was the only failure in the run. Artifact:
  `/tmp/orkestrator-test-run.7fBsxT/` (workspace log). Isolated rerun
  `bun test ./src/core/nodes/node-coordination.test.ts` from `apps/backend`,
  three times: 24 pass, 0 fail each.


### Resolution — 2026-11-06

- **Stale; fixed by `b965aea44` (#1547, merged 2026-11-01 12:34 UTC).** In the
  `held` variant the test sent "Uses the first wake budget." to a busy recipient
  and left that message pending, with its busy backoff, when it released the
  second message. The next `finishTurn` drain could then deliver the first
  message ahead of the released one. That delivery consumed the turn, so the
  released message stayed `pending-inject` with `userReleasedAt` set at
  revision 2, which is exactly the recorded symptom. `b965aea44` settles the
  first delivery (`await world.finishTurn(recipient)`) before sending and
  releasing the second.
- **Every recorded sighting predates that fix.** The 2026-10-31 runs predate it,
  and the 2026-11-01 run on `visual-change-image-05b2937be199-r1` came from
  `ec08062d8` (#1521, merged 11:21 UTC), which does not contain `b965aea44`. No
  recurrence has been recorded since.
- **Reproduced:** yes, for the pre-fix test. With the settle line temporarily
  removed,
  `mise run test:logged -- --name coord-node-prefix -- bun --cwd=apps/backend test ./src/core/nodes/node-coordination.test.ts -t "stay pending while held" --rerun-each=30`
  failed 1 of 30 on an unpinned host (70.8 ms), with the identical
  `pending-inject` / `userReleasedAt` / revision 2 record.
- **Verification of the current test:** `coord-node-postfix` (`--rerun-each=300`):
  300/300 pass. `coord-node-held-stress` (`--rerun-each=100`, pinned to one core
  beside 6 busy loops): 100/100 pass. `coord-node-file-stress` (whole owner,
  `--rerun-each=10`, same contention): pass. No source changed.

