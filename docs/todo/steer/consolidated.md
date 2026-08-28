# Native steering: consolidated research and implementation plan

Status: implementation-ready plan; provider gates called out below.  
Date: 2026-08-28  
Code reviewed: `3962f549` on `native-platform-steering`

## Purpose

This document consolidates the three independent steering assessments:

- [`codex.md`](codex.md);
- [`grok.md`](grok.md); and
- [`opus.md`](opus.md).

It also incorporates the live Claude, Pi, Grok, and OpenCode probes performed
after those reports were written, plus the OpenCode Session V2 migration
checkpoint in [`../opencode-v2.md`](../opencode-v2.md).

The goal is to implement as much real steering as the providers can support,
with one honest product contract across all platforms. The implementation must
not depend on migrating OpenCode to its experimental V2 Session protocol.

The request for no “login in the front” is interpreted as no steering **logic**
in the frontend. This design also preserves the stronger literal boundary:
provider login, credentials, bridge tokens, and authentication state remain in
the backend, bridge, or provider process. The renderer receives normalized
status and capability snapshots, never credentials.

## Executive conclusion

Use one strict production meaning of `steer`:

> Deliver this instruction to the provider run the user is currently watching,
> at the provider's next safe model boundary. If that run is no longer eligible,
> do not turn the instruction into later work.

Under that definition:

| Platform | Proven provider behavior | Production decision |
| --- | --- | --- |
| Codex | `turn/steer` is turn-pinned, caller-identified, reconcilable, and represented in authoritative history | Keep enabled; move the remaining retry and provider logic out of the renderer |
| Pi | `AgentSession.steer()` delivers inside the same agent run after current tool calls; delivery and persistence were live-proven | Keep enabled after adding a run token, persistent deduplication, honest ambiguity, and transcript handling |
| Grok | Private `_x.ai/interject` really interjects into one active ACP prompt, but a stale call intentionally starts a fallback turn | Implement the adapter and qualification tests, but do not advertise production steer until the provider can atomically reject stale interjections |
| Claude | Streaming input sometimes folds into a tool loop, but during token-only generation it becomes another turn; `priority: "now"` preempts | Do not advertise steer; retain the probe as a version-qualification test |
| OpenCode | Legacy/V1 Session has no native steer. V2 has real steer admission, but V1 and V2 use separate runners and projections | Stay on V1 and do not advertise steer; no V2 dependency in this plan |
| Cursor | A live `Run` can wait, stream, inspect, or cancel, but cannot accept more input | Do not advertise steer; wait for an upstream same-run primitive |

The immediate production target is therefore **Codex and Pi**. Grok is the
next viable platform once its stale-interjection race is closed by an atomic
provider operation. Claude, OpenCode V1, and Cursor keep Orkestrator's durable
follow-up queue, which remains deliberately distinct from steering.

This is not an implementation-cost decision. It is a semantic and reliability
decision: a provider is enabled only when it can uphold the same minimum
contract.

## The product contract

### Steer, queue, and cancel are different operations

- **Steer** changes the run already in progress. It is delivered at a safe
  provider boundary inside that run.
- **Queue** persists a prompt for a later run after the current run becomes
  idle. Orkestrator already provides this on every native platform.
- **Cancel and send again** ends the current run and starts replacement work.

Neither queueing nor cancel-and-reprompt may be presented as steer. If a stale
steer cannot be safely rejected, the provider does not satisfy the production
contract.

### Minimum guarantees for every enabled provider

1. **Same-run delivery.** The instruction joins the eligible run already in
   progress; it does not start another run.
2. **Run pinning.** Admission is bound to the run observed by the backend. A
   different run is `mismatch`, and no run is `idle`.
3. **Safe-point semantics.** Providers may differ in timing. Codex can accept
   through `turn/steer`; Pi waits until current tool calls finish. Both are
   valid because the next model iteration in the same run sees the instruction.
