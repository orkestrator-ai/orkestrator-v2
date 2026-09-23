# MultiReviewService interactive Fix settlement activity source

- **ID:** 0151
- **Status:** open
- **Date observed:** 2026-09-23
- **Test:** `MultiReviewService settles the interactive Fix card in the
  background with final usage`
- **File:** `apps/backend/src/core/multi-review-service.test.ts:741`
- **Original command:** `mise run test` (second full run on branch
  `slash-commands-support-3b13a4bc3b08-r1`)
- **Worker configuration:** aggregate workspace group with package tasks in
  parallel; the backend suite used its normal Bun runner configuration.
- **Failure:** after `fixSession.status` reached `idle`, the environment's
  `agentActivitySources["multi-review"].state` was still `working`
  (`toMatchObject` at line 741). Suite counts: backend 3,536 pass, 1 fail;
  every other group passed.
- **Isolated rerun:**
  `bun test --preload ../../tests/setup-node.ts ./src/core/multi-review-service.test.ts`
  from `apps/backend`, five consecutive runs: 176 pass, 0 fail each.

## Current assessment

The assertion reads the environment activity source immediately after the
workflow snapshot reports the Fix session idle. The two are written by
separate asynchronous steps, so under aggregate contention the environment
write can land after the snapshot the test waited for. The test does not
exercise slash-command code. Keep open until the test waits on the activity
source itself or the service orders the two writes.
