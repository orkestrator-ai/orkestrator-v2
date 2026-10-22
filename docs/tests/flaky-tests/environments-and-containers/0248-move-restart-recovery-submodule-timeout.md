# Move restart recovery submodule re-link exceeds the aggregate deadline

- **ID:** 0248
- **Status:** open
- **Date observed:** 2026-10-16
- **Test:** `restart recovery re-links submodules of an adopted or abandoned copy`
- **Owning file:** `apps/backend/src/core/environment-move.test.ts`
- **Original command:** `mise run test` on
  `feat/gateway-terminal-fallback-backoff` (web gateway terminal fallback
  reconnect backoff; no backend code changed). Several other worktrees were
  running suites on the host at the same time.
- **Failure:** the default 5000 ms test timeout at 5039.39 ms. The test's own
  `git submodule --quiet foreach --recursive` call
  (`environment-move.test.ts:786`) was then killed with `SIGTERM` (`timedOut:
  false`), which Bun reported as an unhandled error between tests and a
  dangling process it killed.
- **Suite counts:** backend 8,085 passed, 40 skipped, 3 failed across 438 files
  (324.01 s). The other two failures were the 0211 recurrence and
  `agent provider module boundaries`, which is deterministic on `main` at
  `9906db30` (`http-bridge-provider.ts` has 1,505 lines) and not a flake.
  Web, protocol, desktop, CLI, toolchain, root, bridge and lockfile groups
  passed.
- **Isolated rerun:** `mise run test:logged -- --name backend-env-move-file --
  bun test --cwd apps/backend --preload ../../tests/setup-node.ts
  ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the
  unchanged owning file in 18.9 s.
- **Evidence:** `/tmp/orkestrator-test-run.3Pp4em/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Hypothesis:** the submodule fixture's Git subprocesses were slowed by
  concurrent host load; not established.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.

## Recurrence on 2026-10-16 during the storage writer guards merge

`mise run test:logged -- --name merge-tests -- mise run test` ran the backend
with two isolated workers within a four-slot workspace group while other
worktree validations shared the host. Two tests in the owning file exceeded
the five-second deadline: `move_environment > moves a worktree with nested
submodules (same disk)` (5,081.81 ms, line 350) and `restart recovery re-links
submodules of an adopted or abandoned copy` (5,733.49 ms, line 846). Their
pending submodule checks were then killed with `SIGTERM` and reported as
unhandled errors between tests.

`mise run test:logged -- --name merge-environment-move-isolated -- bun test
--cwd apps/backend --preload ../../tests/setup-node.ts
./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the
unchanged owning file in 39.2 seconds. Evidence and aggregate package counts
are retained in
`/tmp/orkestrator-test-run.Q27xqQ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The shared-load hypothesis remains unconfirmed; no assertion, timeout or skip
was changed.

Aggregate backend counts for this observation: 8,341 passed, 40 skipped,
5 failed and 3 between-tests errors across 8,386 tests in 445 files
(391.37 seconds). The other failures are recorded in 0162, 0165 and 0248.

## Coordinator launch-defaults main merge — 2026-10-16

`mise run test:logged -- --name merge-tests -- mise run test`, with the testing
guide's GNU-tool PATH, reserved 4/1/2/1 workspace/root/bridges/protocol slots.
Backend used two isolated Bun workers while another worktree's aggregate
shared the host. `move_environment > moves a worktree with nested submodules (copy)`
exceeded its 5000 ms budget at 5077.71 ms. Its pending submodule check was
terminated with `SIGTERM`, reporting invalid nested Git metadata as an
unhandled error between tests.

