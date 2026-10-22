# Worktree tracked-edit cache hit

- **ID:** 0180
- **Status:** resolved
- **Date observed:** 2026-10-03
- **Snapshot:** based on `19cf6535`, with the workflow-result submission and review-nudge fixes staged. No watcher, diff-statistics or Git-snapshot implementation or tests changed.
- **Original command:** `mise run test:logged -- --name full-suite-gnu -- mise run test`, with the GNU-tool PATH prescribed in `docs/development/testing-guide.md`.
- **Worker configuration:** workspace group 2 workers (Turbo at most two package tasks, one isolated Bun worker per package); root group 3, bridges 2 and protocol 1. The workspace group waited 35.7 seconds for the preceding full run's workspace group to finish.
- **Failure:** `real Git through the shared owner > a tracked edit that never touches the index is detected` at `apps/backend/src/core/worktree-snapshots-git.test.ts:136` expected the file-list cache-hit count to be 1 but received 0 (130.66 ms). The preceding assertion returned the expected modified `a.txt` row.
- **Suite result:** backend 5,625 passed, 15 skipped, 1 failed across 316 files (228.70 seconds); the full run exited 1 after 290.4 seconds. Root, bridges and protocol passed. The preceding full run's workspace group passed; that run failed five unrelated shell fixtures because BSD utilities were selected. Those shell fixtures passed with the documented GNU-tool PATH.
- **Isolated rerun:** `mise run test:logged -- --name worktree-snapshot-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures`, with the same GNU-tool PATH, passed all four tests in 0.5 seconds.
- **Evidence:** aggregate artifact `orkestrator-test-run.wloB6p/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; wrapper artifact `orkestrator-test-run.v3aPaS`. The aggregate contains only this backend assertion failure.
- **Hypothesis:** another watcher hint may invalidate the file-list cache after the test observes the changed revision but before `readRows()` runs. The correct file row followed by a missing cache hit is consistent with a fresh read-triggered scan. This is unconfirmed; no test was skipped or loosened.

## Recurrence on 2026-10-12

The environment-move fix validation reproduced `real Git through the shared owner > a tracked edit that never touches the index is detected` under
`mise run test:logged -- --name move-full-suite -- mise run test`, with the GNU
tool PATH documented in the testing guide. Group allocations were 2/3/2/1.
Backend package: 5,840 passed, 15 skipped and 4 failed across 328 files; this failure lasted 288.04 ms and expected 1 cache hit but received 0.

The owning file passed alone, exit 0, in 0.5 seconds:

```bash
mise run test:logged -- --name isolate-worktree-snapshots -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/y3/xxg06qlx09d2x3mjf0cv3wjc0000gn/T/orkestrator-test-run.tUZZDC/summary.json`
and its compressed group logs. Status remains open; the isolated pass confirms
recurrence but does not establish a root cause. No assertion, timeout or skip
was changed.

- **Recurrence 2026-10-13:** `mise run test` on `deps/upgrade-2026-10`
  (Bun 1.4.3, Vite 8, Electron 44 batch) failed the same cache-hit assertion
  (`Expected: 1, Received: 0` at line 136) in the workspace group; the file
  passed alone three times in a row (4 pass, 0 fail each). The change touches
  no worktree-snapshot code.

## Recurrence on 2026-10-15

GitHub setup recovery validation reproduced the same cache-hit assertion
(`Expected: 1, Received: 0`, 143.34 ms) under `mise run test`, with four
workspace worker slots. Evidence is in
`/tmp/orkestrator-test-run.9M60yV/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The unchanged owning file passed alone (exit 0, 0.7 seconds):

```bash
mise run test:logged -- --name worktree-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures
```

No watcher implementation, assertion, timeout or skip was changed.

## Recurrence on 2026-10-16

