# `standalone backend service > drains an active local server process tree before exiting` (`apps/backend/tests/standalone.test.ts`)

- **ID:** 0122
- **Status:** resolved
- **Date observed:** 2026-08-14
- **Original command:** `set -o pipefail; bun test --cwd apps/backend src tests --parallel 2>&1 | tee /tmp/rev-backend-tests-cwd.log`, at or immediately after `c4ce823fb218e0f858115c0e0ada81203998c10a`
- **Worker configuration:** Backend package only, `bun test src tests --parallel`, run on its own rather than inside `bun run test`.
- **Failure:** timed out after 5,000 ms (reported duration 5,001.55 ms) with no assertion message.
- **Suite counts:** Backend package: 1,696 total, 1,695 passed, 1 failed across 55 files in 37.02 s.
- **Isolated rerun:** `bun test --cwd apps/backend ./tests/standalone.test.ts` -> 8 passed, 0 failed in 35.48 s. Evidence: `/tmp/rev-isolated-standalone.log`.
- **Related:** a different case in the same file, `exits without a leftover listener when environment-managed Serve setup fails`, is recorded separately above. Both cases boot a real backend process and wait on its shutdown.
- **Hypothesis:** The test spawns a real local server process tree and waits for the drain to complete. The isolated file takes 35.48 s for 8 tests, so this suite is already near the budget per case without contention; a parallel backend run adds process-startup competition on top. A later run of the same command at the same head passed this case and failed a different backend test instead, which is consistent with a shared-resource race rather than a defect in the drain itself. Establish whether the outstanding wait is on process exit or on port release before adjusting the budget.

## Design-agent links refresh through d6ed0717d — 2026-10-24

The combined merge repeated a failure in this owner during `mise run test:logged -- --name merge-tests -- mise run test` (workspace/root/bridge/protocol reservations 4/1/2/1, other worktrees active). The complete unchanged owner passed with one worker in 132.4 s: `mise run test:logged -- --name design-links-owner-backend-standalone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/standalone.test.ts --parallel=1 --only-failures`. See [0772](../aggregate-validation-runs/0772-design-agent-links-main-refresh-validation.md) for the exact failing cases, durations, counts, parents and artifacts. No assertion, deadline or skip changed; shared-host contention remains a hypothesis.

## Resolution (2026-11-15)

- **Owner moved:** the test is now in `apps/backend/tests/standalone.lifecycle.test.ts` (split by `dc90609bf`).
- **Root cause:** wall-clock deadlines in the shared standalone helpers, sized for an idle host: `waitForProcessExit` polled a real exit against a 5 s deadline, the ready-line wait gave up after 20 s, and the file-level budget was 30 s for a case that boots a backend, starts a server tree and drains it. Under load the drain (the real signal) was still progressing when one of these expired.
- **Fix:** every wait still ends on its real signal (the ready line, `child.exited`, the PID disappearing); only the hang watchdogs changed. `standalone-test-support.ts`: `waitForProcessExit` deadline 60 s, cleanup wait 30 s; `standalone-ready.ts`: `DEFAULT_BACKEND_READY_TIMEOUT_MS` 60 s; the three standalone files' `jest.setTimeout` 150 s, kept above the helper watchdogs so a stuck fixture still fails with its named diagnostic. No assertion decides on elapsed time.
- **Reproduced:** no — the drain stall was not re-created; the change is to watchdogs only, which is weaker evidence.
- **Stress:** `mise run test:logged -- --name f2-standalone -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./tests/standalone.lifecycle.test.ts ./tests/standalone.test.ts ./tests/standalone-ready.test.ts --parallel=2` ran 14 tests: the lifecycle case passed; one unrelated failure (`agent-test startup loads the Cursor snapshot…`: `cursor bridge directory not found`, a bridge-path lookup, not a deadline). Not run under contention.
