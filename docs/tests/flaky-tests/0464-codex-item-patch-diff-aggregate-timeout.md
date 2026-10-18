# Codex patch diff aggregate timeout

- **ID:** 0464
- **Status:** open
- **Date observed:** 2026-10-18
- **File:** `bridges/codex-bridge/src/item-to-parts.test.ts`
- **Test:** `itemToParts > keeps apply_patch diffs scoped to each file_change invocation`
- **Original command:** `mise run test:logged -- --name merge-full-suite -- mise run test`, four aggregate groups with workspace/root/bridges/protocol reservations of 4/1/2/1; bridge tasks used one worker each. Codex group: 2227 passed, 4 failed across 82 files.
- **Evidence:** `orkestrator-test-run.LitzDV/bridges.log.gz` (under the platform temporary directory).
- **Failure:** The case exceeded its 30-second deadline (30000.83 ms).
- **Isolated reruns:** The first owning-file run failed before tests because port 65456 was in use. `PORT=0 mise run test:logged -- --name merge-item-to-parts-free-port -- bun test --cwd bridges/codex-bridge ./src/item-to-parts.test.ts --parallel=1 --only-failures` then passed unchanged, exit 0, 1.4 s.
- **Assessment:** Aggregate scheduling or child startup latency is unconfirmed. The separate port collision was avoided with an ephemeral port; no source, assertion or timeout changed.
