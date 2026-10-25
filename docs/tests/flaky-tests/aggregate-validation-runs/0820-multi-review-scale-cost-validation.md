# Multi Review scale-and-cost validation: aggregate five-second timeouts

- **ID:** 0820
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** todo 0027 (Multi Review rollback gates, reviewer-transcript fallback, Build Pipeline result reminders, fan-out interleaving tests, verification byte measurement, Codex `<environment_context>` rollout filter) on `todo-0027-multi-review-scale-cost-8f6bdb86aee0`, based on `ba7cc8d4`.
- **Original command:** `mise run test:logged -- --name full-suite -- mise run test` (default reservations; other worktrees validating on the same host, load average 47 to 98 on 18 cores).
- **Aggregate result:** failed after 1,734.4 s with four failures in tests whose behaviour the change does not touch, the same set as [0790](0790-settings-machine-strip-validation.md):
  - `bridges/pi-bridge/src/prompt-cancel-preflight.test.ts`: `concurrent cancels for one claim > repeat cancels of an accepted run share one abort`.
  - `apps/desktop/scripts/dev/coordinator-live.test.ts`: `fixture tree digest > names every class of change a coordinator could make` (5028.27 ms); see [0258](../coordinator-and-multi-review/0258-coordinator-fixture-digest-aggregate-timeout.md). The file imports nothing the change touched.
  - `apps/backend/src/core/coordinator-service.test.ts`: `project coordinator > fetch force, fast-forward sync, remote switching, and divergence stay safe` (5092.56 ms); see [0165](../coordinator-and-multi-review/0165-coordinator-bound-discard-timeout.md).
  - `apps/backend/src/core/environment-move.test.ts`: `restart recovery re-links submodules of an adopted or abandoned copy` (5101.02 ms); see [0248](../environments-and-containers/0248-move-restart-recovery-submodule-timeout.md).
- **Owner reruns:** the pi-bridge owner passed alone (16 passed). `environment-move.test.ts` passed alone with `--parallel=1 --only-failures` (48.5 s). Under the same load the desktop owner and `coordinator-service.test.ts` still exceeded the five-second deadline alone, and both cases passed when run alone with `--timeout 30000`, so the failures are slowness, not a changed result.
- **Evidence:** `orkestrator-test-run.5eWCG0/` under the host temporary directory.

No assertion, timeout or skip was changed for these tests. Shared-host load is the likely contributor, not an established cause.
