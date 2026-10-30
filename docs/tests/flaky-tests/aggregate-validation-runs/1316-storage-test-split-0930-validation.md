# Storage test splits and writer-guard scan (todo 0930) branch validation

- **ID:** 1316
- **Status:** open
- **Date observed:** 2026-10-30
- **Branch:** `todo-0930-storage-test-files-8ccf873101e6`, at `dda88f007` on
  `main` `cd7bbe3e5` (test splits and the writer-guard scan change; docs
  uncommitted).
- **Command:** `mise run test`.
- **Duration:** about 370 s. Bridges and the Codex protocol lockfile passed.
  Workspace failed: backend 11,256 passed, 89 skipped, 1 failed (11,346 tests,
  784 files); web 10,837 passed, 10 skipped; desktop, protocol, CLI,
  toolchain and web-public passed. Root and agent-support failed: 3,304
  passed, 1 skipped, 1 failed (3,306 tests, 161 files, 285.98 s).
- **Host:** shared Linux host (12 cores), load average about 19–24 during the
  run, with other worktrees' suites running.
- **Evidence:** `/tmp/orkestrator-test-run.mitL4U` (compressed group logs).

| Unchanged owner | Aggregate failure | Complete owner rerun |
| --- | --- | --- |
| `apps/backend/tests/codex-subagent-cards.test.ts` | `each child keeps one card, its transcript and status across a fresh backend and a cold restart` expected `idle`, received `recovering` at line 170 (988.01 ms). | Passed alone, 4.0 s. See existing case 0310. |
| `tests/unit/mcp-fixture-cleanup.test.ts` | `MCP fixture cleanup contract > every test importing createFixture from MCP test-support awaits or returns cleanup` timed out after 5,000 ms (7,249.42 ms). | Passed alone, 2.6 s. |

The complete owner rerun commands were:

```bash
mise run test:logged -- --name codex-subagent-alone -- bun --cwd=apps/backend test tests/codex-subagent-cards.test.ts
mise run test:logged -- --name mcp-cleanup-alone -- bun test ./tests/unit/mcp-fixture-cleanup.test.ts
```

Both exited zero, run at load average about 12.7, without assertion,
deadline or skip changes. The branch touches neither owner nor anything they
import: its code changes are storage test files, their test-support modules
and the writer guard's analysis. Every storage test file and the writer guard
passed in this aggregate, including the raw-writer scan that case 1309
tracked.

The cold-restart status mismatch recurs in case 0310. The MCP cleanup
contract is a static scan, like the storage writer guard, so a CPU-bound
deadline miss at load 19–24 is the likely cause. That is a hypothesis, not
confirmed. These observations do not turn the failed aggregate into a pass.
