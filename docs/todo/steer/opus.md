# Steering the running turn: how Codex does it, and what it would take elsewhere

Status: feasibility assessment. No code changed.
Date: 2026-08-28. Branch: `native-platform-steering`.

Scope: how `/steer` works for Codex native tabs today, and whether the same
behaviour can be offered on the other five native platforms — Claude Code,
OpenCode, Cursor Agent, Grok Build and Pi.

**Headline: the Orkestrator-side plumbing is already platform-neutral and
capability-gated, and Pi already ships a second implementation of it. Every
remaining question is a vendor question.** Two of the three remaining platforms
have a real upstream steering primitive (OpenCode: yes, explicit; Claude: very
likely, but through an unverified path), and two do not (Cursor, Grok).

---

## 1. What "steer" means here

Steering is **not** queueing, and the distinction is the whole feature.

- **Queue** (`capabilities.queue`) is Orkestrator's own. A prompt sent while a
  turn is running is persisted in `storage-prompt-queues` and dispatched by
  `prompt-queue-drainer.ts` once the provider reports idle. It becomes a *new
  turn*, after the one the user was watching.
- **Steer** (`capabilities.actions.steer`) hands text to the turn that is
  *already running*, so it changes the course of that turn rather than following
  it. The user's mental model is "no, not that file — this one", said while the
  agent is still working.

The composer refuses to conflate them deliberately:
`AgentNativeTab.controller.tsx:700-704` — *"A command the runtime performs on the
live turn (Codex `/steer`) is not a prompt: queueing it would run it after the
turn it was meant to redirect."*

Everything below is about the second thing.

---

## 2. How `/steer` works for Codex today

### 2.1 The path, end to end

| Layer | File | What happens |
| --- | --- | --- |
| Command table | `packages/protocol/src/agent-slash-commands.ts:59-64` | `/steer` is a `SESSION_ACTION_SLASH_COMMANDS` entry: kind `steer`, capability `steer`, refuses a bare invocation with *"Add instructions after /steer."* |
| Capability | `packages/protocol/src/native-agent.ts:408`, `:513`, `:519` | `actions.steer?: boolean`. True for `codex` and `pi`; absent everywhere else. |
| Resolution | `agent-slash-commands.ts:83-96` | `resolveSessionActionCommand(text, capabilities, runningTurn)`. Returns `null` when no turn is running — `/steer` typed at an idle tab is an ordinary prompt, not an error. |
| Menu | `agent-slash-commands.ts:128-152` | `withSessionActionSlashCommands` merges `/steer` into the provider's discovered command list, and **deletes** it for a provider that cannot perform it. |
| Composer | `AgentNativeTab.controller.tsx:705-768` | Refuses attachments, mints/reuses a `requestId`, calls `performAction`, maps the outcome to a message. |
| Hook | `apps/web/src/hooks/useNativeAgentSession.ts:768-777` | `performAction` → invoke → `refresh()`. |
| Client | `apps/web/src/lib/backend/workflows.ts:358-365` | `invoke("perform_native_agent_session_action", …)`. |
| Command | `apps/backend/src/core/commands-registry-native.ts:284-291` | Registry entry. |
| Validation | `apps/backend/src/core/commands-validation.ts:459-464` | `steer` requires non-blank `text` **and** non-blank `requestId`. |
| Service | `apps/backend/src/core/native-agent-service-dispatch.ts:474-500` | Maps action kind → capability key, refuses if the platform's table says no, then delegates to the provider. |
| Provider | `apps/backend/src/core/http-bridge-provider.ts:1328-1367` | Reads `/session/:id/status` for an authoritative `turnId`, POSTs `/session/:id/steer` with `{ input, requestId, expectedTurnId }`, maps HTTP to outcome. |
| Bridge route | `bridges/codex-bridge/src/index.ts:1374-1422` | Validates all three fields, maps runtime outcome to 202/404/409/503. |
| Bridge runtime | `bridges/codex-bridge/src/app-server-runtime-sessions.ts:510-657` | The interesting part; see below. |
| Engine | `bridges/codex-bridge/src/engine/app-server-engine.ts:772-785` | `turn/steer` JSON-RPC with `threadId`, `expectedTurnId`, `input`, `clientUserMessageId`. |

