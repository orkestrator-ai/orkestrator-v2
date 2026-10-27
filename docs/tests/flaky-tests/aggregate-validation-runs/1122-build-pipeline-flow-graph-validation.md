# Build pipeline flow graph branch validation

- **ID:** 1122
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `pipeline-flow-graph-d2d5436138ad-r1` at `e0c97e076`, which merges
  `origin/main` `863b57821`. The branch changes `apps/web` (build pipeline,
  flow graph, Multi Review), the build pipeline backend
  (`apps/backend/src/core/build-pipeline*`, `commands-registry-build.ts`),
  `packages/protocol/src/build-pipeline.ts`, `e2e/PipelineFlow*` and docs.
  None of the owners below is in the change.
- **Command:** `mise run test:logged -- --name flow-graph-full-test -- mise run test`,
  exit 1 after 1675.3 s (groups 1672.3 s). Group artifacts
  `orkestrator-test-run.GjFg1g` and the outer log `orkestrator-test-run.AAmDU9`,
  both below the host temporary directory.
- **Host:** shared macOS host, load average 100–205 throughout, with other
  sessions' suites running in parallel.

## Suite counts

| Group | Passed | Skipped | Failed |
| --- | --- | --- | --- |
| backend | 12,019 | 120 | 44 |
| desktop | 1,369 | 16 | 2 |
| web | 9,993 | 10 | 0 |
| protocol | 1,943 | 2 | 0 |
| web-public, toolchain, CLI | 41, 91, 329 | — | 0 |
| root and agent-support | 3,526 | — | 2 |
| claude-bridge | 1,703 | 6 | 3 |
| codex, acp, pi, cursor bridges | 2,441, 695, 651, 801 | 46, 3, 2, 0 | 0 |
| codex protocol lockfile | passed | | |

## Failures and what they are

Every owner was rerun unchanged and alone with
`mise exec -- bun test --preload <root>/tests/setup-node.ts --parallel=1 <file>`
from its package, first on the branch and then on a fresh clone of
`origin/main` `863b57821` under `/tmp/ork-main-compare.*` with its own
`bun install --frozen-lockfile` and no links into the build worktree.

| Owning file | Aggregate failures | Branch alone | `origin/main` alone | Registry |
| --- | --- | --- | --- | --- |
| `apps/backend/src/core/environment-move.test.ts` | 26 move, recovery and rollback cases; 5–40 s deadlines | 34 passed, 4 failed (nested-submodule moves, re-link, restart re-link; Git `could not read IPC response`) | identical 4 failed | [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [0935](../environments-and-containers/0935-environment-move-cursor-read-failure-timeout.md), [1101](1101-codex-typed-prompts-0211-validation.md) |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | `real Git through the shared owner`: tracked edit, linked-worktree staging, shared ref; five-second deadlines | 1 passed, 3 failed | identical 3 failed | [0180](../environments-and-containers/0180-worktree-tracked-edit-cache-hit.md), [0957](../environments-and-containers/0957-worktree-index-and-shared-ref-aggregate-timeouts.md) |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | explicit and configured roots; alias retargeting | 7 passed, 2 failed | identical 2 failed | [1101](1101-codex-typed-prompts-0211-validation.md) |
| `apps/backend/tests/commands-integration.test.ts` | artifact git excludes injection (16.8 s) | 54 passed, 1 failed (git excludes, 5 s) | 53 passed, 2 failed (git excludes and scan caches) | [0187](../environments-and-containers/0187-workspace-artifact-git-excludes-timeout.md), [0162](../environments-and-containers/0162-electron-diff-statistics-aggregate-timeout.md) |
| `apps/backend/tests/worktree-watcher.test.ts` | `observes a real file write`, zero changes | 33 passed, 1 failed | identical 1 failed | [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md) |
| `apps/backend/tests/docker-image.test.ts` | two `pinned image identity` cases expecting `--add-host host.docker.internal:…` | 19 passed, 2 failed, deterministic | identical 2 failed | Recorded here; fails the same on `origin/main` on this host. |
| `apps/backend/tests/staged-input-relay.test.ts` | four `staged input relay` cases (mode 0755 for 0700, expected rejections resolve) | 5 passed, 4 failed, deterministic | identical 4 failed | Recorded here; fails the same on `origin/main` on this host. |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | two `pruneProfiles` cases with an unexpected `keychainWarning` | 20 passed, 2 failed | identical 2 failed | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) |
| `tests/unit/migrate-copy.test.ts` | `a missing listing/root completion times out as extract-failed` | 10 passed, 2 failed | identical 2 failed | [1013](1013-interactive-command-main-merge-validation.md), [1101](1101-codex-typed-prompts-0211-validation.md) |
| `apps/backend/tests/commands-environment-fork.test.ts` | `starts a local fork from the source commit rather than origin/main` (9.5 s) | 24 passed | not needed | aggregate-only, recorded here |
| `apps/backend/tests/commands-registry-environments.test.ts` | three local-worktree lifecycle cases (14–42 s) | 68 passed | not needed | aggregate-only, recorded here |
| `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts` | `Claude CLI execution policy qualification > network`, controller aborted at 15.6 s | 4 passed | not needed | aggregate-only, recorded here |
| `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts` | `coordinator-sandbox-refuses`, `unavailable-hook-reads` (15–17 s) | 9 passed | not needed | aggregate-only, recorded here |

## Conclusion

Every failing owner is outside the change. Nine fail the same way alone on a
clean `origin/main` clone, so they predate this branch. The other four passed
alone, so they are aggregate timing failures under this host load. No
assertion, deadline, skip or implementation was changed.
