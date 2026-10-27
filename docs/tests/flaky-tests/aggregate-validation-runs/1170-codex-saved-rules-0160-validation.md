# Codex saved rules (todo 0160) branch validation

- **ID:** 1170
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `todo-0160-codex-saved-rules-94d86804329e` at `0d325203a`,
  based on `origin/main` `863b57821`. The branch changes
  `bridges/codex-bridge` (approvals and their tests),
  `apps/backend/src/core/http-bridge-interactions.ts` and its test, one e2e
  comment and docs. None of the files below imports the changed code.
- **Command:** `mise run test` (logs `orkestrator-test-run.dNockB` below the
  host temporary directory). The Codex protocol lockfile passed; the
  workspace, root/support and bridges groups exited 1.
- **Counts:** backend 11,437 passed, 106 skipped, 55 failed; desktop 1,369
  passed, 16 skipped, 2 failed; root/support 3,526 passed, 2 failed;
  claude-bridge 1,696 passed, 6 skipped, 10 failed. Web, web-public, CLI,
  protocol, toolchain and the codex, acp, cursor and pi bridges passed
  (codex-bridge 2,441 passed, 48 skipped).
- **Host:** shared macOS host, 18 cores, load average about 150 while the
  suite and the reruns ran (other sessions' builds in parallel). The
  worktree is on an external APFS volume with **Owners: Disabled**
  (`diskutil info /Volumes/Lexar`), so files report no real owner or mode
  bits there.

## Failures and what they are

Owners were rerun unchanged with
`mise run test:logged -- --name <label> -- bun test --cwd <package> ./<file> --parallel=1`
(root files without `--cwd`). The base column reran the same files in this
worktree switched to a detached `863b57821` (same `node_modules`; the branch
changes no dependency), then switched back.

| Owning file | Aggregate failures | Owner alone on the branch | Base `863b57821` alone | Registry |
| --- | --- | --- | --- | --- |
| `apps/backend/src/core/environment-move.test.ts` | 29 `move_environment`, `interrupted move recovery` and `move failure boundaries` cases | 14 failed, 614.4 s | Failed, 191.2 s | 1101, 0692, 0790 (open) |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | Two hook timeouts (`(unnamed)`) | 0 passed, 2 failed | Failed | 0957, 0180 (open) |
| `apps/backend/tests/worktree-watcher.test.ts` | `startWorktreeWatcher > observes a real file write` | Failed (no change seen) | Failed | 0091 (open) |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | Two location cases | 1 failed (`retargeting an accepted alias…`) | Failed | 1101 |
| `apps/backend/tests/docker-image.test.ts` | `pinned image identity > a restricted runtime on a gateway image joins its egress gateway…`, `… a rootless daemon names the host address…` | 2 failed, deterministic | Failed | Recorded here |
| `apps/backend/tests/staged-input-relay.test.ts` | Four `staged input relay` cases (owner-only copy mode, relay removal) | 4 failed, deterministic | Failed | Recorded here; the mode checks cannot hold on an owners-disabled volume |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases | 2 failed | Failed | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper > a missing listing/root completion times out as extract-failed` | 2 failed | Failed | 1101 |
| `apps/backend/tests/commands-integration.test.ts` | Git excludes injection (5.0 s), `backend-owned diff statistics` scan caches (33.3 s) and config-retarget counts | Failed twice (git excludes; scan caches) | Failed twice of three (git excludes) | [0187](../environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md) (open) |
| `apps/backend/tests/commands-registry-environments.test.ts` | `creates local worktrees from the fetched remote base branch`, `queues a local stop behind a background start` | Failed twice | Passed twice, failed once (fetched remote base branch) | Recorded here |
| `apps/backend/src/core/diff-stats-tracking.test.ts` | Seven retarget and candidate cases, 13–21 s | Failed once, then passed (40.8 s) | Passed | 0962, 1101 |
| `apps/backend/src/core/change-tracking/acceptance-sharing.test.ts` | `V09: environments aliasing one checkout share one watcher and scan…` (28.4 s) | Failed once, then passed | Passed | Recorded here |
| `apps/backend/src/core/public-api/public-api-project-init-cascade.test.ts` | `project.init > initializes a local repository with one commit and no remote…` (14.2 s) | Failed once, then passed | Passed | Recorded here |
| `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts` | Eight qualification cases at 17 s | Passed, 41.6 s | Not needed | Recorded here |
| `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts` | `escape`, `unavailable` at 17 s | Passed, 9.6 s | Not needed | Recorded here |

## Conclusion

No failing file is owned or reached by the 0160 change. Eight owners fail
the same way on the base when run alone: real-Git and file-watch fixtures at
their deadlines under this load (environment move, worktree snapshots,
worktree watcher, worktree location), and the docker-image,
staged-input-relay, profile-cleanup and migrate-copy cases, which are
deterministic on this host. The remaining owners pass alone on the branch
(diff-stats, acceptance-sharing, project-init, the two Claude live
conformance files) or fail and pass on identical files on both the branch
and the base (commands-integration, commands-registry-environments): timing
under host load, not the change. No assertion, deadline, skip or
implementation was changed.