Backend reported 8,413 passed, 40 skipped, five failed and one between-tests
error across 8,458 tests in 450 files (364.58 seconds). The aggregate exited 1
after 453.6 seconds. Other failures are recorded in 0162, 0211 and 0256.
Evidence:
`/tmp/orkestrator-test-run.H7G9oK/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
outer artifact `/tmp/orkestrator-test-run.e7nGed/merge-tests.log.gz`.

`mise run test:logged -- --name merge-move-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures`
passed the entire unchanged owning file (exit 0, 16.2 seconds). Shared host
contention remains an unconfirmed hypothesis; no implementation, assertion,
timeout or skip changed.

## Multi Review restart-continuation main merge — 2026-10-17

- Original command: `bun run test` from `apps/backend` on `53b43e81` (the Multi Review restart-continuation branch after merging `origin/main` at `607d12e2`), macOS arm64 under shared-host load (load average 18–28).
- Aggregate: backend 8,857 passed, 41 skipped and six failed across 8,904 tests in 475 files (100.52 seconds). All six were five-second timeouts in unchanged owners; the others are recorded in 0165/0248, [0301](../coordinator-and-multi-review/0301-looped-review-lease-takeover-timeout.md) and [0302](../coordinator-and-multi-review/0302-validation-worker-progress-watchdog-timeout.md).
- This case timed out at 5156.76 ms, and `move_environment > a failed submodule re-link restores the original checkout` at 5157.03 ms.
- Unchanged owning-file rerun: `bun test --preload ../../tests/setup-node.ts src/core/environment-move.test.ts` from `apps/backend` passed 37 of 37 in 33.31 seconds.
- No assertion, timeout, skip or implementation in this owner changed.

Recurrence on 2026-10-17, preview tunnel slow-reader validation:
`mise run test:logged -- --name full-tests -- mise run test` on `9da80451`
plus a preview-tunnel-only change, load average 30 to 40. The case timed out
at 5061.30 ms (`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.vJOfiZ/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`). The unchanged owning file then passed alone
(`bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1`,
37 passed). No implementation, assertion, timeout or skip changed.


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

## MCP live-apply qualification main merge — 2026-10-18

`mise run test:logged -- --name merge-tests -- mise run test`, with the testing guide's GNU-tool PATH prefix, exited 1 after 375.4 seconds. Workspace/root/bridges/protocol used 4/1/2/1 slots; browser validation and other host work ran concurrently.

`restart recovery re-links submodules of an adopted or abandoned copy` timed out at 5149.03 ms. Its pending Git submodule status command was terminated after the test deadline.

`mise run test:logged -- --name merge-environment-move-rerun -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the unchanged owning file alone in 13.4 seconds.

Backend reported 9084 passed, 41 skipped and three failed across 9128 tests in 483 files. Every other workspace package, root/support, bridges and protocol regeneration passed. The other failures are recorded in 0165.

Evidence: `orkestrator-test-run.tMXC4x/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. Confirmed intermittent recurrence; shared-host contention remains a hypothesis. No source, assertion, timeout or skip changed.

## Design live-cycle second main merge observation — 2026-10-18

The GNU-tool PATH run of `mise run test:logged -- --name merge-full -- mise run test` (workspace/root/bridges/protocol reservations 4/1/2/1, alongside browser validation) timed out nested submodule moves on the same disk (5490.85 ms), copied moves (5259.61 ms), and restart re-linking (5271.68 ms).

`mise run test:logged -- --name merge-unit-owner-environment-move -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` also timed out restart re-linking (5083.24 ms), followed by a submodule configuration error after the Git child was terminated. It reported 36 passed, one failed and one error across 37 tests (57.3 seconds logged).

Evidence: aggregate `orkestrator-test-run.yluX61/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; isolated `orkestrator-test-run.GobX0g/merge-unit-owner-environment-move.log.gz`, below the host temporary directory. This observation does not independently establish a flake; submodule move validation remains unresolved. No implementation, assertion, timeout or skip changed.