4. **No silent duplication.** A lost response never causes an automatic resend
   under a new identity. Exact retry either reconciles the original admission
   or remains `unknown`.
5. **Honest ambiguity.** If a provider lacks a durable caller ID and a process
   dies in the admission window, the result stays `unknown`. The system may
   sacrifice retryability; it may not guess and duplicate the instruction.
6. **Authoritative transcript.** A permanent user row is derived from a
   provider delivery event or reconciled history, not merely from click intent.
7. **Background correctness.** Pending, accepted, and ambiguous state is
   available through backend/bridge snapshots after tab unmount, environment
   switching, renderer restart, or missed live events.
8. **Bounded state.** Inputs, ledgers, history scans, event buffers, and replay
   windows have explicit byte and count limits.
9. **Credential isolation.** Provider credentials and authentication controls
   never cross into renderer-owned state.

These guarantees are the common floor, not a claim that every provider has the
same internal notion of a turn.

## Research method and versions

The original reports independently inspected the repository, installed SDK
types, generated protocols, and upstream documentation. The follow-up work
then exercised the uncertain contracts against the pinned runtimes rather than
inferring behavior from types alone.

| Platform | Qualified version | Evidence |
| --- | --- | --- |
| Codex | Repository-generated app-server protocol | Existing bridge implementation and contract suites |
| Pi | `@earendil-works/pi-coding-agent` `0.84.3` | [`pi-steering-probe.mjs`](probes/pi-steering-probe.mjs) against a real model/tool run |
| Claude | Agent SDK `0.3.245`, bundled Claude Code `2.1.245` | [`claude-streaming-probe.mjs`](probes/claude-streaming-probe.mjs) and [`claude-retry-probe.mjs`](probes/claude-retry-probe.mjs) |
| Grok | Grok Build CLI `1.0.10` | [`grok-acp-probe.mjs`](probes/grok-acp-probe.mjs) over the real stdio connection |
| OpenCode | SDK and CLI `1.18.23` | Live legacy/V2 compatibility and pure-V2 probes recorded in [`../opencode-v2.md`](../opencode-v2.md) |
| Cursor | `@cursor/sdk` `1.0.28` | Installed SDK surface and current bridge |

Current OpenCode documentation still describes V2 prompt admission with a
caller ID, `delivery: "steer" | "queue"`, and `resume`, while the stable SDK
examples continue to use the legacy `client.session.*` surface. The relevant
primary sources are the upstream
[V2 Session specification](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md)
and [SDK documentation](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/sdk.mdx).
The live probe is decisive for Orkestrator because it tests the exact pinned
client/server pair and current lifecycle.

## Where the original reports disagreed, and what resolved it

### OpenCode: promising types did not imply a safe hybrid

The reports agreed that OpenCode V2 exposed the strongest non-Codex admission
shape, but differed on likely integration scope. Live probing established:

- legacy and V2 APIs address the same top-level session ID;
- a V2 steer sent into a legacy `promptAsync` session starts a separate V2
  execution rather than joining the legacy run;
- V2 input and output appear only in V2 history, not in legacy messages;
- pure V2 steering works at a safe model boundary and exact ID reuse is
  idempotent; and
- a stale V2 steer can start a new drain, while `resume: false` merely parks it
  for a later drain.

The conclusion is no longer conditional: **there is no safe steer-only V2
addition to the current legacy integration**. OpenCode steering requires a
whole-session V2 migration and still lacks atomic stale-run admission. This
plan therefore leaves OpenCode on the current V2 SDK client plus legacy/V1
Session protocol and introduces no `client.v2.session` dependency.

### Claude: the transport is live, but the meaning changes by phase

The reports correctly identified the held-open input stream, but could not tell
whether later input was a steer or a queued command. The probe found:

