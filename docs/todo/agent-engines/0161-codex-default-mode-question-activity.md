# Codex Default-mode questions do not show the session as waiting

Checked against `main` at `00a0cb82` (2026-10-25). Code item done on
`todo-0161-codex-default-mode-question-2cf150514fc2` from `863b5782`
(2026-10-27). The real-app-server and real-model question qualifications
below are complete; the durable description lives in
[`agent-engines.md`](../../architecture/agent-engines.md) (end of
"Interaction deadlines and pausing") and
[`bridges/codex-bridge/AGENTS.md`](../../../bridges/codex-bridge/AGENTS.md).

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
`isBlocking: false`, so the bridge published them as non-blocking
(`bridges/codex-bridge/src/app-server/interactions.ts`) and the backend did
not hold the session's activity at `waiting`.

## Current state

- **Codex's semantics (0.164.0, read from source).** The tool handler sets
  `is_blocking: mode == ModeKind::Plan` and `auto_resolution_ms: None`
  (`codex-rs/core/src/tools/handlers/request_user_input.rs`).
  `Session::request_user_input` (`core/src/session/mod.rs`) parks a oneshot
  and awaits it with no timeout; app-server forwards the request
  (`app-server/src/bespoke_event_handling.rs`) and also awaits the client's
  answer with none, marking the thread as waiting on user input whatever the
  flag says. The only consumer of `is_blocking: false` is the TUI
  (`tui/src/bottom_pane/request_user_input/mod.rs`): after a 60 s hidden grace
  and a 60 s visible countdown it sends an empty answer, unless a key press or
  paste snoozes it. Transcript async questions
  (`request_user_input_async`) are a different, item-based path. Read at tag
  `rust-v0.164.0` (commit `6aaac694`).
- **The bridge publishes every parked question as blocking.**
  `describeInteraction` sets `isBlocking: true` (now a literal type on
  `InteractionRequest`) and uses the wire flag only for the deadline: `true`
  waits indefinitely, anything else gets the bounded deadline
  (`AGENT_INTERACTION_DEFAULT_TIMEOUT_MS`, 5 min, pausable to 24 h), shortened
  by a legacy `autoResolutionMs`. Expiry cancels with `{ answers: {} }`, the
  same empty answer Codex's TUI sends.
- **The backend already read every question as blocking.** The second commit
  of #1273 (`b52267c2`, after this file was written) made
  `mapCodexInteraction` (`apps/backend/src/core/http-bridge-interactions.ts`)
  publish `blocking: true` for any Codex question, and the bridge's
  `getActivity` reports `waiting` for any parked interaction. That rule stays
  for bridges that still pass the wire's `false` through.
- **Live, against the real pinned app-server** (loopback model, throwaway
  `CODEX_HOME`): `live-request-user-input.test.ts` pauses the question as
  soon as it parks. Its separate `RUN_LIVE_CODEX_QUESTION_DEADLINES=1`
  qualification uses a fixed 10.5-minute pause and an unheld five-minute
  expiry control. See Qualification for recorded runs.

## Outstanding work

### Code

1. **Done (2026-10-27) — Decide what `isBlocking: false` means for a
   Default-mode question.** The turn genuinely waits: Codex never resolves the
   question itself, and `isBlocking: false` only permits a client to
   auto-resolve it. So the bridge publishes it blocking and keeps a bounded,
   pausable deadline of its own (decisions 1 and 2). Evidence:
   `interactions.ts` (`describeInteraction`, `InteractionRequest.isBlocking`);
   `interactions.test.ts` ("a Default-mode question (wire isBlocking false)
   blocks with the bounded deadline", "every parked question is published
   blocking", the deadline cases); `app-server-runtime-lifecycle.test.ts` ("a
   Default-mode non-blocking RPC question waits until answered": activity
   `waiting`, `isBlocking: true`, a deadline);
   `native-agent-service-projection-lifecycle.test.ts` (the current bridge and
   an older bridge both give turn phase `blocked` with no renderer mounted,
   and `running` after the answer); `live-request-user-input.test.ts` (below).
   `mise run test` passed the bridges group; its other failures are in files
   the change does not reach and are recorded in flake case
   [1175](../../tests/flaky-tests/aggregate-validation-runs/1175-codex-default-mode-question-0161-validation.md).

### Qualification

- **Done (2026-10-27) — Bridge and real app-server, paused past ten
  minutes.** macOS 27.0 arm64, Codex 0.164.0 from the release tarball
  (sha256 matches the toolchain manifest) in a temporary directory, a
  throwaway `CODEX_HOME` with a fake key and a loopback Responses endpoint, no
  credits:

  | Run | Answer delay | Result |
  | --- | --- | --- |
  | `RUN_LIVE_CODEX_APP_SERVER=1` | 2 s | exit 0, both cases (11.4 s). |
  | `RUN_LIVE_CODEX_APP_SERVER=1 CODEX_LIVE_QUESTION_ANSWER_DELAY_MS=660000`, `-t "watched session"` | 11 min | exit 0, 1 pass, 1 filtered out, 9 `expect()` calls (663.2 s). |

  The question was published `isBlocking: true` with a deadline, the pause
  applied, the only resolution was `answered`, the model was sampled once
  before the answer, and the answer reached it.