**Post-aggregate owning-file rerun (same merge, 2026-10-18):** after the full suite finished, `mise run test:logged -- --name merge-post-suite-environment-move -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 28.0 seconds logged. Together with the aggregate failure this confirms an intermittent recurrence; the earlier isolated failure is retained above. No implementation, assertion, timeout or skip changed.

## Further main merge at f51c7252 — 2026-10-18

- **Original command:** the testing guide's GNU-tool PATH prefix, then `mise run test:logged -- --name refresh-main-tests -- mise run test`, merging `f51c7252` into `17c19221`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; backend used two isolated Bun workers alongside targeted browser and CLI validation on the shared host.
- **Failure:** `restart recovery re-links submodules of an adopted or abandoned copy` exceeded its 5000 ms deadline at 5059.73 ms. The coordinator timeouts also produced late fixture errors after their deadlines.
- **Suite counts:** backend 9088 passed, 41 skipped and four failed across 9133 tests in 485 files (385.41 s); every other workspace package, root/support, bridges and protocol passed. Aggregate exited 1 after 445.1 s.
- **Owning-file rerun:** after the aggregate, the same GNU-tool PATH with `mise run test:logged -- --name refresh-main-owner-move -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the unchanged file, exit 0, in 14.2 s. The three owning files ran sequentially.
- **Evidence:** `orkestrator-test-run.AP1Ws9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; outer log `orkestrator-test-run.TVK3dv/refresh-main-tests.log.gz`.
- **Assessment:** confirmed intermittent recurrence; shared-host contention remains a hypothesis. No implementation, assertion, timeout or skip changed.

## Agent-mail main merge recurrence — 2026-10-19

The aggregate failed this owner and its unchanged owning file passed with one worker. Exact commands, symptoms, counts, timings and bounded evidence are recorded in [0500](../aggregate-validation-runs/0500-agent-mail-main-merge-validation.md). No implementation, assertion, timeout or skip changed.


## OpenCode sign-in main merge — 2026-10-19

- **Original command:** the testing guide's GNU-tool PATH prefix with `/opt/homebrew/bin:/usr/bin` ahead of ambient shims, `mise run test:logged -- --name merge-tests -- mise run test`, merging `cd443028` into `d897a4eb`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers alongside browser and build checks.
- **Failure:** `move_environment > moves a worktree with nested submodules (same disk)` exceeded 5000 ms (5232.80 ms), followed by a terminated Git submodule command. The owning source and test were unchanged.
- **Owning-file rerun:** the same PATH with `mise run test:logged -- --name merge-environment-move-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 22.8 seconds logged).
- **Suite counts:** backend reported 9166 passed, 41 skipped, two failed and one between-test error across 9209 tests in 491 files (408.13 seconds). The other failure was the merged registry metric capacity, corrected by raising the bounded entry limit from 656 to 657; its unchanged owning test passed. The aggregate exited 1 after 492.1 seconds.
- **Evidence:** `orkestrator-test-run.tW4jss/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory after aggregate completion.
- **Assessment:** confirmed intermittent recurrence. Concurrent subprocess contention remains a hypothesis; no implementation, assertion, timeout or skip changed.

## Recurrence 2026-10-21 (idle-observation qualification branch)

- **Command:** `mise run test` on `3ebece08` (macOS 27.0, Apple Silicon, host running other agent workloads). The workspace group failed on three known flakes (0291, 0248, 0175): `move_environment > a failed submodule re-link restores the original checkout`, `restart recovery re-links submodules of an adopted or abandoned copy` and `a branch baseline follows origin/<ref> only when the policy fetches`, each at the 5-second default (5060 to 5098 ms).
- **Isolated rerun:** `bun test ./src/core/environment-move.test.ts ./src/core/container-git-fetch-git.test.ts` from `apps/backend` passed 43 of 43 (40.05 s). The branch did not change either owning file or the code they test.

## Cold-restart qualification — 2026-10-21

- **Original command:** `env -u PORT mise run test` on branch `qualify-cold-restart-reconcile-c5a876531b5f` (base `9b3f53a2`), with the host at a load average of about 10 on 18 cores. The change touches only the Codex bridge, one e2e spec and docs.
- **Failure:** `restart recovery re-links submodules of an adopted or abandoned copy` exceeded 5000 ms (5137.87 ms); the backend reported one failure and the workspace group failed after 707.2 seconds. Every other group passed.
- **Owning-file reruns:** `bun --cwd=apps/backend test src/core/environment-move.test.ts` without the Node preload failed the same case again (5075.09 ms; 36 passed). The documented command, `env -u PORT mise run test:logged -- --name environment-move-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures`, passed unchanged (exit 0, 40.0 seconds logged).
- **Evidence:** `orkestrator-test-run.oQ14Bx` (aggregate) and `orkestrator-test-run.ZCmfUZ` (preload-free rerun) under the host temporary directory.
- **Assessment:** confirmed recurrence. No implementation, assertion, timeout or skip changed.

## Cold restart review qualification — 2026-10-21

- **Original command:** `mise run test:logged -- --name review-full-suite -- mise run test`, alongside isolated live cold-restart qualification; workspace/root/bridges/protocol reserved 4/1/2/1 slots.
- **Failure:** `restart recovery re-links submodules of an adopted or abandoned copy` exceeded the default 5000 ms deadline (5073.05 ms). Backend reported 9739 passed, 67 skipped, three failed and one between-test error across 9809 tests in 551 files (630.83 seconds).
- **Owning-file rerun:** `mise run test:logged -- --name environment-move-recheck -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the unchanged owning file (exit 0, 20.3 seconds logged).
- **Evidence:** `orkestrator-test-run.K1HiOG/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory.
- **Assessment:** confirmed intermittent recurrence; concurrent load is an unconfirmed explanation. No implementation, assertion, timeout or skip changed.

## Federated client backend validation — 2026-10-21

- **Original command:** a full `test:workspace` run during the federated multi-backend client work on `implement-remote-doc-007d1ec11a16-r1` (backend machine profile, authenticated hello and loopback client gateway, `0ec079bb`). That change does not touch `environment-move.ts` or its test.
- **Failure:** this owner's submodule re-link case exceeded the five-second test timeout. The exact test name, elapsed milliseconds, worker counts, suite counts and evidence log path were not captured.
- **Owning-file rerun:** `apps/backend/src/core/environment-move.test.ts` passed unchanged when rerun alone. The exact rerun command and duration were not captured.
- **Assessment:** reported recurrence of the known intermittent timeout; shared-host contention remains a hypothesis. No implementation, assertion, timeout or skip changed.

## Credential snapshot review validation — 2026-10-21

`mise run test:logged -- --name full-suite -- mise run test` on
`fix-agent-test-host-home-writes-c7337a6ddd7f` (base `a8128980`) timed out
`move_environment > moves a worktree with nested submodules (same disk)`
at 5084.10 ms against the default 5000 ms budget. Workspace/root/bridges/protocol
reserved 4/1/2/1 slots; the backend used two isolated Bun workers. The move
implementation and its tests were unchanged.

`mise run test:logged -- --name environment-move-rerun -- bun test --cwd apps/backend
--preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts
--parallel=1 --only-failures` passed the entire unchanged owning file,
exit 0, in 46.9 seconds.

Evidence: `orkestrator-test-run.9G1j25/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory; outer log in `orkestrator-test-run.TM4iwl`.
Shared host contention remains a hypothesis. No implementation, assertion,
timeout or skip changed.