### 2.2 The four hard problems Codex solved

The route is trivial. The 150 lines behind it are not, and they are the real
cost of this feature on any platform.

**(a) Binding to the turn the user meant.** The renderer's view of the turn is
always a poll behind. `steerSession` takes `expectedTurnId`, checks it against
the live accumulator (`app-server-runtime-sessions.ts:559-562`) and lets
app-server re-check it atomically. A turn that finished or was replaced answers
`mismatch`, not "sent". Without this, steering text lands on whatever turn
happens to be running when the request arrives — which may be a different one.

**(b) At-most-once under ambiguity.** A transport failure after `turn/steer`
reached app-server is indistinguishable from one before it. Codex refuses to
guess:

- A bounded `Map<requestId, …>` (`app-server-runtime-base.ts:606-621`,
  `MAX_STEER_REQUESTS = 500` at `:424`) records `{threadId, turnId, inputDigest,
  state, requestedAt}` per request id.
- Reusing an id with *different* input or a different target returns `unknown`
  and dispatches neither version (`:521-529`).
- On retry of a `unknown` record, `reconcileRequest` does an authoritative
  `thread/read` looking for the `clientUserMessageId` app-server persists on
  every steered user message. Found → `accepted` without re-sending. Confirmed
  absent → the id is freed for a genuine retry (`:531-556`).
- Only a *structured* rejection naming a stale `expectedTurnId` is reported as
  `mismatch`. Transport failures, timeouts and process exit are `unknown`
  (`:636-654`).
- The composer keeps the same `requestId` after an `unknown`
  (`AgentNativeTab.controller.tsx:726-736`), so the retry is a *probe*, not a
  second steer.

**(c) Rendering a user message inside an assistant turn.** app-server persists a
successful steer as another user message *inside* the running turn, and the
engine reducer deliberately does not render its live item. So the bridge splits
the assistant row at the exact item boundary where the steer landed:

- `boundaryAfterItems` (`sessions/turn-accumulator.ts:399-428`) drives the split
  from `followingItemIds` — items app-server ordered *after* the steer — and
  never from absence in `precedingItemIds`. The comment is worth reading: absence
  is not evidence, because a still-streaming item is missing from the prefix
  while genuinely belonging above the steer, and demoting on absence emptied the
  pre-steer row and pushed the whole in-flight response below the user's message.
- `freezeAssistantSegment` captures the boundary *before* any await, so items
  arriving during rendering cannot leak above the steer (`:432-442`).
- `appendAcceptedSteer` (`app-server-runtime-sessions.ts:680-…`) flushes the
  pre-steer row, appends the user message, and opens a new assistant row.
- Sub-agent cards get the same treatment
  (`subagent-transcript-parts.ts:29`, `:146`, `:193`) so a spawn emitted while
  the steer RPC was in flight does not land on the wrong side.
- The timestamp used to divide the two rows is the instant app-server
  *acknowledged* the steer, not the instant the request was made — sampling
  before the RPC attributed everything emitted during the round-trip to the wrong
  row (`:616-622`).

**(d) Reserving the name.** `parseCodexSteerCommand`
(`bridges/codex-bridge/src/prompts/slash-commands.ts:91-95`) accepts multi-line
free text, unlike ordinary prompt templates. `/steer` is excluded from
prompt-template expansion (`:216-221`), refused outright with structured output
(`app-server-runtime-prompt.ts:271-281`), and answered locally with a usage hint
when no turn is running (`:1091-1101`).

### 2.3 Two entry points, not one

1. **The composer.** Platform-neutral and capability-gated. This is the one that
   would "just work" for a new platform.
2. **`AgentInfoButton`'s "Active turn" panel**
   (`apps/web/src/components/layout/AgentInfoButton.tsx:1525-1625`). This is
   **hardcoded to `activeSession.provider === "codex"`** and prefers a direct
   renderer→bridge call (`steerCodexSession` in
   `apps/web/src/lib/codex-client.ts:1539-1583`) when a `codexClient` is in the
   store, falling back to `performNativeAgentSessionAction` otherwise. The
   review action next to it is hardcoded the same way. Adding a platform means
   either replicating this branch or — better — converting it to read
   `capabilities.actions.steer`.

