# Public exec restart fixture cleanup EPERM

- **ID:** 0341
- **Status:** open
- **Date observed:** 2026-10-17
- **Test:** `environment.exec > the worker survives a backend restart and its result is reconciled, not re-run`
  in `apps/backend/src/core/public-api/public-api-exec.test.ts`.
- **Command:** `mise run test:logged -- --name final-full-suite -- mise run test`.
  Workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two
  isolated Bun workers. Workspace admission waited 51.0 seconds.
- **Failure:** fixture cleanup at `public-api/test-support.ts:143` threw
  `EPERM: operation not permitted, rm '/tmp/ork-public-api-ApNWKX'`
  (1,160.22 ms). Backend: 8,793 passed, 41 skipped, 2 failed across 471 files
  (486.80 seconds). The other failure was tracked validation case 0227;
  all preview tunnel tests passed.
- **Isolated rerun:** `mise run test:logged -- --name public-exec-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/public-api/public-api-exec.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file, exit 0 (37.7 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.bXnknL/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** fixture teardown or filesystem contention could explain the
  temporary-directory removal failure; the cause is unconfirmed. No public
  API implementation, assertion, timeout or skip changed.

## Recurrence during the remaining real-Electron preview cases (2026-10-21)

- **Command:** `mise run test:logged -- --name full-tests-0a835 -- mise run test`
  on branch `qualify-preview-electron-remaining-cases-0a835a98d18e` (no
  backend change), load average 16 to 36.
- **Failure:** `EPERM: operation not permitted, rm '/tmp/ork-public-api-…'`
  from `cleanup` (`test-support.ts:143`), the same symptom (1095.80 ms).
- **Alone:** `bun test --preload ../../tests/setup-node.ts ./src/core/public-api/public-api-exec.test.ts --parallel=1`
  in `apps/backend`: 17 passed (32.85 s) at load 36.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.txKi1Z/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## Idle-observation main refresh — 2026-10-22

- **Merge:** `origin/main` at `566758e05` into `f7bb5e5a` on the idle-observation qualification branch.
- **Original command:** `ORKESTRATOR_TEST_GROUP_TIMEOUT_MS=3600000 mise run test:logged -- --name oct22-full -- env -u ORKESTRATOR_TEST_GROUP_TIMEOUT_MS mise run test`; only the outer logger's allowance includes queueing. Inner group deadlines were unchanged.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers. Component and isolated browser checks also ran on the host.
- **Failure:** the same restart case hit cleanup `EPERM` at `test-support.ts:143` after 1076.38 ms. Backend reported 9915 passed, 68 skipped and one failed across 9984 tests in 571 files (595.43 seconds). All other workspace packages, root/support, bridges and protocol passed; aggregate exit 1 in 712.1 seconds.
- **Isolated rerun:** `mise run test:logged -- --name oct22-public-exec-owner -- bun test --cwd apps/backend ./src/core/public-api/public-api-exec.test.ts --parallel=1` passed the entire unchanged owning file, exit 0, in 32.2 seconds.
- **Evidence:** `orkestrator-test-run.HnWfCT/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.MmnVTZ/oct22-full.log.gz`, below the host temporary directory.
- **Assessment:** intermittent cleanup failure confirmed; no implementation, assertion, timeout or skip changed.

## Shared creation-dialog draft validation — 2026-10-23

- **Original command:** `mise run test:logged -- --name draft-fix-suite -- mise run test`, validating `7a667390d`; workspace/root/bridges/protocol reserved 4/1/2/1 slots and backend used two isolated workers.
- **Failure:** the restart case again failed during temporary-directory cleanup with `EPERM` at `public-api/test-support.ts:143` (1297.11 ms).
- **Isolated rerun:** `mise run test:logged -- --name draft-fix-rerun-public-exec -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/public-api/public-api-exec.test.ts --parallel=1 --only-failures` passed the complete unchanged owning file, exit 0 in 18.9 seconds logged.
- **Partial aggregate results:** web reported 8,818 passed, 10 skipped and zero failed; desktop reported 1,197 passed, 14 skipped and one failed (0694); root/support reported 3,376 passed, two failed and one error (Pi staging and disk-report timeouts). Backend totals are unavailable: the outer logger reached its 1,800-second deadline after workspace admission had waited 1,075.3 seconds. This run does not establish complete backend validation.
- **Evidence:** `orkestrator-test-run.x5x58l/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.NEAVB6/draft-fix-suite.log.gz` below the host temporary directory. The child log was compressed after the outer watchdog stopped the process tree.
- **Assessment:** another confirmed intermittent cleanup failure. No public API implementation, assertion, timeout or skip changed.
