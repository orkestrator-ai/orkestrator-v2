# `ACP bridge > starts local-default Cursor ACP without project MCP auto-approval` (`bridges/acp-bridge/src/acp-prompt.test.ts:50`)

- **ID:** 0132
- **Status:** resolved
- **Date observed:** 2026-08-17
- **Original command:** `bun run test:logged -- --name bridge-tests -- bun test bridges --parallel=2 --only-failures`,
  at `d70f1ac7` on `investigate-sub-agent`, with a clean tree.
- **Worker configuration:** the bridges group alone on two Bun workers — not the
  four-group `scripts/test-all.ts` run, and with no live production Orkestrator
  on the host. This is the quietest configuration in which this family has been
  recorded.
- **Failure:** `error: Timed out waiting for ACP state: false` (duration
  15,011.97 ms), thrown from the shared `waitFor` helper
  (`acp-test-harness.ts:184`) via `spawnBridge` (`acp-test-harness.ts:234`),
  reached through `readAgentArgs` (`acp-prompt.test.ts:25`) at
  `acp-prompt.test.ts:50`. As with the rest of this family the expired wait is
  the `GET /global/health` poll against the freshly spawned bridge child, so the
  child never reported healthy and none of the agent-argument behaviour under
  test was reached.
- **Suite counts:** bridges group `2679 pass, 11 skip, 1 fail, 8906 expect() calls.
  Ran 2691 tests across 92 files. [64.3s]`. It was the only failure in the run.
- **Isolated rerun:** `bun run test:logged -- --name acp-prompt-solo -- bun test bridges/acp-bridge/src/acp-prompt.test.ts`
  → exit 0 in 3.7 s; the target passed.
- **Related:** same `spawnBridge` health-wait family as
  `ACP bridge > bounds remembered provider message ids during a large replay`
  (`acp-transcript.test.ts:136`),
  `ACP bridge > keeps a completed turn idle when Cursor replay is failed`
  (`acp-transcript.test.ts:1410`) and
  `ACP bridge > rejects a concurrent second turn that carries a different requestId`
  (`index.test.ts:4956`).
- **Hypothesis:** the load explanation the `:136` entry offers does not cover
  this occurrence, and that is the new evidence here. The whole file passes alone
  in 3.7 s, yet one child startup exceeded 15 s with only one sibling worker and
  no competing group or production instance — so contention on the host cannot be
  the whole story, and raising `BRIDGE_STARTUP_TIMEOUT_MS` would not be justified
  by a 4x miss at this load. That points at the shared suspicion the `:1410`
  entry already raised rather than at throughput: a prior test's child still
  shutting down while holding its state directory or port, which would stall a
  fresh spawn regardless of how quiet the host is. The measurement this family
  still needs is unchanged — record how long the child actually took to bind, and
  whether a previous child was still alive when the failing spawn began, before
  any budget is touched. The change in flight touched only
  `bridges/codex-bridge` sub-agent status derivation, which no ACP path loads.
