# Native `/steer` feasibility for other platforms

Date: 2026-08-28. Branch: `native-platform-steering`.

Scope: how `/steer` works for Codex native tabs today, and whether the
other native platforms can grow the same *kind* of behaviour. The other
native platforms are Claude, OpenCode, Pi, Cursor, and Grok. Assessment
is from the current source, the pinned SDKs, and the generated Codex
app-server protocol. It is not an implementation plan.

Method: Codex is the baseline because it is the only engine whose
`turn/steer` path is fully wired through composer, backend, bridge,
transcript split, and retry. A platform is "similar" only if a running
turn can receive extra user text that changes *that* turn, without
being queued as a later prompt and without starting a new turn on
failure.

## 1. What "steer" means in this product

Three different things look similar in the composer and must not be
collapsed.

**Ordinary prompt.** Starts a turn. If the tab is already running, the
shared native tab enqueues it (`capabilities.queue` is true for every
platform) and the backend drains the queue after idle. That is
follow-up work.

**Cancel and re-prompt.** Stops the run, then sends a new prompt. The
work that was in flight is abandoned. Cursor's `Run.cancel()` and ACP
`session/cancel` are this. It is not steering.

**Steer** (`capabilities.actions.steer`). Hands extra instructions to
the turn that is already running, so that turn's later model calls see
them. The Codex comment in the shared composer is the product
definition: a runtime command on the live turn is not a prompt, because
queueing it would run it *after* the turn it was meant to redirect.

The capability is the gate, not the platform name. The composer
resolves `/steer` only when `actions.steer === true` *and* a turn is
running. A provider that does not advertise the action keeps `/steer
…` as ordinary prompt text, including while it is running, so it lands
in the follow-up queue.

Idle `/steer` is also an ordinary prompt at the composer. Codex then
intercepts that leaked prompt in the bridge and answers locally,
rather than starting a model turn whose first user message is the
raw command.

## 2. How Codex `/steer` works today

Codex is the only engine with a vendor RPC whose contract is "this
text joins this turn, or it is rejected".

### 2.1 Composer and command table

`packages/protocol/src/agent-slash-commands.ts` defines `/steer` as a
runtime session action: kind `steer`, capability `steer`, argument
hint `<instructions>`, refused when bare with *"Add instructions
after /steer."*

`resolveSessionActionCommand(text, capabilities, runningTurn)`:

- returns `null` when no turn is running (idle `/steer` is a prompt);
- returns `null` when `capabilities.actions.steer` is not true;
- otherwise returns `{ kind: "steer", text }` or an `error`.

`withSessionActionSlashCommands` merges `/steer` into the discovered
command list only for a capable provider, and **deletes** a stale
`/steer` entry for a provider that cannot perform it. The native
projection uses this, so the slash menu advertises exactly what the
composer will execute.

The shared native tab
(`apps/web/src/components/native-agent/AgentNativeTab.controller.tsx`)
intercepts a resolved steer *before* queue or dispatch:

- attachments are refused ("`/steer` supports text only");
- `performNativeAgentSessionAction` is called with `{ kind: "steer",
  text, requestId }`;
- an `unknown` outcome stores that `requestId` so a retry of the
  *same* text reuses it instead of steering twice;
- the prompt queue is not touched.

A second UI, Codex-only, lives on `AgentInfoButton` as an "Active
turn" panel. That panel still calls `steerCodexSession` over the
Codex bridge when a loopback client exists, otherwise the same
backend session action. It is not the path other platforms would
use; the composer `/steer` path already is.

### 2.2 Capability table

`nativeAgentCapabilities()` in
`packages/protocol/src/native-agent.ts`:

| Platform | `actions.steer` |
| --- | --- |
| Codex | `true` (with compact and review) |
| Pi | `true` (with compact) |
| Claude | absent (`compact`, `rewindFiles` only) |
| OpenCode | absent (`compact`, `undo`, `redo`, `share`) |
| Cursor | `{}` |
| Grok | `{}` |

