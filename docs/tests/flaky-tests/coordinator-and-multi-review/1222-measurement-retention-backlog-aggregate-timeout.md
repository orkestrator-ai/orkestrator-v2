# Measurement retention backlog times out in the aggregate

- **ID:** 1222
- **Status:** open
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

## Ledger qualification observation, 2026-11-06

Observed on `ledger-stall-qualification-a9ca4f9c771b` at `ae675f613`, based on
`413bd6219a6c32f4fa586f8a5612355ad26c64a4`. The recurrence check
`mise run flaky:recurrence -- 1222 --base 413bd6219a6c32f4fa586f8a5612355ad26c64a4`
confirmed that the base contains the earlier fixture fix (`b6fb8c3ec9`), so this
case is reopened. The fixture still seeds its 30,000 file rows atomically.

- **Original command:** `mise run test:logged -- --name ledger-retention-owners -- bun test --cwd apps/backend ./src/core/change-tracking/retention-deletion.test.ts ./src/core/change-tracking/retention-store-walks.test.ts ./src/core/change-tracking/measurement-retention.test.ts ./src/core/change-tracking/service-retention-outcome.test.ts --parallel=2 --only-failures`.
- **Worker configuration:** two isolated Bun workers; focused scan-plan, benchmark, type and source-guard checks were also running on the host.
- **Failure:** backlog test timed out at 5278.30 ms against its 5000 ms budget; asynchronous retention subsequently used a closed database. The other failing case is tracked in [9897](9897-retirement-purge-pin-deadline.md).
- **Suite counts:** 70 pass, 2 fail, 2 errors across 72 tests in four files; exit 1 after 60.0 s.
- **Owning-file rerun:** `mise run test:logged -- --name measurement-retention-isolated -- bun test --cwd apps/backend ./src/core/change-tracking/measurement-retention.test.ts --parallel=1 --only-failures` also failed: 10 pass, 2 fail, 2 errors across 12 tests in 8.0 s. The backlog timed out at 5612.35 ms and the following large-measurement case used the closed database.
- **Evidence:** `output/agent-testing/ledger-review/ledger-retention-owners.log.gz` and `output/agent-testing/ledger-review/measurement-retention-isolated.log.gz` in the observing workspace; original runner artifacts `orkestrator-test-run.dLtPn3` and `orkestrator-test-run.xNHmCs`.

This observation does **not** establish a flake: the complete owner failed in
isolation as well. The deadline failure and cleanup cascade remain unresolved;
no timeout, assertion or skip was changed. The new provider-evidence boundary
and benchmark-report regressions passed separately.