### 2.4 Pi: the existing second implementation

Pi already reports `actions: { compact: true, steer: true }`
(`native-agent.ts:509-515`) and is served by a much smaller path:

- `http-bridge-provider.ts:1304-1327` posts `{input, requestId}` to
  `/session/:id/steer` with **no** `expectedTurnId`. The comment explains why:
  Pi holds the queue itself and delivers a steering message before the next model
  call, so there is no turn id to guard against.
- `bridges/pi-bridge/src/http.ts:479-491` answers `{outcome:"idle"}` (HTTP 200)
  when nothing is running, and otherwise calls `session.steer(text)`.
- The Pi SDK's `AgentSession.steer(text, images?)`
  (`@earendil-works/pi-coding-agent@0.84.3`,
  `dist/core/agent-session.d.ts:370-377`) is a first-class primitive: *"Queue a
  steering message while the agent is running. Delivered after the current
  assistant turn finishes executing its tool calls, before the next LLM call."*
  Pi also has `followUp()`, and `prompt()`/`sendUserMessage()` take
  `deliverAs: "steer" | "followUp"`.
- Pending steering and follow-up messages surface through the shared queue
  snapshot (`bridges/pi-bridge/src/public.ts:169-179`), fed by Pi's own queue
  events (`translate.ts:299-305`).

**Pi's implementation has a real gap that any new platform should not copy.**
The provider sends `requestId`; `handleSteer` ignores it. There is no
idempotency record and no reconciliation. The provider maps a thrown fetch to
`{outcome:"unknown"}` (`http-bridge-provider.ts:1320-1322`), and the composer
then *deliberately reuses the same request id* on retry — which, against a bridge
that does not deduplicate, steers the turn twice. This is a pre-existing defect
worth fixing in the same change as any new platform, because it is the exact
failure the shared composer contract promises does not happen.

---

## 3. What is already generic

This matters because it sets the floor on cost. Turning `steer` on for a
platform requires **no change** to:

- `packages/protocol/src/agent-slash-commands.ts` — the whole file is
  capability-driven; the comment at `:136-139` was written for exactly this
  ("the old menu listed `/steer` for Codex only because Codex owned the menu").
- `AgentNativeTab.controller.tsx` — resolution, request-id reuse, attachment
  refusal, outcome messaging, send-button title.
- `useNativeAgentSession.ts`, `workflows.ts`, `commands-registry-native.ts`,
  `commands-validation.ts`.
- `native-agent-service-dispatch.ts` — the capability map at `:479-488` already
  contains `steer: "steer"`.
- `native-agent-service-projection.ts:612-621` — merges the runtime command into
  the menu for any platform, even one with no command discovery.

The per-platform work is exactly three things: flip the capability, add the
provider branch, implement the bridge route. Plus tests, plus — for the
`AgentInfoButton` panel — de-hardcoding one component.

---

## 4. Per-platform feasibility

### 4.1 Claude Code — **feasible, medium confidence, medium-to-high cost**

**Verdict: the transport already exists in the bridge; the vendor semantics need
an empirical probe before committing.**

What is already true and is the strongest argument for this platform:

`holdSdkPromptOpen` (`bridges/claude-bridge/src/services/session-manager-persistence.ts:1281-1332`)
already converts **every** prompt to the SDK's streaming-input mode and holds the
input open for the whole turn, closing it only once the result has arrived and
no background task remains. The bridge also retains the live `Query` handle per
turn (`SessionState.queryControl`, `types/index.ts:327`), and the SDK's `Query`
exposes `streamInput(stream)` (`sdk.d.ts:2674`). So there are two viable
injection routes and neither requires restructuring how turns are driven. The
missing piece is only a push channel into that held-open iterable — today it
yields the initial messages and then awaits `closedPromise` with no way to add
more.

What is *not* established, and is the gate on this work:

