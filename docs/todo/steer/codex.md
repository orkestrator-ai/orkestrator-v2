# Native `/steer` feasibility

Date: 2026-08-28  
Code reviewed: `3962f549`

## Scope

This report derives the current behaviour from the implementation, tests, and
the installed SDK/protocol contracts. No other document under
`docs/todo/steer/` was consulted.

The platforms covered are the native platforms in
[`agent-platforms.ts`](../../../packages/protocol/src/agent-platforms.ts):
Claude, Codex, Cursor, Grok, OpenCode, and Pi.

## Executive conclusion

Codex `/steer` is more than a way to submit text while the composer says that a
turn is running. It is a turn-pinned, retry-safe operation with an authoritative
transcript boundary. That is the standard a genuinely equivalent feature needs
to meet.

| Platform | Current state | Native same-run primitive | Feasibility of Codex-like behaviour |
| --- | --- | --- | --- |
| Codex | Shipped | `turn/steer` | Baseline |
| Pi | Shipped, with weaker guarantees | `AgentSession.steer()` | High for user-visible behaviour; medium for Codex-level failure guarantees |
| OpenCode | Not exposed by Orkestrator | V2 prompt admission with `delivery: "steer"` | High for native steering; conditional for strict turn pinning |
| Claude | Not exposed by Orkestrator | Streaming input on a live `Query` | Plausible, but the exact delivery semantics need a contract probe |
| Cursor | Not supported | None on an active `Run` | Blocked by the SDK |
| Grok | Not supported | None in ACP v1 | Blocked by the protocol/provider |

The practical path is:

1. Harden Pi, because Orkestrator already advertises it as steer-capable.
2. Prototype OpenCode's V2 steer admission and its stale-turn race before
   enabling the capability.
3. Probe Claude streaming input against the pinned SDK and CLI before choosing
   an implementation.
4. Do not emulate steering for Cursor or Grok with cancel-and-reprompt. The
   existing durable Orkestrator queue already covers the distinct “do this
   next” use case without misrepresenting it as same-run steering.

## What “Codex-like” means

A provider should not receive the `/steer` capability merely because it accepts
another prompt while busy. The Codex implementation establishes these
observable guarantees:

1. **Same run:** the instruction joins the already-running provider turn. It
   does not start an unrelated turn.
2. **Stale-turn rejection:** the request is bound to the turn the user saw. If
   that turn ends or is replaced before admission, the instruction is not sent
   somewhere else.
3. **Retry safety:** a lost HTTP response is reported as `unknown`, and retrying
   the same request ID cannot insert the instruction twice.
4. **Authoritative reconciliation:** a bridge restart or an evicted in-memory
   request record can be reconciled against provider state.
5. **Transcript fidelity:** the steering user message appears at the point at
   which the running assistant changed direction. Output before and after it is
   not collapsed into one assistant row or reordered.
6. **Background correctness:** an inactive or remounted tab can recover the
   result from backend/bridge snapshots. Live events are not the sole record.
7. **Honest outcomes:** `applied`, `idle`, `mismatch`, and `unknown` remain
   distinct. Ambiguity is never converted into a silent retry or success.

These guarantees are also the useful dividing line between steering and the
shared durable prompt queue. A queued prompt is intentionally a later unit of
work. A steer changes the work that is already in progress.

## How Codex `/steer` works today

### Shared command and UI routing

The command is no longer fundamentally Codex-specific at the renderer layer:

- [`agent-slash-commands.ts`](../../../packages/protocol/src/agent-slash-commands.ts)
  defines `/steer` as a runtime session action.
- The command is advertised only when `capabilities.actions.steer` is true.
- It is claimed as an action only while the projected turn is running. An
  incapable provider keeps `/steer ...` as ordinary prompt text.
- [`AgentNativeTab.controller.tsx`](../../../apps/web/src/components/native-agent/AgentNativeTab.controller.tsx)
  routes the action before normal dispatch or queueing, rejects attachments,
  creates a request ID, and preserves that ID and the draft after an ambiguous
  result.

The protocol already has the provider-neutral pieces in
[`native-agent.ts`](../../../packages/protocol/src/native-agent.ts):

```ts
{ kind: "steer"; text: string; requestId: string }

outcome: "applied" | "idle" | "mismatch" | "unknown"
```

There is a second entry point in
[`AgentInfoButton.tsx`](../../../apps/web/src/components/layout/AgentInfoButton.tsx):
the explicit “Active turn” steering panel. That panel is still gated on the
provider name `codex`. The slash-command path will generalise automatically
when another provider advertises the capability; identical panel UX will
require converting this gate to capability-based shared action routing.

