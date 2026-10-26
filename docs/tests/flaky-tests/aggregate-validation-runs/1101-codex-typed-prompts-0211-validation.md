# Codex typed prompts (todo 0211) branch validation

- **ID:** 1101
- **Status:** open
- **Date observed:** 2026-10-26
- **Branch:** `prompt-display-bug-7b20be78777d-r1` at `fdcb5345d`, based on
  `origin/main` `ce205ad34`. The branch changes only `bridges/codex-bridge`,
  `e2e/agent-testing` and docs; `apps/backend`, `apps/desktop`, `packages` and
  `tests` are identical to `origin/main`.
- **Command:** `mise run test` (logs `orkestrator-test-run.Y6HDo7` below the
  host temporary directory). Bridges and the Codex protocol lockfile passed
  (bridges 159.8 s); the workspace group and root/support group exited 1.
- **Host:** shared macOS host, 18 cores, load average 23–30 while the suite
  and the reruns below ran (other sessions' suites in parallel).

## Failures and what they are

Every owner rerun used
`mise run test:logged -- --name 0211-<label> -- bun test --cwd <package> <file> --parallel=1`
on the branch. The `origin/main` column is a detached `origin/main` worktree
(`/private/tmp/orkestrator-verify-main-94c2a263`, since removed): its full
`mise run test` (`orkestrator-test-run.PofpIi`) and focused owner runs
(`g52w2w`, `Rz6D9p`, `M8k3bU`, `MHvg8P`, `Ks8uxh`).

| Owning file | Aggregate failures | Owner alone on the branch | `origin/main` | Registry |
| --- | --- | --- | --- | --- |
| `apps/backend/src/core/environment-move.test.ts` | Nested-submodule moves (same disk, copy), failed submodule re-link, restart re-link, `rejected path commit clears the journal…` (both), Cursor read failure retention; five-second deadlines | 32 passed, 6 failed (all five-second deadlines), 110.2 s | Same deadline failures in the full suite and focused runs, `rejected path commit … (true)` included | [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md), [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md), [0935](../environments-and-containers/0935-environment-move-cursor-read-failure-timeout.md) (open). `rejected path commit` has no own case; recorded here. |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | `real Git through the shared owner`: tracked edit, linked-worktree staging, shared ref baseline; five-second deadlines | 2 passed, 2 failed (tracked edit, linked-worktree staging), 11.7 s | Same cases failed in the full suite and focused run | [0180](../environments-and-containers/0180-worktree-tracked-edit-cache-hit.md) (open); the staging and shared-ref cases recorded here. |
| `apps/backend/tests/worktree-watcher.test.ts` | `startWorktreeWatcher > observes a real file write` | passed, 1.0 s | Failed in the full suite and alone | [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md) (open) |
| `apps/backend/tests/commands-integration.test.ts` | `injects workspace artifact git excludes into local worktrees before status reads`, hook deadline at 13.4 s | passed, 28.7 s | Did not fail in the full suite or the focused rerun | [0187](../environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md), reopened as a recurrence |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases with an unexpected `keychainWarning` | 20 passed, 2 failed, deterministic | Same two fail | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) (macOS only) |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper > a missing listing/root completion times out as extract-failed`: extraction status 2, not 0 | 10 passed, 2 failed, deterministic | Same two fail | [1013](1013-interactive-command-main-merge-validation.md) (retained alone there too) |

## Conclusion

None of these files is owned or reached by the 0211 change, and every one
except commands-integration fails the same way on `origin/main`. The
backend failures are five-second deadlines on real-Git fixtures under host
load; they reproduce on `origin/main` under the same load, so they are not
excused by isolation and stay open in their own cases. The profile-cleanup
and migrate-copy failures are deterministic on this macOS host and belong to
their owners. No assertion, deadline, skip or implementation was changed.
