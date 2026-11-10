# `ACP bridge > settles the turn before a delayed Cursor replay and enriches only its captured tools` (`bridges/acp-bridge/src/acp-transcript.test.ts:2447`)

- **ID:** 0022
- **Status:** resolved
  large-transcript case
- **Date observed:** 2026-08-29
- **Original command:** `bun run test`
- **Worker configuration:** the bridge group ran two Bun workers while the
  workspace, root/agent-support, and protocol groups ran concurrently.
- **Failure:** the bounded state wait expired after the aggregate runner
  reported 652,814.96 ms. The final snapshot had completed both turns but had
  not yet applied the delayed replay enrichment expected by the predicate.
- **Suite counts:** bridge group reported 3,179 passed, 11 skipped, 2 failed,
  and 1 trailing error across 3,192 tests.
- **Isolated rerun:** `bun test src/acp-transcript.test.ts` from
  `bridges/acp-bridge` passed 70/70 in 18.23 s; the affected case passed in
  1,774.68 ms.
- **Hypothesis:** the state machine reached its idle second-turn snapshot, and
  only the deliberately delayed replay lagged. Together with the ten-minute
  aggregate duration and green isolated owner, this is evidence of scheduling
  starvation around the delayed enrichment rather than transcript corruption.

## Resolution (2026-11-10)

- **Status:** resolved; the feature and its test were removed.
- **Root cause:** not established. The bounded state wait expired while the
  deliberately delayed Cursor tool replay, a whole second agent child spawned
  after the turn, had not yet enriched the snapshot during a ten-minute
  aggregate.
- **Fix:** already on `main`. `efcc8e7a4` (`fix(bridges): address hot-path
  memory and delivery issues`, #1733, 2026-11-04, item BR-16) removed the
  unreachable Cursor tool replay from the ACP bridge: its scheduler,
  collector, gates, `ACP_MAX_LIVE_CURSOR_TOOL_REPLAYS` and the fake agent's
  replay fixtures. It also deleted this test and the other replay tests from
  `acp-transcript.test.ts`. Its replacement, `acp-context.test.ts` ("a turn's
  generic tool calls spawn no replay child"), checks that no replay child is
  spawned and waits for nothing delayed. `git grep` finds no remaining
  reference to the replay code. No change in this sweep.
- **Reproduced:** no — the code path and the test no longer exist.
- **Stress:** none; there is nothing left to run.
