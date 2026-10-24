# container status and fetch scripts against a local remote > a branch baseline follows origin/<ref> only when the policy fetches (apps/backend/src/core/container-git-fetch-git.test.ts)

- **ID:** 0175
- **Status:** resolved
- **Date observed:** 2026-09-28
- **Original command:** `mise run test:logged -- --name backend-workspace -- bun run --cwd apps/backend test:workspace`
- **Worker configuration:** the backend package's own `test:workspace` script, run straight after two full `mise run test` passes on the same host.
- **Failure:** the test exceeded Bun's default 5-second timeout (reported at 5205 ms), followed by `killed 1 dangling process`.
- **Suite counts:** 5278 total, 5262 passed, 1 failed, 15 skipped (305 files, 153.88 s)
- **Isolated rerun:** `mise run test:logged -- --name git-fetch-alone -- bun test --cwd apps/backend src/core/container-git-fetch-git.test.ts src/core/plan-usage.test.ts` → passed (4.8 s for both files)
- **Hypothesis:** the case runs real `git` processes against a local remote. Under aggregate load its total wall time crosses the 5-second default, and the dangling process was the in-flight `git` child the timeout abandoned. Host load average was about 8 shortly after the failure. It passed in the preceding full `mise run test` on the same change. The change in progress (multi-account support) does not touch the container git scripts or this test.

## Recurrence 2026-10-21 (idle-observation qualification branch)

- **Command:** `mise run test` on `3ebece08` (macOS 27.0, Apple Silicon, host running other agent workloads). The workspace group failed on three known flakes (0291, 0248, 0175): `move_environment > a failed submodule re-link restores the original checkout`, `restart recovery re-links submodules of an adopted or abandoned copy` and `a branch baseline follows origin/<ref> only when the policy fetches`, each at the 5-second default (5060 to 5098 ms).
- **Isolated rerun:** `bun test ./src/core/environment-move.test.ts ./src/core/container-git-fetch-git.test.ts` from `apps/backend` passed 43 of 43 (40.05 s). The branch did not change either owning file or the code they test.

## Cold restart review qualification — 2026-10-21