### Backend and bridge routing

The shared backend action reaches the selected provider through
[`native-agent-service-dispatch.ts`](../../../apps/backend/src/core/native-agent-service-dispatch.ts).
For Codex,
[`http-bridge-provider.ts`](../../../apps/backend/src/core/http-bridge-provider.ts)
does the following:

1. Reads `/session/:id/status`.
2. Requires `status: "running"` and captures the active `turnId`.
3. Posts `{ input, requestId, expectedTurnId }` to `/session/:id/steer`.
4. Preserves the distinction between a stale-turn `409`, an ambiguous transport
   failure, and an accepted request.

The Codex route in
[`index.ts`](../../../bridges/codex-bridge/src/index.ts) validates all three
fields and maps runtime results to explicit HTTP outcomes. An idle raw
`/steer` is also intercepted locally by
[`app-server-runtime-prompt.ts`](../../../bridges/codex-bridge/src/app-server-runtime-prompt.ts),
so stale UI cannot accidentally turn it into a new Codex model turn.

### Turn-safe dispatch and retry

The core implementation is
[`app-server-runtime-sessions.ts`](../../../bridges/codex-bridge/src/app-server-runtime-sessions.ts).
It keeps a bounded request ledger keyed by the client request ID and records the
thread, expected turn, input digest, and whether the result is accepted or
unknown.

Before a fresh dispatch, and before retrying an ambiguous dispatch, it asks the
engine to reconcile the request. The engine implementation in
[`app-server-engine.ts`](../../../bridges/codex-bridge/src/engine/app-server-engine.ts)
uses `thread/read` and the supplied `clientUserMessageId` to determine whether
the provider already attached that exact message to that exact turn.

Only after reconciliation does the engine call app-server `turn/steer` with:

```ts
{
  threadId,
  expectedTurnId,
  input,
  clientUserMessageId: requestId,
}
```

This closes two otherwise dangerous races:

- A request delayed until a later turn cannot be delivered to the later turn.
- A timeout after app-server accepted the message does not cause a duplicate on
  an exact retry, even after a bridge restart.

Only a provider error that proves the expected turn is stale becomes
`mismatch`. A timeout, process exit, or closed transport remains `unknown`.

### Transcript ordering

App-server persists the accepted steer as another user item inside the active
turn. The bridge therefore has to split one streaming assistant turn into:

```text
assistant output before the steer
user steering instruction
assistant output after the steer
```

The runtime obtains authoritative preceding/following item IDs from
`thread/read`. The accumulator in
[`turn-accumulator.ts`](../../../bridges/codex-bridge/src/sessions/turn-accumulator.ts)
freezes the current assistant segment at that item boundary and starts a new
one. It deliberately does not infer a boundary merely because an item is absent
from a partial or truncated read.

This is a substantial part of the feature, not cosmetic rendering. Without it,
the displayed conversation can claim that an assistant produced post-steer
output before the steering instruction existed.

### Test coverage that defines the contract

The current tests cover more than the happy path:

- UI action routing, incapable-provider fallback, and ambiguous request-ID
  reuse.
- Route validation and every action outcome.
- Expected-turn and client-message IDs on the app-server request.
- Idle and stale-turn races.
- Timeout reconciliation, bridge restart reconciliation, and request-cache
  eviction.
- Multiple steering messages in one turn.
- Streaming item completion around the steer boundary.
- Partial/truncated `thread/read` results and transcript rehydration.
- Detach/reattach behaviour.

Relevant suites include
[`AgentNativeTab.test.tsx`](../../../apps/web/src/components/native-agent/AgentNativeTab.test.tsx),
[`http-bridge-provider.test.ts`](../../../apps/backend/src/core/http-bridge-provider.test.ts),
[`index-routes.test.ts`](../../../bridges/codex-bridge/src/index-routes.test.ts),
[`app-server-engine.test.ts`](../../../bridges/codex-bridge/src/engine/app-server-engine.test.ts),
and
[`app-server-runtime-prompt.test.ts`](../../../bridges/codex-bridge/src/app-server-runtime-prompt.test.ts).

## Platform assessments

### Pi: real steering is already present, but it is not retry-safe

Pi is already marked `actions.steer: true`, and the shared backend posts the
request to the Pi bridge. The bridge handler in
[`http.ts`](../../../bridges/pi-bridge/src/http.ts) checks that the session is
running and calls `session.steer(text)`.

