# Design pruned-receipt token never executes — aggregate timeout

- **ID:** 0267
- **Test:** `design operations: prepare, execute, status and cancel > unknown and
  expired tokens never execute, even after their receipt is pruned`
  (`apps/backend/src/core/design/operations.test.ts:363`)
- **Status:** resolved
- **Date observed:** 2026-10-16
- **Original command:** GitHub Actions run 38893136380 (`pull_request`,
  branch `multi-review-flow-graph-followups`, head `fa45dcef`), job "Unit and
  integration tests", group `workspace (web, backend, desktop, web-public, cli,
  protocol, toolchain)`; `@orkestrator/backend:test:workspace` ran
  `bun test --preload ../../tests/setup-node.ts src tests --only-failures --parallel=${ORKESTRATOR_TEST_WORKERS:-2}`.
- **Worker configuration:** backend used two parallel Bun workers inside the
  workspace group, which ran alongside the bridges, protocol and root groups.
- **Failure:** `this test timed out after 5000ms`, reported at 5016.03 ms.
- **Suite counts:** backend 8,385 passed, 3 failed across 8,430 tests in 449
  files (759.14 s). The other failures were
  [0266](../coordinator-and-multi-review/0266-coordinator-retention-open-conversation-timeout.md) and
  [0218](0218-design-service-replay-aggregate-timeout.md).
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/design/operations.test.ts -t "unknown and expired" --rerun-each 5`
  (from `apps/backend`) → passed unchanged, 1.21–1.70 s per run. The whole
  file took 2.4 s (22 pass).
- **Root cause:** this belongs to the same class as
  [0193](0193-design-sync-gap-aggregate-timeout.md),
  [0215](0215-design-operation-replay-event-count.md) and
  [0218](0218-design-service-replay-aggregate-timeout.md). The test pushed the
  expired receipt out of the bounded list with `DESIGN_LIMITS.receiptsPerCanvas + 1`
  (129) sequential, fsynced `mutate` commits against the generic 5 s deadline.
  Each commit also writes a history checkpoint. The token, expiry and
  pruning logic run in microseconds. The cost was the commit count.
- **Fix:** this branch. The loop runs inside
  `withDesignLimit("receiptsPerCanvas", 4, ...)`, so it makes 5 real commits
  instead of 129. The test now also asserts that the persisted record holds
  exactly 4 receipts, which proves that the lowered bound pruned it. Every
  original assertion is kept: an unknown token returns `unknown`, a malformed
  token throws, an expired token returns `expired` idempotently, and after
  pruning the token returns `unknown` without moving the frame. Pruning at the
  shipped 128 bound is still covered in memory by `records.test.ts` ("the count
  bound drops the oldest receipts and their digests together"). The deadline
  and production code are unchanged.
- **Verification:**
  - Alone: `--rerun-each 5` before 1.21–1.70 s per run. With
    `--rerun-each 10` after the change: 10 pass, 0.05–0.09 s per run.
  - All design tests: `bun test --preload ../../tests/setup-node.ts ./src/core/design/ --rerun-each 2`
    → 378 pass, 0 fail across 12 files (24.7 s).
  - CPU stress: 18 `yes` burners on 18 cores, the pre-change and changed
    files (`--rerun-each 5`), the 0266 pair, and `design/history.test.ts` plus
    `design/sync.test.ts` all ran concurrently. Before: 0.89–1.76 s per run.
    After: 0.04–0.14 s per run. No failures.
  - `oxfmt --check`, `oxlint` and `tsc --noEmit -p tsconfig.json` /
    `tsconfig.test.json` in `apps/backend` passed.