Against the pinned `@anthropic-ai/claude-agent-sdk@0.3.245`, a user message
pushed mid-turn goes into the CLI's **command queue**. `SDKControlInterruptResponse.still_queued`
(`sdk.d.ts:3781-3785`) describes those as *"async user messages that survive
this interrupt … These WILL run"* — i.e. as their own subsequent turn, which is
queueing, not steering.

But the same prose describes a **fold** path where a queued command becomes a
`queued_command` attachment on the *running* turn's transcript
(`sdk.d.ts:3773`: *"A fold-in-flight uuid's queued_command attachment may already
appear in the aborted turn's transcript … it never runs as its own turn"*), and
`resumeDropsTurn` (`:1876`) refers to *"a queued user message or task
notification the session absorbed mid-turn"*. `SDKUserMessage` additionally
carries an undocumented `priority?: 'now' | 'next' | 'later'` (`:4992`) which the
SDK passes through untyped-in-prose to the CLI.

The published Agent SDK docs are no help either way — they describe streaming
input as *"queue multiple messages for sequential processing"* and *"provide
additional context mid-execution"* in the same paragraph.

**This is resolvable in an afternoon and must be resolved first.** Write a
throwaway script that starts a long tool-heavy turn, pushes a second
`SDKUserMessage` (once bare, once with each `priority` value) into the open
iterable, and reads the resulting transcript: does the text reach the model
before the current turn's next model call, or does it start a second turn after
the `result`? Everything below depends on that answer.

**If it folds into the running turn** — work required:

- Push channel on `holdSdkPromptOpen`, or a `streamInput` call on the retained
  `Query`. Small.
- `POST /session/:id/steer` on the bridge. Small.
- **Idempotency is the real cost.** There is no typed `command_lifecycle` message
  in 0.3.245 — the frames are named only in prose — so there is no observation
  channel equivalent to Codex's `thread/read` + `clientUserMessageId`
  reconciliation. The bridge would have to stamp `SDKUserMessage.uuid` with the
  request id, keep a bounded `Map` like Codex's `steerRequests`, and reconcile a
  `unknown` retry by scanning its own persisted transcript for that uuid. That is
  weaker than Codex's reconciliation (it is bridge-local state plus a local
  transcript rather than a provider-authoritative read) and it must be honest
  about it: a bridge restart mid-ambiguity should answer `unknown`, not
  "definitely not sent".
- **Turn binding.** `session.latestTurnGeneration`
  (`bridges/claude-bridge/src/types/index.ts:385`) is the counter; it is not on
  the status route. Either expose it as a `turnId` and take the Codex
  `expectedTurnId` contract wholesale, or accept Pi's weaker `idle`-race
  contract. Given Claude's turn model — a single query that can cross result
  boundaries for background tasks (`session-manager-prompt.ts:580-645`) — the
  generation counter is more load-bearing here than for Pi, and I would take the
  binding.
