# Cross-service read policy (0054) validation under aggregate load

- **ID:** 0696
- **Status:** resolved
- **Date observed:** 2026-10-23.
- **Baseline:** `062971245` with the 0054 read-policy change (`packages/protocol/src/preview-header-policy.ts`, `apps/backend/src/preview-publication.ts` and their tests) in the working tree.
- **Original command:** `mise run test:logged -- --name full-tests-0054 -- mise run test`.
- **Workers:** default aggregate allocation; other worktrees were testing on the same host (load average 42 to 75 during the run and reruns). Contention is a hypothesis, not an established cause.
- **Aggregate result:** exit 1 in 803.2 s. Workspace and bridges groups failed; root and the Codex protocol lockfile check passed. Workspace: backend 9553 passed and one failed, desktop 1197 passed and one failed, every other package passed. Bridges: Codex 2249 passed, 38 skipped and four failed; every other bridge passed.
- **Original evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.nrRxHo/` (group logs), outer `orkestrator-test-run.dIVgn4`.

## Failures and complete owner reruns

None of the failing owners imports the changed modules (checked by walking `environment-move.test.ts`'s import graph; the desktop and Codex owners are outside the backend and protocol preview code). Every rerun used `mise run test:logged -- --name <label> -- bun test --cwd <package> --preload ../../tests/setup-node.ts <file> --parallel=1`.

| Owner | Original failure | Complete owner result |
| --- | --- | --- |
| `apps/backend/src/core/environment-move.test.ts` | `move_environment > moves a worktree with nested submodules (copy)` exceeded five seconds after a submodule clone failed with "Unable to read current working directory" (same family as 0248, 0291 and 0621). | Failed alone twice at load 57 to 61 on five-second timeouts in different cases (0248 among them); `env-move-alone-3` passed all 37 in 57.8 s at load 75. |
| `apps/desktop/scripts/dev/coordinator-live.test.ts` | Recurrence of [0258](../coordinator-and-multi-review/0258-coordinator-fixture-digest-aggregate-timeout.md). | Failed alone once on the same timeout; `coordinator-live-alone-2` passed in 5.6 s. |
| `bridges/codex-bridge/src/app-server-runtime-prompt.test.ts` | Four `at-most-once dispatch` cases: [0492](../agent-bridges/0492-codex-deleted-session-initial-retry-race.md) (expected 404 after deletion), "shutdown cancels a delayed retry and leaves a durable retry marker" and "shutdown during the retry window settles the thread instead of leaving it starting" ("first initial prompt attempt did not run"), and "a deleted session's retry window does not wedge a thread another tab holds" (expected 404, received a processing result). | `codex-runtime-prompt-alone` passed in 10.6 s. |

## Assessment

Every failing owner passed unchanged when rerun alone, so these are recorded as load-sensitive flakes. No implementation, assertion, timeout or skip changed.

## Final run after the main merge and review fixes — 2026-10-23

- **Baseline:** this branch merged with `origin/main` at `cda435fc9`, plus the review fixes and the `content-server.engines.test.ts` sink-icon fix.
- **Command:** `mise run test:logged -- --name full-tests-0054-final2 -- mise run test`, run shortly after a host reboot (load average about 2 at the start, 24 during the reruns).
- **Result:** exit 1 in 398.0 s. Root and the Codex protocol lockfile check passed. Workspace: backend 10123 passed, 61 skipped, three failed; every other package passed. Bridges: Pi 571 passed, one skipped, two failed (one case plus an unnamed hook timeout); every other bridge passed.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.QVdH4t/`.

| Owner | Original failure | Complete owner result |
| --- | --- | --- |
| `apps/backend/tests/commands-registry-environments-create.test.ts` | "backs off failed reconciliation for 30 seconds and clears the floor after success" (recurrence of [0229](../environments-and-containers/0229-reconciliation-backoff-aggregate-timeout.md)) and "does not reuse a namespaced historical PR head after an A to B to A rename" exceeded five seconds; "lets an explicit first prompt bypass rename retry backoff" failed in 11 ms after them. | `backend-registry-owner` failed the A-to-B-to-A case alone on the same five-second timeout (51 passed); `backend-registry-owner-2` and `-3` then passed all 52 in 24.6 s and 20.9 s. |
| `bridges/pi-bridge/src/prompt-cancel-preflight.test.ts` | "cancel while Pi's preflight is held > acknowledges as pending and aborts the run the moment Pi accepts" (2004.93 ms) and an unnamed five-second hook timeout. | `pi-cancel-owner` passed in 0.4 s. |

None of these owners imports the changed preview code; the branch changes no command-registry or Pi bridge source. No implementation, assertion, timeout or skip changed.

## Further main merge validation — 2026-10-23

