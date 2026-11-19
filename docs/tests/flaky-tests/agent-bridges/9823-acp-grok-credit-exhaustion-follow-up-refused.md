# ACP bridge Grok credit-exhaustion test sent its follow-up prompt mid-turn (`bridges/acp-bridge/src/acp-context.test.ts`)

- **ID:** 9823
- **Status:** resolved
- **Date observed:** 2026-11-19
- **Base:** `5e9835d0a` (`main`, CI run 44550686801, job `Tests (root-bridges)`).
- **Test:** `ACP bridge > shows Grok credit exhaustion on a failed sub-agent card`
  (`bridges/acp-bridge/src/acp-context.test.ts`).
- **Failure:** `Timed out waiting for ACP state` after 60,091.99 ms
  (`acp-test-harness.ts:227`). The dumped session was `idle` at revision 5,
  its sub-agent card `agentState: "active"`, and it held only the
  `BACKGROUNDSUBAGENT: validate` user message: the `FAILCREDITSSUBAGENT`
  follow-up never reached the session.
- **Original command:** the CI `Tests (root-bridges)` shard of the complete
  non-iOS suite. The same test passed on every other `main` and pull request
  run on 2026-11-19.
- **Isolated rerun:** unchanged, the test passed 15 of 15 alone (about
  470–500 ms each).

## Root cause

The test waited only for the sub-agent card to turn `active`. The bridge sets
that while handling the `subagent_spawned` updates, before the launching
turn's `end_turn` reply arrives, so the session could still be `running`. The
follow-up prompt was then sent without checking its answer, and a prompt
during a running turn is refused with 409 "Session is already running"
(`bridges/acp-bridge/src/acp-http.ts`). The dropped prompt left the second
wait to time out. The test pattern dates from #512; nothing in the bridge
changed.

## Resolution (2026-11-19)

- **Class:** test race on an intermediate state.
- **Reproduced:** delaying the fake agent's `end_turn` by 300 ms in
  `src/testing/fake-agent-prompt-start.ts` (temporary, reverted) made the
  unchanged test fail with the same 60 s timeout and state dump.
- **Fix:** the first wait also requires `session.status === "idle"`, and the
  test asserts the follow-up prompt is accepted with 202.
- **Verification:** with the 300 ms delay injected the fixed test passed; the
  targeted test passed 5 of 5, `acp-context.test.ts` 53 of 53 on three runs,
  and `bun test src --parallel=2` in `bridges/acp-bridge` 894 pass, 0 fail.
