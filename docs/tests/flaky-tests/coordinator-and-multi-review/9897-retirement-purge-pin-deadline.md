# A reader pin between purge batches exceeds the test deadline

- **ID:** 9897
- **Status:** resolved
- **Date observed:** 2026-11-06
- **Test:** `retirement regressions > a pin admitted between purge transactions stops later batches`.
- **File:** `apps/backend/src/core/change-tracking/retention-deletion.test.ts`.
- **Observing branch:** `ledger-stall-qualification-a9ca4f9c771b`, commit `ae675f613`.
- **Base:** `413bd6219a6c32f4fa586f8a5612355ad26c64a4`.
- **Original command:** `mise run test:logged -- --name ledger-retention-owners -- bun test --cwd apps/backend ./src/core/change-tracking/retention-deletion.test.ts ./src/core/change-tracking/retention-store-walks.test.ts ./src/core/change-tracking/measurement-retention.test.ts ./src/core/change-tracking/service-retention-outcome.test.ts --parallel=2 --only-failures`.
- **Worker configuration:** two isolated Bun workers; focused scan-plan, benchmark, type and source-guard checks also ran on the host.
- **Failure:** timed out at 5224.61 ms against Bun's 5000 ms budget. Later asynchronous retention called `LedgerRetirement.pendingPurges` against a closed database.
- **Suite counts:** 70 pass, 2 fail, 2 errors across 72 tests in four files; exit 1 after 60.0 s. The measurement-backlog failure is recorded separately in [1222](1222-measurement-retention-backlog-aggregate-timeout.md).
- **Isolated rerun:** `mise run test:logged -- --name retention-deletion-isolated -- bun test --cwd apps/backend ./src/core/change-tracking/retention-deletion.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (39 tests, exit 0) in 52.6 s. Passing raw output was deleted by the logged runner.
- **Evidence:** `output/agent-testing/ledger-review/ledger-retention-owners.log.gz` in the observing workspace; original artifact `orkestrator-test-run.dLtPn3/ledger-retention-owners.log.gz`.

## Investigation

The test inserts 600 extra evidence revisions before starting the purge, then
admits a reader pin between transactions, releases it and verifies eventual
cleanup. Those extra revisions currently use individual SQLite autocommits.
That setup and real capture/purge work may be sensitive to host contention,
but the failing run did not record separate setup and purge timings. The
closed-database error follows timeout cleanup; it does not prove the cause of
the original delay. Treat the cleanup lifetime as a possible product race
until investigated. No timeout, assertion, skip or fixture changed here.

## Resolution (2026-11-15)

- **Class:** default test budget (A) with a fixture repair.
- **Root cause:** the test seeds 600 evidence rows, and its sibling `a large evidence stream and pinned selection range obey every batch budget` seeds 1,000 rows across four tables, each in its own SQLite autocommit; that setup, not the purge under test, dominated the time on a busy host and passed Bun's former 5 s default. The later `LedgerRetirement.pendingPurges` call against a closed database is the timed-out test's purge still running when `afterEach` closed the harness (a consequence of the timeout, not a product race: a test that completes drains its purge first).
- **Fix:** both seeding loops in `apps/backend/src/core/change-tracking/retention-deletion.test.ts` run in one `ledger.transaction`, as production callers do (the same repair as 1222's fixture); counts, batch budgets and assertions are unchanged. The file sets no budget of its own, so it runs under `tests/default-test-timeout.ts` (imported by `tests/setup.ts` and `tests/setup-node.ts`), which sets Bun's default per-test and hook budget to 60 s.
- **Reproduced:** no. The complete owner passed with the old budget forced (`--core 14 --burners 6 -- bun test ... retention-deletion.test.ts --timeout=5000`, 33.5 s, after the fixture repair). It was not run with the unrepaired fixture under the 5 s budget, so the pre-fix failure was not reproduced.
