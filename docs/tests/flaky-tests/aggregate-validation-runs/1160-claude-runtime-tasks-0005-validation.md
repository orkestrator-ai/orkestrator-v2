# Claude runtime task ownership (todo 0005) branch validation

- **ID:** 1160
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `todo-0005-mid-turn-steer-and-interrupt-78c91fda395a` at
  `dd187e995`, based on `origin/main` `863b57821`. The branch changes only
  `bridges/claude-bridge` and docs; `apps`, `packages`, `scripts`, `tests` and
  `docker` are identical to `origin/main`.
- **Command:** `mise run test` (output kept in `/tmp/ork-0005-run/full-test.log`
  during the run). The Codex protocol lockfile passed; the root/support,
  bridges and workspace groups exited 1. The workspace group waited 1,514 s
  for worker slots and finished at 2,924 s.
- **Host:** shared macOS host, 18 cores, load average 142–176 at the end of
  the run (other sessions' builds and suites in parallel).

## Counts

Web 9,941 passed; CLI 329 passed; backend 11,457 passed, 106 skipped, 37
failed; root/support 3,526 passed, 2 failed; Pi, Codex, ACP and Cursor bridges
passed; Claude bridge 1,710 passed, 6 skipped, 5 failed; desktop 2 failed.

## Failures and what they are

Counts are distinct test names; bun prints each failure twice in the log.

Owners were rerun alone on the branch with
`bun test --preload ../../tests/setup-node.ts <file>` (`--cwd` of the owning
package; the root file without a preload). The `origin/main` column is a
detached worktree of `863b57821` under the host temporary directory, with its
`node_modules` linked to this checkout's (lockfiles identical), removed
afterwards.

| Owning file | Aggregate failures | Owner alone on the branch | `origin/main` alone | Registry |
| --- | --- | --- | --- | --- |
| `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts` | `escape`, `network`, `unavailable`: deadlines at 16–17 s while the real CLI starts | 4 passed | not needed | recorded here |
| `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts` | `default-sandbox-writes`, `coordinator-sandbox-refuses`: deadlines at 16–17 s | 9 passed | not needed | recorded here |
| `apps/backend/src/core/change-tracking/acceptance-sharing.test.ts` | one case | 15 passed | not needed | recorded here |
| `apps/backend/src/core/public-api/public-api-project-init-cascade.test.ts` | `project.init > initializes a local repository…` (30.9 s) | 11 passed | not needed | recorded here |
| `apps/backend/src/core/public-api/public-api-schedules.test.ts` | environment launch resolving the base branch (64.9 s) | 10 passed | not needed | recorded here |
| `apps/backend/tests/standalone-ready.test.ts` | `escalates SIGTERM to SIGKILL after the grace period` | 6 passed | not needed | [0491](../backend-services-and-tooling/0491-standalone-ready-sigkill-escalation-aggregate.md) (open) |
| `apps/backend/tests/worktree-watcher.test.ts` | `observes a real file write` | 34 passed | not needed | [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md) (open) |
| `apps/backend/tests/commands-registry-environments.test.ts` | two lifecycle cases (7 s each) | 67 passed, 1 failed | 68 passed | comes and goes on identical files, as in [1101](1101-codex-typed-prompts-0211-validation.md) |
| `apps/backend/src/core/environment-move.test.ts` | 20 move and recovery cases, five-second deadlines | 33 passed, 5 failed | 34 passed, 4 failed | [1101](1101-codex-typed-prompts-0211-validation.md) and its linked cases |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | two `real Git through the shared owner` cases (5 s) | 1 passed, 3 failed | 1 passed, 3 failed | [0180](../environments-and-containers/0180-worktree-tracked-edit-cache-hit.md), [1101](1101-codex-typed-prompts-0211-validation.md) |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | three worktree-root cases (20–23 s) | 8 passed, 1 failed | 8 passed, 1 failed | [1101](1101-codex-typed-prompts-0211-validation.md) |
| `apps/backend/tests/docker-image.test.ts` | two `pinned image identity` cases | 19 passed, 2 failed | 19 passed, 2 failed | recorded here; fails on the base too |
| `apps/backend/tests/staged-input-relay.test.ts` | four relay cases | 5 passed, 4 failed | 5 passed, 4 failed | recorded here; fails on the base too |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | two `pruneProfiles` cases | 20 passed, 2 failed | 20 passed, 2 failed | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) |
| `tests/unit/migrate-copy.test.ts` | two `verified copy helper` cases: extraction status 2, not 0 | 10 passed, 2 failed | 10 passed, 2 failed | [1013](1013-interactive-command-main-merge-validation.md) |

## Conclusion

The two Claude live-CLI qualification files are the only failures in a
directory the branch changes, and they pass alone: their 16–17 s deadlines
cover a real CLI start, which the host's load (about ten times its core count)
stretched past them. The change does not reach their code path (execution
policy and sandbox launch options). Every other owner is outside the change;
those that still fail alone fail the same way on `origin/main`. No assertion,
deadline, skip or implementation was changed.
