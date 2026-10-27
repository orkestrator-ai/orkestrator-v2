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


## Review-fix validation — 2026-10-27

Working tree based on `60c6655b1`, on the same branch and external-volume
checkout. The fixes cover startup recovery, private temporary files and hooks,
preview gating, Markdown boundaries and sanitization, recovered branch integrity,
closed PRs, and routed outcomes/error codes. No failing baseline owner below was
edited or given a different deadline.

### Passing checks on the final relevant files

All commands used `mise run test:logged -- --name <label> -- <command>`.

| Label | Command after the logging wrapper | Result |
| --- | --- | --- |
| `agents-md-check-complete` | `mise run check` | Format, lint and typecheck passed, 3.5 s |
| `agents-md-pr-final` | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agents-md-pr.test.ts --parallel=1 --only-failures` | 17 passed, 9.3 s; real local Git, fake gh; includes reference-transaction hooks, private-directory permissions and hostile body symlinks |
| `agents-md-final-nodes` | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/nodes --parallel=2 --only-failures` | Complete node directory passed, 7.9 s |
| `agents-md-recovery-final` | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/nodes/node-coordination-agents-md.test.ts ./src/core/index-agents-md-recovery.test.ts --parallel=1 --only-failures` | Passed, 6.4 s; production backend init, two boots, one execution and coordinator notification |
| `agents-md-backend-focused` | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/agents-md-pr.test.ts ./src/core/agents-md-commands.test.ts ./src/core/nodes/node-coordination-agents-md.test.ts ./src/core/index-agents-md-recovery.test.ts ./src/core/control-mcp-server.test.ts --parallel=3 --only-failures` | Passed, 9.9 s; includes base-branch fallbacks and direct coordinator denial |
| `agents-md-routing` | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/gateway-handlers.test.ts ./src/core/nodes/node-routing.test.ts ./src/core/nodes/node-link.test.ts --parallel=2 --only-failures` | Passed, 0.8 s |
| `agents-md-web-focused` | `bun test --cwd apps/web ./src/components/federation/AgentsMdApprovalDialog.test.tsx --parallel=1 --only-failures` | Passed, 0.5 s |
| `agents-md-protocol` | `bun test --cwd packages/protocol ./src/agents-md-orkestrator.test.ts --parallel=1 --only-failures` | Passed, 0.1 s |
| `agents-md-browser` | `bunx playwright test --config e2e/playwright.config.ts e2e/AgentsMdApproval.spec.ts` | 10 passed across desktop/mobile, 8.5 s; pending, failed/retried and invalid previews included |

The final PR and node-directory runs followed the last changes to those
modules. The earlier focused runs remain evidence for the other unchanged
owners. Passing logs are deleted by the logged runner.

### Broad suite results

`mise run test:logged -- --name agents-md-full -- mise run test` used the
default worker plan: four workspace slots, one root slot, two bridge slots
and one lockfile slot; Turbo ran two package tasks at once and backend used
two Bun workers. The component browser run ran concurrently on the shared
macOS host. The outer run finished in 877.0 s and remained failed.

| Group | Passed | Skipped | Failed |
| --- | ---: | ---: | ---: |
| Backend | 12623 | 123 | 15 (plus 5 between-test errors) |
| Desktop | 1394 | 16 | 2 |
| Web | 10191 | 10 | 0 |
| Protocol | 2101 | 2 | 0 |
| Web public | 41 | 0 | 0 |
| Toolchain | 91 | 0 | 0 |
| Root workspace package | 329 | 0 | 0 |
| Root and agent-support | 3533 | 0 | 2 |
| Bridges | 6442 | 62 | 2 |

The Codex protocol lockfile check passed. The backend failures were five
real-Git environment-move deadlines, two coordinator-service deadlines, four
staged-input relay cases, two Docker image cases, one file watcher case, and
one retry-notice regression assertion. The between-test errors followed the
move deadlines and fixture cleanup.

The aggregate overlapped the last retry-cleanup edit. Its retry-notice case
observed one remaining notice instead of zero. The final focused recovery run
and complete final node-directory run both passed with the legacy-key notice
assertion intact. An earlier cached module in the long-lived aggregate worker
is a hypothesis, not a confirmed runtime defect or a classified flake. The
aggregate remains failed; it is not reported as a clean final-source run.

`mise run test:logged -- --name agents-md-browser-full -- mise run test:browser`
finished in 493.0 s: **858 passed, 105 skipped, 3 failed** with nine workers.
Both native branch-picker projects retained `rel` instead of `release/2.0`;
the desktop waiting tool group retained scrollTop 704 instead of zero. All
ten AGENTS.md cases passed. The task's chained public-site suite did not run
after the component suite failed.

### Complete unchanged owner reruns

Each command below also used the logging wrapper and `--parallel=1
--only-failures` for Bun tests. Backend tests preloaded
`../../tests/setup-node.ts`. These are separate complete owning-file runs;
none changes assertions, skips or deadlines.

| Owner | Owning-file command after wrapper | Result |
| --- | --- | --- |
| Environment move | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/environment-move.test.ts --parallel=1 --only-failures` | 32 passed, 6 failed, 5 errors; 93.8 s; same real-Git deadline/cleanup class recorded above |
| Coordinator service | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --parallel=1 --only-failures` | Passed, 49.2 s; case 0165 updated |
| Profile cleanup | `bun test --cwd apps/desktop ./scripts/dev/profile-cleanup.test.ts --parallel=1 --only-failures` | 20 passed, 2 failed; unexpected keychainWarning fields, 3.1 s |
| Copy helper | `bun test ./tests/unit/migrate-copy.test.ts --parallel=1 --only-failures` | 10 passed, 2 failed; extract status 2 instead of 0, 9.0 s |
| Claude lifecycle | `bun test --cwd bridges/claude-bridge ./src/services/session-manager-lifecycle.test.ts --parallel=1 --only-failures` | 38 passed, 1 failed; missing sessionManagerTestHome, 1.2 s |
| Claude persistence | `bun test --cwd bridges/claude-bridge ./src/services/session-manager-persistence.test.ts --parallel=1 --only-failures` | 99 passed, 1 skipped, 1 failed; same missing identifier, 4.0 s |
| File watcher | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/worktree-watcher.test.ts --parallel=1 --only-failures` | 33 passed, 1 failed; no observed write, 2.8 s |
| Docker image | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/docker-image.test.ts --parallel=1 --only-failures` | 19 passed, 2 failed; missing expected add-host arguments, 2.1 s |
| Staged input relay | `bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/staged-input-relay.test.ts --parallel=1 --only-failures` | 5 passed, 4 failed; owner-only relay/mount assertions, 0.7 s |
| Tool group | `bunx playwright test --config e2e/playwright.config.ts e2e/ToolGroupFold.spec.ts` | Passed, 19.6 s; case 0747 updated |
| Native branch picker | `bunx playwright test --config e2e/playwright.config.ts e2e/AgentLaunchDialog.spec.ts` | 2 passed, 2 failed; same rel/release mismatch, 11.3 s |

These baseline failures were not freshly compared with clean main in this
review-fix run; earlier clean-main evidence remains above. The coordinator and
tool-group recurrences passed their unchanged owners and were recorded in
their existing numbered cases and indexes.

### Failure artifacts and limits

All paths below are under
`/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/`:

- Whole test run: `orkestrator-test-run.75rRyc/agents-md-full.log.gz`; group
  logs and summary: `orkestrator-test-run.7AiZMP/`.
- Component browser: `orkestrator-test-run.ypVY2E/agents-md-browser-full.log.gz`.
- Owner failures: lifecycle `orkestrator-test-run.IKRVFF/`, persistence
  `orkestrator-test-run.2QBghg/`, move `orkestrator-test-run.6WyQGL/`, profile
  `orkestrator-test-run.NNzWZi/`, copy `orkestrator-test-run.XfGFLe/`, watcher
  `orkestrator-test-run.Z5r1zF/`, image `orkestrator-test-run.q5A62g/`, relay
  `orkestrator-test-run.ibU1My/`, picker `orkestrator-test-run.9djKyn/`.

No live GitHub PR or second physical node was exercised: PR tests use real
local bare repositories with fake gh, and routing uses the real node-link and
portal over a simulated authenticated network. Electron, Docker scenarios and
iOS were not selected for these backend/protocol and component-control fixes.
No dev:test profile was created; Playwright owned and stopped its fixture
servers. No failing test was skipped, loosened or changed to mask a failure.