The aggregate exited 1 after 735.0 seconds. Backend reported 9,742 passed,
67 skipped, one failed and one between-tests error across 9,810 tests in
551 files (696.00 seconds). The timed-out submodule subprocess was terminated
with SIGTERM and emitted the between-tests `CommandFailedError` about missing
submodule metadata. The other failing test was the unchanged terminal history
owner, recorded in [0513](../web-ui/0513-terminal-history-backward-page-count.md).
All other workspace packages, root/support, bridges and protocol regeneration
passed.

## Second cold-restart main merge — 2026-10-22

- **Original command:** `env -u PORT mise run test:logged -- --name main-refresh2-full -- mise run test`, merging `origin/main` at `edcd60d92` into `a973416e`.
- **Workers:** normal workspace/root/bridges/protocol reservations of 4/1/2/1 slots, alongside browser and container checks.
- **Failure:** `restart recovery re-links submodules of an adopted or abandoned copy` exceeded 5000 ms (5090.90 ms), followed by a terminated Git subprocess error. This was the aggregate's only failing test; root/support, bridges and protocol regeneration passed. Aggregate exit 1, 558.2 s logged.
- **Owning-file rerun:** `env -u PORT mise run test:logged -- --name main-refresh2-move-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the complete unchanged file (exit 0, 19.1 s).
- **Evidence:** `orkestrator-test-run.ZQ12yB/main-refresh2-full.log.gz` and `orkestrator-test-run.1b7Rd4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. No move implementation, assertion, timeout or skip changed; concurrent validation does not establish the cause.