| Injection point | Bare / `next` | `now` | `later` |
| --- | --- | --- | --- |
| During an active tool call | Folded into the same SDK query after the tool | Preempted the current query and began replacement work | Completed the original result, then ran a later turn |
| During token-only generation | Original result completed, then another turn handled the input | Aborted/preempted the original query | Ran as a later turn |

The supplied UUID is replayed and persisted, but retrying the same UUID after
completion or resume executes it again. It is not a durable idempotency key.

Claude therefore has a phase-dependent command channel, not one stable
steering operation. Restricting admission to a tool phase would still leave an
unavoidable race between the bridge's phase check and the CLI consuming the
message. Keep `actions.steer` disabled until Claude exposes an atomic contract
for same-query delivery or reject-if-no-longer-eligible behavior.

### Grok: the standard protocol lacks steer, but this CLI has an extension

All three reports concluded that ACP v1 offered only `session/prompt` and
`session/cancel`. That is correct for the standard protocol but incomplete for
the pinned Grok CLI.

The live probe discovered the unadvertised `_x.ai/interject` request:

- during an active `session/prompt`, it returns `status: "queued"`;
- the interjected instruction is consumed inside that same prompt drain;
- the original standard request has one final `turn_completed` event;
- no cancel or second standard `session/prompt` is required; and
- `_x.ai/session/interjection` echoes the caller's `interjectionId`.

Two results prevent immediate production use:

1. Repeating the same `interjectionId` inserts the instruction twice. The ID is
   correlation metadata, not provider idempotency.
2. Calling `_x.ai/interject` after the run becomes idle still returns queued
   and intentionally starts an `interject-fallback-*` prompt. It can run before
   the next ordinary prompt.

A backend status check and bridge `promptSequence` can reject obvious stale
requests, but they cannot close the final cross-process race after the check.
Production enablement requires a provider call that atomically binds the
interjection to the active prompt, or atomically rejects it when idle.

### Pi: bridge-owned run pinning is possible

One report advised against inventing an `expectedTurnId` that Pi itself could
not enforce; another proposed exposing the existing `promptSequence`. The live
probe and current bridge control flow support the second approach, with a clear
limit.

Pi's bridge increments `promptSequence` synchronously when it accepts a run,
and its runtime already uses that value to determine whether callbacks still
belong to the active run. `session.steer()` synchronously queues with the SDK
before its promise settles. A bridge process generation plus `promptSequence`
can therefore reject requests for an older run within one live process.

It cannot create provider-level post-crash idempotency. Pi does not accept a
caller message ID. The bridge must persist its ledger, but a crash after SDK
admission and before the accepted record is durable remains `unknown` and must
not be automatically resent.

### Frontend ownership: the existing generic path is not yet enough

The reports described most renderer routing as provider-neutral, which is true,
but the current renderer still owns reliability decisions:

- `AgentNativeTab.controller.tsx` mints and retains the request ID in draft/ref
  state after an ambiguous outcome;
- `AgentInfoButton.tsx` has a `codexSteerRetryRef`, a Codex-only provider gate,
  and a direct renderer-to-Codex bridge fast path; and
- the static capability table says which platforms support steer before a
  backend runtime has qualified the current bridge/provider instance.

That is incompatible with the desired backend-owned design. The shared command
parser can remain in the renderer as presentation behavior, but admission,
identity, retry, reconciliation, and runtime capability must move behind the
backend boundary.

## Current Codex baseline

Codex already solves the provider-side hard problems:

1. The backend reads authoritative status and captures `turnId`.
2. The bridge receives `{ input, requestId, expectedTurnId }`.
3. App-server atomically checks `expectedTurnId` in `turn/steer`.
4. `clientUserMessageId` makes admission searchable through `thread/read`.
5. A bounded ledger distinguishes accepted, stale, and ambiguous attempts.
6. Reconciliation avoids duplicate delivery after response loss or bridge
   restart.
7. The accumulator splits assistant output around the authoritative user item.
8. Rollout hydration reconstructs the same order after detach or remount.

