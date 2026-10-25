# Live provider review fixes: backend timing failures in repository validation

- **ID:** 0887
- **Status:** open
- **Date observed:** 2026-10-25
- **Change under test:** `2238f5ec4` on
  `todo-0031-live-provider-qualification-8ba0df8f1372`: isolated-toolchain
  documentation, an OpenCode failure hint and feature-title naming coverage.
  None of the five failing owners or their implementations changed.
- **Original command:** `mise run test:logged -- --name review-suite -- mise run test`.
- **Worker configuration:** workspace/root/bridges/protocol reservations
  4/1/2/1; backend used two isolated Bun workers. Other worktrees occupied
  the shared host's 18 worker slots; workspace admission waited 606.5 s.
- **Aggregate result:** exit 1 after 1430.1 s logged. Backend: 11,443 passed,
  89 skipped, five failed across 11,537 tests and 680 files (781.21 s), with
  a late terminal-history assertion between tests. Every other workspace
  package, root/support, bridges and protocol regeneration passed.
- **Failure evidence:**
  `/var/folders/hc/8ntcxqnj4916wj9cxy6vx16c0000gn/T/orkestrator-test-run.IsKFbW/workspace-web-backend-desktop-web-public-cli-protocol-toolchain.log.gz`.
  Outer runner evidence is in `orkestrator-test-run.C5AhgB` under the same
  temporary directory.

| Owning file under `apps/backend/src/core/` | Failing test | Aggregate failure | Complete unchanged owner rerun |
| --- | --- | --- | --- |
| `review-validation-worker.test.ts` | `cooperative parallel groups do not multiply queue or execution deadlines` | Expected `passed`, received `incomplete`; 1668.06 ms. Recurrence of [0227](../coordinator-and-multi-review/0227-validation-cooperative-groups-incomplete.md). | Exit 0, 38.5 s. |
| `commands-state-sync.test.ts` | `durable tab teardown commands > times out a hanging provider delete without blocking other intents` | Elapsed bound expected less than 250 ms, received 261.32 ms; test 292.36 ms. Recurrence of [0460](../backend-services-and-tooling/0460-tab-teardown-hanging-delete-elapsed-bound.md). | Exit 0, 11.0 s. |
| `terminal-history.test.ts` | `terminal history > pages fixed history backwards and rejects a cursor for another history` | Five-second timeout at 5001.45 ms; late work expected `row-1250`, received `undefined`. Recurrence of [0213](../backend-services-and-tooling/0213-terminal-history-aggregate-timeout.md). | Exit 0, 7.5 s. |
| `storage-kanban-concurrency.test.ts` | `StorageService Kanban mutation serialization > validates initial status and appends direct creations to each project column` | Five-second timeout at 5367.72 ms. | Exit 0, 0.8 s. |
| `native-agent-service-summary-transcripts.test.ts` | `revised rows before the window > are projected like window rows, resolve their details, and deltas mirror them` | Five-second timeout at 5193.31 ms. | Exit 0, 0.7 s. |

Each rerun selected exactly one complete owner with the Node preload and one
isolated Bun worker. Exact commands:

```sh
mise run test:logged -- --name review-worker-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/review-validation-worker.test.ts --parallel=1 --only-failures
mise run test:logged -- --name state-sync-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/commands-state-sync.test.ts --parallel=1 --only-failures
mise run test:logged -- --name terminal-history-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/terminal-history.test.ts --parallel=1 --only-failures
mise run test:logged -- --name kanban-concurrency-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/storage-kanban-concurrency.test.ts --parallel=1 --only-failures
mise run test:logged -- --name summary-transcripts-isolated -- bun test --cwd apps/backend --preload ../../tests/setup-node.ts ./src/core/native-agent-service-summary-transcripts.test.ts --parallel=1 --only-failures
```

The unchanged owners' isolated passes establish intermittent behavior. Shared
host contention is a hypothesis, not a confirmed root cause. No implementation,
assertion, timeout or skip in these owners changed. The original aggregate
remains failed. The focused feature-build/resolver tests, both OpenCode hint
branches, and repository format/lint/type checks passed. Live-provider and
browser scenarios were not selected for documentation, diagnostic and backend
test-only changes.
