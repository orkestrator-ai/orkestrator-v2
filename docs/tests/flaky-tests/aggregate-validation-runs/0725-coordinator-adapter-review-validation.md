# Coordinator adapter review validation under shared-host load

- **ID:** 0725
- **Status:** open
- **Date observed:** 2026-10-24
- **Snapshot:** `efbe4cf56` after `b86f4039b` on `todo-0026-coordinator-read-only-adapters-d18c30e4bc68`.
- **Original command:** `mise run test:logged -- --name repository-tests-final -- mise run test`.
- **Workers:** workspace/root/bridges/protocol reservations 4/1/2/1; backend used two isolated workers. Other worktrees shared the host; load averages reached 124.51 / 102.99 / 63.65 during the owner reruns.
- **Final result:** exited 1 in 1646.0 seconds. Backend: 10,687 passed, 115 skipped, 14 failed across 10,816 tests in 637 files (1611.17 s). Root/support, bridges, protocol regeneration and every other workspace package passed. No watchdog or output-limit failure occurred.
- **Evidence:** host temporary artifact `orkestrator-test-run.BMW5aO/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz` after aggregate finalization; top-level `orkestrator-test-run.53nuai/repository-tests-final.log.gz`.

## Failures and complete owning-file reruns

Every owner below is unchanged by this work. Reruns use
`mise run test:logged -- --name <name> -- sh -c 'cd apps/backend && bun test <owner> --parallel=1 --only-failures'`.

| Test and owner | Aggregate failure | Separate owner result |
| --- | --- | --- |
| `terminal history > normalizes lines, CRLF, Unicode, and ANSI across transport chunks and pages`, `./src/core/terminal-history.test.ts` | 5000.90 ms timeout, followed by late null `recent.previousCursor` access after cleanup | `terminal-history-isolated`: passed unchanged, exit 0, 17.3 s. Recurrence of [0213](../backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md). |
| `interactive preview in Chromium > infinite loops before and after ready are killed, the browser is gone and capacity recovers`, `./src/core/transcript-artifacts/preview-interactive.test.ts` | elapsed 9014 ms against `< 9000 ms`; test duration 9704.85 ms | `preview-interactive-isolated`: failed again (elapsed 9004 ms against `< 9000 ms`, test duration 11040.60 ms); 6 passed, 1 failed in 88.2 s logged. Evidence: `orkestrator-test-run.dpXJli/preview-interactive-isolated.log.gz`. No passing isolated result was established. |
| `local OpenCode server starts on one host > shutdown between database-lock attempts prevents a retry spawn`, `./src/core/opencode-host-start.test.ts` | Expected `shutting down`, received child exit before healthy (544.48 ms) after `database is locked` | `opencode-host-isolated`: passed unchanged, exit 0, 19.9 s. Recurrence of [0723](../backend-services-and-tooling/0723-opencode-host-shutdown-retry-race.md). |
| `container status and fetch scripts against a local remote > a branch baseline follows origin/<ref> only when the policy fetches`, `./src/core/container-git-fetch-git.test.ts` | 5195.88 ms timeout | `container-git-isolated`: failed again at 5187.34 ms under shared-host load; 5 passed, 1 skipped, 1 failed, 1 between-test error (20.8 s logged). Evidence: `orkestrator-test-run.n7xmMd/container-git-isolated.log.gz`. This run does not independently confirm a passing flake rerun; historical case [0175](../environments-and-containers/0175-container-git-fetch-branch-baseline-timeout.md) remains open. |
| `mermaid rendering > the external watchdog ends a blocked render within the deadline and the browser is gone`, `./src/core/transcript-artifacts/mermaid-render.test.ts` | elapsed 11509 ms against `< 5000 ms`; test duration 12093.98 ms | `mermaid-render-isolated`: reproduced unchanged (elapsed 17879 ms against `< 5000 ms`, test duration 19258.53 ms); 12 passed, 1 failed, 152.1 s logged. Evidence: `orkestrator-test-run.ej4fu6/mermaid-render-isolated.log.gz`. Historical case [0512](../design-canvas-and-artifacts/0512-mermaid-watchdog-elapsed-under-load.md) remains open; this run did not establish an isolated pass. |
| `agent accounts > the same login cannot be added twice`, `./src/core/agent-accounts.test.ts` | An extra Codex account directory remained (480.72 ms) | `agent-accounts-isolated`: reproduced unchanged (338.63 ms); 37 passed, 1 failed, 24.9 s logged. Evidence: `orkestrator-test-run.87qaoS/agent-accounts-isolated.log.gz`. Historical case [0239](../backend-services-and-tooling/0239-agent-account-duplicate-directory-cleanup.md) remains open; this run did not establish an isolated pass. |
| `public_action contract > capabilities reports the package version without launcher metadata`, `./src/core/public-api/public-api-projects.test.ts` | 5001.37 ms timeout; child was killed during cleanup | `public-api-projects-isolated`: reproduced unchanged (5002.82 ms); 24 passed, 1 failed, 1 between-test error, 22.5 s logged. Evidence: `orkestrator-test-run.mK5qxq/public-api-projects-isolated.log.gz`. No passing isolated result was established. |
| `untracked inventory caps publish non-exact Git scope totals`, `./src/core/change-tracking/review-regressions.test.ts` | 5901.53 ms timeout | Not rerun; this observation alone does not establish a flake. |

Shared-host scheduling and Chromium startup contention are hypotheses consistent
with the measured load and deadlines, not confirmed root causes. No production
code, assertion, deadline or skip in these owners was changed. Coordinator
policy, registration, reload, prompt-wiring and Cursor attribution regressions
passed, as did format, lint and type checks. The root, bridge and protocol
lockfile groups passed in the aggregate. Separate UI, Docker and iOS scenario
suites were not run.


## Additional aggregate failures

The following unchanged owners were not rerun. These observations alone do not
establish flakes. No corresponding assertion, implementation, timeout or skip
was changed.

| Owner | Test | Duration |
| --- | --- | --- |
| `apps/backend/src/core/change-tracking/review-regressions.test.ts` | `Pi occurrences keep distinct operations, transcript presentations and per-turn volume` | 894.63ms |
| `apps/backend/tests/recurring-baseline.test.ts` | `driven native observation baseline (step 07) > is deterministic, content-free, and sharing drops reads without losing edges` | 5016.53ms |
| `apps/backend/src/core/looped-review-scheduling.test.ts` | `LoopedReviewService keyed scheduling > old and new drivers make the same transitions from one persisted fixture` | 5017.30ms |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | `start uses and persists both explicit and configured roots; generic reads stay within the worktree` | 5039.82ms |
| `apps/backend/src/core/commands-environment-worktree-location.test.ts` | `retargeting an accepted alias keeps creation and cleanup at the original physical root` | 5197.75ms |
| `apps/backend/tests/tmux-commands-teardown.test.ts` | `Electron tmux environment teardown > an unlinked live socket retains session attribution, cleanup and startup retry state` | 5316.55ms |