The shared design should preserve this behavior while relocating request
ownership from the renderer to the backend. Codex is the reference adapter,
not a special renderer path.

## Target architecture

### 1. Renderer: presentation and intent only

The renderer may:

- show `/steer` when the backend projection says it is available;
- keep the user's current draft as ordinary ephemeral UI state;
- submit `{ kind: "steer", text }`;
- display normalized `pending`, `applied`, `idle`, `mismatch`, or `unknown`
  state from the projection; and
- invoke backend-provided `retry` or `discard` actions for a parked record.

The renderer must not:

- branch on `codex`, `pi`, or another provider name;
- generate or retain steer request IDs;
- read provider status or turn IDs;
- decide whether an ambiguous operation is safe to resend;
- call a bridge directly;
- infer acceptance from SSE delivery; or
- retain provider credentials, login results, or tokens.

`AgentInfoButton` should use the same backend action as the composer. Remove the
direct `steerCodexSession` path, `codexSteerRetryRef`, and provider-name gate.
The panel becomes capability-driven shared chrome, or it can be removed if the
composer is the preferred single entry point.

### 2. Backend: authoritative steer coordinator

Add one backend coordinator in the native-agent service layer, backed by
`StorageService` and serialized per logical session. It should own:

- request ID generation;
- input validation and byte limits;
- resolution of logical session to provider session;
- runtime capability and active-run checks;
- provider run-token acquisition;
- persistent `prepared`, `accepted`, `unknown`, and terminal records;
- exact retry and reconciliation policy;
- conflict handling when another steer is parked;
- discard handling;
- projection state for inactive/remounted tabs; and
- retention and cleanup limits.

One active or unresolved steer per logical session is sufficient. A suggested
record is:

```ts
interface PersistedSteerDispatch {
  logicalSessionKey: string;
  provider: AgentPlatform;
  providerSessionId: string;
  requestId: string;
  input: string;
  inputDigest: string;
  expectedRunId: string;
  state: "prepared" | "accepted" | "unknown" | "idle" | "mismatch";
  createdAt: number;
  updatedAt: number;
}
```

The input is needed for a backend-owned retry and belongs in the same protected
storage boundary as prompts. Logs and metrics contain only the action kind,
provider, outcome, sizes, timings, and opaque IDs—never the input, transcript,
credentials, or attachment data.

Dispatch order:

1. Resolve the session and lock its action lane.
2. Reject unsupported or non-text input before creating a record.
3. Ask the provider adapter for authoritative active-run status.
4. Generate the request ID and persist `prepared` before provider dispatch.
5. Dispatch `{ input, requestId, expectedRunId }` to the bridge/provider.
6. Persist the explicit outcome before replying to the renderer.
7. On timeout or disconnect, reconcile through the provider adapter and persist
   `accepted` only on explicit positive evidence; otherwise persist `unknown`.
8. Rehydrate the parked state in every projection snapshot.

If an unresolved record already exists, a new steer does not pass it. The UI
receives backend-derived choices:

- **Retry** only when the adapter can safely reconcile or repeat the exact ID;
- **Discard** to stop treating the record as pending, without claiming it was
  not delivered; or
- no retry when the provider's crash window makes a repeat unsafe.

This should reuse the existing recoverable-dispatch and parked-dispatch storage
patterns where their invariants match, rather than create a second independent
reliability model.

### 3. Provider-neutral adapter contract

Add a provider-facing steering capability separate from the renderer protocol:

```ts
interface ProviderSteerAdapter {
  getActiveRun(sessionId: string): Promise<
    | { state: "running"; runId: string }
    | { state: "idle" | "unsupported" }
  >;

  steer(input: {
    sessionId: string;
    requestId: string;
    expectedRunId: string;
    text: string;
  }): Promise<{ outcome: "applied" | "idle" | "mismatch" | "unknown" }>;

  reconcile(input: {
    sessionId: string;
    requestId: string;
    expectedRunId: string;
    inputDigest: string;
  }): Promise<"applied" | "absent" | "unknown">;
}
```

