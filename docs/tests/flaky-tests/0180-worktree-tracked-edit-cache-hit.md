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
