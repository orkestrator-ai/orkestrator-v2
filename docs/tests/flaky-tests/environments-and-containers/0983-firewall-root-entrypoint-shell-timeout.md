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
- **Hypothesis:** the same host-contention deadline as [0632](0632-firewall-policy-probe-budget.md) and [0192](0192-firewall-bootstrap-shell-timeout.md): the fixture runs the real entrypoint shell script, which does not finish within five seconds when the aggregate saturates the host. Unconfirmed. No firewall code, assertion, timeout or skip changed.
