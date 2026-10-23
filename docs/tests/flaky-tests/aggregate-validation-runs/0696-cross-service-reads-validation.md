# Cross-service read policy (0054) validation under aggregate load

- **ID:** 0696
- **Status:** open
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
