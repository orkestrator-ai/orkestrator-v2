# Codex Default-mode questions do not show the session as waiting

Checked against `main` at `00a0cb82` (2026-10-25).

Found while fixing item 13 of
[0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md)
on 2026-10-25. Interactive Codex sessions can now ask questions in Default
mode (`features.default_mode_request_user_input`, set by
`codexRequestUserInputConfig` in `bridges/codex-bridge/src/codex-config.ts`).
Codex 0.164.0 sends those `item/tool/requestUserInput` requests with
`isBlocking: false`, so the bridge publishes them as non-blocking
(`bridges/codex-bridge/src/app-server/interactions.ts`) and the backend does
not hold the session's activity at `waiting`.

## Current state

- The loopback test `live-request-user-input.test.ts` (gated by
  `RUN_LIVE_CODEX_APP_SERVER=1`) showed the request parked with
  `isBlocking: false` and a deadline, and the model was not sampled again
  until the answer arrived: the turn did wait.
- The card still appears and can be answered and paused. Only the activity
  (sidebar indicator, `waiting` state) is wrong while it is pending.

## Outstanding work

### Code

1. **Decide what `isBlocking: false` means for a Default-mode question.**
   Read Codex's source or app-server schema for the pinned version: does
   Codex resolve a non-blocking question on its own after some time, and if
   so how long? If the turn genuinely waits for the answer, publish it as
   blocking (or `waiting`) in the bridge; if Codex auto-resolves it, keep it
   non-blocking and publish that limit as the deadline.

### Qualification

- With a real Codex model: an interactive question shows the session as
  waiting while pending, and a paused question survives past ten minutes
  (`ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=codex`, case `codex-question` in
  `paused-interactions-live.spec.ts`).

## Constraints and rationale

- A non-blocking request must not park a build pipeline on a turn that is
  still running (`AgentInteractionRequest.blocking`).

## Open questions

- None beyond item 1.

## Needs verification

- Whether Codex has its own timeout on a held Default-mode question.

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md) item 13.

## Replaces

- Nothing.
