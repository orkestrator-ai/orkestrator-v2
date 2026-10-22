# Codex overlapping generation recovery observation window

- **ID:** 0463
- **Status:** open
- **Date observed:** 2026-10-18
- **File:** `bridges/codex-bridge/src/app-server-runtime-lifecycle.test.ts`
- **Test:** `crash recovery > overlapping generation changes recover one pass at a time`
- **Original command:** `mise run test:logged -- --name merge-full-suite -- mise run test`, four aggregate groups with workspace/root/bridges/protocol reservations of 4/1/2/1; bridge tasks used one worker each. Codex group: 2227 passed, 4 failed across 82 files.
- **Evidence:** `orkestrator-test-run.LitzDV/bridges.log.gz` (under the platform temporary directory).
- **Failure:** Expected `[start:1, end:1, start:2, end:2]`, received the same sequence without `end:2` at line 3448 after an 80 ms observation window (208.41 ms case duration).
- **Isolated rerun:** `mise run test:logged -- --name merge-rerun-app-server-runtime-lifecycle -- bun test --cwd bridges/codex-bridge ./src/app-server-runtime-lifecycle.test.ts --parallel=1 --only-failures`: passed unchanged, exit 0, 2.3 s.
- **Assessment:** Recovery timing under aggregate load is a hypothesis; no assertion or timeout changed.
