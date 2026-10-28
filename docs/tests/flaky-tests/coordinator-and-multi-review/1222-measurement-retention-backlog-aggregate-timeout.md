# Measurement retention backlog times out in the aggregate

- **ID:** 1222
- **Status:** resolved
- **Date observed:** 2026-10-28
- **Tests:** `superseded measurements > retention prunes a backlog in batches, sparing selected and restorable ones`; followed by `superseded measurements > a single large measurement is pruned in strict row batches and reader pins are counted`.
- **File:** `apps/backend/src/core/change-tracking/measurement-retention.test.ts`
- **Original command:** `mise run test` during todo 0732 review preparation at `7eabcbab3`.
- **Worker configuration:** default aggregate planning; workspace (6 worker slots), root (1), bridges (2), and protocol (1) ran together. Backend default-tier concurrency is up to four isolated Bun workers.
- **Failure:** the backlog case exceeded Bun's 5000 ms deadline (11075.66 ms reported), then the following case failed with `RangeError: Cannot use a closed database` (159.68 ms reported).
- **Suite counts:** backend reported 9904 pass, 87 skip, 2 fail and 2 errors across 9993 tests in 651 files. Root and agent-support, bridges, and protocol groups passed. Aggregate exited 1 after 322.3 s.
- **Isolated rerun:** `mise run test:logged -- --name measurement-retention-isolated -- bun test --cwd apps/backend ./src/core/change-tracking/measurement-retention.test.ts --parallel=1 --only-failures` passed the complete unchanged owning file (5 tests, exit 0) in 3.4 s.
- **Evidence:** review validation `review-validation-57710318-a93e-4fd9-872d-9ccc1472fcfe`, `validation-05.stdout.txt`, failure section; aggregate artifact directory `orkestrator-test-run.KzfhUA`. Passing isolated output was removed by `test:logged` as designed.
- **Hypothesis:** aggregate load delays the backlog fixture and/or asynchronous retention batches past the deadline. Cleanup then closes the database while timed-out asynchronous work may still be running, explaining the subsequent database error. The precise source of the delay is unconfirmed. No backend implementation, timeout, assertion, or skip changed in that isolated rerun.

## Review-fix rerun and fixture repair

The required aggregate rerun (`mise run test:logged -- --name
review-fixes-default-tests -- mise run test`) repeated the backlog timeout
(13577.71 ms), followed by the closed-database failure (283.35 ms).
Evidence: `orkestrator-test-run.7b6xLR/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log`
under the host temporary directory (compressed on completion).

Inspection found that the backlog fixture inserted 150 measurements with
200 file rows each outside a transaction, causing over 30,000 separate
SQLite autocommits. Production measurement insertion and the neighboring
large fixtures already use `ledger.transaction`. The backlog setup now uses
one transaction too. The 150-by-200 workload, real asynchronous retention
batches, event-loop progress assertion, protected selections and restore
operations, batch limits, and idempotence assertions are unchanged.

`mise run test:logged -- --name measurement-retention-batched -- bun test --cwd apps/backend ./src/core/change-tracking/measurement-retention.test.ts --parallel=1`
passed all five tests after the repair (exit 0, 3.7 s). The subsequent
identical aggregate command passed the complete workspace group, including
the backend at four isolated Bun workers, while root and protocol also
passed. The workspace group finished at 981.7 s including about 632 s of
queue time. This verifies the fixture repair under aggregate load; the
broader run was later interrupted by the logged runner's 30-minute
deadline while the unrelated bridges group was still queued; no backend
failure occurred in the post-repair run. See [1223](../aggregate-validation-runs/1223-todo-number-guards-review-validation.md).
