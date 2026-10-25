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

## Recurring-work qualification main merge — 2026-10-22

- **Original command:** `mise run test:logged -- --name merge-tests -- mise run test` after merging `origin/main` (`3b469e885`) into pre-merge HEAD `61866a15b208019ee787038202be0e3381a42343`. Workspace reserved four slots (two package tasks with two Bun workers each), root/support one, bridges two and protocol verification one. Browser/Electron checks and the Docker image build overlapped parts of the run.
- **Failure:** `restart recovery re-links submodules of an adopted or abandoned copy` exceeded its five-second deadline at 5056.41 ms. Its recursive submodule-status subprocess received SIGTERM, producing an unhandled error between tests.
- **Suite counts:** backend 10019 passed, 98 skipped, one failed and one error across 10118 tests in 581 files (577.57 s). Workspace had 12 of 13 successful tasks; root/support, bridges and generated-protocol groups passed. Aggregate exit 1 (656.5 s logged).
- **Complete unchanged owner:** `mise run test:logged -- --name merge-submodule-owner -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures` passed all 37 tests, exit 0 (20.5 s logged).
- **Evidence:** `orkestrator-test-run.bej67B/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** confirmed recurrence of this deadline failure. No implementation, test assertion, deadline or skip changed.

## Test-suite speed-up branch — 2026-10-22

- **Original command:** `mise run test` on `speed-up-review-68ad8937158f-r1` (area suites, a six-worker backend pool, and fixed-sleep removals). Workspace reserved eight slots (backend six Bun workers plus one two-worker package task), root/support one, bridges two and protocol one. Host load rose from 8 to about 50 during the run as other worktrees' suites started.
- **Failure:** `restart recovery re-links submodules of an adopted or abandoned copy` exceeded its five-second deadline at 5111.70 ms. The aggregate finished in 335.1 s.
- **Owner change:** this branch changes the owning file's fixtures (the project, origin and submodule source repositories are now built once per file and copied per test); the failing test's assertions and deadline are unchanged.
- **Owning-file rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` from `apps/backend` passed all 37 tests twice (28.8 s and 19.6 s) at host load 46.
- **Evidence:** `orkestrator-test-run.EZ31P0/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Assessment:** recurrence of the known deadline failure under heavy host load. A larger backend worker pool adds concurrent Git work, so watch this entry's frequency after the change lands.

## Native agent collaborator extraction — 2026-10-23

- **Failure:** `restart recovery re-links submodules of an adopted or abandoned copy` hit the five-second timeout (5091.28 ms) after an `lstat` ENOENT on a moved tree's `.git`.
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test` on `todo-0010-native-agent-collaborators-3fc4749e0985` (native agent service refactor; no environment-move or Git code changed), macOS arm64, Bun 1.4.2.
- **Suite counts:** backend 10,120 passed, 86 skipped, 3 failed across 592 files (544.12 s); web 8,818 passed; root/support, bridges and the Codex protocol lockfile passed.
- **Owning-file rerun:** `mise run test:logged -- --name env-move-alone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed twice (35.4 s and 36.7 s logged).
- **Evidence:** `orkestrator-test-run.EveQv4/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory.
- **Changes:** recorded evidence only; no test, timeout, assertion or skip changed.


## Remote coordination and project copy review fixes — 2026-10-24

- **Original command:** `mise run test:logged -- --name repository-tests -- mise run test`, on `coordinator-repo-environments-88e7fd2fdb7a-r1`, macOS arm64, Bun 1.4.3. Workspace/root/bridges/protocol reserved 4/1/2/1 workers, with two isolated backend workers; component browser validation ran concurrently.
- **Failure:** `restart recovery re-links submodules of an adopted or abandoned copy` exceeded its five-second deadline (5044.44 ms), followed by termination of a dangling subprocess. The owning file and move implementation were unchanged.
- **Complete unchanged owner:** `mise run test:logged -- --name move-recovery-recheck -- bun test --cwd apps/backend ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed, exit 0 in 11.1 seconds.
- **Evidence:** `orkestrator-test-run.mrtrrc/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory. The aggregate's separate OpenCode version assertions expect 1.19.0 while the installed CLI reports 1.19.4; those failures are not classified as flakes.
- **Assessment:** recurrence of the known aggregate deadline failure. No assertion, timeout, skip, or move code changed; host contention remains a hypothesis.


## Recurrence — 2026-10-24 (worktree signal review validation)