The backend `performProjectionAction` refuses any action the table
does not advertise. Flipping the flag without a provider path would
make the composer send an action the backend then rejects.

### 2.3 Backend

`NativeAgentSessionAction` is `{ kind: "steer"; text; requestId }`.
Validation requires both fields non-blank.

`HttpBridgeProvider.performSessionAction` has two steer branches:

- **Codex.** `GET /session/:id/status`. If not `running`, `idle`. If
  running with no `turnId`, `unknown` (cannot bind safely). Otherwise
  `POST /session/:id/steer` with `{ input, requestId, expectedTurnId }`.
  HTTP 409 maps to `idle` or `mismatch`. Body `outcome: "unknown"`
  or a thrown fetch maps to `unknown` plus the request id. 404 is
  "session was not found".
- **Pi.** `POST /session/:id/steer` with `{ input, requestId }` and
  **no** expected turn id. The comment states the reason: Pi holds
  its own queue and delivers before the next model call; the bridge
  answers `idle` when nothing is running.

Cursor and Grok throw immediately (`does not support session
actions`). OpenCode's provider implements compact/undo/redo/share
and throws `OpenCode does not support ${action.kind}` for steer.

### 2.4 Codex bridge

`POST /session/:id/steer` requires `input`, `requestId`, and
`expectedTurnId`, all non-blank.

`steerSession` in `app-server-runtime-sessions.ts`:

1. Look up a bounded in-process `steerRequests` map (cap 500) keyed
   by `requestId`, hashed with the input and bound to thread + turn.
   A reused id with different input or target is `unknown`, not a
   second dispatch.
2. An already-`accepted` id returns `accepted` without calling
   app-server.
3. An ambiguous previous attempt reconciles via `thread/read`. If
   the client id is present on the expected turn, accept and split
   the transcript using the *original* `requestedAt`. If an
   authoritative read proves the write did not land, the id is
   forgotten and a retry may dispatch.
4. If the session is not running, `idle`. If the live `turnId` is
   not `expectedTurnId`, `mismatch` — without an RPC.
5. Even on a first attempt, reconcile first. A request found after
   cache loss (bridge restart) is `accepted` without appending a
   duplicate user row; the rollout already has it.
6. Call `turn/steer` with `threadId`, `expectedTurnId`, `input`,
   and `clientUserMessageId = requestId`.
7. Read ordering (`precedingItemIds` / `followingItemIds`) from
   another `thread/read`. A failed ordering read does not change
   acceptance.
8. Stamp `requestedAt` only after app-server has acknowledged the
   steer. Sampling before the RPC dated the row boundary earlier
   than the steer could have landed.
9. Transport failures, timeouts, and process death are `unknown`.
   A structured RPC error that says the expected turn is stale or
   no longer accepting input is `mismatch`.

The generated protocol (`TurnSteerParams`) makes `expectedTurnId`
required: "The request fails when it does not match the currently
active turn." `clientUserMessageId` is optional on the wire;
Orkestrator always sends the request id so a later `thread/read`
can prove delivery.

### 2.5 Transcript split

App-server persists an accepted steer as another user item *inside*
the active turn. The engine reducer does not render that live
userMessage, so the bridge splits the assistant stream:

- freeze the current assistant segment at the item boundary
  (`boundaryAfterItems` uses `followingItemIds` as positive
  evidence; absence from `precedingItemIds` is *not* used, because
  a still-streaming item is missing from a partial read while
  genuinely belonging above the steer);
- flush the coalescer so the pre-steer row is published first;
- append a user message with the same `turnId`;
- open a new assistant row for post-steer output;
- retain up to eight historical assistant segments so earlier rows
  keep re-rendering as late items arrive.

A detach/re-attach rebuilds the same shape from rollout order. A
test covers that path.

Idle `/steer` that still reaches `POST /prompt` is answered locally
(`parseCodexSteerCommand`) and never starts a model turn.
Structured output plus `/steer` is a 400.

### 2.6 Codex guarantees (the comparison baseline)

1. **Same-turn delivery.** The text is bound to one `turnId`. A
   different live turn is `mismatch`, not a silent apply.
