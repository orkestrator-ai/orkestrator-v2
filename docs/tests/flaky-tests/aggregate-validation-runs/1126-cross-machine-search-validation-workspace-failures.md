# Cross-machine search validation: workspace-group backend and desktop failures

- **ID:** 1126
- **Status:** open
- **Date observed:** 2026-10-27. The host was a macOS arm64 Mac (Darwin 27)
  with 18 logical cores and Bun 1.4.x, with many other worktrees active.
  `uptime` load averages during the owner reruns were 4 to 52.
- **Branch:** `search-projects-environments-d964ef18680e-r1` (PR #1327). It
  changes web search, the protocol node summaries and the backend read model
  that builds them. It does not change environment move, worktree location,
  worktree snapshots or watchers, the command registry, Docker image
  creation, the container entrypoints or the desktop profile tooling.
- **Target:** `origin/main` at `863b578217fca437c37c53372bec7a4f97719079`,
  checked out as a detached worktree with its own `bun install`.

## Runs

Two `mise run test` verifications of the branch failed in the workspace group.
The first listed 44 workspace failures and the second (at `2df7af3b6`) listed 32.
Every failure was in one of the ten owning files below. None of them is a
search, federation or summary test. Each owner was then rerun alone with
`bun test --preload ../../tests/setup-node.ts <file>`, from `apps/backend`
(`apps/desktop` for profile cleanup), on the branch and on `origin/main`.

| Owner | Branch alone | `origin/main` alone | Known case |
| --- | --- | --- | --- |
| `apps/backend/src/core/environment-move.test.ts` | Run 1: 33 pass, 5 fail. Run 2: 30 pass, 8 fail. The failing set differs between runs, and every failure is a 5 s deadline. The three nested-submodule cases and submodule restart recovery fail in both runs. | 34 pass, 4 fail in both the earlier verification and this rerun: the same nested-submodule and restart re-link timeouts. | [0201](../environments-and-containers/0201-move-submodule-fixture-index-lock.md), [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md), [0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md), [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [0695](../environments-and-containers/0695-environment-move-no-tmux-timeout.md), [0866](../environments-and-containers/0866-environment-move-interrupted-rename-timeout.md), [0935](../environments-and-containers/0935-environment-move-cursor-read-failure-timeout.md) |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | Run 1: 2 pass, 2 fail. Run 2: 3 pass, 1 fail. All are 5 s watcher deadlines. | 3 pass, 1 fail (this rerun); 1 pass, 3 fail (earlier verification). | [0180](../environments-and-containers/0180-worktree-tracked-edit-cache-hit.md), [0947](../environments-and-containers/0947-worktree-git-aggregate-timeouts.md), [0957](../environments-and-containers/0957-worktree-index-and-shared-ref-aggregate-timeouts.md) |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | 8 pass, 1 fail: `retargeting an accepted alias …` (5.9 s). | 8 pass, 1 fail: the same case (6.0 s). | none |
| `apps/backend/tests/worktree-watcher.test.ts` | 33 pass, 1 fail: `startWorktreeWatcher > observes a real file write` (2 s). | 33 pass, 1 fail: the same case. | [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md) |
| `apps/backend/tests/commands-integration.test.ts` | 55 pass, 0 fail. | 55 pass, 0 fail (this rerun). In the earlier verification it had 53 pass, 2 fail, with timeouts of 8.5 s and 11.4 s. | [0187](../environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md) recurrence, aggregate only |
| `apps/backend/tests/commands-registry-environments.test.ts` | 68 pass, 0 fail. | 68 pass, 0 fail. | [0188](../environments-and-containers/0188-environment-worktree-aggregate-timeouts.md) recurrence, aggregate only |
| `apps/backend/tests/commands-environment-fork.test.ts` | 24 pass, 0 fail. | 24 pass, 0 fail. | aggregate only |
| `apps/backend/tests/staged-input-relay.test.ts` | 5 pass, 4 fail. | 5 pass, 4 fail, identical assertions. | Host dependence, not a flake: [todo 0321](../../../todo/containers-and-environments/0321-macos-host-dependent-unit-failures.md) |
| `apps/backend/tests/docker-image.test.ts` | 19 pass, 2 fail (`pinned image identity` `--add-host` cases). | 19 pass, 2 fail, identical assertions. | Host dependence: todo 0321 |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | 20 pass, 2 fail (an unexpected `keychainWarning`). | 20 pass, 2 fail, identical assertions. This was also recorded in [1013](1013-interactive-command-main-merge-validation.md). | Host dependence: todo 0321 |

The non-workspace failures from the same runs are recorded separately. The
migration-copy failures are in todo 0320. The Claude qualification deadlines
are in flake [1125](../agent-bridges/1125-claude-offline-cli-qualification-deadlines.md).
The firewall seed/live/cache timeout recurred as
[0192](../environments-and-containers/0192-firewall-bootstrap-shell-timeout.md).

## Assessment

- Three owners pass alone on both trees: command integration, the
  registry's environment lifecycle and environment fork. Their aggregate
  failures are load-sensitive deadlines, recurrences of the cases listed
  above.
- Four timeout owners also fail alone, on the branch and on `origin/main`
  alike: environment move (submodule cases), worktree snapshots, worktree
  location and the worktree watcher. They need real Git, real file events or
  submodule clones within 2 to 5 s deadlines. They are pre-existing on this host
  and are covered by the open cases above. The branch does not touch them.
- Three owners fail deterministically with identical assertions on both
  trees. Each has a demonstrated macOS cause, set out in todo 0321.

No test, deadline or implementation outside the search change was modified.
