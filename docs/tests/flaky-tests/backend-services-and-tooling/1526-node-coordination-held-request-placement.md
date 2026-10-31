# Node coordinator request still pending-inject after the finished turn (apps/backend/src/core/nodes/node-coordination.test.ts)

- **ID:** 1526
- **Status:** open
- **Date observed:** 2026-10-31
- **Test:** `a command node's deliverNow on this leaf > node coordinator requests stay pending while held, until injection` (`apps/backend/src/core/nodes/node-coordination.test.ts:348`)
- **Original command:** `mise run test:logged -- --name full-test -- mise run test` (default suite) on branch `todo-0039-mcp-management-d5f657bb2ee5` (base `931e5541`), Linux, with a `dev:test` profile running beside it; host load average 39–47.
- **Worker configuration:** the default runner's workspace group (`ORKESTRATOR_BACKEND_TEST_WORKERS` unset, so the backend workspace's default worker count).
- **Failure:** after `world.finishTurn(recipient)`, `toMatchObject({ placement: "injected" })` (lines 342–348) received the item still at `placement: "pending-inject"`, with `userReleasedAt` set and `revision: 2` (Expected −1 / Received +34), after 126 ms.
- **Suite counts:** the workspace group failed on this test plus an environmental Codex title-runner case (pinned Codex binary not installed on the host); the root, bridges and codex-protocol groups passed. A second full run did not reproduce it.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/nodes/node-coordination.test.ts` from `apps/backend` → passed (24 pass).
- **Hypothesis:** The same owner appears in aggregate case 1324 with an inject-placement mismatch under load. Here the hold was released (`userReleasedAt`) but the injection after the finished turn had not landed when the test read the item, which reads as the inject step completing after `finishTurn` returns under heavy load. No code in the branch touches `apps/backend/src/core/nodes/` or agent mail.