- **Merge parents:** preview branch `cf65ce74b` and `origin/main` at `01d052e0b`; common ancestor `cda435fc9`.
- **Scope:** the combined merge changes 208 paths from the common ancestor, including code and configuration. The two original conflicts were prose records: the aggregate index retains both 0696 and 0720; case 0229 retains both recurrence sections. The original NUL-delimited conflict list and parent IDs are retained in local Git metadata.
- **Passed:** formatting, lint, typechecking, conflict-marker and relative-link checks, the private-preview browser suite (Chromium, Firefox and WebKit), and the separately run public-site browser suite.
- **Repository suite:** the GNU-tool PATH invocation `ORKESTRATOR_TEST_AREA_BASE=cda435fc905eb43b73e8e6f0159ceb680a4bbc61 mise run test:logged -- --name merge-tests -- mise run test` completed with exit 1 in 1573.0 s. Workspace, root/support and bridge groups failed; the Codex protocol drift check passed. Backend: 10262 passed, 64 skipped, eight failed; web: 8888 passed, 10 skipped, one failed; root/support: two failing cases; ACP: 654 passed, three skipped, one failed. All ten complete failing unit owners subsequently passed unchanged as detailed below; the original aggregate exit remains failed. Evidence: `orkestrator-test-run.QHFNZ6/*.log.gz` and outer `orkestrator-test-run.884pLs/merge-tests.log.gz` under the host temporary directory.
- **Component browser:** the first attempt refused port 1422 because its fixture belonged to another checkout. The run with `ORKESTRATOR_E2E_PORT=15422` and `ORKESTRATOR_PUBLIC_E2E_PORT=15423` completed with 469 passed, 95 skipped and 40 failed using nine workers (1172.1 s logged). Reload, layout and native branch-selection failures span multiple owners; no complete component-owner reruns were performed, so this run does not establish new flakes. Evidence: `orkestrator-test-run.LkMryB/merge-browser-retry.log.gz` under the host temporary directory. The separate public-site run used port 15424 and passed.
- **Isolated application browser:** `mise run test:logged -- --name merge-agent-browser -- mise run test:agent:browser:isolated` failed the narrow Repository settings click in `browser-gateway.spec.ts`, then reached its 15-minute suite deadline after starting case 66/81 (916.4 s logged). This is not a complete passing run. The runner stopped and reset its exact disposable profile `qa-browser-0f31b3cd-33c` successfully. Evidence: `orkestrator-test-run.nbAgP0/merge-agent-browser.log.gz`.

Complete unit-owner reruns used `mise run test:logged`, explicit paths and `--parallel=1 --only-failures`; backend/bridge runs used the aggregate's Node preload:

| Complete owner | Aggregate failure | Rerun result |
| --- | --- | --- |
| `bridges/acp-bridge/src/acp-generalization.test.ts` | Filesystem/terminal case exceeded 60 s; recurrence of 0219. | Passed unchanged with the explicit Node preload (3.9 s logged). |
| `tests/unit/preview-latency-baseline.test.ts` | `releases private-origin attachments after handoff failure (att-missing-url)` timed out in `get_preview_capabilities`. | Passed unchanged (5.8 s logged). |
| `apps/backend/src/core/opencode-host-start.test.ts` | Shutdown between database-lock attempts observed early process exit. | Passed unchanged (13.2 s logged). |
| `apps/backend/src/core/transcript-artifacts/content-server.engines.test.ts` | Firefox setup hook exceeded five seconds. | Passed unchanged in all installed engines (293.6 s logged). |
| `apps/backend/src/core/coordinator-service.test.ts` | Two Git branch/discard cases timed out. | Passed unchanged (37.4 s logged). |
| `apps/backend/src/core/public-api/public-api-exec.test.ts` | Process exit-status/stream separation case failed. | Passed unchanged (17.3 s logged). |
| `apps/web/src/App.test.tsx` | Failed-retry Docker warning case failed. | First rerun: 114 passed and one different startup-probe case failed (22.7 s logged; evidence `orkestrator-test-run.CvOUQr`). The complete unchanged owner passed after the browser runs ended (6.1 s logged). |
| `apps/backend/src/core/environment-move.test.ts` | Nested-submodule move and recovery cases exceeded five seconds. | First rerun: 36 passed, one recovery timeout and one associated late error (66.8 s logged; evidence `orkestrator-test-run.6c9J0C`). The complete unchanged owner passed after the browser runs ended (30.6 s logged). |
| `tests/unit/hooks/useVirtuosoScrollState.test.ts` | Sticky reactivation scroll-state case failed. | Passed unchanged (2.9 s logged). |
| `apps/backend/src/core/transcript-artifacts/mermaid-render.test.ts` | External watchdog case missed its elapsed deadline; recurrence of 0512. | Passed unchanged (24.9 s logged). |

The passing whole-owner reruns establish intermittent aggregate recurrences for those owners. Host contention is a hypothesis; other worktrees were running suites concurrently. No implementation, assertion, timeout or skip was changed. Live-provider, Docker-image and iOS qualification were not run.

## Triage 2026-10-25

Resolved: run record only. Owner cases cover every confirmed failure: environment move 0248/0291/0621, coordinator digest [0258](../coordinator-and-multi-review/0258-coordinator-fixture-digest-aggregate-timeout.md), Codex runtime prompt [0492](../agent-bridges/0492-codex-deleted-session-initial-retry-race.md), registry create [0229](../environments-and-containers/0229-reconciliation-backoff-aggregate-timeout.md), Pi cancel [0500](0500-agent-mail-main-merge-validation.md), ACP 0219, preview baseline 0771, OpenCode host 0723, artifact engines 0507/0697, coordinator service 0165, public API exec 0341/0624, App 0082 and Mermaid 0512. One `useVirtuosoScrollState` sticky-reactivation failure passed alone; that owner's earlier cases (0135, 0381) are resolved, so the lead may want to reopen one if it recurs. The 40 component failures were not rerun and do not establish flakes.
