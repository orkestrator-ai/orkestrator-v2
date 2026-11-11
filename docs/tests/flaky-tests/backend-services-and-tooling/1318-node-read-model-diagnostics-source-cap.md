# Named summary due job counts a scheduler the full diagnostics registry dropped (apps/backend/src/core/nodes/node-read-model.test.ts)

- **ID:** 1318
- **Status:** resolved
- **Date observed:** 2026-10-30
- **Test:** `named summary due job reconciles missed events and stops with the model` (`apps/backend/src/core/nodes/node-read-model.test.ts:86`)
- **Original command:** `bun test src/core/nodes src/core/coordinator-deliver-now.test.ts src/core/commands-registry-coordinator-nodes.test.ts src/core/commands-registry-coordinator.test.ts src/core/control-mcp/server.test.ts src/core/control-mcp/nodes.test.ts src/core/control-mcp/node-auth.test.ts src/core/agent-mail-service.test.ts src/core/storage-agent-mail.test.ts tests/gateway-command-nodes.test.ts` from `apps/backend` (one Bun process, default workers), on macOS during todo 0740.
- **Worker configuration:** Bun 1.4.4 default; all listed files in one process.
- **Failure:** `expect(summarySchedulers()).toBe(before + 1)` at line 112: `Expected: 32`, `Received: 31` (duration: 2.76 ms to 5.18 ms).
- **Suite counts:** 466 total, 465 passed, 1 failed (twice on the 0740 branch); 455 total, 454 passed, 1 failed with the same command on the branch's base `cd7bbe3e` code (the 0740 code changes set aside), so the branch did not cause it.
- **Isolated rerun:** `bun test src/core/nodes/node-read-model.test.ts` from `apps/backend` → passed (11 pass) three times in a row.
- **Hypothesis:** The process-global `recurringDiagnosticsRegistry` (`apps/backend/src/core/recurring-diagnostics.ts`) admits at most `MAX_DIAGNOSTIC_SOURCES` (32) schedulers and pools together, and `add` silently drops a source past that (`droppedSources += 1`). Earlier files in the same process leave schedulers registered: `before` read 31, so with at least one pool also registered the model's `node-summary-reconcile` scheduler was dropped and the count stayed at 31. Alone, few sources are registered and it is admitted. Not confirmed which earlier files leak the 31 sources.

## Resolution (2026-11-10)

- **Root cause:** confirmed as hypothesised, with the leak located. Most node
  tests build a `TestNodeNetwork` and never stop it. Each node's
  `NodePortal` starts a `NodeReadModel` whose `node-summary-reconcile` job
  registers in the process-wide `recurringDiagnosticsRegistry`, which admits
  32 scheduler and pool sources in total and drops the rest. In a run without
  file isolation the leaked jobs fill the table. Instrumenting
  `NodeReadModel.start`/`stop` in the one-process `src/core/nodes` run found
  138 models still running when this test began, started by
  `node-handover` (41), `node-portal` (29), `node-event-relay` (14),
  `node-link` (14), `node-event-stream` (2) and `node-read-model` (2) tests,
  and 36 more started from asynchronous paths; the snapshot showed 31
  admitted summary schedulers and 185 dropped sources, so this test's own job
  was refused. Timers outliving their test break invariant 15 in `AGENTS.md`.
  The default suite isolates files, which is why it surfaced only in focused
  one-process runs.
- **Fix:** `node-network-test-support.ts` tracks networks until `stop()` and
  exports `stopTestNodeNetworks()`; `node-handover`, `node-portal`,
  `node-event-relay`, `node-link`, `node-event-stream` and `node-read-model`
  tests call it in `afterEach`. No assertion changed.
- **Reproduced:** yes — the original one-process command (`cd apps/backend &&
  bun test --preload ../../tests/setup-node.ts src/core/nodes
  src/core/coordinator-deliver-now.test.ts ... tests/gateway-command-nodes.test.ts`,
  run as `mise run test:logged -- --name repro-1318`) failed this test
  deterministically (`Expected: 32 / Received: 31`; 682 pass, 1 fail), as did
  `bun test --preload ../../tests/setup-node.ts src/core/nodes` alone (467
  pass, 1 fail). After the fix the same command (`fixed-1318`) passed.
- **Stress:** `mise run test:logged -- --name nodes-touched -- bash -c 'cd
  apps/backend && bun test --preload ../../tests/setup-node.ts` with the six
  touched owners and `node-network-test-support.test.ts` `--parallel=4
  --rerun-each=3'` passed, so stopping an already-stopped network is safe.
