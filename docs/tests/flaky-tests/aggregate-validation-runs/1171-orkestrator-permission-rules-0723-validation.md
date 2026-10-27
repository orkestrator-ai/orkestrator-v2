# Orkestrator permission rules (todo 0723) branch validation

- **ID:** 1171
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `feature-clarification-18cad6211bd8-r1`, uncommitted on
  `727f91c8f`. The change adds `packages/protocol/src/permission-rules.ts`,
  `apps/backend/src/core/permission-rules/`, rule eligibility in the Codex,
  Claude, Pi and ACP bridges, web components, CLI commands and docs. None of
  the files below imports the changed code.
- **Command:** `mise run test` (logs `orkestrator-test-run.TgL2Ow` below the
  host temporary directory). The Codex protocol lockfile passed; the
  workspace, root/support and bridges groups exited 1.
- **Host:** the shared macOS host and owners-disabled external volume of
  [1170](1170-codex-saved-rules-0160-validation.md), with another
  worktree's `mise run test` running at the same time.

## Failures and what they are

Owners were rerun alone on the branch with `bun test <file>`. The base column
reran the same files in a temporary detached worktree at `727f91c8f` that
shares this worktree's `node_modules` (the change adds no dependency); the
worktree was removed afterwards.

| Owning file | Aggregate failures | Owner alone on the branch | Base `727f91c8f` alone | Registry |
| --- | --- | --- | --- | --- |
| `bridges/claude-bridge/src/services/session-manager-lifecycle.test.ts`, `session-manager-persistence.test.ts` | `a complete journal proves an unclaimed id absent…`, `reconcilePersistedSessions > restores journal completeness…` | 9 failed (`ReferenceError: sessionManagerTestHome is not defined`: both files use the harness export without importing it) | 9 failed, the same | Recorded here; a test-file defect, not a flake |
| `apps/backend/src/core/environment-move.test.ts`, `worktree-snapshots-git.test.ts`, `apps/backend/tests/docker-image.test.ts`, `staged-input-relay.test.ts`, `commands-registry-environments.test.ts` | Move, real-Git, pinned-image, staged-relay mode and fetched-base cases | 15 failed | 18 failed | 1170, 1101, 0957 |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases | 2 failed | 2 failed | [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) |
| `tests/unit/migrate-copy.test.ts` | `verified copy helper > a missing listing/root completion times out as extract-failed` | 2 failed | 2 failed | 1101, 1170 |
| `bridges/cursor-bridge/src/http.test.ts` | `authentication > reports an authenticated credential as ready` | Passed (77) | Not needed | [0182](../agent-bridges/0182-cursor-auth-readiness-aggregate-timeout.md) |
| `apps/backend/src/core/diff-stats-tracking.test.ts` | `a worker that takes in newer target history is retargeted…` | Passed | Not needed | [1110](../coordinator-and-multi-review/1110-diff-stats-reset-baseline-deadline.md) |
| `apps/backend/tests/worktree-watcher.test.ts` | `startWorktreeWatcher > observes a real file write` | Passed | Not needed | [0091](../environments-and-containers/0091-startworktreewatcher-observes-a-real-file-write.md) |
| `tests/unit/test-diagnostic-bounds.test.ts` | `never passes a DOM-producing query result directly to toBeNull` | Caused by this branch's new web tests; fixed in the same change, then passed | Not needed | Not a flake |

## Conclusion

No failing file is owned or reached by the 0723 change apart from the
diagnostics rule, which the branch's own tests broke and now pass. The
Claude session-manager, backend git/Docker/relay, profile-cleanup and
migrate-copy owners fail identically on the base. The Cursor, diff-stats and
worktree-watcher owners pass alone and match their existing cases.