- **Original command:** `mise run test:logged -- --name review-full-suite -- mise run test`, alongside isolated live cold-restart qualification; workspace/root/bridges/protocol reserved 4/1/2/1 slots.
- **Failure:** `a branch baseline follows origin/<ref> only when the policy fetches` exceeded the default 5000 ms deadline (5174.64 ms). Backend reported 9739 passed, 67 skipped, three failed and one between-test error across 9809 tests in 551 files (630.83 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name container-git-recheck -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-git-fetch-git.test.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0, 5.5 seconds logged).
- **Evidence:** `orkestrator-test-run.K1HiOG/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
- **Assessment:** confirmed intermittent recurrence; concurrent load is an unconfirmed explanation. No implementation, assertion, timeout or skip changed.

## 2026-10-21 recurrence during node profile notification validation

- **Snapshot:** `b2c385c1e` plus the node profile notification fix and its integration tests; the Git scripts and this owning test file were unchanged.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`.
- **Worker configuration:** four aggregate groups; workspace held four worker slots, with at most two package tasks and two Bun workers per package. Root held one slot, bridges two and the protocol check one.
- **Failure:** the same branch-baseline case timed out after 5000 ms (reported at 5100.95 ms), with `killed 1 dangling process`. An unhandled `script exited 143` from the case's `shell()` helper followed the timeout.
- **Suite counts:** backend: 9973 tests across 570 files, 9904 passed, 68 skipped, one failed and one error (467.27 s). The other workspace packages, root/support, bridges and protocol check passed. The full logged command exited 1 after 506.7 s.
- **Isolated rerun:** `mise run test:logged -- --name container-fetch-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-git-fetch-git.test.ts --parallel=1 --only-failures` → all six tests passed unchanged (3.7 s logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ozsKgo/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Assessment:** consistent with the existing aggregate-load timeout hypothesis; no timeout or assertion was changed. The full aggregate remains a failed validation result, with this isolated pass confirming the recurrence is intermittent.

## Service preview rollout full suite — 2026-10-22

- Command: `mise run test:logged -- --name full-tests-0042 -- mise run test` on branch `todo-0042-service-preview-rollout-a6b636a9b237` (`b83ae534` plus the service preview rollout working tree, which does not touch this test's code), macOS 26.6.2 arm64, default `mise run test` groups, host load average 15 to 60 (above 400 earlier in the hour).
- Failure: `a branch baseline follows origin/<ref> only when the policy fetches` at 5192.66 ms. Backend: 9909 passed, 84 skipped, 4 failed across 9997 tests in 572 files (630.59 s); the other failures were 0213, 0175 and 0165 (two cases).
- Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.iQtiOF/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- Isolated rerun: `mise exec -- bun test --cwd apps/backend ./src/core/container-git-fetch-git.test.ts --parallel=1` passed unchanged (6 passed, 1 skipped) at load 11.

## CI-health branch aggregate — 2026-10-22

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`
  (with `PORT` unset) on `todo-0030-test-suite-ci-health`, macOS arm64, Bun
  1.4.3, host load average 21–27 from other sessions.
- **Failure:** timed out at 5,052.49 ms. Backend reported 9,904 passed and 1
  failed across 9,985 tests in 571 files (604.7 s).
- **Isolated rerun:** `mise run test:logged -- --name container-fetch-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-git-fetch-git.test.ts --parallel=1 --only-failures`
  passed unchanged (5.8 s).
- **Evidence:** orkestrator-test-run.UPlMVd orkestrator-test-run.FNlm01 under the host temporary directory.
- No implementation, assertion, timeout or skip changed.

## Agent interaction and permission review — 2026-10-22

- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots. Other worktrees also held host capacity.
- **Failure:** `container status and fetch scripts against a local remote > a branch baseline follows origin/<ref> only when the policy fetches` exceeded 5000 ms (5169.99 ms), with one dangling child killed.
- **Isolated rerun:** `mise run test:logged -- --name git-fetch-isolated -- bun test --cwd apps/backend ./src/core/container-git-fetch-git.test.ts --parallel=1 --only-failures` passed the complete unchanged six-test owner (11.6 s logged, exit 0).
- **Suite counts:** backend: 9901 passed, 80 skipped, five failed and one error across 9986 tests in 571 files (821.53 s). Three Codex fixture failures were fixed separately; the PATH timeout is tracked in 0671.
- **Evidence:** `orkestrator-test-run.rkxXtB/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` beneath the host temporary directory; passing focused output was removed by `test:logged`.
- **Assessment:** another confirmed intermittent recurrence. Neither the owning test nor the container Git implementation changed. Shared-host load remains a hypothesis; no deadline, assertion or skip was changed.

## Service installation review fixes — 2026-10-23

- **Snapshot:** `6e26d05ea` plus the service installation review fixes on `backend-installation-97564095f43d-r1`. Neither the owning test nor the container Git implementation changed.
- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reserved 4/1/2/1 slots; workspace allowed two package tasks with two Bun workers per package. The published CLI scenarios also ran during part of the aggregate.
- **Failure:** `container status and fetch scripts against a local remote > a branch baseline follows origin/<ref> only when the policy fetches` exceeded the 5000 ms deadline (reported at 5200.34 ms), with one dangling process killed.
- **Isolated rerun:** `mise run test:logged -- --name container-git-isolated -- bun test --cwd apps/backend ./src/core/container-git-fetch-git.test.ts --parallel=1` passed the unchanged complete six-test owner (15.2 s logged, exit 0).
- **Suite counts:** backend: 10,078 passed, 86 skipped and one failed across 10,165 tests in 586 files (475.13 s); every other workspace package and the root, bridge and protocol groups passed. The aggregate exited 1 after 493.2 s.
- **Evidence:** `orkestrator-test-run.LHocuH/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory; the aggregate wrapper is `orkestrator-test-run.MeKvlm/repository-tests.log.gz`.
- **Assessment:** confirmed intermittent recurrence. Aggregate load remains a hypothesis; no implementation, deadline, assertion or skip was changed.

## Multi Review inspector validation — 2026-10-23

- **Command:** `mise run test:logged -- --name repository-tests -- mise run test`, alongside component-browser validation; the aggregate workspace group reserved four worker slots.
- **Failure:** the branch-baseline case timed out at 5099.79 ms against the 5000 ms deadline. Its owning test and Git implementation were unchanged.
- **Complete owning-file rerun:** `mise run test:logged -- --name container-fetch-isolated -- bun --cwd=apps/backend test ./src/core/container-git-fetch-git.test.ts --parallel=1 --only-failures` passed (13.0 seconds logged, exit 0).
- **Evidence:** `orkestrator-test-run.tXLYBH/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
- **Assessment:** confirmed intermittent recurrence; concurrent load remains a hypothesis. No assertion, deadline or skip changed.

## Transcript scroll validation — 2026-10-24

- **Command:** `mise run test:logged -- --name final-repository -- mise run test`, while focused Playwright and unit runs for the transcript change ran in the same worktree.
- **Failure:** the branch-baseline case timed out at 5204.28 ms against the 5000 ms deadline. Its owning test and Git implementation were unchanged (the branch changes only renderer transcript code).
- **Complete owning-file rerun:** `mise run test:logged -- --name backend-git-fetch -- bun --cwd=apps/backend test src/core/container-git-fetch-git.test.ts --parallel=1 --only-failures` passed (5.0 s logged, exit 0).
- **Suite counts:** backend 10,568 passed, 77 skipped and 16 failed across 10,661 tests in 618 files (855.84 s); the other failures were this run's watchdog recurrence (0512) and 14 OpenCode execution-policy conformance cases that also fail on the unchanged baseline (host CLI 1.19.4 against an expected 1.19.0).
- **Evidence:** `orkestrator-test-run.4LYtCC/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
- **Assessment:** confirmed intermittent recurrence; concurrent load remains a hypothesis. No assertion, deadline or skip changed.


## Coordinator adapter review — 2026-10-24

The aggregate repeated this case during coordinator adapter validation. Exact
commands, timing, owner rerun results and evidence are recorded in
[0725](../aggregate-validation-runs/0725-coordinator-adapter-review-validation.md).
The owning implementation, assertions, timeouts and skips were unchanged.

## Resolution — 2026-10-24 (worktree signal review)

- **Root cause:** The case runs multiple real Git status/fetch processes and a local remote push under Bun's five-second default. Recorded aggregate runs exceeded that budget; the original `Bun.spawn` helper had no per-test cancellation or child-group teardown, allowing an abandoned status process to surface as a later `script exited 143` error. The evidence does not isolate which host workload caused the slow runs.
- **Fix:** The real-Git cases have explicit 30-second budgets. Their shell helper now uses `runCommand` with a ten-second command deadline and a test-owned abort signal; `afterEach` aborts and awaits pending shell commands, including background fetches. `runCommand` owns and terminates the whole process group.
- **Verification:** `mise run test:logged -- --name watcher-async-regressions -- bun test --cwd <checkout>/apps/backend ./src/core/diff-stats-container-signal.test.ts ./src/core/container-worktree-signal.test.ts ./src/core/container-worktree-signal-install.test.ts ./src/core/container-git-fetch.test.ts ./src/core/container-git-fetch-git.test.ts --parallel=4` passed (78.1 seconds for the five-file group) while the repository suite and other host validation workloads were active. Earlier four-worker runs of the same real-Git owner also passed; no leftover-child error was reported.
- **Fix reference:** Commit containing this resolution and the worktree-signal regression fixes.
- **Aggregate verification:** the real-Git owner reported no failure in the completed repository run (backend 10705 passed, 116 skipped, 20 unrelated failures and five errors across 10841 tests). The full run remains failed because of the unchanged OpenCode version assertion and unrelated timing cases.
