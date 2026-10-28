# Keyboard shortcuts Windows/Linux (todo 0325) branch validation

- **ID:** 1295
- **Status:** open
- **Date observed:** 2026-10-28
- **Command:** `mise run test:logged -- --name full-test -- mise run test` on
  branch `todo-0325-keyboard-shortcuts-desktop-7ea8707afcbb` (one commit on
  `6a6009a09`). The diff touches the desktop application menu, the shortcut
  catalog's platform detection, tests and docs.
- **Host admission:** every group waited 989 seconds for other worktrees'
  exclusive test leases. Load average was about 46. Root and agent-support
  and the Codex protocol lockfile passed. The workspace group failed after
  1,746 seconds. The bridges group started at 1,760 seconds, and
  `test:logged`'s 1,800-second absolute deadline terminated the aggregate.
- **Bridges completion:** `mise run test:logged -- --name bridges -- bunx turbo run test:bridge --cwd . --filter='./bridges/*' --concurrency=2`
  then ran the group's command alone and passed (228.5 s).
- **Workspace counts:** desktop 1,288 passed, 14 skipped, 0 failed. Protocol
  2,124 passed. Toolchain, web-public and CLI had 0 failures. Backend: 10,143
  passed, 89 skipped, 2 failed. Web: 10,292 passed, 10 skipped, 2 failed.
- **Evidence:** `orkestrator-test-run.HKpv4c` (uncompressed: terminated before
  finalization) and `orkestrator-test-run.xkqZHE` (aggregate summary) under
  the host temporary directory.

| Owner | Aggregate failure | Rerun |
| --- | --- | --- |
| `apps/backend/src/core/storage-writer-guards.test.ts` | `raw StorageDatabase writers outside StorageService > name the store they write` timed out at 5,000 ms. | Failed alone on the branch (7.8 s) and on a clean `origin/main` worktree at `92f8c25a7` (12.1 s). Not a flake; same as 1003, 1010 and 1247. |
| `apps/backend/tests/codex-subagent-cards.test.ts` | Cold projection was `recovering`, expected `idle` (2,834 ms). | Passed alone. Recurrence recorded in [0310](../native-agents-and-transcripts/0310-codex-subagent-cards-projection-wait-timeout.md). |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | `typing after the sigil filters a maximal list without fetching, refreshing or scanning`: projection read count was 2. | Failed alone on the branch and on clean `origin/main` `92f8c25a7`, matching [0722](../native-agents-and-transcripts/0722-native-command-filter-projection-read.md). |
| `apps/web/src/components/federation/node-action-requests.test.tsx` | `root-change approval handles over-limit and still permits rejection` timed out at 5,000 ms. The `Apply 501 files` button was not found. | Failed alone on the branch (6.3 s) and on clean `origin/main` `92f8c25a7` (6.4 s). |

Branch reruns used `mise run test:logged` with `bun test --cwd apps/backend`
and `bun test --cwd apps/web` and two workers. The `origin/main` reruns used
the same `bun test` commands in a detached worktree. None of these owners, or
the code they exercise, changed on this branch, and no assertion, timeout or
skip was changed. The aggregate result remains failed. No passing full
`mise run test` was established under this host load.
