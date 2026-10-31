# Storage test splits and writer-guard scan (todo 0930) branch validation

- **ID:** 1324
- **Status:** open
- **Date observed:** 2026-10-30
- **Branch:** `todo-0930-storage-test-files-8ccf873101e6` on `main`
  `cd7bbe3e5`: first run at `dda88f007` (test splits and the writer-guard scan
  change; docs uncommitted), second at `d5091591d` (docs only since). The
  branch was then rebased onto `main` `f32615aff`, which touches no storage
  code; those commits are now `b64a2b224` and `559ba28af`.
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

## Second run, 2026-10-30

`mise run test` at `d5091591d` (the change since the first run is docs only).
The host was far busier: the run took 1,531 s against about 370 s, with load
average about 20–33 while it ran. Root and agent-support (which failed in the
first run), bridges and the protocol lockfile passed. Workspace failed:
backend 11,256 passed, 89 skipped, 1 failed (11,346 tests, 784 files); web
10,835 passed, 10 skipped, 2 failed. Evidence:
`/tmp/orkestrator-test-run.xdiVPX`.

| Unchanged owner | Aggregate failure | Complete owner rerun |
| --- | --- | --- |
| `apps/backend/src/core/nodes/node-coordination.test.ts` | `UP-02/CO-05 collected leaf mail reaches the coordinator on the command node > an item for a known conversation lands in that coordinator's mailbox, then is acknowledged` expected placement `pending-inject`, received `injected` at line 308 (177.93 ms). | Passed alone, 3.1 s. |
| `apps/web/src/components/native-agent/AgentNativeTab.commands.test.tsx` | `AgentNativeTab commands > typing after the sigil filters a maximal list without fetching, refreshing or scanning` (5,036.06 ms, over its 5,000 ms deadline). | Passed alone, 7.0 s for the file. See existing case 0722. |
| `apps/web/src/components/federation/node-action-requests.test.tsx` | `root-change approval handles over-limit and still permits rejection` timed out after 5,000 ms (6,251.48 ms). | Passed alone, 5.7 s for the file. Same failure as case 1313. |

```bash
mise run test:logged -- --name node-coordination-alone -- bun --cwd=apps/backend test src/core/nodes/node-coordination.test.ts
mise run test:logged -- --name agent-native-commands-alone -- bun test --cwd apps/web ./src/components/native-agent/AgentNativeTab.commands.test.tsx --parallel=1 --only-failures
mise run test:logged -- --name node-action-requests-alone -- bun test --cwd apps/web ./src/components/federation/node-action-requests.test.tsx --parallel=1 --only-failures
```

All three exited zero, run at load average about 9, without assertion,
deadline or skip changes. The node-coordination mismatch reads as a race: the
inject completed before the test read the placement. That is a hypothesis, not
confirmed. The branch changes no production code, and every storage test and
the writer guard passed in both runs. Neither run is a green aggregate.


## Goal review repair recurrence — 2026-10-31

The unrelated node-coordination owner again failed an injection-placement
assertion in the full `mise run test` run: `a command node's deliverNow on this
leaf > node coordinator requests stay pending while held, until injection`,
line 348 (315.91 ms). The complete unchanged owner passed alone in 2.4 s:

```sh
mise run test:logged -- --name goal-node-owner -- bun test --cwd apps/backend ./src/core/nodes/node-coordination.test.ts --parallel=1 --only-failures
```

Evidence: `orkestrator-test-run.Zau4wx/review-tests.log.gz` in the host temporary
directory. This establishes a recurrence that passes alone, not a cause or fix.
No assertion, timeout, skip or node-coordination implementation changed.
