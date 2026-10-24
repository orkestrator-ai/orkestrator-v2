# Environment move submodule rollback aggregate timeout

- **ID:** 0291
- **Status:** open
- **Date observed:** 2026-10-17

## Codex catalogue review validation — 2026-10-17

- **Test:** `move_environment > a failed submodule re-link restores the original
  checkout`, `apps/backend/src/core/environment-move.test.ts`.
- **Original command:** `mise run test:logged -- --name final-full-tests -- mise run test`
  (Bun 1.4.3, macOS arm64; workspace/root/bridge/protocol reservations
  4/1/2/1 slots, with two isolated backend workers; other worktrees shared the host).
- **Failure:** the case exceeded its 5000 ms deadline at 5079.69 ms. This is a
  timeout, distinct from the resolved fixture index-lock failure in case 0201.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NfVWIS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
  (compressed when the aggregate completes).
- **Owning-file rerun:** `mise run test:logged -- --name move-owner-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures`
  passed unchanged (exit 0) in 47.3 seconds.
- **Assessment:** the isolated pass confirms intermittence. Shared-host Git and
  filesystem contention remains a hypothesis; no move implementation,
  assertion, timeout or skip changed.

Final aggregate totals: backend 8814 passed, 41 skipped, ten failed and three
between-tests errors across 8865 tests in 472 files (541.38 seconds).
Toolchain had 90 passed and one failed. Root, bridges, protocol and every
other workspace package passed; aggregate exit 1 after 852.0 seconds.

## Codex default-model PR-stage main merge — 2026-10-17

- **Original command:** `bun run --cwd apps/backend test:workspace` (Bun 1.4.2, two workers; host load average 13–27).
- **Failure:** the case exceeded its 5000 ms deadline at 5121.09 ms.
- **Owning-file rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts` passed unchanged (37 passed, 31.6 seconds).
- **Assessment:** a second isolated pass; no move implementation, assertion, timeout or skip changed.


## Landing-page main merge recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` with the testing guide's GNU-tool PATH prefix; workspace/root/bridges/protocol groups used 4/1/2/1 slots and backend used two isolated workers. Other worktrees and browser suites were active.
- **Owning-file failures:**

- move_environment > moves a worktree with nested submodules (same disk) [5257.74ms]
- move_environment > moves a worktree with nested submodules (copy) [5212.07ms]
- move_environment > a failed submodule re-link restores the original checkout [5426.36ms]
- restart recovery re-links submodules of an adopted or abandoned copy [5141.01ms]

- **Owning-file rerun:** `mise run test:logged -- --name merge-15f6cd-backend-owners -- bun test --cwd apps/backend ./src/core/review-validation-worker.test.ts ./src/core/environment-move.test.ts ./src/core/coordinator-service.test.ts ./tests/commands-integration.test.ts --parallel=1 --only-failures` passed all four unchanged files with one worker, exit 0, in 121.2 seconds.
- **Evidence:** `orkestrator-test-run.iFuHsy/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Backend reported 9025 passed, 41 skipped and 17 failed across 9083 tests, with 12 errors between tests.
- **Assessment:** confirmed intermittent recurrence; no implementation, assertion, timeout or skip in these owners changed. Shared-host contention remains a hypothesis.

## Recurrence 2026-10-21 (idle-observation qualification branch)

- **Command:** `mise run test` on `3ebece08` (macOS 27.0, Apple Silicon, host running other agent workloads). The workspace group failed on three known flakes (0291, 0248, 0175): `move_environment > a failed submodule re-link restores the original checkout`, `restart recovery re-links submodules of an adopted or abandoned copy` and `a branch baseline follows origin/<ref> only when the policy fetches`, each at the 5-second default (5060 to 5098 ms).
- **Isolated rerun:** `bun test ./src/core/environment-move.test.ts ./src/core/container-git-fetch-git.test.ts` from `apps/backend` passed 43 of 43 (40.05 s). The branch did not change either owning file or the code they test.


## Agent interaction and permission review — 2026-10-22

- **Original command:** `mise run test:logged -- --name final-suite -- mise run test` on the project-resource and approval fixes.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots alongside other worktrees; workspace waited 111.4 seconds for host capacity.
- **Failure:** `move_environment > a failed submodule re-link restores the original checkout` exceeded 5000 ms (5088.17 ms). A follow-on between-test `CommandFailedError` reported `submodule--helper` could not enter `libs/sub` and the child received SIGTERM.
- **Owning-file rerun:** `mise run test:logged -- --name environment-move-isolated -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the complete unchanged 37-test owner (41.0 s logged, exit 0).
- **Suite counts:** backend: 9904 passed, 80 skipped, two failed and one between-test error across 9986 tests in 571 files (572.47 s); the other failure is tracked in 0672. Root/support, bridges and protocol passed.
- **Evidence:** `orkestrator-test-run.H9pUnY/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory; passing focused output was removed by `test:logged`.
- **Assessment:** confirms another intermittent recurrence. No environment-move implementation, test, deadline, assertion or skip changed. The shared-host contention hypothesis remains unproven.

## Agent accounts main merge — 2026-10-24

The backend aggregate timed out `move_environment > a failed submodule re-link restores the original checkout` at 5133.53 ms. The complete unchanged owner passed in 33.9 s: `mise run test:logged -- --name merge-environment-move-owner -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`. Original evidence: `orkestrator-test-run.AdOl8u/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. No assertion, deadline or skip changed. See [0740](../aggregate-validation-runs/0740-agent-accounts-sign-in-0003-validation.md).