- **Review follow-up (2026-10-27) — Fixed elapsed-time qualification.**
  `RUN_LIVE_CODEX_APP_SERVER=1 RUN_LIVE_CODEX_QUESTION_DEADLINES=1
  ORKESTRATOR_TEST_NO_PROGRESS_TIMEOUT_MS=750000 mise run test:logged --
  --name codex-question-deadlines -- bun test
  bridges/codex-bridge/src/app-server/live-request-user-input.test.ts --parallel=1`
  passed in 652.8 s against managed Codex 0.164.0. The held question stayed
  pending for 10.5 minutes with one model sample and then delivered
  `PROBE_BETA`; the separate unheld control expired after the production
  five-minute window, sent `{ answers: {} }`, and left no parked request.
  The watchdog allowance is needed because Bun buffers the long test's output;
  the first attempt hit the runner's five-minute no-output cutoff. The elapsed
  windows themselves remain fixed. Summary: host temporary directory
  `orkestrator-test-run.2w0Gfw/summary.json`.
- **Real-model question qualification (2026-10-27).** Disposable profile
  `codex-question-pause-0161`, Codex 0.164.0, model `gpt-6.1-sol`, default
  10.5-minute browser wait. The combined Codex question/approval run recorded
  `codex-question: resumed with the answer`: it was pending after 12 minutes,
  reloaded with its pause, accepted the chosen codeword, finished its turn,
  and cleared pending interactions. The separate approval case ran its command
  (marker present, turn idle) but its model replied without the required done
  token, so the combined test failed. Both setup-cleanup cases passed. Artifacts:
  `output/agent-testing/codex-question-pause-0161/browser/` and host temporary
  directory `orkestrator-test-run.bvu0of`. The new
  `ORKESTRATOR_AGENT_TEST_PAUSE_CASES=codex-question` selector permits an
  independent question qualification without changing its wait or assertions.
- **Done — independent real-stack question rerun (2026-10-27).** Same
  disposable profile, with `ORKESTRATOR_AGENT_TEST_PAUSE_PROVIDERS=codex`,
  `ORKESTRATOR_AGENT_TEST_PAUSE_CASES=codex-question`, and
  `ORKESTRATOR_AGENT_TEST_RUN_ID=codex-question-only-0161`, using
  `ORKESTRATOR_AGENT_TEST_LIVE_PAUSED_INTERACTIONS=1 mise run test:logged --
  --name codex-question-browser -- mise run test:agent:paused-interactions`.
  No wait override: the question survived the full 10.5-minute pause, stayed
  pending throughout, rehydrated after reload, accepted `PAUSE_BETA`, finished
  with the selected codeword, and cleared pending interactions. All three
  tests passed, including both real-environment setup-failure cleanup cases
  (745.9 s total). Artifacts:
  `output/agent-testing/codex-question-only-0161/browser/`; summary in host
  temporary directory `orkestrator-test-run.wM2c5n/summary.json`. The profile
  was stopped and reset afterwards.

## Constraints and rationale

- A non-blocking request must not park a build pipeline on a turn that is
  still running (`AgentInteractionRequest.blocking`). A Default-mode question
  never reaches a pipeline: `pipeline` threads keep Codex's refusal, so
  publishing questions as blocking cannot stall one.
- Expiry, disconnect and generation death still cancel; a pause only moves
  the deadline (`bridges/AGENTS.md`, "Interaction deadlines and pauses").

## Assumptions and decisions

1. **Where the "turn waits" rule lives: the bridge, with the backend rule
   kept.** Options: (a) leave the bridge passing the wire's `false` through
   and rely on the backend's question override from #1273; (b) publish
   `isBlocking: true` from the bridge and drop the backend override; (c)
   publish `true` from the bridge and keep the backend override for older
   bridges. Chose (c). Pros: the bridge's own routes say what the turn does,
   so every reader (the backend adapter, an older backend in front of a newer
   bridge, anything reading `/session/:id/interactions`) agrees with the
   bridge's `waiting` activity without a provider special case; an older
   bridge still gets the right activity from a newer backend. Cons: the
   field is now always `true` for a parked RPC, so it carries no information
   inside the bridge; it is kept on the wire because backends read a missing
   or `false` flag as before. The wire hint is no longer published (nothing
   read it but the deadline rule, which is applied in the bridge).
2. **A Default-mode question keeps a bounded, pausable deadline.** Options:
   (a) wait indefinitely like a Plan-mode (`isBlocking: true`) question; (b)
   keep the bridge's default deadline (5 min, pausable to the 24 h ceiling),
   cancelling with an empty answer; (c) copy the TUI's 2-minute policy.
   Chose (b). Pros: it is what `isBlocking: false` asks of a client (a
   Default-mode question may be auto-resolved), the empty answer on expiry is
   exactly what Codex's own client sends, so the model handles it as Codex
   designed; an interactive turn left unattended does not hang for ever;
   every other provider's question uses the same window, and the card's pause
   covers a person who needs longer. Cons: an unpaused question still ends
   after 5 minutes, earlier than a Plan-mode one would; (c) would be
   Codex-faithful but shorter than every other card in the product.
3. **The live test pauses at once; the long qualification has a fixed wait.**
   The quick live contract keeps its two-second answer. The separate
   `RUN_LIVE_CODEX_QUESTION_DEADLINES=1` opt-in always waits 10.5 minutes,
   checks the held question every 30 seconds, and runs an unheld expiry
   control alongside it. This replaces the earlier configurable answer delay,
   so a shortened shakedown cannot be mistaken for deadline qualification.

## Open questions

- None.

## Needs verification

- Verified (2026-10-27): the real-model, real-stack question qualification
  above, including the full pause, reload, answer and completed turn.
- Resolved (2026-10-27): Codex has no timeout of its own on a held
  Default-mode question in 0.164.0 (source read above, and the 11-minute
  live run). A Codex bump re-checks it (`upgrade-agents.md`).

## Related

- [0001-agent-interactions-and-permissions.md](0001-agent-interactions-and-permissions.md) item 13.

## Replaces

- Nothing.