2. **At-most-once.** `requestId` + input digest + persisted
   `clientUserMessageId` + `thread/read` reconciliation. Ambiguous
   transport never auto-retries.
3. **Idle is not a new turn.** Composer, status pre-check, bridge
   `idle` outcome, and the prompt-path builtin all refuse to start
   work the user did not ask for.
4. **Transcript fidelity.** The steering user row appears between
   the assistant activity that preceded it and the activity that
   followed it. Reload reconstructs that order.
5. **Text only, no queue conversion.** Attachments are rejected.
   Ordinary Enter while running still queues; `/steer` does not.
6. **Rehydrate.** Pending/ambiguous request ids live in the
   composer draft; accepted steers live in the rollout.

Anything labelled `/steer` for another platform should be measured
against these, not against "the composer accepted some text while
busy".

## 3. Shared infrastructure that already exists

Most of the *UI* work is already capability-gated and does not need
to be rebuilt per platform:

- slash parsing, menu merge, running-turn intercept, request-id
  reuse, idle-as-prompt, attachment refusal;
- backend action validation and capability check;
- outcome vocabulary: `applied` | `idle` | `mismatch` | `unknown`;
- native prompt queue as the *other* running-turn behaviour, which
  `/steer` must continue to bypass.

What does *not* exist as a shared primitive:

- a generic `expectedTurnId` on the action (only Codex's backend
  branch reads status and pins a turn);
- a generic steer HTTP route (only Codex and Pi serve
  `/session/:id/steer`);
- transcript splitting around a mid-turn user message (Codex-only);
- an "Active turn" panel for anyone but Codex.

Enabling another platform is therefore: prove a provider primitive
that joins the *current* turn, teach that provider's
`performSessionAction` to call it with retry-safe semantics, flip
`actions.steer`, and decide how honest the transcript can be.

Every native prompt path except OpenCode's admission currently
**409s while running**. That is load-bearing: it is why the
Orkestrator queue exists. A steer implementation must not go through
those prompt routes, or it will either 409 or, if the 409 is lifted
casually, start a second turn.

## 4. Per-platform assessment

Pinned versions used for SDK inspection: Pi `0.84.3`, OpenCode
`1.18.23` (SDK and CLI are required to match), Claude Agent SDK
`0.3.245`, Cursor SDK `1.0.28`, Grok Build `1.0.10`.

### 4.1 Pi — already advertised, weaker than Codex

**Feasibility of Codex-like UX: high. Feasibility of Codex-like
guarantees: medium, with known gaps.**

Pi is already `actions.steer: true`. A running Pi native tab already
routes `/steer …` through `performNativeAgentSessionAction`. The
backend posts `{ input, requestId }` to `/session/:id/steer`. The
bridge:

- 400s on blank input;
- returns `{ outcome: "idle" }` when no session is attached or
  `status !== "running"`, and does **not** start a turn;
- otherwise `await session.steer(text)` and returns
  `{ outcome: "applied" }`.

Pi's SDK (`AgentSession.steer`) is a real provider primitive:

> Queue a steering message while the agent is running. Delivered
> after the current assistant turn finishes executing its tool
> calls, before the next LLM call.

That is same-run steering, but it is not Codex `turn/steer`. It
does not interrupt a generation in flight; it waits for the current
tool batch. `followUp()` is the wait-until-settled cousin, which
matches Orkestrator's prompt queue, not `/steer`.

Gaps versus Codex:

1. **`requestId` is ignored.** The backend sends it and maps a
   thrown fetch to `unknown`, but `handleSteer` never reads it.
   There is no `steerRequests` map and no reconciliation. A lost
   HTTP 200 followed by a retry of the same text calls
   `session.steer` again.
2. **No turn pin.** Pi has no `expectedTurnId`. The backend comment
   treats this as acceptable because Pi owns the queue. A steer
   that arrives just as the run ends is `idle` (good). A steer that
   arrives as the *next* run starts is applied to whichever run is
   live at `session.steer()` time (not necessarily the one the
   composer saw).
