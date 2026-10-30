# Container start poll quantisation (todo 0870) branch validation

- **ID:** 1316
- **Status:** open
- **Date observed:** 2026-10-30
- **Branch:** `todo-0870-container-start-polling-ad6103f1e6b0`, uncommitted
  changes on `cd7bbe3e5`.
- **Command:** `mise run test:logged -- --name mise-test -- mise run test`.
- **Duration:** 1,635 s for the groups, most of it queued behind other
  worktrees' aggregate runs. Bridges and the Codex protocol lockfile passed.
  Workspace failed: backend 11,262 passed, 89 skipped, one failed; web,
  desktop, protocol, toolchain, CLI and web-public passed. Root and
  agent-support: 3,304 passed, one skipped, one failed.
- **Host:** omarchy-hp, 12 CPUs, load average about 20 to 28 during the run,
  with several other worktrees' aggregate and browser suites running.
- **Evidence:** `/tmp/orkestrator-test-run.fSibuj` (compressed group logs).

| Unchanged owner | Aggregate failure | Complete owner rerun |
| --- | --- | --- |
| `apps/backend/src/core/storage-writer-guards.test.ts` | `raw StorageDatabase writers outside StorageService > name the store they write` exceeded its 5,000 ms deadline (7,063.26 ms). | Passed alone, 5.2 s for the complete file. See existing case 1309. |
| `tests/unit/mcp-fixture-cleanup.test.ts` | `MCP fixture cleanup contract > every test importing createFixture from MCP test-support awaits or returns cleanup` exceeded its 5,000 ms deadline (6,595.40 ms). | Passed alone, 2.3 s. |

The complete owner rerun commands were:

```bash
mise run test:logged -- --name storage-writers-alone -- bun test --cwd apps/backend ./src/core/storage-writer-guards.test.ts
mise run test:logged -- --name mcp-fixture-alone -- bun test ./tests/unit/mcp-fixture-cleanup.test.ts
```

Both exited zero without assertion, deadline, or skip changes.

Both are source scans with the default 5 s deadline, and neither reads the
files the branch changes (`container-readiness.ts`, `egress-gateway.ts` and
their tests). The failures are consistent with shared-host contention. They
do not establish a root cause or turn the failed aggregate into a pass.