- **Original command:** `mise run test:logged -- --name watcher-full-suite -- mise run test`; standard aggregate worker leases, with other checkout validation active on the host.
- **Failure:** restart submodule re-link exceeded the five-second deadline (5083.69 ms), followed by the interrupted Git subprocess error.
- **Owning-file rerun:** `mise run test:logged -- --name watcher-environment-move-owner -- bun test --cwd <checkout>/apps/backend ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed unchanged in 35.3 seconds.
- **Evidence:** `orkestrator-test-run.iTzv5K/` under the host temporary directory; the full aggregate remains failed. None of these owning files was changed.
- **Final aggregate counts:** backend 10705 passed, 116 skipped, 20 failed and five between-test errors across 10841 tests (747.20 seconds). Fourteen failures were the unchanged OpenCode conformance expectation for CLI 1.19.0 versus the installed 1.19.4; the other six were the timing cases recorded here and in companion records. The complete repository run exited 1 after 1189.0 seconds, including time queued for shared worker capacity.

## PR monitor shutdown validation recurrence — 2026-10-25

- **Original command:** `mise run test:logged -- --name residual-state-suite -- mise run test`, on `todo-0066-residual-module-state-40e8f98a7ef0`, Bun 1.4.4.
- **Workers:** workspace/root/bridges/protocol reservations of 4/1/2/1 slots, including two isolated backend workers. Workspace admission waited 81.6 seconds for shared host capacity.
- **Failure:** `restart recovery re-links submodules of an adopted or abandoned copy` hit the five-second deadline (5069.11 ms), followed by termination of a dangling process.
- **Owning-file rerun:** `mise run test:logged -- --name environment-move-owner -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 21.8 seconds.
- **Evidence:** `orkestrator-test-run.jMkwTI/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` under the host temporary directory after aggregate completion.
- **Assessment:** recurrence of the existing aggregate deadline failure; this change touches no environment-move source, assertions, deadlines, or skips.
- **Final aggregate counts:** backend 10968 passed, 84 skipped and one failed across 11053 tests in 638 files (576.56 seconds). The full run exited 1 in 719.6 seconds; its other two failures were the existing Codex bridge cases 0492 and 0800, whose unchanged owners also passed separately. Root/support and protocol validation passed.

## Annotation qualification validation — 2026-10-25

- **Original command:** `mise run test:logged -- --name annotation-suite -- mise run test`, with the standard worker leases. The workspace group waited 512.1 seconds for shared host capacity before starting.
- **Failure:** `restart recovery re-links submodules of an adopted or abandoned copy` exceeded its five-second deadline at 5072.20 ms. Its recursive submodule-status child was terminated with `SIGTERM`, producing an error between tests.
- **Complete unchanged owner:** `mise run test:logged -- --name annotation-worktree-recovery-check -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` passed, exit 0 in 18.7 seconds.
- **Evidence:** `orkestrator-test-run.N5VXK9/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` below the host temporary directory; the enclosing log is `orkestrator-test-run.gSVRr6/annotation-suite.log.gz`.
- **Assessment:** recurrence of the known deadline failure. The annotation fixes do not change the move implementation or its tests; no deadline, assertion or skip was changed.

## Recurring-work qualification validation — 2026-10-25

- **Original command:** `mise run test:logged -- --name full-0048 -- mise run test` on `todo-0048-recurring-work-qualification-dbe14f8256cc` (storage read path, recurring-work harness and scripts only), macOS 27.0 arm64, Bun 1.4.4, standard worker leases.
- **Failure:** the restart re-link case exceeded its five-second deadline (5059.50 ms); its `git submodule status --recursive` child was terminated with `SIGTERM`.
- **Owning-file reruns:** `mise run test:logged -- --name owners-0048 -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/container-worktree-signal-install.test.ts ./src/core/coordinator-service.test.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` failed this case again (5090.39 ms, plus an error between tests) with 113 passed across the three files (176.81 s). A second rerun of `environment-move.test.ts` alone (`--name env-move-owner-0048`) at load average 55 failed it and both nested-submodule move cases (34 passed, 3 failed, 3 errors, 62.28 s). Evidence: `orkestrator-test-run.fSNcim/` and `orkestrator-test-run.f5VfI7/`.
- **Aggregate evidence:** `orkestrator-test-run.VrI5KW/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` (enclosing log `orkestrator-test-run.JFzi7O/full-0048.log.gz`) under the host temporary directory. Backend 11433 passed, 89 skipped and 4 failed across 11526 tests in 680 files (872.95 s); web 9760 passed; root/support, bridges and the Codex protocol lockfile passed. Test groups finished in 942.4 s; the run exited 1.
- **Assessment:** the host load average was 50 to 55 from other worktrees' suites throughout, so this observation cannot separate load from a defect; it adds to the existing evidence that these submodule fixtures exceed five seconds under heavy load. No environment-move code, assertion, deadline or skip changed.
