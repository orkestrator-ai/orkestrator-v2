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

## Live control metadata review follow-up (2026-10-27)

At `f9eb28571`, the local-settings catalogue regression, warm-CLI authentication
failure regression, runtime eligibility/order/timeout cases and real SDK
initialization contract passed together: 43 tests, zero failures. The final
focused command was:

```sh
mise run test:logged -- --name final-live-control -- bun test ./bridges/claude-bridge/src/services/live-claude-control.test.ts ./bridges/claude-bridge/src/services/claude-sign-in.test.ts ./bridges/claude-bridge/src/services/live-claude-control.live.test.ts --parallel=2 --only-failures
```

`mise run test:logged -- --name check -- mise run check` passed formatting,
lint (existing warnings) and all typechecks. The full non-iOS command was
`mise run test:logged -- --name default-suite -- mise run test`. Its workspace
group received four worker slots after 162.1 seconds; backend and web used two
Bun workers each. The bridge group waited 1,192.9 seconds for two slots.
Observed host load at 03:59 was 89.78/161.13/176.23 on 18 cores.

The root group had 3,526 passes and two failures, both the existing
`migrate-copy` extraction-status assertions. The workspace group had backend
11,476 passes, 106 skips, 18 failures and eight between-test errors; desktop
1,368 passes, 16 skips and three failures. Web, web-public, CLI, protocol and
toolchain tests passed. The separate Codex protocol lockfile check passed.

The new credible flake is
`apps/desktop/tests/artifact-host-manager.test.ts`:
`artifact host lifecycle > a hung artifact frame after readiness is reported unresponsive and closing terminates it`.
The aggregate received no `unresponsive` event after its 80 ms wait
(157.79 ms test duration). The complete unchanged owner passed alone in 1.4 s
with `mise run test:logged -- --name isolated-artifact-host -- bun test --cwd apps/desktop ./tests/artifact-host-manager.test.ts --preload ../../tests/setup-node.ts --parallel=1 --only-failures`.
The passing raw log was removed by the logged runner. Delayed watchdog/event
scheduling under host load is a hypothesis, not a demonstrated cause.

Other unchanged owners were rerun with the same logged-command pattern,
`--parallel=1`, the package cwd and Node preload (no preload/cwd for the root
owner):

| Owner | Isolated result | Duration |
| --- | --- | --- |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | 20 pass, 2 fail; the same unexpected `keychainWarning` assertions as 1100 | 1.9 s |
| `apps/backend/src/core/environment-move.test.ts` | 15 pass, 23 fail, 21 errors; deadlines and teardown errors, so this recurrence is not newly classified as flaky | 236.3 s |
| `apps/backend/tests/commands-registry-environments.test.ts` | 66 pass, 2 fail, 1 error; fetched-base deadline plus suffix-case hook deadline | 65.8 s |
| `apps/backend/tests/commands-integration.test.ts` | 54 pass, 1 fail, 1 error; scan-cache deadline; the original artifact-excludes case passed | 53.2 s |
| `apps/backend/src/core/diff-stats-tracking.test.ts` | 16 pass, 5 fail, 4 errors; deadlines and missing fixture directories after teardown | 88.2 s |
| `apps/backend/tests/worktree-watcher.test.ts` | 32 pass, 2 fail; real-file observation and linked-index hints | 9.3 s |
| `apps/backend/tests/commands-environment-fork.test.ts` | 23 pass, 1 fail; source-commit fork exceeded five seconds (8,349.32 ms) | 20.4 s |
| `tests/unit/migrate-copy.test.ts` | 10 pass, 2 fail; extraction status `2` rather than `0`, as in the earlier run | 3.1 s |

The aggregate also repeated the two `worktree-snapshots-git`, two
`docker-image` and four `staged-input-relay` failures documented above; these
owners were not rerun in this follow-up. No unrelated assertion or deadline
was changed. Browser, Electron, Docker and iOS scenario suites are outside the
scope of the control metadata fixes.

All bridge packages ultimately passed, including Claude: 1,734 passes, six
skips, zero failures (189.14 s). The full command exited 1 after 1,577.3 s,
solely from the workspace and root groups described above. Compressed group
evidence is in the temporary `orkestrator-test-run.CX0Bro` artifact directory;
the outer logged command retained `orkestrator-test-run.kk9C3O`. The updated
registry owner and final repository formatting check also passed.
