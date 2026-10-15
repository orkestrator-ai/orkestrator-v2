# Codex escalation restart backstop timing

- **ID:** 0212
- **Status:** open
- **Date observed:** 2026-10-15
- **Test:** `session lifecycle > a failed escalation restart keeps the guard and re-arms the backstop` in `bridges/codex-bridge/src/app-server-runtime-lifecycle.test.ts:907`.
- **Original command:** `mise run test:logged -- --name full-tests -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reserved 4/1/2/1 slots on a shared 18-slot host. The Codex package used one isolated Bun worker.
- **Failure:** after an 80 ms wait, `restartAttempts` was 1 instead of greater than 1; reported test duration 103.80 ms. The Codex package reported 2048 passed, 22 skipped and 1 failed across 75 files.
- **Isolated rerun:** `mise run test:logged -- --name codex-lifecycle-isolation -- bun test ./bridges/codex-bridge/src/app-server-runtime-lifecycle.test.ts --parallel=1 --only-failures` passed unchanged (exit 0) in 1.6 seconds.
- **Evidence:** `/tmp/orkestrator-test-run.VSQjnP/bridges.log` (compressed after aggregate completion).
- **Hypothesis:** timer delivery under concurrent host load exceeded the test's short observation window. The tmux socket cleanup change does not modify bridge lifecycle code. The cause remains unconfirmed; no assertion, timeout or skip was changed.
