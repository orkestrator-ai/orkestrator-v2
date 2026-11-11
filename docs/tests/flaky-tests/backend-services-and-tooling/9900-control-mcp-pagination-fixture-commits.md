# MCP aggregate pagination fixture timeout

- **ID:** 9900
- **Status:** resolved
- **Date observed:** 2026-11-07
- **Base commit:** `148e9ad0aac93b0f363af93e33543b73be36ee40`
- **Observed head:** `4c7c2fc9551ebf7a0c19a8f71e320c8a4c32e242`
- **Test:** `aggregate MCP regressions > legacy and voice lists drain over 200 leaf projects and environments`
- **File:** `apps/backend/src/core/control-mcp/leaf-nodes.test.ts`
- **Original command:** `mise run test:logged -- --name review-default-tests -- mise run test`
- **Worker configuration:** default concurrent workspace/root/bridge/protocol aggregate; backend package uses its planned worker pool.
- **Failure:** test timed out at 5229.90 ms against its 5000 ms limit; the in-flight list-projects RPC then rejected with ECONNRESET during cleanup. Nearby storage diagnostics show 3069 ms durable transactions. The test seeded 201 projects and 201 environments through separate durable operations before exercising pagination.
- **Suite counts:** backend 16974 tests; 1 failure and 1 between-tests error. The review package reports five named failures overall; the four root guard/ownership failures are separate, unrelated failures.
- **Evidence:** `.orkestrator/review-artifacts/review-validation-cba8cc51-0777-4f33-8593-91e98c378a78/validation-04.stderr.txt`, lines 266–290.
- **Isolated rerun before repair:** `mise run test:logged -- --name address-mcp-owner -- bun test --cwd apps/backend ./src/core/control-mcp/leaf-nodes.test.ts --parallel=1 --only-failures` passed (1.6 s).

## Resolution (2026-11-07)

- **Root cause:** pagination coverage included 402 independent fixture writes, making its setup depend on durable-write latency rather than pagination progress. The recorded aggregate shows multi-second storage commits; no ticket merge code runs in the pagination scenario.
- **Fix:** seed the existing and additional project/environment arrays with `seedStore`, once per store. Keep all pagination, cross-node, voice-resolution and count assertions and the original timeout.
- **Reproduced:** no — the original aggregate failure is captured, and the unchanged owner passed alone; host contention was not recreated before repair. Removing the unnecessary commits directly reduces the recorded setup cost, but does not prove every possible aggregate timeout is eliminated.
- **Stress:** `mise run test:logged -- --name address-mcp-repeat -- bun test --cwd apps/backend ./src/core/control-mcp/leaf-nodes.test.ts --parallel=1 --rerun-each=10 --only-failures` passed all ten repetitions of the complete owner in 12.1 s. The runtime/MCP two-owner run also passed in 1.6 s. Aggregate validation is recorded in the Address Findings result.
