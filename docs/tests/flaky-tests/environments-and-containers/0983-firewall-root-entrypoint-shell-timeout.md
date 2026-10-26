# Firewall root-entrypoint fixture times out in the aggregate

- **ID:** 0983
- **Status:** open
- **Date observed:** 2026-10-26
- **Test:** `container firewall policy > the root entrypoint runs the firewall itself and records the outcome per mode`
- **File:** `tests/unit/firewall-policy.test.ts:806`
- **Original command:** `mise run test` on `todo-0112-review-fanout-recovery-0aecfac78013` (review fan-out runner, Claude and Codex bridge status fields, tests and docs; nothing under `docker/` or the firewall scripts), macOS arm64, Bun 1.4.4, standard worker leases; host load average 22 to 32.
- **Failure:** in both full runs of the day, after about 5,002 ms (Bun's five-second budget), `expect(result.exitCode).toBe(0)` at line 822 received `null`: the real shell harness had not exited when the deadline fired.
- **Suite counts:** root and agent-support tests 3,470 passed and 2 failed of 3,472 in 166 files (207 s); the other failure was the `flaky test register` index check, which fails deterministically on `main` because case 0887 has no `- **ID:**` line. Workspace, bridges and the Codex protocol lockfile groups passed.
- **Isolated rerun:** `mise run test:logged -- --name firewall-owner -- bun test ./tests/unit/firewall-policy.test.ts` passed (37.8 s). Earlier in the day the complete owner also passed alone (34 passed).
- **Aggregate evidence:** `orkestrator-test-run.5Cv5CX` under the host temporary directory.
- **Recurrence (2026-10-26, after the Multi Review fixes):** the full run failed it again with eight other firewall shell-fixture deadlines (`firewall-policy.test.ts`, `firewall-refresh.test.ts`); rerunning both owners alone at load average 15 to 35 (`mise run test:logged -- --name firewall-owners -- bun test ./tests/unit/firewall-policy.test.ts ./tests/unit/firewall-refresh.test.ts`) still failed three different five-second cases, this one included (46 passed, 88 s). Under that load the owner fails alone too, as 0632 records for `main`; nothing in this branch touches the firewall scripts.
- **Hypothesis:** the same host-contention deadline as [0632](0632-firewall-policy-probe-budget.md) and [0192](0192-firewall-bootstrap-shell-timeout.md): the fixture runs the real entrypoint shell script, which does not finish within five seconds when the aggregate saturates the host. Unconfirmed. No firewall code, assertion, timeout or skip changed.

## Restart-status coverage validation — 2026-10-26

- **Command:** `mise run test`, workspace/root/bridge/protocol reservations 4/1/2/1.
- **Failure:** root-entrypoint deadline at 5002.92 ms, exit code `null`; the GitHub seed/live/cache case also timed out at 5009.12 ms (0192).
- **Root counts:** 3469 passed, 3 failed across 3472 tests in 166 files (230.78 s). The third failure is the existing missing ID metadata in registry case 0887, also reproduced alone.
- **Evidence:** `orkestrator-test-run.nG0pIs/root-and-agent-support-tests.log.gz` below the host temporary directory.
- **Owner rerun:** `mise run test:logged -- --name firewall-policy-isolated -- bun test ./tests/unit/firewall-policy.test.ts --parallel=1 --only-failures`: 33 passed, 1 failed (45.45 s). Both aggregate firewall cases passed; a different policy-3 HTTPS probe hit 5002.93 ms. Evidence: `orkestrator-test-run.jPtxw9`.
- **Assessment:** the complete owner still fails under current host conditions, so this observation does not establish a new flake classification. No firewall code, assertion or deadline changed.
