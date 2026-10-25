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

## Recurrence during the Usage-tab main merge (2026-10-22)

- **Command:** `mise run test:logged -- --name merge-full-suite -- mise run test`
  on branch `t3/settings-usage-tab` after merging `origin/main` at `edcd60d9`.
  No public-API, exec or test-support change on that branch.
- **Failure:** `EPERM: operation not permitted, rm '/tmp/ork-public-api-c6iJS9'`
  from `cleanup` (`test-support.ts:143`), the same symptom (1059.90 ms). The
  only failure of the whole suite: root and agent-support, bridges and the
  codex protocol lockfile all passed, and the workspace group's other packages
  passed (web 8,752, protocol 1,728, desktop 1,125, CLI 148, toolchain 91,
  web-public 41).
- **Alone:** `mise run test:logged -- --name merge-exec-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts src/core/public-api/public-api-exec.test.ts --parallel=1`
  passed the unchanged owning file, exit 0 (31.8 seconds logged).
- **Evidence:** `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.uDtv0l/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

## Shared creation-dialog draft validation — 2026-10-23

- **Original command:** `mise run test:logged -- --name draft-fix-suite -- mise run test`, validating `7a667390d`; workspace/root/bridges/protocol reserved 4/1/2/1 slots and backend used two isolated workers.
- **Failure:** the restart case again failed during temporary-directory cleanup with `EPERM` at `public-api/test-support.ts:143` (1297.11 ms).
- **Isolated rerun:** `mise run test:logged -- --name draft-fix-rerun-public-exec -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/public-api/public-api-exec.test.ts --parallel=1 --only-failures` passed the complete unchanged owning file, exit 0 in 18.9 seconds logged.
- **Partial aggregate results:** web reported 8,818 passed, 10 skipped and zero failed; desktop reported 1,197 passed, 14 skipped and one failed (0694); root/support reported 3,376 passed, two failed and one error (Pi staging and disk-report timeouts). Backend totals are unavailable: the outer logger reached its 1,800-second deadline after workspace admission had waited 1,075.3 seconds. This run does not establish complete backend validation.
- **Evidence:** `orkestrator-test-run.x5x58l/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.NEAVB6/draft-fix-suite.log.gz` below the host temporary directory. The child log was compressed after the outer watchdog stopped the process tree.
- **Assessment:** another confirmed intermittent cleanup failure. No public API implementation, assertion, timeout or skip changed.

## Transcript scroll main merge — 2026-10-24

- **Original command:** `ORKESTRATOR_TEST_AREA_BASE=f12cc5a5382417bf1bfbda2a7fd93e0d6013aa95 mise run test:logged -- --name merge-repository -- mise run test` on `improve-scroll-smoothness-c791b057f3a2-r1`, merging parents `623df8ed5f24b5a26d7459809b348b8094987006` and `5282e441ab46bc47aa1a6eafcf71af917729278e`. Workspace/root/bridges/protocol used 4/1/2/1 worker slots; component and isolated-stack browser suites shared the host.
- **Failure:** `environment.exec > the worker survives a backend restart and its result is reconciled, not re-run` failed during cleanup with `EPERM` removing `/tmp/ork-public-api-0Ay6I1` at `test-support.ts:143` (1139.44 ms).
- **Complete unchanged owner:** `mise run test:logged -- --name merge-public-exec-owner -- bun test --cwd apps/backend ./src/core/public-api/public-api-exec.test.ts --parallel=1 --only-failures` passed, exit 0 (17.0 s logged).
- **Evidence:** `orkestrator-test-run.k5J28D/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory after aggregate finalization.
- **Assessment:** recurrence of the existing cleanup flake; host contention is a hypothesis. The test, support helper, assertions, deadlines and skips were unchanged from both merge parents.

## Repository separator validation — 2026-10-25

- **Change:** `146fff6c6` on `repo-group-separators-4be2bb2ba0a0-r1`; sidebar rendering and regression tests only.
- **Original command:** `mise run test:logged -- --name aggregate-tests -- mise run test`. Workspace/root/bridges/protocol reserved 4/1/2/1 worker slots; backend used two isolated workers. Component-browser and isolated-browser checks also ran on the host.
- **Failure:** The restart reconciliation case again failed in fixture cleanup with `EPERM` at `test-support.ts:143` after 1115.60 ms.
- **Owning-file rerun:** `mise run test:logged -- --name public-exec-owner -- bun test --cwd apps/backend ./src/core/public-api/public-api-exec.test.ts --parallel=1 --only-failures` passed the complete unchanged file, exit 0 in 12.6 seconds logged.
- **Aggregate counts:** Backend 11,012 passed, 79 skipped and three failed across 660 files (642.56 s); root/support 3,405 passed and one failed across 162 files (403.31 s). All other workspace packages, bridges and protocol passed; aggregate exit 1 in 692.6 s logged.
- **Evidence:** `orkestrator-test-run.sQR1xm/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; the outer aggregate log is `orkestrator-test-run.k2y50g/aggregate-tests.log.gz`.
- **Assessment:** Recurrence of the existing intermittent failure. No backend implementation, assertion, deadline or skip changed; the original aggregate remains non-green.
