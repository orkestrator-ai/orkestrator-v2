# Codex escalation restart backstop timing

- **ID:** 0214
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `session lifecycle > a failed escalation restart keeps the guard and re-arms the backstop` in `bridges/codex-bridge/src/app-server-runtime-lifecycle.test.ts:907`.
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots on a shared 18-slot host. The Codex package used one isolated Bun worker.
- **Failure:** after an 80 ms wait, `restartAttempts` was 1 instead of greater than 1; reported test duration 103.80 ms. The Codex package reported 2048 passed, 22 skipped and 1 failed across 75 files.
- **Isolated rerun:** `mise run test:logged -- --name codex-lifecycle-isolation -- bun test ./bridges/codex-bridge/src/app-server-runtime-lifecycle.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 1.6 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.VSQjnP/bridges.log` (compressed after aggregate completion).
- **Hypothesis:** timer delivery under concurrent host load exceeded the test's short observation window. The tmux socket cleanup change does not modify bridge lifecycle code. The cause remains unconfirmed; no assertion, timeout or skip was changed.

## Recurrence — 2026-10-16

- **Change:** Multi Review graph breakpoint/zoom containment and transcript-tail freshness, plus read-only Pi SDK and concurrent finding-cap regression coverage; no Codex lifecycle code changed.
- **Command:** `mise run test:logged -- --name full-suite -- mise run test`.
- **Failure:** the same assertion at line 907 observed one restart after 80 ms (140.71 ms test duration). The shared host was running other worktrees; this run reserved 4/1/2/1 workspace/root/bridge/protocol slots and used one isolated worker per bridge.
- **Owning-file rerun:** `mise run test:logged -- --name codex-lifecycle-rerun -- bun test ./bridges/codex-bridge/src/app-server-runtime-lifecycle.test.ts --parallel=1 --only-failures` passed unchanged in 2.5 seconds (exit 0).
- **Evidence:** `/tmp/orkestrator-test-run.1PZf4j/bridges.log.gz` after aggregate finalization.
- The timer-delivery hypothesis remains unconfirmed; no assertion, timeout or skip was changed.

## Recurrence — 2026-10-17

- **Change:** Codex refused-cell rollout recovery and coordinator conformance evidence. The failing test and restart-backstop implementation are unchanged.
- **Command:** `mise run test:logged -- --name full-suite -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots on the shared 18-slot host; Codex used one isolated Bun worker. The bridge group waited 426.6 seconds for capacity.
- **Failure:** line 907 observed `restartAttempts = 1` after the 80 ms observation window; test duration 136.08 ms. Codex reported 2215 passed, 34 skipped and 1 failed across 81 files.
- **Owning-file rerun:** `mise run test:logged -- --name lifecycle-isolated -- bun test ./bridges/codex-bridge/src/app-server-runtime-lifecycle.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 2.0 seconds.
- **Evidence:** `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.nN9Z1G/bridges.log.gz` after aggregate finalization.
- The repeated failure matches the existing timer-delivery hypothesis under host contention. No assertion, timeout or skip was changed.

The entire Codex package subsequently passed with
`mise run test:logged -- --name codex-package-rerun -- bun run --cwd bridges/codex-bridge test:bridge`
(exit 0, 39.0 seconds). The aggregate finished with the backend-only recurrences
recorded in 0211 and 0247; root/support and protocol passed.
