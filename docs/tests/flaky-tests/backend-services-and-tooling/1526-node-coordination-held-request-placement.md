# Node coordinator request still pending-inject after the finished turn (apps/backend/src/core/nodes/node-coordination.test.ts)

- **ID:** 1526
- **Status:** resolved
- **Date observed:** 2026-10-31
- **Test:** `a command node's deliverNow on this leaf > node coordinator requests stay pending while held, until injection` (`apps/backend/src/core/nodes/node-coordination.test.ts:348`)
- **Original command:** `mise run test:logged -- --name full-test -- mise run test` (default suite) on branch `todo-0039-mcp-management-d5f657bb2ee5` (base `931e5541`), Linux, with a `dev:test` profile running beside it; host load average 39–47.
- **Worker configuration:** the default runner's workspace group (`ORKESTRATOR_BACKEND_TEST_WORKERS` unset, so the backend workspace's default worker count).
- **Failure:** after `world.finishTurn(recipient)`, `toMatchObject({ placement: "injected" })` (lines 342–348) received the item still at `placement: "pending-inject"`, with `userReleasedAt` set and `revision: 2` (Expected −1 / Received +34), after 126 ms.
- **Suite counts:** the workspace group failed on this test plus an environmental Codex title-runner case (pinned Codex binary not installed on the host); the root, bridges and codex-protocol groups passed. A second full run did not reproduce it.
- **Isolated rerun:** `bun test --preload ../../tests/setup-node.ts ./src/core/nodes/node-coordination.test.ts` from `apps/backend` → passed (24 pass).
- **Hypothesis:** The same owner appears in aggregate case 1324 with an inject-placement mismatch under load. Here the hold was released (`userReleasedAt`) but the injection after the finished turn had not landed when the test read the item, which reads as the inject step completing after `finishTurn` returns under heavy load. No code in the branch touches `apps/backend/src/core/nodes/` or agent mail.

## Resolution (2026-11-10)

- **Root cause:** a test ordering race, the same one recorded in the
  Coordinator group's
  [1536](../coordinator-and-multi-review/1536-node-deliver-now-inject-placement-race.md)
  (and 1420, 1421, 1511). In the `held` variant the test sent "Uses the first
  wake budget." to a busy recipient and left it pending, with its busy
  backoff, when it released the second message. Under load the backoff
  expired and the next `finishTurn` drain delivered the first message
  instead, consuming the turn, so the released message stayed
  `pending-inject` with `userReleasedAt` set at revision 2: this case's
  exact record.
- **Fix:** already on `main`: `b965aea44` (#1547, merged 2026-11-01) settles
  the first delivery (`await world.finishTurn(recipient)`) before the second
  is sent and released (`node-coordination.test.ts`, "Settle this delivery
  before releasing another message"). This observation's base `931e5541`
  predates it (`git merge-base --is-ancestor b965aea44 931e5541` is false).
  No further change.
- **Reproduced:** yes, by 1536's resolution (2026-11-06): with the settle
  line removed the test failed 1 of 30 with the identical record. Not re-run
  here.
- **Stress:** `mise run test:logged -- --name stress-1526 -- bun
  scripts/test-under-contention.ts -- bun test --cwd apps/backend --preload
  ../../tests/setup-node.ts ./src/core/nodes/node-coordination.test.ts -t
  "stay pending while held" --rerun-each=100` passed (macOS, unpinned
  burners, host load ~35 to 55).
