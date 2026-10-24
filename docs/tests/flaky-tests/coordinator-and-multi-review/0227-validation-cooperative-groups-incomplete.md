# Review validation: cooperative parallel groups finished "incomplete" under load (`apps/backend/src/core/review-validation-worker.test.ts`)

- **ID:** 0227
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `cooperative parallel groups do not multiply queue or execution deadlines`
- **Owning file:** `apps/backend/src/core/review-validation-worker.test.ts:1162`
- **Original command:** `mise run test:logged -- --name full-suite-4 -- mise run test`
  on the default PATH, with the standard group slots and other workers' suites
  on the host.
- **Failure:** `expect(done.results[0]!.status).toBe("passed")` received
  `"incomplete"` after 3,650.15 ms. The earlier `queued` and "worker slots"
  assertions passed.
- **Suite counts:** backend 7,704 passed, 39 skipped, 2 failed (7,745 tests,
  308.64 s). The other failure is a recurrence of 0187.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/review-validation-worker.test.ts --parallel=1`
  from `apps/backend` passed unchanged (46 tests, 41.08 s).
- **Evidence:** `/tmp/orkestrator-test-run.9os4UH/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** the case's execution deadline expired while the host was
  contended, so the run ended `incomplete` rather than `passed`. Not confirmed.

## Preview tunnel close-drain validation recurrence (2026-10-17)

- **Command:** `mise run test:logged -- --name final-full-suite -- mise run test`.
  Workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two
  isolated Bun workers. Workspace admission waited 51.0 seconds.
- **Failure:** the same cooperative-groups case received `incomplete` instead
  of `passed` at line 1167 (3,713.94 ms). Backend: 8,793 passed, 41 skipped,
  2 failed across 471 files (486.80 seconds). The other failure was a public
  API fixture cleanup EPERM; all preview tunnel tests passed.
- **Isolated rerun:** `mise run test:logged -- --name validation-worker-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0 (52.3 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.bXnknL/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
  The timing hypothesis remains unconfirmed; no assertion, timeout or skip changed.


## Landing-page main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` with the testing guide's GNU-tool PATH prefix; workspace/root/bridges/protocol groups used 4/1/2/1 slots and backend used two isolated workers. Other worktrees and browser suites were active.
- **Owning-file failures:**

- cooperative parallel groups do not multiply queue or execution deadlines [1882.73ms]

- **Owning-file rerun:** `mise run test:logged -- --name merge-15f6cd-backend-owners -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts ./src/core/environment-move.test.ts ./src/core/coordinator-service.test.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed all four unchanged files with one worker, exit 0, in 121.2 seconds.
- **Evidence:** `orkestrator-test-run.iFuHsy/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Backend reported 9025 passed, 41 skipped and 17 failed across 9083 tests, with 12 errors between tests.
- **Assessment:** confirmed intermittent recurrence; no implementation, assertion, timeout or skip in these owners changed. Shared-host contention remains a hypothesis.

## Agent-mail main merge recurrence — 2026-10-19

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](../aggregate-validation-runs/0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.

## ScheduleWakeup follow-up main merge — 2026-10-21

- **Original command:** the testing guide's GNU-tool PATH with `mise run test:logged -- --name merge-full-tests -- mise run test`.
- **Workers:** workspace/root/bridge/protocol reservations 4/1/2/1; backend used two isolated workers, alongside component and isolated-stack browser checks.
- **Failure:** `cooperative parallel groups do not multiply queue or execution deadlines` returned `incomplete` instead of `passed` at line 1167 (1846.13 ms). The preceding queued-state assertions passed.
- **Owning-file rerun:** `mise run test:logged -- --name merge-validation-worker-owner -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed the complete unchanged owner (exit 0, 40.3 seconds logged).
- **Evidence:** `orkestrator-test-run.d10zQ4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Aggregate counts are recorded in [0630](../aggregate-validation-runs/0630-modal-width-main-merge-validation.md).
- **Assessment:** confirms intermittent deadline behavior. Host contention remains an unproven hypothesis; no source, assertion, deadline or skip changed.

## Coordinator adapters main merge — 2026-10-24

Original command: `ORKESTRATOR_TEST_AREA_BASE=$(git merge-base HEAD MERGE_HEAD) mise run test:logged -- --name merge-tests -- mise run test`, workspace/root/bridges/protocol reservations 4/1/2/1. The cooperative deadline case failed after 3639.61 ms. `mise run test:logged -- --name merge-owner-review-worker -- bun --cwd=apps/backend test ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures` passed the complete unchanged owner (49.6 s).

Full failure names, counts, evidence paths and unresolved limitations are in [0724](../aggregate-validation-runs/0724-coordinator-adapters-main-merge-validation.md). No implementation, assertion, timeout or skip changed. The original aggregate remains non-green.

## Recurrence — 2026-10-24 (worktree signal review validation)

- **Original command:** `mise run test:logged -- --name watcher-full-suite -- mise run test`; standard aggregate worker leases, with other checkout validation active on the host.
- **Failure:** `cooperative parallel groups do not multiply queue or execution deadlines` received `incomplete` instead of `passed` at 2758.29 ms.
- **Owning-file rerun:** `mise run test:logged -- --name watcher-validation-worker-owner -- bun test --cwd <checkout>/apps/backend ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures` passed unchanged in 50.5 seconds.
- **Evidence:** `orkestrator-test-run.iTzv5K/` under the host temporary directory; the full aggregate remains failed. None of these owning files was changed.
- **Final aggregate counts:** backend 10705 passed, 116 skipped, 20 failed and five between-test errors across 10841 tests (747.20 seconds). Fourteen failures were the unchanged OpenCode conformance expectation for CLI 1.19.0 versus the installed 1.19.4; the other six were the timing cases recorded here and in companion records. The complete repository run exited 1 after 1189.0 seconds, including time queued for shared worker capacity.

## Container state observation main merge — 2026-10-24

- **Original command:** `mise run test:logged -- --name merge-suite -- mise run test`, merging feature `66a9736cc` and main `d6ed0717d`; default workspace/root/bridge/protocol 4/1/2/1 plan alongside browser, Electron and Docker checks.
- **Aggregate:** `cooperative parallel groups do not multiply queue or execution deadlines` reported `incomplete` instead of `passed` after 2989.36 ms.
- **Owning-file rerun:** the same case again reported `incomplete` (4299.43 ms); the cooperative-stop stdout case also failed.
- **Complete unchanged owner:** `mise run test:logged -- --name merge-review-worker-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures` failed: 47 passed and two failed across 49 tests in 100.73 s.
- **Evidence:** `orkestrator-test-run.bFHIz7/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.pQ8a8n/merge-review-worker-owner.log.gz` below the host temporary directory.
- **Assessment:** no new isolated pass or root cause was established. No implementation, assertion, timeout or skip changed.
