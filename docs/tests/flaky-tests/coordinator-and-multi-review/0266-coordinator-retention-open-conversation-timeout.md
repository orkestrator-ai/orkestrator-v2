# Coordinator retention keeps an open conversation — aggregate timeout

- **ID:** 0266
- **Test:** `project coordinator > retention never removes an open conversation`
  (`apps/backend/src/core/coordinator-service.test.ts:136`)
- **Status:** resolved
- **Date observed:** 2026-10-16
- **Original command:** GitHub Actions run 38893136380 (`pull_request`,
  branch `multi-review-flow-graph-followups`, head `fa45dcef`), job "Unit and
  integration tests", group `workspace (web, backend, desktop, web-public, cli,
  protocol, toolchain)`; `@orkestrator/backend:test:workspace` ran
  `bun test --preload ../../tests/setup-node.ts src tests --only-failures --parallel=${ORKESTRATOR_TEST_WORKERS:-2}`.
- **Worker configuration:** backend used two parallel Bun workers inside the
  workspace group, which ran alongside the bridges, protocol and root groups.
- **Failure:** `this test timed out after 5000ms`, reported at 5022.97 ms.
- **Suite counts:** backend 8,385 passed, 3 failed across 8,430 tests in 449
  files (759.14 s). The other two failures were
  [0267](../design-canvas-and-artifacts/0267-design-pruned-receipt-token-timeout.md) and the
  `design service ... reset through changes()` case
  [0218](../design-canvas-and-artifacts/0218-design-service-replay-aggregate-timeout.md). The run predates
  the 0218 fix in #1038.
- **Earlier observation:** the same case timed out locally at 5196.81 ms during
  coordinator launch-defaults validation, recorded with other backend fixtures
  in [0255](../aggregate-validation-runs/0255-backend-fixtures-launch-defaults-validation.md).
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts -t "retention never removes" --rerun-each 5`
  (from `apps/backend`) → passed unchanged, 1.53–1.69 s per run (JUnit
  timings).
- **Root cause:** a test-cost issue, not a retention bug. To reach the
  64-conversation boundary, the test ran 64 complete `createConversation` /
  `closeConversation` cycles: 128 serialized durable workspace writes, each
  with workspace reads, canonical project-path resolution, attachment-directory
  pruning and snapshot assembly. Alone, that took about 1.6 s. Under aggregate
  CI load, it reached the generic 5 s deadline. The sibling attachment
  retention test had already been rewritten for the same reason.
- **Fix:** this branch. One real create/close cycle supplies a genuine closed
  conversation. A single `storage.mutateCoordinatorWorkspace` call then fills
  the boundary: the original open conversation, the closed one and 62 closed
  clones, for 64 in total. Three more real create/close cycles then run
  `retainCoordinatorConversations` at the boundary. The assertions are now
  stronger. The conversation count stays at 64 and the original conversation
  remains open. The three oldest closed conversations (`oldestClosedId`,
  `closed-0` and `closed-1`) are evicted, while `closed-2` and the newest
  closed conversation are kept. The production code and deadline are
  unchanged.
- **Verification:**
  - Alone: `--rerun-each 5` before 1.53–1.69 s per run; after, 0.19–0.20 s
    per run. Ran `--rerun-each 10` after the change: 10 pass.
  - Full owning file: `bun test --preload ../../tests/setup-node.ts ./src/core/coordinator-service.test.ts --rerun-each 2`
    passed three times (96 pass, 34–40 s). One earlier run reported
    `1 fail, 1 error` while other agents were testing in parallel on the host.
    Its output was not captured, and the next three runs passed.
  - CPU stress: 18 `yes` burners on 18 cores, the pre-change and changed
    files (`--rerun-each 5`), the 0267 pair, and `design/history.test.ts` plus
    `design/sync.test.ts` all ran concurrently. Before: 1.74–2.40 s per run.
    After: 0.23–0.46 s per run. No failures.
  - `oxfmt --check`, `oxlint` and `tsc --noEmit -p tsconfig.json` /
    `tsconfig.test.json` in `apps/backend` passed.