3. **Transcript.** `translate.ts` records `queue_update` as pending
   `steering` / `followUp` strings. It never inserts a user message
   when a steer is delivered, and never splits the assistant row.
   The initial prompt's user row is appended by the prompt route
   *before* dispatch; a later steer is invisible in the rendered
   transcript unless Pi emits something this adapter does not
   currently consume. Pi's JSONL session file has the conversation;
   Orkestrator's transcript does not reconstruct Codex's
   before/steer/after shape.
4. **Queue surfaces are not the same queue.** `GET /session/:id/queue`
   exposes Pi's in-process steering + follow-up lists as generic
   items. The native projection's `queue` is Orkestrator's durable
   prompt queue in storage. The backend does not read the bridge
   `/queue` route. Pending Pi steers therefore do not appear in the
   composer queue UI, and ordinary queued prompts do not appear in
   Pi's SDK queue.

Pi also 409s `POST /prompt` while running, same as Cursor/Grok, so
Enter-while-running still uses Orkestrator's follow-up queue. That
split is correct: `/steer` and Enter are different verbs.

**To bring Pi up to Codex-like failure handling** (without pretending
the delivery model is identical): honour `requestId` with a bounded
map; on retry, do not call `session.steer` for a known-accepted id;
treat transport failure as `unknown`; optionally append a clearly
labelled user row when the SDK reports delivery, without claiming
item-accurate split if Pi does not expose one. Do **not** invent an
`expectedTurnId` Pi cannot enforce.

**Do not wait to "enable" Pi.** It is already enabled. The work is
hardening, plus deciding whether the weaker delivery timing
("after current tools") is acceptable to keep advertising as
`/steer`. It is still same-run, so it is closer to Codex than a
queue is.

### 4.2 OpenCode — explicit V2 steer admission, unused

**Feasibility of native steering: high, conditional on proving the
pinned server. Feasibility of strict turn pinning: unknown until
probed.**

OpenCode is the only engine without a bridge. The backend talks to
`opencode serve` through `@opencode-ai/sdk/v2/client`. Today
`OpenCodeProvider.send` uses the *legacy* session namespace:
`client.session.promptAsync({ sessionID, messageID, parts, … })`.
`performSessionAction` has no steer branch.

The same SDK also exposes a separate V2 namespace that this
repository never calls:

```ts
client.v2.session.prompt({
  sessionID,
  id?,                 // caller-owned admission id
  prompt?,
  delivery?: "steer" | "queue",
  resume?,
})
```

A successful call returns `SessionInputAdmitted` (`admittedSeq`,
`id`, `sessionID`, `prompt`, `delivery`, `timeCreated`, optional
`promotedSeq`). Errors include HTTP 409 `ConflictError`. Durable
events `session.next.prompted` and `session.next.prompt.admitted`
both carry `delivery: "steer" | "queue"`.

That is a first-class steer/queue distinction at admission time,
with an id that looks like the idempotency key Codex uses
`requestId` for. The SDK and CLI are pinned to the same version
(`1.18.23`), so the types are not from a newer client talking to
an older server in the intended install.

What is **not** proven in this codebase:

1. Does the pinned `opencode serve` actually admit
   `delivery: "steer"` on a live session, and does that text reach
   the in-flight agent loop rather than waiting for idle?
2. If the loop ends between admit and consume, is the admission
   rejected (409), withdrawn, or consumed by the *next* run?
3. Does reusing `id` after an ambiguous HTTP failure return the
   existing admission instead of creating a second one?
4. Does the current `session.messages` projection the backend
   already uses show the steered user message, or only the V2
   event stream?
5. How does this interact with Orkestrator's own prompt queue?
   Enter-while-running already enqueues. `/steer` must not also
   enqueue, and a V2 `delivery: "queue"` admission must not be
   what `/steer` calls.

There is no `expectedTurnId` on the V2 prompt API. Binding would
be "whatever loop is running when the admission is consumed",
closer to Pi than to Codex, unless 409-on-conflict is exactly
"the loop you wanted has ended".

