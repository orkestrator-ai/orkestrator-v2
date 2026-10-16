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
