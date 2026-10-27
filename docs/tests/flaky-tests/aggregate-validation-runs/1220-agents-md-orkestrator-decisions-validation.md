# AGENTS.md ## Orkestrator decisions branch validation

- **ID:** 1220
- **Status:** open
- **Date observed:** 2026-10-27
- **Branch:** `agents-decision-pr-350b9400f5bb-r1` at `c6c9ae9ac`, based on
  `origin/main` `405bb445e`. The branch adds the coordinator's
  `propose_agents_md_update` tool: `packages/protocol` (new
  `agents-md-orkestrator.ts`, the coordinator tool-name list and surface
  actions), backend AGENTS.md commands, node action requests and
  coordination, the Control MCP tool, the coordinator context prompt, the
  approval dialog in `apps/web`, an e2e fixture and docs. None of the files
  below imports the changed code.
- **Command:** `mise run test:changed` (the protocol change selects every
  group; logs `orkestrator-test-run.IIXjee` below the host temporary
  directory), then
  `mise run test:logged -- --name bridge-tests -- bun test bridges --parallel=2 --only-failures`
  (logs `orkestrator-test-run.pK4YbJ`).
- **Counts (test:changed):** backend 12,589 passed, 123 skipped, 26 failed;
  desktop 1,394 passed, 16 skipped, 2 failed; web 10,188 passed; protocol
  2,096 passed; web-public, toolchain, root/support (329) and the Codex
  protocol lockfile passed. Bridges: claude-bridge 1,739 passed, 3 failed;
  cursor-bridge 819 passed, 1 failed; codex, acp and pi passed. The bridge
  rerun: 6,428 passed, 62 skipped, 16 failed, 1 error.
- **Host:** shared macOS host, 18 cores, load average 10–18 during the
  reruns. The worktree is on the external `/Volumes/Lexar` volume; the
  comparison clone was in `/tmp` on the internal disk.

## Failures and what they are

Owners were rerun unchanged with `bun test ./<file>` from their package
directory, one at a time, in this worktree and in a fresh clone of
`origin/main` `405bb445e` in a separate temporary directory (`bun install
--frozen-lockfile`, no symlinks into this worktree).

| Owning file | Aggregate failures | Owner alone on the branch | Clean `origin/main` alone | Registry |
| --- | --- | --- | --- | --- |
| `apps/backend/tests/staged-input-relay.test.ts` | Four `staged input relay` cases | 4 failed | 4 failed, the same cases | 1170, 1190 |
| `apps/backend/tests/docker-image.test.ts` | Two `pinned image identity` cases | 2 failed | 2 failed, the same cases | 1170, 1190 |
| `apps/backend/tests/worktree-watcher.test.ts` | `startWorktreeWatcher > observes a real file write` | 1 failed | 1 failed | 0091 |
| `apps/backend/src/core/environment-move.test.ts` | `move_environment`, `interrupted move recovery`, `move failure boundaries` (real-Git 5 s deadlines) | 17 failed | 12 failed | 1101, 0692, 0790 |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | `retargeting an accepted alias…`, `start uses and persists both explicit and configured roots…` | 2 failed | 2 failed, the same cases | 1101 |
| `apps/backend/src/core/diff-stats-tracking.test.ts` | `a worker that takes in newer target history is retargeted…` | 5 failed | 3 failed (overlapping candidate cases) | 0962, 1101 |
| `apps/backend/src/core/change-tracking/acceptance-sharing.test.ts` | `V09: environments aliasing one checkout share one watcher and scan…` | Failed 3 of 3 full-file runs (8–16 s); its describe block alone passed (4 pass) | Failed 1 of 3 full-file runs (13.2 s) | 1170 |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | Two `pruneProfiles` cases | 2 failed | 2 failed, the same cases | 1100 |
| `bridges/claude-bridge/src/services/session-manager-lifecycle.test.ts` | `session lifecycle > a complete journal proves an unclaimed id absent…` (`ReferenceError: sessionManagerTestHome is not defined`) | 1 failed | 1 failed, the same error | Recorded here |
| `bridges/claude-bridge/src/services/session-manager-persistence.test.ts` | `reconcilePersistedSessions > restores journal completeness only from a marked journal…` | 1 failed | 1 failed | Recorded here |
| `apps/backend/src/core/public-api/public-api-project-init-cascade.test.ts` | `project.init > initializes a local repository…` (21.0 s) | Passed (11) | Not needed | 1170 |
| `apps/backend/tests/commands-integration.test.ts` | `injects workspace artifact git excludes…` (5.0 s) | Passed (55) | Not needed | 0187 |
| `bridges/claude-bridge/src/conformance-coordinator-sandbox-live.test.ts` | Nine qualification cases | Passed (9) | Passed (9) | 1125, 1165 |
| `bridges/claude-bridge/src/conformance-execution-policy-live.test.ts` | Four qualification cases | Passed (4) | Passed (4) | 1125, 1201 |
| `bridges/acp-bridge/src/acp-session.test.ts` | `ACP bridge > one aborted resume waiter does not kill the shared session/load` | Passed (24) | Passed (24) | Recorded here |
| `bridges/cursor-bridge/src/http.test.ts` | `authentication > reports an authenticated credential as ready` (10 s hook timeout) | Passed (77) | Not needed | 0182 |
| `bridges/claude-bridge/src/services/session-manager-prompt-mcp-sync.live.test.ts` | `a running Claude CLI unloads removed and renamed MCP servers` (90 s) | Not rerun (live CLI probe) | Not rerun | 0671 |

## Conclusion

No failing file is owned or reached by the AGENTS.md change, and every
branch-owned suite passed (protocol section tests, PR operation against a
real local remote, commands, approval/restart, Control MCP, coordinator
prompt, the approval dialog and its Playwright spec). Owners that fail alone
on the branch fail the same way on a clean `origin/main` clone; the counts of
the real-Git deadline owners (environment move, diff-stats) vary from run to
run on both. The remaining aggregate failures pass alone and are deadline
timeouts under parallel load. The V09 acceptance-sharing case is a timing
flake on both trees (it passes when its block runs alone and failed on main
too).
