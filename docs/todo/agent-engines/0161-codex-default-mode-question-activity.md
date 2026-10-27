# Codex Default-mode questions do not show the session as waiting

Checked against `main` at `00a0cb82` (2026-10-25).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Waiting activity for a Default-mode question**: code item 1, a pending question with `isBlocking: false` should hold the session at `waiting`. Status: done (backend side, in `b52267c2`); the file's description is out of date.
2. **Codex's own timeout on a held question**: the "Needs verification" item and the rest of code item 1, whether Codex resolves a non-blocking question itself, and which deadline to publish. Status: open.
3. **Live qualification**: with a real Codex model, a question shows the session as waiting, and a paused one survives past ten minutes (`codex-question`). Status: open.

### 1. Waiting activity for a Default-mode question

**Problem.** As filed: a Codex Default-mode question arrives with `isBlocking: false`, so the backend did not hold the session's activity at `waiting`.

**Context.** Default-mode questions are enabled by `codexRequestUserInputConfig` (`bridges/codex-bridge/src/codex-config.ts:129-134`; off only for the `pipeline` policy). The constraint is that a non-blocking request must not park a build pipeline on a running turn.

**Investigation.** This is already fixed in the backend, in the same change that created this file (`b52267c2`, #1273).
- `mapCodexInteraction` treats every parked `question` RPC as blocking: `const isBlocking = kind === "question" || request?.isBlocking !== false;` (`apps/backend/src/core/http-bridge-interactions.ts:773-777`). The comment says why: "A parked requestUserInput RPC needs an answer even when Codex's Default mode reports isBlocking:false". MCP forms and URLs keep the wire value.
- The test "a Default-mode Codex RPC question publishes waiting and resumes after an answer" (`apps/backend/src/core/native-agent-service-projection-lifecycle.test.ts:33`) feeds an `isBlocking: false` question through the real bridge's `describeInteraction`. It asserts `turn.phase` `blocked` and `blocking: true`, from authoritative reads alone.
- The bridge still records the wire hint (`bridges/codex-bridge/src/app-server/interactions.ts:38-45`, `:152-154`). Its comment also says a parked question RPC publishes waiting.
- The constraint still holds: transcript async questions (non-RPC) take another path and do not block. The pipeline policy does not enable Default-mode questions.

**Decisions.**

- **How is the file brought up to date?**
  - **Mark code item 1's activity half done with the reference above, and narrow the item to the deadline question (task 2) (recommended).**
    - Pros: the file stops describing a fixed bug; the remaining question stays visible.
    - Cons: an edit to an existing item, which the README allows ("tick or remove it, correct it").
  - **Leave the item as written until the live run.**
    - Pros: nothing changes until there is live proof.
    - Cons: the next reader investigates a bug that is already fixed.

### 2. Codex's own timeout on a held question

**Problem.** It is unknown whether Codex itself resolves a held `isBlocking: false` question after some time. If it does, Orkestrator should publish that limit as the deadline. If it does not, Orkestrator's own deadline is the only one.

**Context.** The deprecated `autoResolutionMs` field was Codex's way of saying "I will resolve this myself". The generated params now say to use `isBlocking` instead (`bridges/codex-bridge/src/app-server/generated/typescript/v2/ToolRequestUserInputParams.ts:9-13`).

**Investigation.**
- Because `isBlocking` is `false`, the bridge gives the question a deadline. That deadline is `defaultExpiresAt`, which is `requestedAt + approvalTimeoutMs` (`bridges/codex-bridge/src/app-server/server-request-router.ts:807`). The default is `AGENT_INTERACTION_DEFAULT_TIMEOUT_MS`, 5 minutes (`packages/protocol/src/agent-interactions.ts:15`). The bridge shortens it when Codex sends `autoResolutionMs` (`interactions.ts:198-203`).
- On expiry the bridge cancels the question with empty answers (`server-request-router.test.ts:834`, "auto-cancels and is counted as expired"). So an unattended Default-mode question ends after 5 minutes unless it is paused.
- The 0.164.0 loopback test (`bridges/codex-bridge/src/app-server/live-request-user-input.test.ts`) showed the model waiting for the answer, with no auto-resolution observed. The generated protocol carries no other timeout field.

**Decisions.**

- **Which deadline does a Default-mode question get?**
  - **Keep the bridge's 5-minute pausable deadline, which fails closed, and record that 0.164.0 sends no `autoResolutionMs` (recommended).**
    - Pros: matches every other interactive card; pause covers a user who needs longer; no change to the bridge.
    - Cons: an interactive question the user misses is cancelled after 5 minutes, even though Codex would wait.
  - **Treat a question RPC as waiting indefinitely, as `isBlocking: true` does.**
    - Pros: matches Codex's observed behaviour (the turn waits).
    - Cons: an unattended interactive tab could wait forever; an explicit stop becomes the only way out.
- **How is Codex's own behaviour settled?**
  - **Extend the opt-in loopback test to hold a question for longer than 5 minutes with the deadline raised, and record whether Codex resolves it (recommended).**
    - Pros: direct evidence on the pinned version; the test already exists and is gated by `RUN_LIVE_CODEX_APP_SERVER=1`.
    - Cons: a slow live run.
  - **Read Codex's source for 0.164.0.**
    - Pros: no model calls.
    - Cons: the source is Rust in another repository and may not match the binary's flags.

### 3. Live qualification

**Problem.** The waiting indicator and the pause past the window have not been seen with a real model.

**Context.** Case `codex-question` in `e2e/agent-testing/paused-interactions-live.spec.ts:76`. Codex is in the spec's default provider list (`:35`).

**Investigation.** Note that the default window is 5 minutes, not 10, so "survives past ten minutes" is a stricter test than it needs to be.

**Decisions.**

- **Where does it run?**
  - **In an isolated `dev:test` profile with `ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=codex`, batched with 0031 (recommended).**
    - Pros: the agreed harness; the profile isolates the Codex home.
    - Cons: needs Codex credentials and a long wait.
  - **Only the backend unit test above.**
    - Pros: already passing.
    - Cons: it uses a stubbed provider, so the sidebar indicator is not shown with a real Codex turn.

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
