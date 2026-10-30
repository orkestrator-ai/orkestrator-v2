# Second backend on one host (todo 0244) branch validation

- **ID:** 1316
- **Status:** open
- **Date observed:** 2026-10-30
- **Branch:** `todo-0244-second-backend-one-host-1bf2521d817d`, base
  `cd7bbe3e5`. The branch changes the Control MCP port rule and bind retry
  (`control-mcp-server.ts`, `core/index.ts`, `data-dir.ts`), the instance
  descriptor (`packages/protocol/src/backend-instance.ts`,
  `instance-descriptor.ts`, `main.ts`), their tests and docs. No owner below
  changed or depends on those files.

## Run: `mise run test`

- **Host admission:** other worktrees' suites ran at the same time; load
  average 45 to 77 when the run finished. The groups finished in 740 s. The
  codex protocol lockfile group passed; the workspace, root and bridges groups
  each failed one test.
- **Evidence:** `orkestrator-test-run.6ZoAlz/` and
  `orkestrator-test-run.GJpNxY/` under the host temporary directory.

| Owner | Aggregate failure | Rerun |
| --- | --- | --- |
| `bridges/codex-bridge/src/commands/codex-command-catalogue.test.ts` | `a cold app-server child > an explicit refresh cannot replace the baseline for an already armed delay`: expected `stale`, received `ready` (80.7 ms). Recurrence of [0800](../agent-bridges/0800-codex-command-catalogue-armed-delay-race.md). | Passed alone (`bun test --cwd bridges/codex-bridge ./src/commands/codex-command-catalogue.test.ts --parallel=2`). |
| `tests/unit/disk-report.test.ts` | `disk report > reports an isolated checkout and only fixes named legacy Turbo artifacts` timed out after 5,000 ms with a null subprocess status. Recurrence of [0259](../environments-and-containers/0259-disk-report-aggregate-timeout.md). | Failed the same way with `--parallel=2`; with `--parallel=1 --only-failures` it passed once (5.3 s) and timed out once (6.3 s) under the same load. |
| `apps/backend/tests/container-replacement-inputs.test.ts` | `migration binds fresh read-only Codex inputs and retains the source revision` timed out after 5,000 ms. | Passed alone (`bun test --cwd apps/backend ./tests/container-replacement-inputs.test.ts --parallel=2`, 2.6 s). |

The first aggregate run on this branch failed only the branch's own new
`control-mcp-port.test.ts` (a test race between the listener's `running` flag
and its state notification); the test now waits for the notification and
passed five solo runs. No implementation, assertion, wait, timeout or skip in
the owners above changed.