`mise run test` on `multi-review-flow-graph-followups` (Multi Review flow
graph follow-ups; no worktree-snapshot code changed) failed the same test in
the workspace group, alongside cases 0248 and the deterministic
`agent provider module boundaries` failure. Evidence is in
`/tmp/orkestrator-test-run.zlamOL/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
The unchanged owning file passed alone (`bun test src/core/worktree-snapshots-git.test.ts`
from `apps/backend`: 4 pass, 0 fail). No assertion, timeout or skip was changed.

## MCP apply-path merge validation recurrence on 2026-10-16

`mise run test:logged -- --name merge-final-suite -- mise run test` after
merging main through `65077337` into `mcp-apply-path-gaps` reproduced the same
cache-hit assertion (`Expected: 1, Received: 0`, 192.77 ms, now at line 139).
The backend reported 8,323 passed, 40 skipped and one failed across 444 files;
the other workspace packages, root, bridges and protocol check passed.
Evidence:
`/tmp/orkestrator-test-run.822ACU/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.

After the aggregate finished, the unchanged owning file passed alone (exit 0,
1.5 seconds):

```bash
mise run test:logged -- --name merge-worktree-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures
```

No watcher implementation, assertion, timeout or skip was changed. The existing
cache-invalidation hypothesis remains unconfirmed.

## Recurrence on 2026-10-17

`mise run test:logged -- --name full-suite -- mise run test` on the remote host
maintenance branch (based on `eeeca4b3`) failed the same cache-hit assertion
(`Expected: 1, Received: 0`, 213 ms) in the workspace group, next to two
deterministic failures that change caused and fixed: the command-label budget
and the CLI pack list. It failed once more when run in one `bun test` process
with `tests/gateway-support-extra.test.ts` (139 ms), then passed alone three
times in a row (4 pass, 0 fail each) with
`bun test --preload ../../tests/setup-node.ts src/core/worktree-snapshots-git.test.ts`
from `apps/backend`. The change touches no worktree-snapshot, watcher or diff
code. Status remains open.

## Recurrence — 2026-10-17 (host maintenance review fixes)

The `all-tests` aggregate again expected one `file-list-read` cache hit but
observed zero in `a tracked edit that never touches the index is detected`.
The unchanged owning file passed alone in 0.4 s with:

```sh
mise run test:logged -- --name git-snapshots-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures
```

Aggregate evidence:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Q6mb2y/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
No snapshot implementation, assertion, timeout or skip changed.

## Auth-secrets main merge recurrence on 2026-10-17

`mise run test:logged -- --name latest-merge-tests -- mise run test` while
merging main through `2039ae62` into
`todo-auth-response-secrets-fd4c38797733` reproduced the same cache-hit
assertion at line 139 (`Expected: 1, Received: 0`, 135.99 ms). The workspace
group reserved four worker slots, with two package tasks and two isolated Bun
workers per package; root reserved one slot, bridges two, and protocol one.
The backend reported 8,492 passed, 40 skipped and one failed across 455 files
(279.57 seconds). The aggregate exited 1 after 314.3 seconds; the other
workspace packages, root, bridges and protocol passed.

The unchanged owning file passed alone (exit 0, four tests, 0.9 seconds):

```bash
mise run test:logged -- --name merge-worktree-recheck -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures
```

Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.CRhLaf/summary.json`
and `workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`
in the same directory; wrapper artifacts are in `orkestrator-test-run.XvaLJ6`.
No watcher implementation, assertion, timeout or skip changed. The existing
cache-invalidation hypothesis remains unconfirmed.

## Recurrence during the preview re-baseline merge (2026-10-17)

- **Original command:** `mise run test:logged -- --name rb2-full-suite -- mise run test`
  with the GNU-tool `PATH` prefix; macOS arm64, Bun 1.4.3, branch
  `todo-preview-rebaseline-084636c7dd34` merged with `main` at `768ff53f` (no
  worktree-snapshot code changed).
- **Failure:** the same cache-hit assertion at line 139 (130.18 ms).
- **Suite counts:** backend 8,715 passed, 41 skipped, 1 failed; every other
  workspace package, root/support, bridges and the protocol lockfile passed.
- **Isolated reruns:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1`
  failed this case in 2 of 6 runs alone (3 pass, 1 fail each time) and passed
  in the other 4, at a host load average of about 22 with other worktrees
  running live tests. Earlier recurrences always passed alone; this is the
  first evidence that host load alone, without the aggregate, can trigger it.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.YA5c3d/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
  No assertion, timeout or skip changed; the cause remains unconfirmed.

## Multi Review recovery validation — 2026-10-17