This is a genuine provider primitive. Pi documents steering as an instruction
delivered after the current assistant finishes active tool calls and before the
next model call in the same agent loop. It is meaningfully different from Pi's
follow-up queue and from Orkestrator's durable prompt queue. See the official
[Pi SDK documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md).

The current Orkestrator route nevertheless has three important gaps:

1. **It ignores `requestId`.** The backend sends one, but the Pi bridge parses
   only `input`. If `session.steer()` succeeds and the HTTP response is lost,
   the UI's exact retry can enqueue the same instruction twice.
2. **It has no expected run identity.** It checks only `state.status ===
   "running"`. A delayed request can cross the boundary between two runs in the
   same session and steer the wrong one.
3. **The rendered transcript has no equivalent split.** Pi queue events update
   pending queue state, but the current translation path does not insert a live
   user steering row and split the surrounding assistant output in the way the
   Codex accumulator does.

The first two gaps can be reduced with a bridge-owned monotonically changing
`runId`, exposed in status and required as `expectedRunId`, plus a bounded
request ledger keyed by `(sessionId, runId, requestId, inputDigest)`. The bridge
must check the run and mark admission in the same synchronous state transition
around `session.steer()`.

Exact crash-window reconciliation is harder. Unlike Codex's
`clientUserMessageId`, the currently used Pi surface does not give the bridge a
documented durable client ID it can search after restarting. Persisting an
accepted ledger improves ordinary response-loss retries, but a process death
between Pi admission and ledger persistence remains ambiguous. Exact parity
there requires either a stable ID in Pi's persisted conversation/event stream
or upstream idempotent admission support.

For transcript fidelity, the bridge should consume the delivered steering user
message as an authoritative event, persist it, and split the assistant row at
that event. If Pi does not emit a stable delivered-message event, the UI may
show a clearly labelled “steering requested” event, but it must not claim exact
delivery ordering that the provider cannot prove.

**Assessment:** high feasibility for the behaviour users expect, with a
medium-sized hardening change. Exact Codex-level recovery across a Pi bridge
crash is conditional on a durable provider identifier.

### OpenCode: the strongest additional native candidate

The installed `@opencode-ai/sdk` client exposes the V2 session prompt surface.
The current V2 contract admits a prompt with:

- a caller-supplied ID;
- `delivery: "steer" | "queue"`; and
- `resume`, which controls whether admission schedules execution.