Implementation shape, *if* a live probe confirms same-run
delivery:

- add a steer branch to `OpenCodeProvider.performSessionAction`
  that calls `client.v2.session.prompt` with `delivery: "steer"`
  and `id: action.requestId`;
- map 409 to `idle` or `mismatch` only after reading the error
  body (do not guess);
- map transport failure to `unknown` and reuse `id`;
- flip `actions.steer` for `opencode`;
- keep `promptAsync` for ordinary prompts so Enter remains the
  Orkestrator queue.

Do not route ordinary running-turn Enter through
`delivery: "steer"`. That would silently convert follow-ups into
steers.

**Unknown that should be answered with a focused live probe
against the pinned server before flipping the flag.** The types
are not a substitute for that probe: this repo already has a
history of vendor APIs that exist on paper and behave differently
on the wire.

### 4.3 Claude — streaming stdin is already open; steering is unproven

**Feasibility of *some* mid-query injection: medium. Feasibility of
labelling it `/steer` today: low until a probe says what extra
stdin messages actually do.**

The Claude bridge already runs every turn in streaming-input mode.
`holdSdkPromptOpen` yields the original user message, then keeps
the iterable open until the turn (including background agents) is
settled. The SDK comment is explicit: a string prompt closes stdin
on the first `result`; an AsyncIterable avoids that only while it
remains open.

So the transport for a later user message exists. The bridge does
not use it. `sendPrompt` throws `"Session is already processing a
prompt"` when `status === "running"`. `Query.streamInput` is never
called. `holdSdkPromptOpen` cannot yield a second message.

The Agent SDK's `SDKUserMessage` also carries:

- `priority?: 'now' | 'next' | 'later'`
- `uuid?: UUID` plus `cancel_async_message` for dropping a queued
  async user message
- `shouldQuery?: boolean` (false = append without starting a turn)

Those fields look like a concurrent-prompt scheduler, not like
Codex `turn/steer`. `priority: 'now'` *might* be immediate
injection into the live query; `'next'` / `'later'` look like
Orkestrator's queue. Nothing in this repository documents or tests
that mapping. `Query.interrupt()` is cancel, not steer.

A further complication is Claude's background-task release. A
result can publish the session `idle` while stdin stays open for
live tasks, then reclaim `running` if the model continues. A steer
that keys off `status === "running"` would see idle in that window
and either no-op or, if someone naively opened the prompt path,
start a *second* query against a CLI child that is still held. Any
Claude steer has to target the live `queryControl`, not the UI
phase, and must not inject into a retained background query the
user is no longer watching as "the turn".

Transcript: Claude's stream state groups by API message id and
block index. There is no equivalent of Codex's
`freezeAssistantSegment`. Injecting a user message mid-query would
need a new split (or an honest "steering requested" notice that
does not claim row-accurate placement).

**To even prototype:** add an injection queue to the held iterable
(or call `streamInput` on the live `Query`), a
`POST /session/:id/steer` that pushes onto it, refuse when no live
query exists, and *measure* whether the extra message:

- interrupts the current generation;
- waits for the current tool batch (Pi-like);
- or waits for the query result (that is a queue, do not advertise
  `steer`).

Until that measurement exists, do not set `actions.steer` for
Claude. The composer would then divert `/steer` away from the
queue for a behaviour that has not been shown to join the live
turn.

### 4.4 Cursor — no inject API

**Feasibility of real steering: none with the pinned SDK.
Emulating it: do not.**

Cursor native tabs drive `@cursor/sdk` in process.
`SDKAgent.send()` returns a `Run` whose operations are `stream`,
`wait`, `cancel`, and `conversation`. There is no steer, follow-up,
or inject method. `SendOptions` has `idempotencyKey` for *that*
send, not for a mid-run append.

The bridge 409s `POST /prompt` while `running` or `dispatching`.
That is correct: a second `send` would be another run.

`queuedFollowUp` appears only as a *subagent* `backgroundReason`,
not as a user-facing admission mode.

