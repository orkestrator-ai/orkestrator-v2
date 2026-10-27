# Rich transcripts preview worker pin (todo 0053) branch validation

- **ID:** 1190
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `todo-0053-rich-transcripts-eb2983a9cff6`, based on
  `origin/main` `863b57821`. The branch changes the transcript-artifact
  preview worker preparation (`apps/backend/src/core/transcript-artifacts/`),
  `apps/backend/scripts/build.ts`, `docker/artifact-preview-worker/`, a new
  workflow, `turbo.json`, `tests/unit/ci-workflows.test.ts` and docs. None of
  the owners below is touched or imported by the change.
- **Command:** `mise run test` (logs `orkestrator-test-run.T4DKSJ` below the
  host temporary directory). The Codex protocol lockfile passed; workspace,
  root/support and bridges exited 1 (workspace 2,533 s).
- **Host:** shared macOS host, 18 cores, load average 110–170 during the
  suite and the reruns (several other sessions' suites in parallel).

## Failures and what they are

Owners were rerun alone with `bun test --preload ../../tests/setup-node.ts
<file>` from their package. The `origin/main` column is the same worktree
switched to a detached `origin/main` (`863b57821`) for the rerun, then
switched back.

| Owning file | Aggregate failures | Owner alone on the branch | `origin/main` alone |
| --- | --- | --- | --- |
| `tests/unit/test-suite-ownership.test.ts` | Root tests importing backend sources: the branch's new `tests/unit/preview-worker-pin.test.ts` and an import in `ci-workflows.test.ts`. | A real defect of the branch, fixed: the pin-writer test moved to `apps/backend/src/core/transcript-artifacts/preview-worker-pin-writer.test.ts` and the workflow test uses the label literal. 4 passed after the fix. | Not applicable |
| `apps/backend/src/core/environment-move.test.ts` | 18 move, recovery and failure-boundary cases, deadlines of 6–33 s | Not rerun (unchanged owner) | 33 passed, 5 failed |
| `apps/backend/tests/commands-registry-environments.test.ts` | 4 local-worktree creation cases, 14–34 s | Not rerun | 67 passed, 1 failed |
| `apps/backend/tests/commands-integration.test.ts` | Git-excludes injection, Git scan caches | Not rerun | 53 passed, 2 failed |
| `apps/backend/src/core/diff-stats-tracking.test.ts` | 7 retarget and candidate cases, 15–35 s | 18 passed, 3 failed | 20 passed, 1 failed |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | 2 cases | 0 passed, 1 failed (file aborted) | 1 passed, 3 failed |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | Explicit and configured roots; alias retarget | 7 passed, 2 failed | 7 passed, 2 failed |
| `apps/backend/tests/docker-image.test.ts` | `pinned image identity`: restricted runtime on a gateway image; rootless host address | 19 passed, 2 failed | 19 passed, 2 failed |
| `apps/backend/tests/staged-input-relay.test.ts` | Four `staged input relay` cases, under 1 s each | 5 passed, 4 failed | 5 passed, 4 failed |
| `apps/backend/tests/worktree-watcher.test.ts` | `startWorktreeWatcher > observes a real file write` | 33 passed, 1 failed | 33 passed, 1 failed |
| `apps/backend/src/core/control-mcp-operator-tools.test.ts` | `launch_environment returns the created environment…`, 29.8 s | 7 passed | Not rerun |
| `apps/backend/tests/commands-environment-fork.test.ts` | `starts a local fork from the source commit…`, 9.2 s | 24 passed | Not rerun |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases | Not rerun | 20 passed, 2 failed ([1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md)) |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper > a missing listing/root completion…`: extraction status 2, not 0 | Not rerun | 10 passed, 2 failed |
| `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts` | `unavailable-hook-refuses-abbreviation`, 15.4 s | 9 passed | 9 passed |
| `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts` | `escape`, 17.0 s | 4 passed | 4 passed |

## Conclusion

Apart from the ownership test, which caught a real defect of the branch (now
fixed), no failing owner is reached by the change. The Claude bridge
qualifications, operator tools and environment fork owners pass alone, so
their failures here are aggregate-only observations at load 110–170.
`docker-image`, `staged-input-relay`, `commands-environment-worktree-location`,
`worktree-watcher`, `worktree-snapshots-git`, `diff-stats-tracking`,
`environment-move`, the two command suites, profile-cleanup and migrate-copy
fail alone on unchanged `origin/main` too, so they belong to their owners
(see also [1101](1101-codex-typed-prompts-0211-validation.md)). `docker-image`
and `staged-input-relay` fail in well under a second, which is not a load
deadline; they were not failing in 1101 and may come from the rootless
runtime change merged just before (`1aabf049e`, todo 0109). No assertion,
deadline, skip or implementation outside the branch's own files was changed.