`absent` means the provider has authoritative evidence that dispatch did not
land and an exact retry is safe. A missing record, bridge restart, unreadable
journal, or old bridge version is `unknown`, not `absent`.

For HTTP bridges, standardize:

- `GET /session/:id/status` for a user-initiated active-run snapshot;
- `POST /session/:id/steer` with `input`, `requestId`, and `expectedRunId`;
- `GET /session/:id/steer/dispatch?requestId=...` for no-touch reconciliation;
  and
- explicit `applied`, `idle`, `mismatch`, and `unknown` outcomes.

The reconciliation route must not touch liveness, hydrate a transcript, attach
an agent, or start work. Background reconciliation must never poll the
tab-facing `/status` route.

### 4. Capabilities and snapshots

Keep provider support and current availability separate:

- **Support** answers whether this exact provider/bridge version implements the
  production contract.
- **Availability** answers whether the current session has an eligible running
  run and no conflicting parked steer.

The backend projection should combine them into the action exposed to the UI,
including a normalized reason when unavailable. Do not enable a provider by
changing only the static `nativeAgentCapabilities()` table.

Live events can trigger a refresh, but the projection snapshot is
authoritative. Returning to a tab must reconstruct capability, parked state,
transcript delivery, and the permitted recovery actions without having seen the
original event.

### 5. Transcript model

Use two stages:

1. A backend-owned pending/unknown interaction card represents dispatch state.
2. An authoritative delivered user row represents conversation history.

Remove the pending card only after a provider event or reconciliation proves
delivery. Do not insert a permanent user row merely because a bridge accepted
the HTTP request.

Provider adapters may use different evidence:

- Codex: app-server user item plus `clientUserMessageId` and item ordering;
- Pi: delivered `message_start`/`message_end` user event and persisted JSONL;
- Grok, once safe: `_x.ai/session/interjection` for correlation plus the
  provider's prompt/update ordering.

## Provider implementation plans

### Codex: migrate orchestration to the shared backend

1. Wrap the existing Codex status, dispatch, and reconciliation behavior in
   the provider-neutral adapter.
2. Make the backend coordinator generate and persist the request ID.
3. Remove renderer-to-bridge steering and both renderer retry refs.
4. Project ambiguous Codex state from the backend with retry/discard actions.
5. Keep `turn/steer`, `expectedTurnId`, `clientUserMessageId`, `thread/read`
   reconciliation, and transcript splitting unchanged.
6. Retain the bridge's bounded ledger as a provider-local defense and recovery
   aid; it complements rather than replaces the backend record.

This phase proves the new shared architecture without changing Codex's
provider-visible behavior.

### Pi: harden the already-enabled primitive

1. Give each Pi bridge process an opaque generation and expose the active run
   as `pi:<generation>:<promptSequence>`.
2. Require `requestId` and `expectedRunId` on the Pi steer route.
3. Check the token against `state.status`, `state.dispatching`, and
   `promptSequence` immediately before calling `session.steer()`.
4. Add a byte- and count-bounded persistent ledger keyed by session,
   request ID, run ID, and input digest.
5. Persist `prepared` before the SDK call and `accepted` after the SDK confirms
   queue admission. An exact accepted retry returns `applied` without calling
   the SDK again.
6. After restart, a `prepared` record with no durable provider caller ID stays
   `unknown`; do not automatically resend it.
7. Consume Pi's user-message delivery event to append the steering user row at
   the actual safe-point boundary. Rehydrate from the Pi JSONL session file,
   which the live probe showed contains the initial prompt, assistant/tool
   activity, steering user message, and post-steer response in provider order.
8. Keep Pi steering and Pi follow-up events distinct from Orkestrator's durable
   prompt queue in snapshots and labels.
