# Efficiency checkpoint workload exceeds its aggregate deadline

- **ID:** 0788
- **Status:** environmental
- **Date observed:** 2026-10-24
- **Test:** `supervision workloads > an unchanged pipeline session is read whole and saved once`
- **File:** `tests/unit/efficiency/harness.test.ts`
- **Merge parents:** `109a3a90509f3b5f258881f9004c4fde4747f0a9` and `d6ed0717d00a9a04ba658ba6c50e0978bc2011a6`.
- **Original command:** `env -u PORT mise run test:logged -- --name merge-complete-suite -- mise run test`, with the testing guide's GNU-tool PATH and `ORKESTRATOR_TEST_AREA_BASE=0014505caeed69395b3cc996dd541fcc6df12c23`.
- **Worker configuration:** workspace/root/bridge/protocol reservations 4/1/2/1; root ran with one worker. Other worktrees were validating concurrently; the host load average reached 147.
- **Failure:** five-second timeout (5012.23 ms). Root/support reported 3,397 passed, three failed and one between-test error across 3,400 tests in 162 files (970.54 seconds).
- **First isolated rerun:** `env -u PORT mise run test:logged -- --name merge-efficiency-owner -- bun test ./tests/unit/efficiency/harness.test.ts --parallel=1 --only-failures`, same GNU-tool PATH, retained the timeout (5001.79 ms): 32 passed, one failed, 14.8 seconds logged. Artifact: `orkestrator-test-run.UI9utn/merge-efficiency-owner.log.gz` under the host temporary directory.
- **Complete unchanged owner after root completion:** `env -u PORT mise run test:logged -- --name merge-efficiency-owner-after-root -- bun test ./tests/unit/efficiency/harness.test.ts --parallel=1 --only-failures`, same GNU-tool PATH, passed (exit 0, 7.2 seconds logged). The host load had fallen to approximately 76 before this rerun.
- **Aggregate evidence:** `orkestrator-test-run.YFMbrr/root-and-agent-support-tests.log.gz` after aggregate finalization; outer run `orkestrator-test-run.I7HssJ`.
- **Hypothesis:** contention during real temporary-store initialization and checkpoint commits exceeded the generic deadline. The workload uses real `StorageService` and performs both unchanged and moving session cases; no test, assertion, timeout, skip or implementation changed during this merge resolution. The final whole-owner pass establishes intermittence; the earlier failed rerun remains part of the evidence.

## Triage 2026-10-25

- **Disposition:** environmental (host load).
- **Evidence:** host load reached 147 during the aggregate, and the first isolated rerun failed the same way at that load. The owner passed once load fell to about 76. A run that fails alone at that load is a host condition, not a flake by the registry's definition. Reopen if it fails at normal load.


## Criterion verification review — 2026-10-28

- **Aggregate:** `mise run test:logged -- --name review-repair-default -- mise run test`, on the structured-ticket branch. The run waited 559 seconds for the shared host lease; workspace/root/bridges/protocol reservations were 6/1/2/1.
- **Failure:** `supervision workloads > an unchanged pipeline session is read whole and saved once` timed out at 5024 ms in the root group.
- **Complete owning-file rerun:** `mise run test:logged -- --name efficiency-rerun -- bun test ./tests/unit/efficiency/harness.test.ts --parallel=1 --only-failures` passed unchanged (8.9 s).
- **Evidence:** `orkestrator-test-run.bgBVht` under the host temporary directory.
- **Assessment:** confirmed intermittent recurrence; no implementation, assertion, timeout or skip in this owner changed.

## Container replacement input coverage review — 2026-10-28

- **Aggregate:** `mise run test:logged -- --name default-tests -- mise run test`, at commit `76dba61d9`, with workspace/root/bridges/protocol reservations of 6/1/2/1. The root group used one worker.
- **Failure:** `supervision workloads > the batch route answers 100 sessions in two requests; an older bridge in one each` exceeded its five-second deadline (6322.77 ms). The root group ran 3,247 tests across 158 files in 491.32 seconds, with this as its only failure.
- **Complete unchanged owner rerun after root completion:** `mise run test:logged -- --name supervision-recheck -- bun test ./tests/unit/efficiency/harness.test.ts --parallel=1 --only-failures` passed (exit 0, 13.3 seconds logged).
- **Evidence:** `/tmp/orkestrator-test-run.ryfxPE/root-and-agent-support-tests.log.gz` after aggregate finalization; outer run `/tmp/orkestrator-test-run.a6YBTO`. The shared Linux host's load average reached 58.65 during the aggregate.
- **Assessment:** another workload in this owner exceeded the same generic deadline under contention and passed alone. This branch adds only a deterministic container replacement test; no supervision implementation, assertion, deadline or skip changed.
