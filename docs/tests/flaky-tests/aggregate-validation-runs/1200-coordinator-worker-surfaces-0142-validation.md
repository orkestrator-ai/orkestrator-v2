# Coordinator worker surfaces (todo 0142) branch validation

- **ID:** 1200
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `todo-0142-coordinator-product-surfaces-1d2b5f278d51` at
  `1d08f0e01`, based on `origin/main` `863b57821`. The branch changes
  coordinator code in `apps/backend` (Control MCP coordinator tools,
  coordinator store receipts, node action requests, pane-layout helpers), the
  approval dialog in `apps/web/src/components/federation`, and
  `packages/protocol` (`coordinator.ts`, the new `coordinator-surfaces.ts`
  and its export). It does not touch `bridges/`, `apps/desktop`,
  `packages/cli` or `tests/unit`.
- **Command:** `mise run test` (logs `orkestrator-test-run.9SvbWc` below the
  host temporary directory). Only the Codex protocol lockfile group passed.
- **Host:** shared macOS host, 18 cores, load average 58–79 during the run
  and 194–290 during the owner reruns, with other sessions' suites running in
  parallel. The workspace group waited about 6.5 minutes for worker slots
  before starting.

## Failures and what they are

| Owning file | Aggregate failures | Owner alone on the branch | `origin/main` | Registry |
| --- | --- | --- | --- | --- |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper > a missing listing/root completion times out as extract-failed`: extraction status 2, not 0 | 10 passed, 2 failed, deterministic | Same two fail alone in a detached `origin/main` worktree | [1101](1101-codex-typed-prompts-0211-validation.md), [1013](1013-interactive-command-main-merge-validation.md) |
| `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts` | `coordinator-hook-refuses`: "Operation aborted" at 15.6 s (real pinned Claude CLI, scripted local model) | Failed twice alone: 6 passed / 3 failed, then 2 passed / 7 failed, a different set each time, every one at the 17 s mark | 1 passed, 8 failed alone, same 17 s mark | Recorded here only: it fails alone too, so it is not a flake by the registry's rule; the varying set points to CLI start-up time under load. |
| `apps/backend` (workspace group) | 14 failures, all five- or six-second deadlines (environment-move, coordinator-service Git status cases, worktree location, terminal history, change-tracking regressions, review-validation worker, agent-accounts containers, leaf-node MCP lists, storage writer guards), then the group's 1,800 s deadline killed the backend task before it reported totals | `storage-writer-guards` and `coordinator-service` passed alone on a second run (the first, at load 194+, failed 1 and 4 by deadline); `agent-accounts-containers` and `control-mcp-leaf-nodes` passed alone; `environment-move` (6), `review-validation-worker` (1), `change-tracking/review-regressions` (2), `commands-environment-worktree-location` (1) and `terminal-history` (1) still failed alone by deadline | `environment-move` and the worktree owners are already open in 1101 as failing on `origin/main` under load | 1101 and the cases it links |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases | Not rerun | Deterministic on macOS | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) |
| `packages/cli/tests/command-surface.test.ts` | `native shell completion execution > fish parses collisions …`, five-second deadline | Not rerun | Not compared | Recorded here |
| `apps/web` | `AgentNativeTab commands > typing after the sigil filters a maximal list…` (2.7 s) and `long transcript fixture > … 20 scroll/expand cycles` (120 s) | Not rerun | Not compared | Recorded here |

## Conclusion

The only owners the change reaches (`storage-writer-guards`,
`coordinator-service`, `control-mcp-leaf-nodes`, `control-mcp-server`,
`coordinator-review-actions`, the node action request suites and the
federation dialog test) pass alone. Every remaining failure is a deadline on
a saturated host or a known deterministic failure on `origin/main`. No
assertion, timeout or skip was changed. The backend totals are missing
because the group deadline killed the task; the affected-test run that
followed is recorded below.

## Affected-test run

`mise run test:changed` (logs `orkestrator-test-run.jBbWup`), load average
175–290, completed every group this time:

- Codex protocol lockfile passed. Root/support: the same two `migrate-copy`
  failures. Bridges: Claude 7 of the 9 `conformance-coordinator-sandbox-live`
  cases at the 15–17 s mark; Codex 2,441, Pi 651, Cursor and ACP all passed.
- Workspace: web 9,942 passed, 0 failed; protocol 1,938 passed, 1 failed
  (`WorkspaceChangeProbe > stops measuring a repository whose snapshots are
  repeatedly slow`, 5.2 s deadline); desktop the two `pruneProfiles` cases;
  backend 12,014 passed, 120 skipped, 55 failed.
- Of the 55 backend failures, 48 are real-Git deadlines (environment move and
  move recovery, worktree location and aliases, fork, worktree creation,
  diff-statistics scans, the worktree watcher). The fast ones:
  `opencode-host-start.test.ts` and `native-agent-service-activity-batch.test.ts`
  passed alone; `tests/docker-image.test.ts` (2) and
  `tests/staged-input-relay.test.ts` (4) fail alone, and fail identically
  (19/2 and 5/4) in a detached `origin/main` worktree.
- Every backend test file that imports a module the branch changes, plus the
  coordinator, status-wake, node-file and writer-guard suites (25 files, 417
  tests), passed 414 with three real-Git deadlines
  (`commands-environment-worktree-location` twice, `coordinator-service`
  once); `coordinator-service` passed in full on an earlier rerun and fails a
  different Git case at the 5 s mark on each loaded run.