The subsequent `env -u PORT mise run test:logged -- --name main-refresh2-warm -- mise run test`
passed all four non-iOS groups (exit 0, 445.8 s). No move source or test changed
between the failed aggregate, owning-file pass and successful aggregate retry.


## Preview qualification second main merge — 2026-10-21

`mise run test` after merging `origin/main` at `3cfc33fe` into `bf04abc7`
repeated `restart recovery re-links submodules of an adopted or abandoned copy`
at 5,059.80 ms (five-second deadline), with a terminated submodule command
reported between tests. Workspace/root/bridges/protocol reserved 4/1/2/1
workers; backend used two isolated workers alongside Docker/browser validation.
The aggregate exited 1 after 469.0 seconds; backend totals were 9,764 passed,
67 skipped, two failed and one between-test error. All other packages and groups
passed. The other failure is recorded in [0624](../backend-services-and-tooling/0624-public-exec-start-refused-in-aggregate.md).

`mise run test:logged -- --name preview-merge2-move-owner -- bun test --cwd
apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts
--parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in
14.3 seconds. No assertion, timeout, skip or implementation changed. Evidence:
`orkestrator-test-run.aIlmtw/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
below the host temporary directory. Scheduling contention remains a hypothesis.

## Transcript-scroll main merge validation — 2026-10-21

- `mise run test:logged -- --name merge-tests -- mise run test` reproduced `restart recovery re-links submodules of an adopted or abandoned copy` at 5038.43 ms against its 5000 ms timeout. Workspace/root/bridges/protocol reservations were 4/1/2/1, with two isolated backend workers; browser and Electron checks also ran on the shared host.
- The pending submodule subprocess was killed after the deadline and reported as a between-tests error.
- The unchanged owning file passed: `mise run test:logged -- --name merge-move-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` (exit 0, 29.0 s logged).
- Backend counts: 9904 passed, 68 skipped, one failed and one between-tests error across 9973 tests in 570 files (929.21 s). The complete aggregate exited 1 after 1053.9 s; its other failure was the root tmux case (0482), which passed alone.
- Evidence: host temporary directory `orkestrator-test-run.4IXzMM`. Shared-host contention remains a hypothesis. No source, assertion, timeout or skip changed.

## MCP external-edit watch review fixes — 2026-10-22

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`; workspace/root/bridges/protocol reserved 4/1/2/1 slots, with two isolated backend workers.
- **Failure:** `restart recovery re-links submodules of an adopted or abandoned copy` timed out after 5000 ms (5081.66 ms), followed by a terminated submodule command reported as an unhandled error between tests.
- **Owning-file rerun:** `mise run test:logged -- --name environment-move-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 31.8 s logged).
- **Evidence:** `orkestrator-test-run.jhZR27/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** confirmed recurrence. The host load average exceeded 50 during validation; scheduling contention is plausible but unproven. No move implementation, assertion, timeout or skip changed.

The aggregate exited 1 after 822.1 s. Backend counts were 9918 passed, 80 skipped, three failed and two between-test errors across 10001 tests in 572 files (757.16 s). The other failures are recorded in 0248, 0512 and 0673; root firewall fixture timeouts are recorded in 0192. All other workspace packages, bridges and protocol regeneration passed.

## Sidebar main-merge validation — 2026-10-22

- Initial merge of `c17f1c8d5` into `b0f24b642`: `mise run test:logged -- --name merge-suite -- mise run test` reserved workspace/root/bridges/protocol workers 4/1/2/1. Backend reported 9,967 passed, 69 skipped, two failed and one error (556.4 s).
- `restart recovery re-links submodules of an adopted or abandoned copy` exceeded five seconds (5,064.82 ms); the submodule child then reported missing `nested` directories after fixture cleanup and was terminated.
- After refreshing the pending merge to `7e051d955`, `mise run test:logged -- --name merge-environment-move-owner -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed the complete unchanged owner, exit 0 in 23.9 s.
- Evidence: `orkestrator-test-run.9ak22c/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory. Browser, Docker and another worktree's tests overlapped the initial aggregate. No assertion, deadline or skip changed; host contention remains a hypothesis.
