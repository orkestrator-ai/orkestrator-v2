# Worktree tracked-edit cache hit

- **ID:** 0180
- **Status:** open
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
