# Flow graph node faces and live pipeline tokens branch validation

- **ID:** 1215
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `flow-graph-node-faces-tokens-6a89c0a23e19` at `4814836ca`, on
  `origin/main` `405bb445e`. The branch changes the build pipeline supervisor
  and review fan-out (`apps/backend/src/core/build-pipeline-*`), the shared
  flow graph, the pipeline and Multi Review graphs in `apps/web`, the
  `PipelineSession.tokenCount` doc comment, two browser specs and docs. None
  of the owners below is in the change.
- **Command:** `mise run test`, exit 1; groups finished after 751.5 s.
- **Host:** shared macOS host, worktree on an APFS volume mounted `noowners`,
  other sessions' suites running beside it.

## Suite counts

| Group | Passed | Skipped | Failed |
| --- | --- | --- | --- |
| web | 10,193 | 10 | 0 |
| backend | 12,580 | 123 | 23 |
| desktop | — | — | 2 |
| root and agent-support | 3,532 | — | 3 |
| claude-bridge | 1,740 | 6 | 2 |
| codex, acp, cursor, pi bridges | 2,495, 709, 820, 678 | 51, 3, 0, 2 | 0 |
| codex protocol lockfile | passed | | |

## Failures and what they are

The same `mise run test` was run on a fresh clone of `origin/main`
`405bb445e` under `/Volumes/Lexar/orkestrator-baseline.*` (same volume, own
`bun install --frozen-lockfile`, no links into the worktree; deleted
afterwards). It also exited 1: backend 19, desktop 2, root 2, claude-bridge 2.

| Owning file | Branch aggregate | `origin/main` aggregate | Alone | Registry |
| --- | --- | --- | --- | --- |
| `tests/unit/test-diagnostic-bounds.test.ts` | `never passes a DOM-producing query result directly to toBeNull` | passed | **Branch defect**: two new `toBeNull` absence checks in `MultiReviewFlowGraph.test.tsx`. Fixed in `84a6eb160`; 16 passed alone. | — |
| `apps/backend/src/core/environment-move.test.ts` | 12 move, recovery and rollback cases | 5 | Alone with `--parallel=1`: branch 28 passed, 10 failed; `origin/main` 30 passed, 8 failed, with an overlapping but different set each run | [0621](../environments-and-containers/0621-environment-move-nested-submodules-aggregate-timeout.md), [0291](../environments-and-containers/0291-environment-move-submodule-aggregate-timeout.md) |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | tracked edit, rejected path commit | — | branch 4 passed; `origin/main` 3 passed, 1 failed (shared ref) | [0180](../environments-and-containers/0180-worktree-tracked-edit-cache-hit.md), [0957](../environments-and-containers/0957-worktree-index-and-shared-ref-aggregate-timeouts.md) |
| `apps/backend/src/core/change-tracking/acceptance-sharing.test.ts` | V09 alias watcher and scan; queued-write candidate | queued-write candidate | branch failed V09 once alone, then 15 passed twice; `origin/main` 15 passed three times | [1170](1170-codex-saved-rules-0160-validation.md) |
| `apps/backend/tests/commands-environment-fork.test.ts` | `starts a local fork from the source commit` | passed | branch failed once, then 24 passed twice; `origin/main` 24, 24, then 23 passed and 1 failed | [1122](1122-build-pipeline-flow-graph-validation.md) |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | configured roots; alias retargeting | identical | timing failures on both | [1101](1101-codex-typed-prompts-0211-validation.md) |
| `apps/backend/tests/staged-input-relay.test.ts` | 4 owner-only relay cases | identical 4 | identical alone on both, consistent with the `noowners` volume | [1175](1175-codex-default-mode-question-0161-validation.md) |
| `apps/backend/tests/docker-image.test.ts` | 2 `pinned image identity` cases | identical 2 | identical alone on both | [1122](1122-build-pipeline-flow-graph-validation.md) |
| `apps/backend/tests/worktree-watcher.test.ts` | `observes a real file write` | identical | identical alone on both | [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md) |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | 2 `pruneProfiles` cases | identical 2 | identical alone on both | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) |
| `tests/unit/migrate-copy.test.ts` | 2 `times out as extract-failed` cases | identical 2 | identical alone on both | [1101](1101-codex-typed-prompts-0211-validation.md) |
| `bridges/claude-bridge/src/services/session-manager-{lifecycle,persistence}.test.ts` | journal completeness, 2 cases | identical 2 | the two files together fail the same 9 cases on both | [1171](1171-orkestrator-permission-rules-0723-validation.md) |
| `apps/backend/src/core/native-agent-service-reconciliation.test.ts`, `apps/backend/src/core/public-api/public-api-project-init-cascade.test.ts` | passed | shared observations; `project.init` | not rerun | [1175](1175-codex-default-mode-question-0161-validation.md) |

## Conclusion

One failure was the branch's own and is fixed. Every other failing owner is
outside the change, and each either fails the same way on the clean
`origin/main` clone or fails and passes on identical files on both trees
across runs. No assertion, deadline, skip or implementation in an unrelated
owner was changed.