- **Transcript rendering.** Claude's message model builds rows from
  `(api message id, block index)` (`session-manager-prompt-stream.ts:60-84`),
  not from an item-ordered accumulator, so Codex's `boundaryAfterItems` /
  `freezeAssistantSegment` machinery does not port directly. The equivalent is
  splitting `blocksByApiMessage` at the API message that was in flight when the
  steer landed. This is the largest single piece of work and the one most likely
  to look subtly wrong (parts landing on the wrong side of the user's message)
  under real streaming.

**If it queues instead:** do not ship `actions.steer` for Claude. Advertising a
control that silently defers to the next turn is worse than not having it —
Orkestrator's own queue already does that, visibly, with a queue list the user
can see and reorder.

### 4.2 OpenCode — **feasible, high confidence on the primitive, high cost on the path**

**Verdict: OpenCode has explicit first-class steering. The obstacle is that it
lives on an API surface this repo does not use at all.**

The pinned `@opencode-ai/sdk@1.18.23` exposes, on the **v2** namespace only:

```
client.v2.session.prompt({ sessionID, id, prompt, delivery: "steer" | "queue", resume })
  → POST /api/session/{sessionID}/prompt  →  { data: SessionInputAdmitted }
```

(`dist/v2/gen/sdk.gen.d.ts:1685-1695`.) `SessionInputAdmitted`
(`types.gen.d.ts:3213-3221`) carries `admittedSeq`, a caller-supplied `id`, the
`delivery` mode and an optional `promotedSeq`, and there are matching durable
events `session.next.prompted` and `session.next.prompt.admitted`
(`types.gen.d.ts:5367-5387`). That is a better idempotency story than Codex's —
the caller owns the input `id` and the server reports an admission sequence, so
"did it land?" is answerable by a read rather than inferred.

The problem: **the backend drives OpenCode entirely through the legacy surface.**
`opencode-provider.ts:656-669` uses `client.session.promptAsync`
(`POST /session/{id}/prompt_async`) and `client.session.command`
(`POST /session/{id}/command`); `performSessionAction` (`:1214-1277`) uses
`session.summarize` / `revert` / `unrevert` / `share`. Nothing in
`apps/backend` or `apps/web` touches `client.v2.*` — verified by grep. The two
namespaces are parallel projections (`Session` vs `SessionV2Info`,
`/session/…` vs `/api/session/…`, `message.updated` vs `session.next.*`) with
overlapping but non-identical shapes.

**The gating unknown is whether `/api/session/{id}` addresses the same session
objects as `/session/{id}`.** The two info types share `id`, `projectID`,
`parentID`, `title`, `cost`, `tokens` and `revert`, which strongly suggests one
underlying store with two projections, but this is inference from type shapes,
not verification. It must be checked against a running `opencode serve` at the
pinned version before any estimate is trusted:

1. Create a session the normal way (`POST /session`).
2. `GET /api/session/{thatId}` — does it resolve?
3. Start a turn with `promptAsync`, then `POST /api/session/{id}/prompt` with
   `delivery: "steer"` — is it admitted, and does the text reach the model
   before the running turn's next model call?
4. Does the steered input appear in the legacy `session.messages` projection and
   on the legacy `/event` stream the backend already consumes?

**If ids and projections are shared**, this is the *cheapest* of the three
candidates: one new branch in `performSessionAction` calling
`client.v2.session.prompt({ delivery: "steer", id: action.requestId })`, no new
bridge (OpenCode has none), no new transcript machinery, and the caller-owned
`id` gives idempotency almost for free. Flip `actions.steer` in the `opencode`
branch of `nativeAgentCapabilities` and you are largely done.

**If they are not shared**, this becomes a migration of OpenCode's read path onto
the v2 session API — a much larger, riskier change that should be scoped
separately and is not worth doing for steering alone.

There is a second, smaller unknown either way: OpenCode's own steering competes
with Orkestrator's queue (`capabilities.queue` is true for OpenCode). The
composer would then offer two behaviours — `/steer` for immediate, plain Enter
for Orkestrator's queue — which is the same shape Codex already has and is fine,
but the queue snapshot should not double-count an input OpenCode has admitted.

### 4.3 Cursor Agent — **not feasible against the current SDK**

`@cursor/sdk@1.0.28` exposes `SDKAgent.send(message, options) → Run`
(`dist/esm/agent.d.ts:14`) and `Run` with `stream / conversation / wait / cancel /
status` (`dist/esm/run.d.ts:37-56`). `SendOptions`
(`dist/esm/agent.d.ts:34-57`) has `model`, `mcpServers`, `mode`, `onStep`,
`onDelta`, `local`, `cloud`, `idempotencyKey`. There is **no** steer, follow-up,
priority, delivery-mode or mid-run injection surface anywhere in the typings —
grep across the SDK's `.d.ts` for `steer|interject|followUp|queue` returns
nothing.

Calling `send()` a second time while a run is live has undefined semantics here;
the bridge's own model assumes one run at a time
(`bridges/cursor-bridge/src/prompt.ts:60-108`, `state.promptSequence`,
`state.cancelTurn`). It might start a concurrent run against the same workspace,
which is strictly worse than not offering the feature.

The only honest options are (a) wait for Cursor to ship the primitive, or
(b) simulate it with cancel-and-resend, which is a different feature with
different costs (it discards the turn's in-flight work and spends tokens again)
and should not be labelled `/steer`. Do neither for now.

Also note Cursor already reports `actions: {}` deliberately
(`native-agent.ts:492-502`), so nothing needs to change to keep it correct.

### 4.4 Grok Build — **not feasible against ACP v1**

The bridge negotiates `protocolVersion: 1`
(`bridges/acp-bridge/src/acp-context.ts:675-693`). ACP v1 is strictly
turn-based: `session/prompt` is a JSON-RPC *request* that resolves with a
`stopReason` when the turn ends (`acp-prompt.ts:156`), and the only mid-turn
client→agent message in the spec is `session/cancel`. There is no method for
adding input to a live turn.

The ACP v2 draft explicitly addresses this — its announcement describes moving
"beyond the turn", with prompt responses becoming acknowledgements rather than
turn-ending events, specifically to enable *"better support for queueing and
steering"*. But v2 is a draft, the bridge speaks v1, and the Grok CLI's argv and
protocol support are already flagged in `AGENTS.md` as **a versioned contract
nothing in CI can check** (the bridge's tests run against a fake agent that
accepts anything). Building steering against a draft protocol on top of an
unverifiable contract is the worst risk profile of any option here.

Revisit when ACP v2 is stable *and* the pinned Grok CLI advertises it in
`agentCapabilities.sessionCapabilities` — `supportsSessionCapability`
(`acp-context.ts:924-932`) is already the right feature-detection hook.

### 4.5 Pi — **already shipped; needs hardening, not enabling**

Covered in §2.4. Two defects to fix:

1. **No idempotency.** `handleSteer` (`bridges/pi-bridge/src/http.ts:479-491`)
   ignores the `requestId` the provider sends. A retried `unknown` steers twice.
   Fix: a bounded request-id map keyed on `{requestId, inputDigest}`, mirroring
   `steerRequests`, answering `accepted` for a known id rather than re-calling
   `session.steer`.
2. **No turn binding.** Justified in the provider comment on the grounds that Pi
   delivers before the next model call, but it means a steer that arrives just
   after one turn ended and just before the next began is delivered to the wrong
   turn rather than answering `mismatch`. Pi does expose `promptSequence`
   (`state.ts:171`); exposing it on `/session/:id/status` and accepting an
   optional `expectedTurnId` would close this at low cost and would establish
   the pattern any new platform copies.

Neither is a regression introduced by this work, but both are the difference
between "Codex-like" and "shaped like Codex".

---

## 5. Cross-cutting work, whichever platforms are chosen

1. **De-hardcode `AgentInfoButton`.** The "Active turn" panel
   (`AgentInfoButton.tsx:1525-1625`) branches on `provider === "codex"`. Convert
   it to `capabilities.actions?.steer === true` and route through
   `performNativeAgentSessionAction` for every platform, keeping the
   `codexClient` direct path only as the Codex fast path it already is. Note the
   ambiguous-retry ref (`codexSteerRetryRef`) is per-session-identity and would
   need renaming, not restructuring. `AgentInfoButton.test.tsx` has 43 lines
   touching steer.
2. **Turn identity in the shared contract.** `ProviderStatus`
   (`agent-provider-contract.ts:30`) is a bare string union with no turn id, so
   the Codex steer path reads the *bridge's* `/session/:id/status` route
   directly through `bridgeFetch`. A second turn-bound platform makes that worth
   promoting into the contract rather than repeating. Watch the `AGENTS.md`
   constraint while doing it: `/session/:id/status` is a **liveness touch** on
   both the Codex and Claude bridges. A user-initiated steer touching it is fine;
   anything that ends up polling it from a reconciler is not.
3. **Idempotency contract, written down.** Codex's rules — reused id with
   different input is `unknown` and dispatches nothing; only a structured stale
   -turn rejection is `mismatch`; transport failure is never "unsent" — are
   currently implicit in one bridge's implementation. Two more implementations
   is the point at which they need to be a documented contract that
   `http-bridge-provider` enforces uniformly.
4. **The `queue` × `steer` interaction.** Every candidate platform has
   `queue: true`. The composer's send button already says "Add to queue" vs
   "Send to the current turn" based on the draft
   (`AgentNativeTab.controller.tsx:1769-1775`), so this works — but for OpenCode
   and Pi, where the *provider* also holds a queue, the projection must not show
   an input twice.
5. **Tests.** Existing coverage to extend, by file:
   `packages/protocol/src/agent-slash-commands.test.ts` (16 tests, all
   capability-driven — these should need no change, which is the point),
   `native-agent.test.ts:67,92` (capability table),
   `apps/backend/src/core/http-bridge-provider.test.ts` (7),
   `native-agent-service-projection.test.ts` (11),
   `AgentNativeTab.test.tsx` (23), `AgentInfoButton.test.tsx` (43), plus a new
   bridge suite per platform mirroring
   `bridges/codex-bridge/src/index-routes.test.ts` (16).

---

## 6. Recommendation

**Sequence:**

1. **Two probes, in parallel, before any implementation.** (a) Claude: does a
   mid-turn `SDKUserMessage` fold into the running turn, and does `priority`
   change that? (b) OpenCode: do `/api/session/{id}` and `/session/{id}` address
   the same session, and does a `delivery:"steer"` input reach the running turn
   and appear in the legacy message projection? Each is a throwaway script
   against a `dev:test` profile; neither needs a branch.
2. **Harden Pi** regardless of the probe outcomes. It is small, it fixes a real
   double-steer, and it establishes the request-id and turn-binding pattern the
   next platform copies.
3. **OpenCode if probe (b) is green** — likely the cheapest real win, and the
   only candidate whose vendor gives us caller-owned idempotency for free.
4. **Claude if probe (a) is green**, budgeting the transcript-splitting work
   honestly; it is the largest piece and the one most visible when wrong.
5. **Cursor and Grok: no work.** Record the blocking upstream gap (Cursor: no
   SDK surface; Grok: ACP v1 is turn-bound, v2 draft) so the question is not
   re-litigated, and re-check on the next version bump —
   `docs/upgrade-agents.md` is the natural place for that check to live.

**Do not** flip `actions.steer` on for a platform whose "steering" is really
queueing. The capability's whole contract is that the text reaches the turn the
user was watching, and the composer's error messages
(`codex-client.ts:1522-1536`, `AgentNativeTab.controller.tsx:754-757`) promise
exactly that. A platform that quietly defers is better served by the queue that
already exists and that the user can see.

---

## 7. Open questions

| # | Question | How to settle it | Blocks |
| --- | --- | --- | --- |
| 1 | Does a mid-turn `SDKUserMessage` reach the running Claude turn, or start a new one? Does `priority: 'now'` change it? | Script against pinned SDK 0.3.245 | §4.1 entirely |
| 2 | Do OpenCode's `/api/session/{id}` and `/session/{id}` share session ids and message projections? | Script against pinned `opencode serve` 1.18.23 | §4.2 cost estimate |
| 3 | Is there any observation channel for a queued Claude command (the prose-only `command_lifecycle` frames)? | Read the CLI's stream output during probe 1 | Strength of Claude idempotency |
| 4 | Does Pi's `session.steer` deliver to the turn that was running when the HTTP request arrived, or to whichever is running at delivery time? | Pi SDK source / probe | Whether §4.5 item 2 is a real bug or a theoretical one |
| 5 | When does the Grok CLI's ACP implementation move to v2? | Watch `agentCapabilities.sessionCapabilities` on each version bump | §4.4 |

## 8. Sources

Read directly for this assessment: the repository at
`native-platform-steering` (3962f549); `@anthropic-ai/claude-agent-sdk@0.3.245`
`sdk.d.ts`; `@opencode-ai/sdk@1.18.23` `dist/v2/gen/{sdk,types}.gen.d.ts`;
`@cursor/sdk@1.0.28` `dist/esm/{agent,run,options}.d.ts`;
`@earendil-works/pi-coding-agent@0.84.3` `dist/core/agent-session.d.ts`. ACP v1
schema and the ACP v2 draft announcement were read through Context7
(`/agentclientprotocol/agent-client-protocol`); the Claude Agent SDK's
streaming-input documentation through `/websites/code_claude_en_agent-sdk`.