The only way to "redirect" a Cursor run today is `run.cancel()`
plus a new `send`. That is stop-and-reprompt. Labelling it `/steer`
would teach the composer that the text joined the live run, which
is false.

`capabilities.actions` is already `{}`. Keep it that way.
`capabilities.queue` is true, so Enter-while-running already
queues a follow-up that starts after idle. That is the honest
running-turn verb for Cursor.

### 4.5 Grok over ACP — the protocol as spoken here has no steer

**Feasibility of real steering: none on the current ACP surface.
Emulating it: do not.**

Grok native tabs are the ACP bridge speaking JSON-RPC to the
pinned `grok` CLI over stdio. Outbound session methods actually
used: `session/new`, `session/load`, `session/list`,
`session/prompt`, and notify `session/cancel`. `session/prompt`
is awaited until the turn ends (`PROMPT_TIMEOUT_MS`). A second
prompt while `running` or `dispatching` is HTTP 409.

Inbound, unknown methods are refused with JSON-RPC `-32601`.
There is no client-to-agent "inject into the current prompt"
method in this adapter, and the fake-agent tests would not catch a
vendor-only extension the real CLI does not implement.

Grok's argv (`--always-approve`, `--model`, `--reasoning-effort`,
`stdio`) is a versioned contract nothing in CI can check. Building
steering on an undocumented extra method would fail the same way:
the suite stays green against the fake agent.

`capabilities.actions` is `{}`. Same conclusion as Cursor: keep
the follow-up queue; do not advertise `/steer`. If ACP later
standardises a steer/input operation with defined concurrent-
prompt semantics, re-evaluate then, including whether Grok's CLI
implements it.

Cancel-and-reprompt is available (`session/cancel`) and should
stay labelled as stop, not steer.

## 5. Comparison

| Platform | Provider primitive | Orkestrator wiring today | Same-turn? | Retry-safe? | Transcript split? | Flip `actions.steer`? |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | `turn/steer` + `expectedTurnId` + `clientUserMessageId` | Full (composer, backend, bridge, split, idle builtin) | Yes, pinned | Yes | Yes | Already on |
| Pi | `AgentSession.steer()` after current tools | Composer + backend + HTTP route; no id, no pin, no split | Same *run*, not same generation | No | No | Already on; harden |
| OpenCode | V2 `session.prompt({ delivery: "steer", id })` | Unused (`promptAsync` only) | Unknown (types say yes) | Unknown (`id` looks like it) | Unknown | Not until a live probe |
| Claude | Open stdin + `SDKUserMessage` (+ optional `priority`) | Input held open; second prompt 409s | Unproven | Unbuilt | Unbuilt | Not until a live probe |
| Cursor | None (`Run.cancel` only) | 409 while running | No | n/a | n/a | No |
| Grok | None (`session/prompt` + `session/cancel`) | 409 while running | No | n/a | n/a | No |

## 6. What must not be labelled `/steer`

- **Orkestrator's prompt queue.** Every platform already has it.
  Enter while running is follow-up. Converting that into a steer
  would change work the user did not mark as immediate.
- **Cancel then send.** Cursor and Grok can do this. It abandons
  in-flight tool work. The composer copy for `/steer` is "send
  instructions to the turn that is already running".
- **Starting a new turn because the live one ended in the race.**
  Codex and Pi both answer `idle` instead. Any new path must too.
  Codex's prompt-path builtin is the extra backstop for idle
  `/steer` that leaked as a prompt; other platforms that enable
  the action should not let that leak become a model turn either.
- **Advertising the slash command from discovery without the
  capability.** `withSessionActionSlashCommands` already deletes
  a stale `/steer` entry. Do not add a platform-local `/steer`
  prompt template that the model would "execute".

## 7. Shared work that pays off once, if more than Pi/OpenCode land

Independent of which provider is next:

1. **Keep the capability as the only composer gate.** Do not
   special-case platform names in `AgentNativeTab`. Pi already
   relies on this. OpenCode/Claude should too.
