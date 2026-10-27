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

## Abort-cleanup review follow-up (`b982bd610`)

On 2026-10-27, the abort cleanup fixes passed `mise run check`, the focused
OpenCode/provider/service regressions, and the opt-in live OpenCode abort
owner against CLI 1.19.4 in a disposable profile with a scripted local model.
The live owner verified permission and question rejection with HTTP 200,
concurrent-responder HTTP 404, and rejection of stale answers.

The follow-up aggregate command was
`mise run test:logged -- --name abort-repository-tests -- mise run test`.
The root group used `--parallel=1`; the scheduler initially reported 18/18
slots reserved and the root group waited 132.7 s. The host load average was
227.27, 166.17, 165.10 during failure triage. The outer logged run is
`orkestrator-test-run.M2tTuc`, with group logs in
`orkestrator-test-run.EI9pye`, below the host temporary directory.

The outer logged command reached its 1,800,000 ms absolute watchdog and
terminated its owned process tree (exit 1 after 1800.1 s). This run is
**incomplete**, not a full-suite pass. Workspace execution started only after
1,283.7 s waiting for four slots; backend execution had no final summary when
the outer deadline fired. The outer artifact is
`orkestrator-test-run.M2tTuc/abort-repository-tests.log.gz`; inner group logs
remain in `orkestrator-test-run.EI9pye`. The bridge group waited 1,009.9 s and
then passed all five packages (6,313 passed, 57 skipped, zero failed).

Completed workspace packages: web 9,941 passed/10 skipped; public web 41
passed; CLI 329 passed; protocol 1,939 passed/2 skipped; toolchain 91 passed.
Desktop completed with 1,369 passed, 16 skipped, and the two existing
profile-cleanup failures. The unfinished backend log contains 24 failure
records in command integration, environment moves, environment registry, and
worktree-location owners already covered by the earlier validation above;
this is not a final backend count. No new abort/retry/stop owner failed.
The existing stop-ladder and stopped-runtime owners also passed directly:
`mise run test:logged -- --name abort-existing-stop-flows -- bun test --cwd apps/backend ./src/core/native-agent-service-abort-ladder.test.ts ./src/core/native-agent-service-stopped-runtime.test.ts --parallel=2`
(1.6 s).

| Owner | Aggregate observation | Logged isolated rerun |
| --- | --- | --- |
| `tests/unit/change-tracking-boundaries.test.ts` | `renderer code has no counting, diffing or provider-classification engine` timed out at 5,988.07 ms against a 5,000 ms deadline | `mise run test:logged -- --name abort-rerun-boundaries -- bun test ./tests/unit/change-tracking-boundaries.test.ts --parallel=1` passed (2.0 s) |
| `tests/unit/codex-app-server-protocol.test.ts` | `a nonexistent CODEX_PROTOCOL_BINARY fails instead of falling back` timed out at 5,002.15 ms; the abandoned process returned 143 instead of 1 | `mise run test:logged -- --name abort-rerun-protocol -- bun test ./tests/unit/codex-app-server-protocol.test.ts --parallel=1` passed (2.9 s) |
| `tests/unit/migrate-copy.test.ts` | Both missing listing/root completion cases reported extract status 2 instead of 0 | `mise run test:logged -- --name abort-rerun-migrate-copy -- bun test ./tests/unit/migrate-copy.test.ts --parallel=1` repeated the existing host failure (10 passed, 2 failed; 6.2 s; artifact `orkestrator-test-run.h9Lm0f`) |
| `tests/unit/components/GitHubCloneIntegration.test.tsx` | Non-git destination `findByRole("alert")` failed after 1,996.17 ms | `mise run test:logged -- --name abort-rerun-github-clone -- bun test ./tests/unit/components/GitHubCloneIntegration.test.tsx --parallel=1` passed (6.3 s); recurrence recorded in [0352](../web-ui/0352-github-picker-non-git-destination-alert.md) |
| `apps/desktop/scripts/dev/profile-cleanup.test.ts` | The same two unexpected `keychainWarning` fields as [1100](../electron-and-desktop/1100-profile-cleanup-macos-keychain-warning.md) | `mise run test:logged -- --name abort-rerun-desktop-cleanup -- bun test --cwd apps/desktop ./scripts/dev/profile-cleanup.test.ts --parallel=1` repeated them (20 passed, 2 failed; 1.2 s; artifact `orkestrator-test-run.3KCws6`) |
| `apps/backend/tests/commands-integration.test.ts` | PR-polling setup, artifact Git excludes, config-retarget scanning, and Git scan-cache setup timed out | `mise run test:logged -- --name abort-rerun-commands -- bun test --cwd apps/backend ./tests/commands-integration.test.ts --parallel=1` remained non-green (52 passed, 3 failed, one error; 107.9 s; artifact `orkestrator-test-run.mKmMKg`): PR-polling setup, artifact excludes, and config retarget repeated; the cache-setup case passed |


The root/support group finished with 3,523 passed, 5 failed, and one error
across 170 files (541.80 s of execution; 675.6 s including the capacity wait).
The between-test error is the timed-out protocol owner's expected-exit
assertion observing the terminated child, as described in the table.
The Codex protocol lockfile group passed.

The first two owners pass alone and are aggregate-load flakes. The copy owner
remains a reproducible host failure already recorded above; it is not being
classified as a flake. The desktop and command owners also remain non-green
on their isolated reruns; their failures are not being classified as flakes.
No assertion, timeout, skip, or unrelated product code was changed to
accommodate these results.