- Command: `mise run test:logged -- --name final-full-review-recovery -- mise run test` on `4443c027` plus the recovery fixes, macOS arm64 on the shared host. Workspace/root/bridge/protocol reserved 4/1/2/1 slots; backend used two isolated workers. Workspace admission waited 49.6 seconds.
- The tracked-edit case failed at 153.74 ms: cache hits expected 1, received 0 (line 139). Backend: 8,636 passed, 41 skipped, one failed across 463 files (327.78 seconds). The outer run exited 1 after 409.7 seconds. Every other workspace package and the root/bridge/protocol groups passed; all recovery tests passed.
- Unchanged owning-file rerun: `mise run test:logged -- --name snapshots-owner-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures` passed all four tests, exit 0, 0.5 seconds.
- Evidence: `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IJ4t3D/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; outer `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.NEipUr/final-full-review-recovery.log.gz`.
- No watcher implementation, assertion, timeout or skip changed. Cache invalidation racing the read remains a hypothesis, not an established cause.

## Grok-trust PR-stage merge recurrence — 2026-10-17

- **Original command:** `mise run test:logged -- --name pr-stage-full -- mise run test`, on `verify-grok-trust-claude-parked-retry` merged with `origin/main` at `607d12e2`, host load average about 27.
- **Failure:** the cache-hit assertion expected 1 and received 0 (`worktree-snapshots-git.test.ts:139`). The workspace group had three failures in total (8821 backend tests passed); root, bridges and the protocol lockfile groups passed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.rEfkv1/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts src/core/worktree-snapshots-git.test.ts` from `apps/backend` passed unchanged: 4 pass, 0 fail in under a second.
- **Assessment:** an unchanged owning-file pass confirms a recurrence. The branch does not touch this code. No source, assertion, timeout or skip changed.

## Pi and Cursor agent-test logins PR stage — 2026-10-17

- Original command: `bun run test:workspace` in `apps/backend` (two workers) after merging `origin/main` into `fix-pi-login-in-agent-test-profiles-379ebff75838`, macOS arm64 on the heavily loaded shared host.
- The tracked-edit case failed at 304.02 ms: cache hits expected 1, received 0 (line 139). Backend: 8,830 passed, 41 skipped, two failed across 475 files (457.71 seconds); the other failure was 0165.
- Unchanged owning-file rerun: `bun test --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts` in `apps/backend` passed all four tests (0.83 seconds).
- The branch does not touch worktree snapshots. No watcher implementation, assertion, timeout or skip changed.

## Preview tunnel close-drain validation recurrence (2026-10-17)

- **Command:** `mise run test:logged -- --name full-suite -- mise run test`;
  workspace/root/bridge/protocol reserved 4/1/2/1 worker slots, with two isolated
  Bun workers per workspace package. Workspace admission waited 251.3 seconds.
- **Failure:** the unchanged tracked-edit cache-hit assertion at line 139
  expected 1 and received 0 (142.04 ms). Backend: 8,793 passed, 41 skipped,
  2 failed across 471 files (401.33 seconds). The other failure was a new
  relay-test scheduling assumption, corrected in the same change. Other
  workspace packages, root/support, bridges and protocol passed.
