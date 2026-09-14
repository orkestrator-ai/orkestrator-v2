# `ACP bridge > rejects a concurrent second turn that carries a different requestId` (`bridges/acp-bridge/src/index.test.ts:4956`)

- **ID:** 0125
- **Status:** resolved
- **Date observed:** 2026-08-15
- **Original command:** `bun run test:logged -- --name full-suite -- bun run test`, at `5f1d23c525b47c2f0ed8ffc7b8d73cb951a5fad2` on `activate-agent-tab`.
- **Worker configuration:** The bridges group ran `bun test bridges --parallel` alongside the workspace, root, and protocol-lockfile groups under `scripts/test-all.ts`'s bounded pools.
- **Failure:** `error: Timed out waiting for ACP state: false` (duration 5,007.20 ms), thrown from the file's own `waitFor` helper (`index.test.ts:113`) as called by `spawnBridge` (`index.test.ts:158`) — that is, the spawned bridge child never reported healthy, not an assertion about the concurrent-turn behaviour under test.
- **Suite counts:** Bridges group: 2,538 total, 2,526 passed, 11 skipped, 1 failed across 70 files in 41.61 seconds.
- **Isolated rerun:** `bun run test:logged -- --name acp-isolated -- bun test bridges/acp-bridge/src/index.test.ts` -> exit 0, whole file passed in 29.9 seconds.
- **Related:** the resolved entry for `ACP bridge > settles Cursor's in-process child as finished` in the same file. That fix raised the file-wide test budget to 20 s while deliberately leaving `waitFor`'s own default at 5 s, so its diagnostic wins over Bun's generic timeout. This occurrence is that design working as intended: the 20 s budget was never reached because `spawnBridge`'s 5 s health wait expired first.
- **Hypothesis:** Same structural family as that entry — under aggregate spawn contention the bridge child needs longer than 5 s to bind and answer. The failing wait is health, not the behaviour under test, and the change in flight touched only `apps/backend/src/core/storage.ts` and `apps/web/src/components/terminal/TerminalContainer.tsx`, neither of which this file loads. A recurrence should record how long the child actually took to become healthy before `spawnBridge`'s health wait is raised, so the budget is set from measured startup latency rather than from the failure that happened to be observed.
