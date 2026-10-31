# Named summary due job counts a scheduler the full diagnostics registry dropped (apps/backend/src/core/nodes/node-read-model.test.ts)

- **ID:** 1316
- **Status:** open
- **Date observed:** 2026-10-30
- **Test:** `named summary due job reconciles missed events and stops with the model` (`apps/backend/src/core/nodes/node-read-model.test.ts:86`)
- **Original command:** `bun test src/core/nodes src/core/coordinator-deliver-now.test.ts src/core/commands-registry-coordinator-nodes.test.ts src/core/commands-registry-coordinator.test.ts src/core/control-mcp-server.test.ts src/core/control-mcp-nodes.test.ts src/core/control-mcp-node-auth.test.ts src/core/agent-mail-service.test.ts src/core/storage-agent-mail.test.ts tests/gateway-command-nodes.test.ts` from `apps/backend` (one Bun process, default workers), on macOS during todo 0740.
- **Worker configuration:** Bun 1.4.4 default; all listed files in one process.
- **Failure:** `expect(summarySchedulers()).toBe(before + 1)` at line 112: `Expected: 32`, `Received: 31` (duration: 2.76 ms to 5.18 ms).
- **Suite counts:** 466 total, 465 passed, 1 failed (twice on the 0740 branch); 455 total, 454 passed, 1 failed with the same command on the branch's base `cd7bbe3e` code (the 0740 code changes set aside), so the branch did not cause it.
- **Isolated rerun:** `bun test src/core/nodes/node-read-model.test.ts` from `apps/backend` → passed (11 pass) three times in a row.
- **Hypothesis:** The process-global `recurringDiagnosticsRegistry` (`apps/backend/src/core/recurring-diagnostics.ts`) admits at most `MAX_DIAGNOSTIC_SOURCES` (32) schedulers and pools together, and `add` silently drops a source past that (`droppedSources += 1`). Earlier files in the same process leave schedulers registered: `before` read 31, so with at least one pool also registered the model's `node-summary-reconcile` scheduler was dropped and the count stayed at 31. Alone, few sources are registered and it is admitted. Not confirmed which earlier files leak the 31 sources.