9. Intercept an idle raw `/steer` at the bridge prompt path so it cannot expand
   as a normal prompt and start unintended work.

The probe also showed that calling `session.steer()` twice inserts two queue
entries, two user messages, two model iterations, and two persisted messages.
The ledger is therefore required, not defensive polish.

### Grok: implement behind a strict provider gate

1. Extend the ACP JSON-RPC client typing and router for `_x.ai/interject` and
   `_x.ai/session/interjection` without teaching downstream transcript code a
   Grok-specific shape.
2. Correlate `interjectionId` with the backend request ID, but do not treat the
   provider echo as admission idempotency.
3. Add the same bridge generation, `promptSequence` run token, bounded ledger,
   input digest conflict rules, and explicit outcomes as Pi.
4. Record provider broadcasts off the stdout loop; never await transcript
   rendering, persistence, or the browser from that loop.
5. Add a startup/version qualification probe that distinguishes extension
   absence from invalid session input without causing a real interjection.
6. Investigate whether the pinned or a later Grok build exposes a callable
   atomic queue-interject operation, expected prompt ID, or reject-if-idle
   option. Verify it with the end-of-turn race, not only a happy-path call.
7. Keep runtime `actions.steer` false until that probe proves a stale request
   cannot create `interject-fallback-*` work.

A feature flag that merely accepts the fallback behavior would create a second
definition of steer. It is not part of this consistent production plan.

### Claude: retain a qualification probe, not a partial adapter

Do not add a production route based on the current phase checks. Preserve the
probe and run it when upgrading the Agent SDK/CLI. Reconsider only when the
provider offers all of:

- an explicit same-query/same-run delivery mode;
- atomic rejection when that query is no longer eligible;
- a caller ID or authoritative history for deduplication; and
- events/history that place the delivered user instruction in order.

Claude's existing durable Orkestrator queue remains the honest later-work path.
`priority: "now"` is preemption and should stay conceptually under stop/restart,
not steer.

### OpenCode: stay entirely on legacy/V1 Sessions

No step in this plan calls `client.v2.session.*`.

- Keep session creation, prompt dispatch, messages, events, reconciliation, and
  actions on `client.session.*`.
- Keep `actions.steer` false.
- Do not send V2 input into a legacy session, even as an experiment in
  production; the live probe showed concurrent runners and divergent history.
- Keep using Orkestrator's durable prompt queue for later work.
- Revisit only through the full readiness gate in
  [`../opencode-v2.md`](../opencode-v2.md), not as part of steering.

If OpenCode later adds a stable legacy-session steer with atomic active-run
binding, it can be implemented independently. The current documented primitive
does not provide that path.

### Cursor: wait for an upstream primitive

Keep `actions.steer` false. Do not call `Agent.send()` concurrently and do not
compose `Run.cancel()` plus a new send. Re-run a narrow SDK surface probe on
version upgrades and implement an adapter only when a live `Run` can accept
caller-identified input with defined active-run behavior.

## Delivery sequence

### Phase 0: codify the contract

- Add provider-neutral adapter types and outcome tests.
- Add the persisted backend steer record and per-session serialization.
- Define byte/count/retention limits and no-content observability.
- Add projection state for support, current availability, parked outcome, and
  backend-derived retry/discard actions.

### Phase 1: move Codex behind the coordinator

- Route both composer and Active turn panel through the backend.
- Remove renderer request-ID and ambiguous-retry ownership.
- Retain all existing Codex bridge and transcript semantics.
- Run the existing Codex route, reconciliation, restart, transcript, detach,
  and UI suites as the compatibility baseline.

### Phase 2: make Pi satisfy the contract

- Implement run tokens, persistent deduplication, reconciliation outcomes, and
  authoritative transcript delivery.
- Keep ambiguous post-crash admission blocked rather than resend it.
- Parameterize shared UI/backend tests for Codex and Pi.

At the end of this phase, Codex and Pi expose the same product action through
the same backend-owned lifecycle, while retaining their provider-specific safe
points.