- **Isolated rerun:** `mise run test:logged -- --name git-cache-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures`
  passed all four unchanged tests, exit 0 (0.8 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.ZmlX01/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- The existing cache-invalidation hypothesis remains unconfirmed. No watcher
  implementation, assertion, timeout or skip changed.

## Slash catalogue accuracy review observation — 2026-10-17

- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`, macOS arm64, Bun 1.4.3, with 4/1/2/1 workspace/root/bridge/protocol slots on the shared host.
- **Failure:** `real Git through the shared owner > a tracked edit that never touches the index is detected` failed at line 139 in 270.83 ms: cache hits expected 1, received 0. Backend reported 8804 passed, 41 skipped and two failed across 472 files (485.60 seconds). The other failure was the provider module line limit introduced by the slash catalogue fix and corrected by extracting dispatch gate and prompt-tool responsibilities.
- **Owning-file rerun:** `mise run test:logged -- --name worktree-owner-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures` also failed the unchanged case in 178.63 ms (three passed, one failed; 1.1 seconds overall). This observation does not independently establish a flake.
- **Evidence:** aggregate `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.fs9eAA/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`; isolated `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.HPudXt/worktree-owner-isolated.log.gz`.
- No watcher implementation, assertion, timeout or skip changed. The existing cache-invalidation hypothesis remains unconfirmed.

The final `mise run test:logged -- --name final-full-tests -- mise run test`
passed all four groups (exit 0, 841.2 seconds including queue waits), with
the owning test unchanged.

## Recurrence on 2026-10-18

`mise run test:logged -- --name full-suite -- mise run test` on branch
`qualify-annotation-live-implement-0330a0bacc01` (`50c26708`, a dev:test
harness, e2e and docs change) on a heavily loaded macOS host. Evidence is in
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.Zq7Cut/`. The cache-hit assertion (expected 1, received 0) failed in the
backend package, and again in one of three runs of the owning file alone
(`bun test src/core/worktree-snapshots-git.test.ts` from `apps/backend`:
4 passed, 3/1, 4 passed).

## Backend preload contract validation recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name full-suite -- mise run test`
  on `28915027` plus the backend preload contract assertion. Workspace/root/
  bridge/protocol used 4/1/2/1 worker slots, with two isolated Bun workers per
  workspace package.
- **Failure:** `real Git through the shared owner > a tracked edit that never touches the index is detected`
  failed at line 139 in 148.97 ms: cache hits expected 1, received 0. Backend:
  9,017 passed, 41 skipped, one failed across 480 files (577.47 seconds). The
  aggregate exited 1 after 593.6 seconds; every other workspace package and
  the root, bridge and protocol groups passed.
- **Isolated rerun:** `mise run test:logged -- --name worktree-snapshot-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures`
  passed the unchanged owning file (four tests, exit 0, 0.8 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.XESA6C/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`;
  outer artifacts are in `orkestrator-test-run.di5BQw`.
- No watcher implementation, assertion, timeout or skip changed. The existing
  cache-invalidation hypothesis remains unconfirmed.

## Usage-cache validation recurrence — 2026-10-18

- **Command:** `mise run test:logged -- --name usage-all-tests -- mise run test`, with aggregate workspace/root/bridges/protocol reservations of 4/1/2/1 workers; backend used two isolated workers.
- **Failure:** the tracked-edit cache-hit assertion expected 1 and received 0 at line 139 (140.96 ms). Backend reported 9038 passed, 41 skipped and four failures across 481 files; the remaining failures concern shell fixtures outside the usage-cache change.
- **Isolated rerun:** `mise run test:logged -- --name baseline-worktree-git -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures` passed unchanged, exit 0, in 0.6 s.
- **Evidence:** `orkestrator-test-run.BopZMS/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Disposition:** Confirmed recurrence; no watcher implementation, assertion, timeout or skip changed.

## Upgrade-channel merge validation — 2026-10-18

- **Command:** `mise run test:logged -- --name merge-final-tests -- mise run test`, with the testing guide's macOS GNU-tool PATH and aggregate workspace/root/bridges/protocol reservations of 4/1/2/1 workers; backend used two isolated workers.
- **Failure:** The same assertion at line 139 expected 1 and received 0 (175.25 ms). Backend reported 9059 passed, 41 skipped and one failure across 481 files; all other workspace packages, root tests, bridges and protocol regeneration passed. The full command exited 1 after 566.1 seconds including capacity waits.
- **Isolated rerun:** `mise run test:logged -- --name merge-worktree-cache-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures`, with the same GNU-tool PATH, also failed unchanged: three passed, one failed in 1.1 seconds (116.10 ms for the failing test).
- **Evidence:** `orkestrator-test-run.xfw48l/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and `orkestrator-test-run.PMDdwy/merge-worktree-cache-rerun.log.gz` under the host temporary directory.
- **Disposition:** This observation does not independently establish a flake because the owning file failed alone. The test and its worktree implementation were not changed by the merge; no assertion, timeout or skip changed. Full-suite validation remains non-green.

## Recurrence on 2026-10-18

`mise run test:logged -- --name full-test -- mise run test` on branch `qualify-coordinator-live-six-platforms-fb2b4a53344d`, on a host at load average 36–69 with several live
suites running in other environments. Failed at 231.49 ms, an assertion rather than a timeout. Workspace and root
artifacts:
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.UQLOD6/`.
The unchanged owning file passed alone (4 pass, 1.4 s).


## Live coordinator review-fix validation — 2026-10-18

- **Aggregate:** `mise run test:logged -- --name coordinator-full-suite -- mise run test`
  on `qualify-coordinator-live-six-platforms-fb2b4a53344d`, macOS arm64, Bun 1.4.3.
  Backend used two isolated workers alongside the other aggregate groups and
  another worktree's validation. The workspace group exited 1 after 363.7 s;
  backend reported 9045 passed, 41 skipped, two failed and one between-tests
  error. Every other workspace package, root/support, bridges and protocol
  lockfile validation passed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.MUMuwG/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- **Failure:** the tracked-edit cache-hit assertion at line 139 expected 1
  and received 0 (105.32 ms). The preceding modified-file assertion passed.
- **Owning-file rerun:** `mise run test:logged -- --name worktree-cache-rerun -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures`
  passed unchanged, exit 0, in 0.4 s.
- **Assessment:** confirmed intermittent recurrence; the existing
  invalidation hypothesis remains unconfirmed. No watcher implementation,
  assertion, timeout or skip changed.

## Live transcript paging qualification recurrence — 2026-10-18

- **Original command:** `mise run test:logged -- --name full-test -- mise run test` on `qualify-transcript-paging-live-mr-c2fa28c0ecdd` (web transcript views and an opt-in e2e spec only), shared macOS arm64 host.
- **Failure:** the unchanged case failed at line 139 in 185.23 ms: cache hits expected 1, received 0. Backend reported 9,016 passed, 41 skipped and two failed across 480 files (414.4 seconds); the other was the new coordinator timeout [0480](0480-coordinator-fetch-remotes-submodule-timeout.md).
- **Isolated rerun:** `mise run test:logged -- --name git-cache-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures` passed, exit 0 (0.8 seconds logged).
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.9ChzHs/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
- No watcher implementation, assertion, timeout or skip changed.

## Recurrence after merging main into the real-Electron preview branch (2026-10-18)

- **Command:** `mise run test:logged -- --name full-tests-merged -- mise run test`
  on branch `qualify-preview-electron-tunnel-c6ca4deaffee` after merging
  `origin/main` at `68dc1c8d`, on a macOS arm64 host shared with other
  live-test worktrees.
- **Failure:** the same test failed in the backend workspace group (135.8 ms).
- **Isolated rerun:** `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1`
  passed 4/4. The owning file was unchanged on the branch.


## OpenCode sign-in main merge — 2026-10-19

- **Original command:** the testing guide's GNU-tool PATH with `/opt/homebrew/bin:/usr/bin` ahead of ambient shims, `mise run test:logged -- --name merge-final-tests -- mise run test`, merging `cd443028` into `d897a4eb`. Workspace/root/bridges/protocol reserved 4/1/2/1 slots; backend used two isolated workers.
- **Failure:** the tracked-edit cache-hit assertion at line 139 expected 1 and received 0 (991.71 ms). Backend reported 9166 passed, 41 skipped and two failed across 9209 tests in 491 files (471.65 seconds). The other failure was the resource-event timeout in [0503](0503-backend-resource-event-aggregate-timeout.md). Every other workspace package, root/support, bridge and protocol check passed. Aggregate exit 1 in 608.1 seconds logged, including 84.5 seconds waiting for the workspace reservation.
- **Owning-file rerun:** the same PATH with `mise run test:logged -- --name merge-final-owner-worktree-snapshots -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/worktree-snapshots-git.test.ts --parallel=1 --only-failures` passed unchanged (exit 0, 0.5 seconds logged).
- **Evidence:** `orkestrator-test-run.cM59au/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` and outer `orkestrator-test-run.NdOLPH/merge-final-tests.log.gz` below the host temporary directory.
- **Assessment:** confirmed intermittent recurrence. The invalidation-timing hypothesis remains unconfirmed; no implementation, assertion, timeout or skip changed.

## File/LOC change-tracking validation — 2026-10-20

- **Original command:** `mise run test:logged -- --name ct-full2 -- mise run test` on branch `implement-file-change-f3950a40ac3a-r1` (uncommitted change-tracking implementation on `97af3d45`), on a macOS arm64 host.
- **Failure:** the tracked-edit cache-hit assertion at line 139 expected 1 and received 0 (134.31 ms). Backend ran 9748 tests across 548 files; this was the only failure. Root/support, bridges and the codex protocol lockfile passed.
- **Owning-file rerun:** `bun test --cwd apps/backend ./src/core/worktree-snapshots-git.test.ts` passed 4/4 in five consecutive runs.
- **Caveat:** the owning file is unchanged, but the branch changes the shared scan path it exercises (`SharedScanQueue` now lets a caller join a running pass that started after its request, and `DiffScanEvent` hooks were added), so this occurrence does not independently establish the flake. An earlier full run on the same branch, before the scan-sharing change, passed this test.
- **Evidence:** `orkestrator-test-run.MRqN8v` and `orkestrator-test-run.SZoJWF` below the host temporary directory.

## Resolution — 2026-10-20

- **Root cause (product):** the diff scan's own `git status` rewrote the linked worktree's index. `getLocalGitStatusDetailed` ran `git status --porcelain=v1 -z --untracked-files=all` without `--no-optional-locks`, so Git opportunistically refreshed the index (`index.lock` then rename to `index`) whenever an entry was racily clean or its stat data had changed. With git 2.56 on APFS this happened on most scans in this fixture. The metadata watcher correctly reports `index` changes as file-list hints, so every watcher-driven scan produced its own hint about one settle window (50 ms here) after it finished. That hint advanced `dirtyEpoch` and queued a redundant rescan. When `readRows()` ran after the self-induced hint (or after a late index-write event from the `beforeAll` scan, delivered after the append), the published body's epoch was older than the read's required epoch. The read then joined the rescan (`coalesced`, not `cacheHits`), returning the right row with zero cache hits, which matches every recorded failure. In a quiet run the margin was about 7 ms: the scan ended at 306 ms, the read finished at 317 ms and the self-hint fired at 323 ms. Any scheduling delay lost that margin, which is why the failure followed load and the full aggregate suite. Instrumented timelines also showed the loop sustaining itself, with a scan, an index write and a hint repeating every ~50 ms until the racy window passed.
- **Fix:** `apps/backend/src/core/commands-files.ts` `getLocalGitStatusDetailed` now passes `--no-optional-locks` to all three scan reads (two `git diff` calls and `git status`). This is Git's documented mode for background readers. The scan no longer writes the index or takes `index.lock`, so it cannot invalidate its own result or collide with the user's Git commands. Trade-off: scans no longer persist refreshed stat data or untracked-cache and fsmonitor state into the index. The next index-writing Git command, from the user or an agent, still persists it.
- **Test:** the cache-hit assertion is unchanged. One regression assertion was added to `a tracked edit that never touches the index is detected`: after the read, the worktree index mtime must still equal its pre-edit value, so the scan must be read-only. Without the fix this new assertion fails deterministically instead of flakily.
- **Verification** (18-core host; concurrent copies via a runner script; "pre-fix" uses a `git` PATH wrapper that strips `--no-optional-locks`, leaving the source untouched):
  - Pre-fix, original assertions only (instrumented copy), 100 runs at 12 concurrent with 18 `yes` CPU burners: **46/100 failed** with the cache-hit `Expected 1, Received 0`. Fixed, same conditions: **0/100**.
  - Pre-fix, updated test file, 10 runs at 5 concurrent, unstressed: 10/10 failed (9 on the new index assertion, 1 on the cache hit). With 100 runs at 12 concurrent under burners: 100/100 failed (54 index, 46 cache hit).
  - Fixed, updated test file, 200 runs at 18 concurrent under 18 CPU burners (load ~14–21): **0/200 failed**.
  - The timeline with the fix shows exactly one hint per real change and no index events after scans.
  - Related backend files (`diff-stats*`, `commands-files*`, `commands-file-*`, `worktree*`): 135 pass. Backend `typecheck`, `oxlint` and `oxfmt --check` are clean on the touched files.
  - `--rerun-each` does not apply here: the file's tests are sequential and stateful over one shared repository.
