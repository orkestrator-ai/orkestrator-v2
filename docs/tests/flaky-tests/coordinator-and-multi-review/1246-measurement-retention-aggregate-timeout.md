# Measurement retention times out in aggregate validation

- **ID:** 1246
- **Status:** resolved
- **Owner:** `apps/backend/src/core/change-tracking/measurement-retention.test.ts`

On 2026-10-28, socket type-of-service guard review preparation failed
`mise run test` in the unchanged retention owner. `retention prunes a backlog
in batches, sparing selected and restorable ones` timed out after 10,031.74 ms
against its 5,000 ms test deadline. The next test, `a single large measurement
is pruned in strict row batches and reader pins are counted`, then reported
`RangeError: Cannot use a closed database` from the timed-out test's work.
The backend group reported 9,904 passed, 87 skipped and two failed tests across
651 files (207.28 seconds), using the default tier's four-worker backend pool.

The complete owning file passed unchanged when rerun alone through:

```sh
mise run test:logged -- --name retention-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/change-tracking/measurement-retention.test.ts --parallel=1
```

The isolated run took 4.7 seconds. The aggregate failure is recorded in
`.orkestrator/review-artifacts/review-validation-718526c1-13d2-4dd8-aa63-6778b1a57ec1/validation-04.stdout.txt`.
Host contention is a possible contributor; the cause is unconfirmed. No test
assertion or timeout was changed.

The required `mise run test` rerun reproduced the same pair of failures:
the backlog test took 8,355.96 ms, followed by the same closed-database error
in the next case (128.22 ms). The backend again reported 9,904 passed,
87 skipped and two failed tests across 651 files (265.16 seconds). Its evidence
is retained with the default-suite rerun's failure artifacts. The desktop
package reported 1,274 passed, 16 skipped and zero failed tests in that run.

## Replaces

Originally numbered 1222; renumbered to 1246 while merging `main`
to preserve both cases after parallel branches reused the number.

## Codex MCP startup validation observation

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

This observation preceded the fixture repair described below.

## Resolution

Both branches independently wrapped the 150-by-200 backlog fixture in one
transaction, avoiding over 30,000 SQLite autocommits without changing the
assertions or deadlines. The repair and passing complete-owner and aggregate
backend evidence are recorded in
[1222-measurement-retention-backlog-aggregate-timeout.md](1222-measurement-retention-backlog-aggregate-timeout.md).
