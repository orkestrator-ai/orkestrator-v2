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