2. **Generalise the AgentInfoButton panel only after the action
   works from the composer.** The panel is Codex-specific chrome,
   not the contract.
3. **Do not put `expectedTurnId` on `NativeAgentSessionAction`
   until a second provider can honour it.** Pi and OpenCode V2
   cannot. The Codex backend branch can keep reading `/status`
   itself.
4. **Idle `/steer` must not start a turn** on any provider that
   advertises the action. Codex handles this in the bridge prompt
   path. Pi currently would send `/steer …` as `session.prompt()`
   when idle, which expands commands. That is a pre-existing
   footgun for a capability that is already on.
5. **`/activity` remains a no-touch route.** A steer status read
   may use `/status` (Codex already does). Do not poll `/status`
   from a background reconciler; a user-initiated steer touching
   it is fine.
6. **Steer and queue stay distinct in the UI.** If a provider
   reports pending steers (Pi's `queue_update`), do not merge them
   into the durable follow-up queue without labelling. Codex does
   not show pending steers as queue items; they either land in the
   transcript or stay in the composer as an unconfirmed draft.

## 8. Suggested sequence

1. **Harden Pi**, because `/steer` is already offered there.
   Honour `requestId`, map transport loss to `unknown`, stop
   double-applying on retry, and intercept idle `/steer` so it
   cannot become a new Pi turn. Decide whether "after current
   tools" is acceptable copy, or whether the slash description
   should say so.
2. **Probe OpenCode V2** against the pinned `1.18.23` server:
   admit `delivery: "steer"` during a live loop, retry the same
   `id` after a dropped response, finish the loop before consume,
   and inspect `session.messages` plus V2 events. Only then add
   the `performSessionAction` branch and flip the flag.
3. **Probe Claude** by injecting one extra `SDKUserMessage` on the
   already-open iterable (and, separately, with `priority: 'now'`)
   during text generation and during a tool call. If it only
   surfaces after `result`, stop. If it joins the live query,
   design the route around `queryControl` liveness, not UI phase,
   and around background-task release.
4. **Do not emulate steering for Cursor or Grok.** Keep the queue.
   Revisit only if the vendor adds a real inject API.

## 9. Open questions a probe has to answer

These are not design choices; they are facts the current tree
cannot know.

| # | Question | Where to look | Why it matters |
| --- | --- | --- | --- |
| 1 | Does pinned OpenCode consume `delivery: "steer"` on the *running* loop, and what does 409 mean? | Live `opencode serve` 1.18.23 | Whether the V2 types are real here |
| 2 | If that loop ends before consume, does the admission die or attach to the next run? | Same | Stale-turn = queue, which must not be `/steer` |
| 3 | Does reusing V2 `id` after a lost 200 return the same admission? | Same | Codex-like at-most-once |
| 4 | Does Claude treat a second stdin user message as now / next / after-result? | Agent SDK 0.3.245 against the managed CLI | Whether Claude has a primitive at all |
| 5 | Does `priority: 'now'` change that? | Same | Might be the actual steer bit |
| 6 | Does Pi `session.steer` bind to the run that was live when HTTP arrived, or the run live at delivery? | Pi SDK 0.84.3 | Whether missing `expectedTurnId` is a real bug |
| 7 | When Pi delivers a steer, is there an event this bridge could render as a user row? | Pi event stream / JSONL | Transcript fidelity ceiling |

## 10. Bottom line

The limiting factor is not the `/steer` command. The command, the
capability gate, the composer intercept, and the outcome vocabulary
already work for any provider that can honour them. Codex honours
them with a turn-pinned, retry-safe, transcript-splitting RPC. Pi
honours a weaker same-run queue and is already exposed to users.
OpenCode has an unused V2 admission API that *looks* like the right
primitive. Claude has an open stdin pipe whose semantics are
unmeasured. Cursor and Grok have cancel and a follow-up queue, and
nothing that joins a live run.

Do not flip `actions.steer` on a platform whose only "steering" is
queueing or cancelling. That would make the composer divert text
away from the behaviour the user actually gets.
