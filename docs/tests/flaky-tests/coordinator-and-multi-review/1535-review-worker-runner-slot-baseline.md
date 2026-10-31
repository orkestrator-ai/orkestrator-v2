# Review validation worker runner-slot case failed once in a baseline run

- **ID:** 1535
- **Status:** open
- **Date observed:** 2026-10-25
- **Test:** `a cooperative command queued on the host does not hold the local runner slot`
- **File:** `apps/backend/src/core/review-validation-worker.test.ts:1474`
- **Original command:** a baseline `mise run test` during todo 0030's
  2026-10-25 round (its item 4 work on this owner).
- **Failure:** failed once; the message was not captured.
- **Isolated rerun:** passed alone and in three full runs.
- **Hypothesis:** none. Created on 2026-10-31 from the triage note in todo
  0030; the only evidence is that note. Next recurrence: keep the message and
  the worker's state file, since the case watches that file rather than a
  control process.
