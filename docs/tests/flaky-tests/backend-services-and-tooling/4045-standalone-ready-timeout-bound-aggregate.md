# Standalone backend readiness timeout exceeds its upper bound in the aggregate

- **ID:** 4045
- **Status:** resolved
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

### Resolution — 2026-11-06

- **Root cause (test):** `expect(elapsedMs).toBeLessThan(200)` measured host scheduling, not behaviour. The ceiling allowed 130 ms beyond the 50 ms deadline plus the 20 ms stderr sleep; the aggregate took 267 ms.
- **Fix detail and assertion change, for review:** the wall-clock ceiling is replaced with direct checks of the property it stood for. Stdout never closes and the child never exits, so the call settling at all shows that it did not wait for either. The rejection names `<stderr not drained in time>`, so it did not wait for stderr. The escalation is still held when the rejection arrives (`signals` is `["SIGTERM"]` and `pendingCount()` is 1), so it did not wait out the kill grace. The `>= 50 ms` lower bound and the message assertion are unchanged, and the case additionally checks that SIGKILL follows once the grace is advanced. A regression that waited on stdout, the child or the grace would fail or hang to the test timeout.
- **Reproduced:** not as a timing failure; the ceiling is exceeded only on a loaded host. The mechanism is the same real-clock dependence as case 0491, which was reproduced.
- **Fix (test only, `apps/backend/tests/standalone-ready.test.ts`):** both cases pass a distinctive `killGraceMs` (`HELD_KILL_GRACE_MS`, 987,653 ms) captured with `installControlledTimeout` (`tests/helpers/controlled-timeout.ts`), so the SIGKILL escalation runs only when the test advances it. After the rejection, each case asserts `["SIGTERM"]`, asserts that exactly one escalation is armed, advances it, and asserts `["SIGTERM", "SIGKILL"]`. The ready deadline and stderr sleep stay on the real clock.
- **Verification:** `mise run test:logged -- --name ready-stress -- bun test --cwd apps/backend tests/standalone-ready.test.ts --rerun-each=30 --parallel=2` PASS (11.6 s, exit 0). With the stderr diagnostic sleep temporarily raised to 200 ms, beyond any grace, the fixed file still passed (`ready-fixed-slow`).