The V2 design describes durable, idempotent prompt admission. Reusing the same
ID for the same session/prompt/delivery returns the existing admission, while
conflicting reuse fails. The runner consumes pending steers ahead of normal
queued prompts between assistant/tool iterations. See OpenCode's official
[V2 session specification](https://github.com/anomalyco/opencode/blob/dev/specs/v2/session.md).

Those properties map unusually well to Orkestrator:

- the existing UI `requestId` can become the V2 prompt ID;
- durable admission can resolve response-loss and backend restart ambiguity;
- the delivery type preserves the steer/queue distinction; and
- durable sequence/history can support inactive-tab recovery and transcript
  ordering.

There are two unresolved integration questions.

First, [`opencode-provider.ts`](../../../apps/backend/src/core/opencode-provider.ts)
currently dispatches normal work through `client.session.promptAsync()`. Its
message hydration, lifecycle tracking, and event reconciliation are built
around that existing surface. A steer implementation must prove that V2 prompt
admission is compatible with sessions created through the current path, and
that the current event stream and message history expose the admitted steer.
If not, this becomes a broader V2 lifecycle migration rather than one new
session action.

Second, the reviewed V2 admission contract does not expose a Codex-style
`expectedTurnId`. A status check followed by admission is not atomic. If the
active run ends in between, a `delivery: "steer"` admission could remain pending
or schedule work later instead of returning `idle`/`mismatch`. `resume: false`
may prevent an immediate wake-up, but it does not by itself prove that a stale
steer cannot be consumed by a later run.

A focused spike should therefore answer:

1. Can the pinned OpenCode server admit `delivery: "steer"` for a session
   created through the existing provider?
2. What happens when admission races with the final event of the active run?
3. Can a stale admitted steer be atomically rejected or withdrawn?
4. Does an exact ID retry return the original receipt without another message?
5. Do the existing message and event APIs preserve the steering user message
   and its order relative to tool/assistant events?

If OpenCode has an atomic active-run precondition that is merely absent from
the reviewed surface, the implementation can reach close parity. Without one,
it should be described as provider-native steering with weaker stale-turn
protection, and the UI should not report a Codex-style `mismatch` it cannot
prove.

**Assessment:** high feasibility for native steering and retry safety;
medium-to-large integration scope; strict stale-turn equivalence remains
conditional.

### Claude: the transport exists, but steering semantics are not yet proven

The Claude Agent SDK `Query` supports streaming input and an `interrupt()`
control. Official examples keep an async input generator open and yield later
user messages into the same query. See
[Streaming Input Mode](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).

Orkestrator's Claude bridge is already close to the necessary transport shape:

- [`session-manager-persistence.ts`](../../../bridges/claude-bridge/src/services/session-manager-persistence.ts)
  converts every prompt into a held-open async iterable.
- [`session-manager-prompt.ts`](../../../bridges/claude-bridge/src/services/session-manager-prompt.ts)
  passes that iterable to the SDK query and retains the live query control.
- The SDK user-message shape supports a UUID, which may be usable as the
  Orkestrator request ID if the SDK persists and re-emits it.

The held iterable currently exposes only its initial prompt and `close()`. It
does not expose a push operation, and the local `ClaudeQueryControl` abstraction
does not expose the SDK's `streamInput()` method. Either could be extended to
inject a later `SDKUserMessage` without starting another `query()`.

The missing fact is semantic rather than mechanical: the public material proves
that follow-up input can enter a live query, but it does not clearly guarantee
that input arriving during tool execution is treated as immediate steering of
the same agent loop. The SDK type also exposes message priority values, but the
reviewed public documentation does not define them strongly enough to build the
feature around `priority: "now"` without testing it.

Before implementation, a live contract probe against the pinned
`@anthropic-ai/claude-agent-sdk` and Claude CLI should record:

- input injected during assistant token streaming;
- input injected during a long-running tool;
- input injected as the query is completing;
- the user/result events and UUIDs emitted for each case;
- behaviour across an approval request;
- whether response loss can be reconciled from resumed session history; and
- whether later assistant output demonstrably incorporates the injected input
  in the same query.

If the probe succeeds, the bridge still needs a bridge-owned active-query
generation exposed to the backend, an expected-generation check, a bounded
request ledger, explicit UUID mapping, and transcript segmentation. Claude has
no provider turn ID in the current session state, so the generation token is
essential to prevent delivery into a replacement query. Background tasks also
need care: only the live foreground query should be steerable, and releasing a
query handle must remove the capability even if child work remains active.

As with Pi, exact post-crash retry safety depends on whether the supplied user
UUID is durable and searchable in resumed history. If it is not, the bridge
cannot close the admission-versus-persistence crash window on its own.

**Assessment:** technically plausible and likely a large bridge/transcript
change. Do not advertise the capability until the same-query delivery and UUID
reconciliation probes pass.

### Cursor: no active-run injection surface

The pinned `@cursor/sdk` returns a `Run` from `Agent.send()`. A live run can be
streamed, inspected, awaited, or cancelled; it has no send/inject/steer method.
A further `Agent.send()` is a follow-up run, and the official SDK documentation
describes an active agent as busy. See the official
[Cursor TypeScript SDK documentation](https://cursor.com/docs/sdk/typescript).

Cancelling the run and sending a new prompt is not equivalent:

- current tool calls may be stopped rather than redirected;
- the original run has a terminal cancellation boundary;
- partial assistant/tool state no longer belongs to one continuing run; and
- a race can cancel or replace work the user did not intend to stop.

The existing Cursor bridge correctly rejects prompts while the session is
running. `/steer` should remain an ordinary provider prompt or be absent from
the advertised command list until Cursor exposes a documented same-run input
primitive with an acknowledgement or durable message identity.

**Assessment:** not feasible without upstream SDK support. The shared durable
queue is the honest current alternative.

### Grok over ACP: the protocol has no steer operation

Grok native mode is implemented by the ACP bridge. ACP v1 standardises
`session/prompt`, `session/cancel`, and agent-to-client session updates. It does
not define a client-to-agent steering/follow-up injection method. The canonical
contract is the
[ACP v1 schema](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/schema/v1/schema.json).

Sending a second concurrent `session/prompt` would rely on unspecified provider
behaviour. `session/cancel` followed by a new prompt has the same destructive
substitution problems as Cursor and also closes outstanding permission
requests. Neither should be labelled steering.

A future implementation is possible if either:

- ACP standardises a steer/input operation with defined concurrent-prompt
  semantics; or
- the Grok agent advertises a documented extension that the bridge can
  capability-negotiate.

Any extension should include an expected prompt/run identifier and a client
message ID. Capability detection must come from the negotiated ACP connection,
not a hard-coded assumption that every ACP agent accepts the extension.

**Assessment:** not feasible on the current standard protocol. Keep the
capability disabled and use the durable queue for later work.

## Shared implementation work

Most renderer and protocol work is already provider-neutral. Enabling another
provider should primarily be a provider/bridge change, but the following shared
work remains:

1. **Generalise the explicit panel.** Replace the Codex-name gate in
   `AgentInfoButton` with `capabilities.actions.steer` and route every provider
   through the shared native session action. Retain the same ambiguous
   request-ID behaviour.
2. **Carry an expected run token generically.** The public action need not expose
   provider IDs to the renderer, but the backend/provider boundary needs an
   atomic way to bind the request to the observed run. Codex already obtains
   its token from bridge status; Pi and Claude need bridge-owned equivalents.
3. **Keep outcome semantics honest.** Providers without atomic run matching
   cannot manufacture `mismatch`. They should return `unknown` when admission
   cannot be proved and `idle` only when provider state proves no eligible run
   existed.
4. **Use provider-owned durable identity where possible.** A bridge-only cache
   handles response loss but not the crash window between provider admission
   and cache persistence. OpenCode's prompt ID and Codex's client user-message
   ID are the useful models.
5. **Render delivery, not intent, as transcript history.** A temporary pending
   steering indicator may be driven by queue/admission state. The permanent
   user row and assistant split should come from an authoritative delivered
   provider event or reconciled history.
6. **Rehydrate on mount.** Pending/admitted steers and delivered transcript
   boundaries must be present in snapshot/history APIs. An SSE event received by
   a mounted tab is not sufficient.

No provider should be enabled by setting `actions.steer: true` before its
backend path implements these semantics. The capability controls both command
discovery and whether a running `/steer` is diverted away from the ordinary
prompt/queue path.

## Acceptance tests for every enabled provider

The Codex suites are the template. A provider should pass the following before
the capability is exposed:

| Scenario | Required result |
| --- | --- |
| Running turn, normal admission | One steering message joins that run |
| Turn ends before admission | `idle` or `mismatch`; no new work starts |
| A different turn starts before admission | The later turn is not steered |
| Response is lost after admission | Exact retry does not duplicate the message |
| Request ID is reused with different text | Rejected or `unknown`; never silently aliased |
| Bridge/backend restarts after ambiguous admission | Reconciles from provider state, or remains honestly `unknown` |
| Two steers in one run | Both appear once and in provider order |
| Steer during token streaming | No output is reordered around the user row |
| Steer during a tool/approval | Provider-defined boundary is preserved and visible |
| Tab is inactive, then remounted | Snapshot/history reconstructs outcome and transcript |
| Session is cancelling/recovering | Instruction is not delivered to an unintended run |
| Steer contains attachments or structured output | Rejected unless the provider contract explicitly supports it |
| Ordinary queued prompt while running | Remains a later queue item, not silently converted to a steer |

Provider-specific contract tests should sit at the narrow SDK/protocol boundary,
while the existing shared `AgentNativeTab` tests should be parameterised enough
to prove capability-gated routing for Codex, Pi, and each newly enabled
provider.

## Suggested delivery order

### 1. Pi hardening

Treat this as correcting an already-advertised capability. Add run identity,
request-ID validation/deduplication, explicit ambiguous outcomes, transcript
delivery handling, and inactive-tab recovery. Document the remaining crash
window if Pi offers no durable client message ID.

### 2. OpenCode contract spike, then integration

Exercise V2 steer admission against the pinned server and current session
lifecycle. Proceed only after the stale-run behaviour and legacy/V2 event
compatibility are known. If an atomic active-run condition is unavailable,
decide explicitly whether weaker native steering is acceptable rather than
implicitly claiming Codex parity.

### 3. Claude contract spike, then bridge implementation

Prove that late streaming input redirects the live query at the intended
assistant/tool boundaries and that supplied UUIDs survive into resumable
history. Only then add the pushable input channel, active-query generation,
request ledger, and transcript split.

### 4. Wait for Cursor and Grok primitives

Keep both capabilities disabled. Add support only when the upstream SDK or ACP
negotiation exposes same-run input; do not build a compatibility layer from
cancel plus prompt.

## Bottom line

The shared Orkestrator action and composer routing are already designed for
multiple platforms. The limiting factor is not the `/steer` command itself; it
is whether each provider offers an atomic, identifiable admission into the run
the user actually meant.

Pi can provide the experience now but needs reliability work. OpenCode is the
best-documented next candidate, subject to its active-run race and current
lifecycle compatibility. Claude has a promising live input channel but needs
empirical contract validation. Cursor and Grok cannot currently support the
same semantics without mislabelling cancellation or queueing as steering.
