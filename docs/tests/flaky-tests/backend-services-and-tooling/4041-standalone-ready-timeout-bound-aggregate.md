# Standalone backend readiness timeout exceeds its upper bound in the aggregate

- **ID:** 4041
- **Status:** open
- **Date observed:** 2026-11-04
- **Test:** `waitForStandaloneBackendReady > times out with a named diagnostic without waiting for stdout to close`
- **File:** `apps/backend/tests/standalone-ready.test.ts`
- **Original command:** `mise run test` on branch
  `sub-agent-models-ed8b12224ab5-r1`, which does not change the standalone
  backend or its readiness wait.
- **Worker configuration:** the default `mise run test` groups, with the
  workspace group concurrent with root, bridges and codex-protocol. Host load
  was not recorded for this run.
- **Failure:** `expect(elapsedMs).toBeLessThan(200)` received 267.29 ms; the case
  took 267.64 ms. Backend workspace group: 14043 pass, 3 fail (the other two were
  a defect in that branch, since fixed). Artifact: `orkestrator-test-run.WqKj7j`.
- **Isolated rerun:** `bun --cwd=apps/backend test tests/standalone-ready.test.ts
  --parallel=1` passed the unchanged file three times (0.6 s, 0.8 s, 0.9 s).

## Current assessment

The case asserts a 200 ms wall-clock ceiling around a 50 ms timeout, which leaves
150 ms for a loaded host to schedule it. Case [0491](0491-standalone-ready-sigkill-escalation-aggregate.md)
is a different assertion in the same file. It did not recur in the next aggregate
run on the same branch, at load average 83–96.
