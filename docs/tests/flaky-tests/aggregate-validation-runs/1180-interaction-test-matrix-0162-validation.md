# Interaction test matrix (todo 0162) branch validation

- **ID:** 1180
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `todo-0162-interaction-test-matrix-gaps-aad7b1f9a6f1` at
  `619dd44e1`, based on `origin/main` `863b57821`. Outside tests and docs the
  branch changes only `apps/backend/src/core/http-bridge-interactions.ts`,
  `opencode-provider.ts` and `opencode-session-close.ts`; its bridge changes
  are test files only.
- **Command:** `mise run test`, exit 1 after 1282.4 s (artifacts
  `orkestrator-test-run.sX3cWH` below the host temporary directory). The
  Codex protocol lockfile passed; workspace, root/support and bridges failed.
- **Host:** shared macOS host, 18 cores, load average 95–176 during the
  suite and the reruns (other sessions' builds in parallel); the bridges
  group waited about 380 s for worker slots.

## Counts

Backend 11,445 passed, 106 skipped, 54 failed; desktop 1,369 passed, 16
skipped, 2 failed; root/support 3,525 passed, 3 failed; Claude bridge 1,702
passed, 8 failed. Web, web-public, protocol, toolchain and the Codex, Pi,
Cursor and ACP bridges passed.

## Owner reruns

Each owner was rerun alone with `bun test ./<file>` from its package. The
base column swapped the branch's three backend source files back to
`origin/main` (`git checkout origin/main -- …`, restored afterwards), so the
backend code was identical to the base.

| Owning file | Aggregate failures | Alone on the branch | Base (`origin/main` sources) |
| --- | --- | --- | --- |
| `apps/backend/src/core/environment-move.test.ts` | Moves, submodule re-links, copy rollback and recovery cases; `git … cannot change to '/private/tmp/ork-env-move-…'` | 5 passed, 33 failed | Not rerun; same failures recorded on the base in [1101](1101-codex-typed-prompts-0211-validation.md) |
| `apps/backend/src/core/worktree-snapshots-git.test.ts` | Real-Git snapshot cases | 0 passed, 2 failed | 1 passed, 3 failed |
| `apps/backend/tests/staged-input-relay.test.ts` | Four relay cases (mode `448` expected) | 5 passed, 4 failed | 5 passed, 4 failed |
| `apps/backend/tests/docker-image.test.ts` | Two `--add-host host.docker.internal:…` expectations | 19 passed, 2 failed | 19 passed, 2 failed |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | Two cases | 7 passed, 2 failed | 8 passed, 1 failed |
| `apps/backend/src/core/public-api/public-api-project-init-cascade.test.ts` | `project.init` local repository | 10 passed, 1 failed | 11 passed |
| `apps/backend/src/core/diff-stats-tracking.test.ts` | One case | 20 passed, 1 failed | — |
| `apps/backend/tests/commands-environment-fork.test.ts` | Local fork from the source commit | 23 passed, 1 failed | — |
| `apps/backend/tests/commands-integration.test.ts` | Artifact git excludes, scan caches | 53 passed, 2 failed | — |
| `apps/backend/tests/commands-registry-environments.test.ts` | Remote-base worktree creation | 67 passed, 1 failed | — |
| `apps/backend/tests/worktree-watcher.test.ts` | `observes a real file write` | 33 passed, 1 failed | — |
| `apps/backend/src/core/change-tracking/acceptance-sharing.test.ts` | One case | 15 passed | — |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases | 20 passed, 2 failed | Deterministic on this host: [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) |
| `tests/unit/migrate-copy.test.ts` | Two `verified copy helper` timeouts | 10 passed, 2 failed | Deterministic on this host: [1013](1013-interactive-command-main-merge-validation.md) |
| `tests/unit/hooks/useEnvironmentListSync.test.ts` | One case | 18 passed | — |
| `scripts/opencode-live-compatibility-probe.test.ts` | `a deadline during setup stops the abandoned probe from spawning a server` | 31 passed | — |
| `apps/web/src/components/build-pipeline/BuildChatTab.test.tsx` | Renderer-error cases | 161 passed | — |
| `apps/web/src/hooks/useManualSessionRefresh.test.tsx` | One case | 6 passed | — |
| `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts` | Six sandbox qualification cases | First run 3 passed, 6 failed; second run 9 passed (52.0 s) | Source identical to `origin/main` |
| `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts` | `escape`, `network` (`controller.signal.aborted` true at the deadline) | 4 passed | Source identical to `origin/main` |

## Conclusion

No failing owner imports the changed interaction or OpenCode abort code paths
in a way its failure touches: the failures are real-Git, filesystem-mode,
Docker argument and live-CLI deadline cases. The ones rerun against the base
sources fail the same way there; the rest pass alone or are recorded as
deterministic on this host in their own cases. The two Claude live
conformance owners and the root, web and script owners failed only in the
aggregate under a load average above 100. No assertion, deadline, skip or
implementation was changed.
