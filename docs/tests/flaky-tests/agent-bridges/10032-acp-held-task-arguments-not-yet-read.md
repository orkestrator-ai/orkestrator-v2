# ACP held `cursor/task`: the card was read before its arguments arrived

- **ID:** 10032
- **Status:** resolved
- **Date observed:** 2026-11-23
- **Base:** `a7d21c3f5` (`main`, CI run 45238054215, job 137915138079
  `Tests (root-bridges)`).
- **Test:** `ACP bridge > keeps a null-duration cursor/task running and still
  reports it as activity` (`bridges/acp-bridge/src/acp-transcript.test.ts`).
- **Failure:** `toMatchObject` at line 1643 after 360.45 ms: `toolArgs` was
  `{}` and the title `Task: Subagent task`, where `description: "Held task"`
  and `subagent_type: "explore"` were expected.
- **Original command:** the CI `Tests (root-bridges)` shard of the complete
  non-iOS suite.
- **Isolated rerun:** the runner's lone rerun of the file passed (12.1 s).

## Resolution (2026-11-24)

- **Root cause:** a test race on an intermediate state. The fake agent writes
  a `tool_call`, then a separate `cursor/task` message with the arguments. The
  test waited only for the card to exist.
- **Fix:** the wait also requires the card's `description`.
- **Reproduced:** yes — delaying the fake agent's `cursor/task` write by
  300 ms (temporary, reverted) failed the old test and passed the new one.
- **Stress:** `bun test --preload ../../tests/setup-node.ts
  src/acp-transcript.test.ts --test-name-pattern "cursor/task"
  --rerun-each=5`: 50 pass, 0 fail.
