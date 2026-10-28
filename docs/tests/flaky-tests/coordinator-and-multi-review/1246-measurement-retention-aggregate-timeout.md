# Measurement retention aggregate timeout and teardown cascade

- **ID:** 1246
- **Status:** open
- **Date observed:** 2026-10-28
- **Owning file:** `apps/backend/src/core/change-tracking/measurement-retention.test.ts`
- **Tests:** `retention prunes a backlog in batches, sparing selected and restorable ones`; `a single large measurement is pruned in strict row batches and reader pins are counted`.
- **Original command:** `mise run test:logged -- --name review-repair-unit -- mise run test` during Codex MCP startup coverage validation at `e6b17047f`.
- **Failure:** the backlog case exceeded its 5,000 ms deadline (5,816.63 ms). The next case raised `RangeError: Cannot use a closed database` from `storage-database.ts:345` through the retention fixture at line 155.
- **Aggregate:** bridges, root/support and Codex protocol groups passed; workspace failed on these two cases. The aggregate spent about 545 s queued for another worktree's host lease and finished in 806.2 s overall.
- **Complete unchanged owner:** `mise run test:logged -- --name measurement-retention-recheck -- bun test --cwd apps/backend ./src/core/change-tracking/measurement-retention.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed (3.7 s logged).
- **Evidence:** host temporary artifacts `orkestrator-test-run.naSe08/review-repair-unit.log.gz` and `orkestrator-test-run.bYdBuw`.
- **Hypothesis:** shared-host contention widened the backlog work past the deadline; fixture cleanup may then have closed a database still used by timed-out work. The causal mechanism has not been established.
- **Changes:** evidence only. No retention implementation, timeout, assertion or skip changed.