### Phase 3: prepare Grok and close the provider gap

- Land extension parsing, correlation, bridge ledger, and conformance probes
  behind a disabled runtime capability.
- Seek or verify an atomic active-prompt interjection operation.
- Enable Grok only after the stale/end-of-turn suite proves no fallback turn is
  possible.

### Phase 4: continuous provider qualification

Add narrow, opt-in live checks to the agent upgrade workflow:

- Claude phase behavior and UUID replay;
- Grok extension discovery, duplicate ID behavior, and stale interjection;
- Cursor live-Run input surface; and
- OpenCode V2 readiness only under its separate migration checkpoint.

Provider upgrades do not automatically enable steer. They update the evidence
used by the backend runtime-support gate.

## Acceptance suite for every enabled provider

| Scenario | Required result |
| --- | --- |
| Running run, ordinary steer | Exactly one instruction joins that run |
| Run ends before admission | `idle` or `mismatch`; no later work starts |
| Another run replaces it | The replacement run is untouched |
| HTTP response is lost after admission | Backend reconciles; no duplicate |
| Same request ID, different input | Refused; neither version is resent |
| Backend restarts with a parked record | Projection rehydrates the record and allowed recovery actions |
| Bridge dies before provider admission | Retry occurs only after authoritative `absent` evidence |
| Bridge dies in provider admission window | `unknown` if no provider ID can reconcile; never auto-resend |
| Two distinct steers in one run | Each appears once in provider order |
| Steer during token output | Provider-defined behavior remains same-run and transcript order is honest |
| Steer during tools or approval | Delivered at documented safe point; no approval defaults to allow |
| Tab/environment is inactive | Work continues; return reconstructs state from snapshots/history |
| SSE disconnect/replay gap | Gap is detected and snapshot reconciliation restores state |
| Session is cancelling/recovering | Instruction is not admitted to unintended work |
| Attachment or oversized text | Rejected before provider dispatch |
| Ordinary compose while running | Remains an Orkestrator queue item, not a steer |
| Ledger/replay/input limits | Old state is bounded without converting uncertainty to success |

Provider-specific tests must exercise the real boundary in addition to fake
agents. Grok's extension and Claude's phase behavior demonstrate why a fake
ACP/SDK surface alone is insufficient.

## Explicit non-goals

- No OpenCode Session V2 migration or mixed V1/V2 session lifecycle.
- No cancel-and-reprompt steering emulation.
- No conversion of ordinary queued prompts into steering messages.
- No frontend provider branches, request journals, run IDs, or credential
  state.
- No success inferred only from an emitted SSE frame.
- No automatic replay of an ambiguous provider admission under a new ID.
- No claim that all provider safe points occur at identical times.

## Final decision record

1. **Codex remains the reference production implementation.** Its provider
   guarantees stay intact while orchestration moves to the backend.
2. **Pi is the second production implementation.** Its primitive is real and
   live-proven; hardening must precede treating its result as equivalent at the
   product layer.
3. **Grok is implementation-ready but not enablement-ready.** The private
   interjection RPC is useful, but its stale fallback violates the common
   contract until an atomic guard exists.
4. **Claude is not consistently steerable on the pinned runtime.** Tool-loop
   folding is insufficient because token-generation input becomes another
   turn.
5. **OpenCode remains on the legacy/V1 Session protocol.** Native V2 steering
   is explicitly excluded from this work.
6. **Cursor remains unsupported.** Cancellation and a later send are not
   steering.
7. **All steering authority lives behind the backend boundary.** The renderer
   expresses intent and renders snapshots; backend and bridge state determine
   what is supported, what ran, and what recovery is safe.

This implements the widest platform set that can keep one truthful meaning of
`/steer`: Codex and Pi now, Grok when its provider-side stale-run gap closes,
and the remaining platforms when they expose an equivalent atomic primitive.
