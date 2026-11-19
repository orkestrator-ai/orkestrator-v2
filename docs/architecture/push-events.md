# Push events

The push event layer tells a client that something it shows has moved, so a
mounted view reads when there is something to read instead of polling on a
timer. It carries four topics: the live agent view (`native-session`),
environment lifecycle and attention (`environment`), workflow run status
(`workflow`) and the opt-in output tail of an expanded running tool row
(`tool-output`). A later surface adds a topic rather than a poller. Windows
reach other machines' topics through their command node (see
[Relayed nodes](#relayed-nodes)). The design and its baseline are in to-do
[8102](../todo/transcripts-and-observation/8102-push-event-layer.md); this file
describes what is built.

## In one paragraph

Every authoritative event stream (`GET /__orkestrator/events`) gets a push
connection, advertised in its `gateway.connected` frame as
`push: { versions: [1], streamId }`. A client sends its whole subscription
set for that stream with `push_set_subscriptions`. For each subscribed
`native-session` key one backend observer reads the session's live update
with tokens of its own, woken by the bridge's state and transcript revisions
(or, for a bridge without them, at the cadence a single viewer used to poll
at), and when a token moves the gateway writes `push.changed` to the
connections subscribed to that key. The view then reads through the
conditional read it already had. While its subscription is healthy the view's
own poll falls to a 30 s recovery poll; while it is not, the view keeps its
old cadence.

## Where the code is

| Part | File |
| --- | --- |
| Wire contract: events, envelopes, bounds, key format, parsers | `packages/protocol/src/push-events.ts` |
| Client controller (set, `seq`, health states), shared by every client | `packages/protocol/src/push-client.ts` |
| Command definitions (`push_set_subscriptions`, `get_push_metrics`) | `packages/protocol/src/contract/domains/system/push-subscriptions.ts` |
| Hub: per-connection sets, coalescing map, throttle, bounds, metrics | `apps/backend/src/core/push/push-hub.ts` |
| `native-session` topic: one observer per subscribed session | `apps/backend/src/core/push/native-session-push-topic.ts` |
| `workflow` topic: run summaries woken by their record's `resource-changed` | `apps/backend/src/core/push/workflow-push-topic.ts`, `workflow-push-summary.ts` |
| `environment` topic: lifecycle and attention digests per subscribed environment | `apps/backend/src/core/push/environment-push-topic.ts` |
| `tool-output` topic: one tool call's output, riding its session's observer | `apps/backend/src/core/push/tool-output-push-topic.ts` |
| Bounded tool output read (`get_native_agent_tool_output`): slicing, anchors, bounds | `packages/protocol/src/native-agent-tool-output.ts`, `apps/backend/src/core/native-agent-tool-output-reads.ts` |
| Expanded running tool row: tail, subscription, load earlier | `apps/web/src/lib/chat/tool-output-tail.ts`, `NativeMessage.renderer.tsx` |
| Composition, gateway port | `apps/backend/src/core/push/index.ts` |
| Relayed nodes: the command node's subscription controller (D10) | `apps/backend/src/core/nodes/node-push-subscriptions.ts` |
| Relayed nodes: the shared leaf stream, its push hold and frame routing | `apps/backend/src/core/nodes/node-event-relay.ts`, `node-event-stream.ts` |
| Gateway: connection per stream, offer, frames, subscribe command, `/metrics` | `apps/backend/src/gateway-handlers.ts`, `gateway-events.ts` |
| Settled-read share between the observer and the viewers | `NativeAgentProgressiveReads.observeSession` (`native-agent-progressive-reads.ts`) |
| Transport: `push-stream-state` from each `gateway.connected` | `apps/web/src/lib/native/node-transport.ts` |
| Per-node client slot, routing (`pushRouteFor`) and `usePushSubscription` | `apps/web/src/lib/push/push-subscriptions.ts` |
| Live view integration and recovery cadence | `useNativeAgentSession.ts`, `native-session-read-policy.ts` |

## Wire contract

### The offer

`gateway.connected` carries `push: { versions, streamId }` on an
authoritative main stream of a backend that has the layer, with
`nodes: true` when it also takes sets for the nodes it relays
([Relayed nodes](#relayed-nodes)). A terminal-only
stream and a per-node relayed stream get none, and neither does any stream of
an older backend. The client transport turns every `gateway.connected` into a
synthesized `push-stream-state` event, `{ state: "connected", offer }` with
`offer: null` when there is no usable offer, and every loss of the main
stream into `{ state: "disconnected" }`. A listener that attaches while the
stream is up is told the current state at once. Like
`native-event-stream-connected`, a server frame with that name never reaches
a listener (`isGatewayTransportEvent`).

The `streamId` is random per connection (144 bits) and bound to a digest of
the credential that opened the stream. The backend forgets it, and every
subscription on it, when the stream closes.

### `push_set_subscriptions`

`{ streamId, setRevision, subscriptions: [{ topic, key }] }` replaces the
stream's whole set. It is answered by the gateway that holds the stream (the
registry handler answers `refused` / `unavailable` to an in-process caller,
which has no stream), and only for a call made with the credential that
opened the stream; anything else is `refused` / `stream-unknown`.

1. A `setRevision` at or below the newest applied one answers `superseded`.
2. Each subscription is validated: an unknown topic, an invalid key (over
   1 KiB, or refused by the topic) or one past the limits (512 subscriptions,
   16 topics) is answered `denied` with a reason. One bad key never fails the
   set.
3. The new set is registered (subscribe before snapshot, invariant 7), and
   `seqBase`, the last `seq` the connection had been sent, is fixed.
4. Each key's stamp is read. A key the topic answers `missing` (no such
   session) or `denied` is unregistered again: its view keeps polling, and
   observing it as well would only double the work.

The answer is
`{ status: "applied", setRevision, seqBase, subscriptions: [{ topic, key, status, generation?, revision? }] }`.

With `nodeId` the set is for that node's keys, held by the command node's
subscription controller ([Relayed nodes](#relayed-nodes)). Each node id is
its own namespace on the connection with its own `setRevision` order, and so
is the absent one (this backend's keys), so a window's local set and its
per-node sets never replace or supersede each other. A connection holds active sets for at most 64 nodes. Cleared sets free
capacity. A bounded set of retired revisions and a revision floor fence delayed
requests after release. A `nodeId` set is answered `refused` / `unavailable`
by a backend without the controller, to a workspace-grant caller, and while
the node cannot take it (not connected, no push on its stream, its call
failed); a client retries that with backoff.

Electron windows on the IPC transport each hold a filtered push stream in the
main process. Main delivers its offer, disconnects and push frames to the
owning window. Commands still use the window's bound backend credentials,
and the ordinary shared relay carries the rest of its events.

### Frames

```json
{ "event": "push.changed", "payload": { "seq": 41, "changes": [
  { "topic": "native-session", "key": "<env>/<agent>/<logical session key>",
    "generation": "<observer lifetime>", "revision": 17, "parts": ["transcript"] } ] } }
```

- Frames are per connection: written with no `id`, never in the replay ring,
  so they take no ring space from the events every client needs.
- `seq` is contiguous for the life of the connection, across set changes.
- A change names only ids, a stamp and part names (`transcript`, `state`,
  `discovery`; empty means "read everything"), nothing the read would not
  show (invariant 12).
- `push.resync` (`{ seq, reason, topics }`) replaces changes the backend could
  not hold, and consumes a `seq` like any frame.
- A relayed node's change carries `nodeId`; its resync is
  `{ seq, reason: "node-reset", topics: "all", nodeId }` and concerns only
  that node's namespace. A resync without `nodeId` concerns every namespace
  of the connection. `seq` is the connection's, shared by every namespace, so
  each client on the stream checks every frame's `seq`.
- A change frame holds at most 64 changes and 16 KiB, including the serialized SSE envelope.

### Stamps

A key's `generation` is the lifetime of the observer behind it (a new one each
time a session starts being observed, and after a backend restart);
`revision` counts the changes it announced. Stamps are compared only within
one generation of one key.

Subscription sets are limited to 512 entries and a 1 MiB invoke body. Entries
with over-budget strings are refused before replacement. A refusal leaves
the existing set in place.

## Backend

### The hub

Per connection the hub keeps the set, a contiguous `seq`, and a coalescing
map of pending changes keyed by subscription that holds the latest stamp and
the union of parts. Its size follows the subscription count, not the change
rate. Bounds: 512 entries and 256 KiB; past either, the map is replaced by
one `push.resync` naming its topics. The marker stays queued and coalesces
coverage while the connection is backpressured.

Throttle per key, leading edge: the first change after a quiet period goes
out within 50 ms (the coalescing window shared by every key of the
connection), and later transcript changes of the same key wait until 150 ms
(`PUSH_KEY_THROTTLE_MS`) after its previous transcript frame, and go out at
that deadline with no coalescing window added. State changes carrying decisions or completion
can go out within the coalescing window even during a transcript burst.
Another topic opts in with its provider's `urgentParts` (the `environment`
topic's `attention`): a change naming one goes out within the coalescing
window whatever the key's throttle, and a change naming only those parts
does not start the throttle. Every other change of such a topic is
throttled per key as above. Throttles are per key, so one session's flood
never delays another key's first change.

While a connection's socket is over the gateway's 1 MiB soft write limit (or
its replay handshake is still draining) changes wait in the map and the hub
retries every 250 ms. A write the gateway refuses (the hard limit dropped the
client) closes the push connection; the client's reconnect re-subscribes.

A publish for a key nobody subscribes to costs one map lookup.

### The `native-session` topic

The first subscription to a session starts one observer; the last release
stops it. The observer:

- reads the session's live update (`get_native_agent_live_update`'s read,
  the same window the view uses) with its own transcript and state tokens;
- publishes each part's first authoritative answer independently, covering
  changes that race the viewer's mount read;
- announces `transcript` or `state` when its token moves, or when the part
  becomes `missing` or `unavailable` (once, not on every read), and
  `discovery` as well when the turn phase changes;
- wakes at once on the session's `native-agent-session-activity`
  announcement or `resource-changed` invalidation (the backend's one emit
  passes every event to the push layer): the backend's own changes (queue,
  dispatch, title, discovery renewals) arrive this way on every provider;
- otherwise reads by the bridge wake rules below, or on the cadence.

**Bridge wake rules** (to-do 8102 task 2, design D7). Every HTTP bridge
(Claude, Codex, Cursor, Pi, ACP/Grok) serves the content-free observe stream
(`GET /event/subscribe?observe=1`); the provider holds one per bridge
connection (`http-bridge/observation-stream.ts`), and each frame names a
session and its `stateRevision` and `transcriptRevision`
([bridges/AGENTS.md](../../bridges/AGENTS.md#state-revisions)). The
provider's mode decides the observer's timer
(`NativeAgentService.canWakePushObserverFromBridge`):

| Mode | When | Observer |
| --- | --- | --- |
| `revisions` | the stream is live and its `connected` frame advertised `"revisions": 1` | reads a running or idle session on the stream's hints for it, with a 30 s backstop (`NATIVE_SESSION_BRIDGE_BACKSTOP_MS`); no timer reads in between |
| `hints` | live, no revisions (an older Claude or Codex bridge) | only an idle session marked `quietObservation` uses the hints and the backstop; a running one keeps 500 ms |
| `none` | stream down, silent past 75 s, a bridge that answers 404 for the route, OpenCode | the cadence below |

- A hint reads no sooner than 150 ms after the previous read
  (`NATIVE_SESSION_BRIDGE_WAKE_FLOOR_MS`, the hub's per-key throttle), so a
  streaming turn (a frame per delta) costs one observer read per frame the
  hub may send; hints inside the floor share one read. The 250 ms p95
  latency target set the spacing ([Measured result](#measured-result)). The
  stream drops a frame whose revisions both equal the session's last frame,
  and names the parts that moved.
- A hint does not drop the observer's settled answer (only a backend wake
  does): the viewers' reads after its frame take that answer. It only stops
  the observer's next read from joining provider work that started before
  the hint (`NativeAgentProgressiveReads.noteObservationHint`).
- The read itself stays the source of truth and stays conditional on both
  parts: the transcript part sends its token, and the state part becomes one
  small `{ unchanged: true }` bridge request while the state revision stands
  (`http-bridge/state-revision.ts`); the side routes (questions, plan
  approvals, interactions, approvals, Codex `/config`, Pi `/queue`) are read
  after it moves. If Pi's queue read fails, the next state read retries it even
  at the same revision. Pi's composer still uses its own revision.
- A connect, a gap (`replay.required`, Codex's sessionless
  `session.reconcile-required`) or a lost stream wakes every observer of that
  provider at once; each re-reads and, if the stream is no longer live with
  revisions, returns to the cadence.
- OpenCode has no bridge stream here: its sessions keep the cadence (its own
  `/api/event` stream is not yet wired as a signal).

The cadence: every 500 ms while the turn is running, blocked, cancelling or
recovering, every 1.5 s idle, and through 3, 5, 10 and 15 s while idle for a
provider qualified for quiet backoff (the same rule as the view's C01
backoff); a part answered `pending` is read again after 250 ms and a failed
read after 2 s (which also leaves bridge mode until the next good read).
The topic's metrics count `bridgeWakes` and `bridgeObservers`.

So a session costs one read per round however many windows view it, and
nothing on the wire unless it moved. Only mounted, active, visible views
subscribe: a hidden document sends an empty set, so no observer keeps a
session that nobody is looking at attached (the liveness-touch rule in
[bridges/AGENTS.md](../../bridges/AGENTS.md)).

### Sharing the observer's read

While a session is observed, a transcript or state read that settled less
than 750 ms ago answers the next equivalent read of the same projection epoch
(`OBSERVED_SETTLED_SHARE_MS`), so the reads the viewers send after a frame
take the observer's answer instead of starting their own provider read. A
running read is joined in preference to it; forced and fresh-source reads
never take it. Observers also bypass settled sharing and join only source
work covering their latest wake or bridge hint. An epoch change, a wake (an
activity announcement or invalidation) and the end of observation drop the
relevant shares; a bridge hint does not. The shares have a 16 MiB budget and
expire without another viewer request. Observer work queues when six
source slots are busy, leaving two slots for foreground reads.

### The `workflow` topic

One workflow run's status summary
(`apps/backend/src/core/push/workflow-push-topic.ts`, summaries in
`workflow-push-summary.ts`).

- **Key:** `<kind>/<id>` with kind `build-pipeline`, `multi-review` or
  `graph-run` (each also its `resource-changed` kind) and the run's record
  id: no `/`, whitespace or control characters, at most 256 bytes
  (`formatWorkflowPushKey`, `parseWorkflowPushKey`). A workflow snapshot's
  `workflowId` is the kind and its `runId` the id.
- **Parts:** `progress` (the run's record moved; every change names it),
  `status` (its phase or status changed) and `result` (it entered or left a
  terminal phase: `complete` or `failed` for a pipeline,
  `isMultiReviewTerminalPhase`, `isGraphRunTerminal`). A run that appears or
  goes away names all three.
- **No poller.** Every save of a run's record announces `resource-changed`
  through the backend's one emit; for a subscribed run that wakes the topic,
  which reads the summary (record revision, phase, terminal: one storage
  read, joined while one is in flight, once more after a burst) and publishes
  when it moved. A quiet run costs nothing; an unsubscribed run costs one
  map lookup per event. The first read sets the baseline and announces
  nothing (the subscriber reads once on its first answer). A failed read
  retries after 2 s, doubling to 30 s, while the key stays subscribed; a
  failed first read answers `missing`.
- **Resolve:** an unknown run, an id that is not a run id, or a deleted run
  is `missing`; a run with a baseline answers its stamp without reading.
- **Completion is never inferred** from a frame or a closed stream: `result`
  means "read again", and the view's read says whether the run finished.

Subscribers today: the live workflow inspector of a workflow snapshot card
(`useWorkflowLiveSnapshot` in `WorkflowLiveInspector.tsx`, read
`transcript_artifact_workflow_live_snapshot`). While its subscription is
healthy it reads on frames and every 30 s; otherwise it keeps its 4 s poll,
and a terminal read stops it either way. The build pipeline, Multi Review
and graph run views were already event-led (their stores re-read on
`resource-changed`, C03) and have no poll to retire. The Multi Review
reviewer tab (C05) and the flow-graph inspector's tails poll a reviewer's
transcript, which a record save does not announce (Multi Review checkpoints
reviewer progress only on status changes and its 60 s progress probe), so
they keep their 4 s poll; see recurring-work.md.

### The `environment` topic

One environment's lifecycle and attention summary
(`apps/backend/src/core/push/environment-push-topic.ts`).

| Key | Parts | Reads it announces |
| --- | --- | --- |
| The environment id (`isEnvironmentPushKey`: at most 128 characters, no `/`) | `lifecycle`, `attention` (urgent), `sessions` | `get_container_lifecycle_snapshot`, `get_agent_registry` with `includePending` |

- **Parts.** `lifecycle`: the record's status, container, setup phase and
  approval, deletion request, lifecycle remedy, pending launch, and the
  container lifecycle record's revision. `attention`: the registry's
  waiting tabs with their pending request (id, kind, label, detail, since,
  count) and the record's activity, waiting-tab, unread and last-activity
  fields. `sessions`: the registry's tab counts. Each part is a SHA-256
  digest held in memory, never logged or sent; a frame names only the parts
  whose digest moved. A deleted environment moves all three once.
- **What wakes it.** The backend's one emit passes every event to the topic;
  only events naming a subscribed environment mark parts:
  `native-agent-session-activity` and `resource-changed` for
  `native-agent-session` or `pane-layout` mark `attention` and `sessions`;
  `resource-changed` for `environment` marks all three;
  `environment-attention` and `native-agent-async-question` mark
  `attention`; `container-lifecycle-updated` and the setup start and
  completion events mark `lifecycle`. Marked parts are read together 100 ms
  after the first mark (a later mark never postpones it; one read in flight,
  once more if marked meanwhile): the record (`storage.getEnvironment`), and
  the registry only when `attention` or `sessions` is due.
- **The one reconcile.** Some providers announce no change to a waiting
  tab's request, so while the registry shows a waiting native tab the topic
  re-reads it every 15 s, and through 1, 3 and 10 s while the registry's 2 s
  deadline left a waiting tab without its request. This is the cadence every
  sidebar row used to poll at, now once per subscribed environment; nothing
  else is read without an event, and the reconcile stops with the last
  subscriber (invariant 15). A failed read retries after 2 s with the parts
  it owed.
- **Resolve:** `missing` when `storage.getEnvironment` has no record (the
  lookup `get_environment` and `get_container_lifecycle_snapshot` use; the
  command is `workspace`, like those reads). The first read publishes every
  part, as `native-session` does, so a change between the view's mount read
  and the baseline is never absorbed.
- **Fairness.** `attention` is the topic's `urgentParts`: an approval or
  question is announced within the coalescing window even right after the
  same key's lifecycle frame, and a session streaming in another environment
  never delays it (its throttle is its own key's).
- **Metrics** (`topics.environment`): observers, reads, failed reads,
  changes, wakes, and reconciles (reads no event asked for).

Subscribers today, each through `usePushSubscription` while mounted:

- **Attention line and hover card** (`useAgentRegistryRead`, behind
  `EnvironmentAttentionLine`, `ProjectHomeActivity` and
  `EnvironmentAgentSummary`; local sources only, through
  `AgentSummarySource.pushScope`). While healthy a frame naming `attention`
  or `sessions` reads at once; the `native-agent-session-activity` and
  `resource-changed` events the source also hears no longer read; a waiting
  request is re-read on the 30 s recovery poll instead of every 15 s, and a
  recovery read that finds a change is counted as `recoveryFoundChange`.
  Unhealthy (no offer, stream dropped, recovering), the view reads once and
  keeps its events and 15 s cadence. Another machine's environments, read
  through the command node, keep their events (no relayed offer).
- **Recovery copies** (`EnvironmentRecoveryCopies`): the lifecycle record is
  checked on a `lifecycle` frame and every 30 s while healthy, every 3 s
  otherwise; a new revision re-reads the list.
- **Rebuild progress** (`EnvironmentRebuildSection`): a `lifecycle` frame
  reads the snapshot; while a rebuild runs the backstop poll is 30 s while
  healthy, otherwise 15 s with lifecycle events or 2 s without.

The sidebar rows themselves (status, activity, unread) come from the
environment store, which is already event-led (`resource-changed`, C03) and
has no poll to retire.

### The `tool-output` topic

A running command can print megabytes. Its row's output used to arrive only
through the row's detail reference, which is content-addressed: every time
the output grew, an expanded row read the whole body again. The
`tool-output` topic and the bounded read `get_native_agent_tool_output` give
an expanded running row a tail that follows the call instead, and leave
collapsed rows costing nothing.

**Key.** `<environmentId>/<agent>/<logicalSessionKey>/<toolUseId>`, the call
id percent-encoded (`formatToolOutputPushKey`), so the last `/` splits it off
a session key that may itself hold `/`. Only one spelling of a call id is a
key. The call id is at most 256 bytes and the key at most 1 KiB. The only
part is `output`.

**Backend.** The topic reads nothing of its own:

- `retain` holds the call's session through the `native-session` topic
  (`NativeSessionPushTopic.hold`). The session's one observer runs while a
  connection subscribes to the session or a hold is kept, so a row and its
  live view share it, and a row of a session nobody else views starts it.
- On each change the observer announces, the topic looks the call up in the
  session's cached live view (`NativeAgentToolOutputReads.toolOutputSource`,
  memory only, bounded search through nested tool groups) and compares a
  content-free fingerprint: the call's detail reference, its state, the
  length of any inline output, and whether it completed. When the fingerprint
  moved it announces `output`.
- Once completion is announced it lets go of the session: the output will not
  grow. A call that leaves the live view is announced once (the row then
  reads through the detail reference it holds).
- `release` drops the watch and its hold; nothing is kept for the key.

**Read.** `get_native_agent_tool_output` (`native-sessions` domain, since 5):

```text
{ environmentId, agent, logicalSessionKey, toolUseId, detailRef?,
  mode: "tail" | "range" | "before", cursor?, anchor?, limit? }
→ { status: "ok", text, start, end, totalBytes, truncatedBefore, complete,
    startAnchor, endAnchor, reset?, toolError? }
  | { status: "missing" } | { status: "expired" }
```

- Offsets are UTF-8 byte offsets into the whole output. `tail` answers the
  newest `limit` bytes, `range` the bytes forward from `cursor` (appending
  after a held end), `before` the bytes ending at `cursor` (history before a
  held start). A range never splits a character.
- `limit` defaults to 32 KiB and is clamped to 64 KiB, so an answer carries
  at most 64 KiB of text; `toolError` is cut to 8 KiB. The call id, detail
  reference and anchor are bounded on input (invariant 11).
- Each answer carries an opaque anchor per end (a length and an FNV-1a hash
  of the 64 bytes beside it). A later read from that end sends it back; if
  those bytes changed, or the cursor is past the end or inside a character,
  the read answers the tail with `reset: true` and the row replaces what it
  holds. Output therefore need not be append-only.
- The call is found in the session's cached live view (its window rows and
  revised rows); with no cached view the read performs one live-view read
  first. The body comes through the call's detail reference
  (`getProjectionToolDetails`), so it shares the detail cache and its provider
  read with every other reader. A call outside the live view is read through
  the `detailRef` the row sends and is `complete` (that reference names a
  fixed body). `missing`: no such call (and no reference); `expired`: the
  reference is no longer held.
- Nothing logs output, ids or offsets; the topic's metrics are counts
  (`watches`, `holding`, `checks`, `changes`, `completions`).

**Client** (`useToolOutputTail`, `ToolOutputTailContext` provided by a live
native tab):

- Expanding a call that is running (`toolState: "pending"`) reads its tail
  and subscribes to its key. An arriving file diff switches the expanded row
  to its detail read. A settled call expanded later and rows outside live
  tabs (reviews, exports) also use the detail read.
- Each frame reads `range` from the held end and appends. Behind by more than
  128 KiB it reads the tail again rather than every byte between.
- The row holds at most 512 KiB of output, dropping older text from the front.
  Above the output it shows "N of earlier output not shown" and "Load earlier",
  which reads 64 KiB `before` the held start and prepends it, until the row
  holds its bound.
- Without a healthy subscription it polls every 2 s while the call runs (30 s
  recovery poll while healthy). The row keeps reading until it has the final
  byte of a completed call, then drops its subscription. Transient read errors
  preserve the held output for the next push or poll.
- Collapsing releases the subscription, stops its timers and drops the text.
  An answer the node cannot serve (`missing`, `expired`, or `unknown-command`
  from an older node) falls back to the row's detail read.

## Relayed nodes

A window shows other nodes' sessions too (node scopes,
[federation.md](federation.md#push-subscriptions-to-other-nodes)). The
command node's relay keeps one stream per node for every window
(`NodeEventRelay`), so a window cannot subscribe on it: two windows' sets
would replace each other and their revisions collide. Instead a window sends
its set for a node to its command node with `nodeId`, and the command node's
`NodePushSubscriptionController` (design D10) holds the node's keys for every
window:

- **Union.** It reference-counts each (topic, key) across the downstream
  connections and sends the node the union, on the push connection of the
  relay's stream to that node, with its own `setRevision` counter per
  upstream `streamId` (its only writer). While any key is held the relay
  keeps that stream open (`holdForPush`), asking only for the `push.` prefix
  when no client watches the node. The call is made with the command node's
  own node credential, the one that opened the stream.
- **Answers.** The node's answer stamps are copied into each downstream
  answer. A set that adds no key to the union, while the node's last answer
  is current, is answered from the held stamps without a node call, so a
  second viewer adds no node traffic. A key the node answers `missing` or
  `denied` is not held for that connection.
- **Changes.** A node `push.changed` is checked against the node's `seq` and
  each change is published to every downstream connection holding its key,
  through the hub's per-connection path: coalesced, throttled and numbered in
  that connection's own `seq`, with `nodeId` on the change.
- **Resync.** A node `seq` gap, a node `push.resync`, a new upstream
  `streamId` (the relay replaced or reopened its stream) or the relay's
  resync hint once the node has answered the current stream makes it send the
  union again and give every connection holding the node a `node-reset`
  resync. A stream that ends does the same, so the windows go back to their
  polling cadence; a set they send meanwhile waits up to 8 s for a stream and
  is then answered `unavailable`.
- **Release.** A key leaves the union when its last downstream subscriber
  drops it or closes. Closing a leaf scope sends an empty set on the owning
  command stream. The controller sends the smaller union and retries a failed
  final empty union with backoff until it is acknowledged or the upstream
  stream closes.
- **Bounds.** The union stays within the node's own limits (512 keys,
  16 topics); a key past them is answered `denied` / `limit`. `stop()` (with
  `NodePortal.stop`) releases every hold and answers every waiting set
  (invariant 15).

## Client

`PushSubscriptionClient` holds one node's set and turns frames into change
notifications. One per node scope (`pushClientFor(scope)`); views use
`usePushSubscription(scope, topic, key, enabled, onChange)`, which returns
whether the subscription is healthy.

| State | Meaning | Views |
| --- | --- | --- |
| `connecting` | No `gateway.connected` seen yet. | Old cadence |
| `unavailable` | No offer (older backend) or the stream was refused. | Old cadence |
| `snapshotting` | A set was sent and not answered yet. | Old cadence |
| `live` | The newest set is answered and no frame was lost. | Recovery poll for `ok` keys |
| `recovering` | The stream dropped, a `seq` gap or `push.resync` arrived, or the set call failed (retried 1 s, doubling to 30 s). | Old cadence |
| `closed` | Disposed. | — |

Ordering rules (design D5): a frame is applied whatever the state of the set
call; a change for a key not in the set, or at or below the stamp the client
holds, is ignored; a duplicate `seq` is ignored. A gap invalidates all parts
of subscribed keys, then applies the frame and re-sends the set. The next frame
and the set answer can carry equal stamps even if the missing frame named
another part of that key. An answer for an older
`setRevision` is ignored. The first answer for a new key always reads once,
which covers a change between the view's mount read and the registration.
Nothing in the client infers that work completed from a stream closing: a
closed stream makes its keys unhealthy and cancels its set request. Each set
request has a 10 s deadline. Missing keys are retried while subscribed, with
backoff from 1 s to 30 s, so establishment can complete after the first set.

Another node's scope (`role: "leaf"`) is routed through the window's command
scope (`pushRouteFor`): its client is built with `nodeId`, listens to the
command scope's stream, sends its set there with `nodeId`, and acts only on
changes and resyncs naming its node (or resyncs naming none). It is
`unavailable` on a stream whose offer lacks `nodes`, and treats a
`refused` / `unavailable` answer as recovering, retried with backoff; a
`node-reset` resync for its node retries at once. So its keys are healthy only
while the command node answers them.

The live view (`useNativeAgentSession`) subscribes while it is enabled and
active. A change invalidates its coordinated read (and marks discovery due
when it names `discovery` or everything). While healthy, its demand is the
30 s recovery poll with no quiet backoff, and an activity announcement for
its own session does not read: the same announcement wakes the session's
observer, whose frame is the read. A stamp gap or reset still re-reads.
Unsettled discovery keeps its 2 s
or 5 s retry deadline. The session shows a recovery notice while the stream
or subscription is recovering. A recovery poll that finds a new projection
is counted as `recoveryFoundChange`.

## Metrics

Content-free (no keys, ids or revisions), in the gateway's
`/__orkestrator/metrics` under `push` and from `get_push_metrics`:
connections, connections with subscriptions, subscriptions and observed keys
by topic, frames, changes and frame bytes sent, changes published and
coalesced, back-pressure holds, resyncs by reason, denials by reason, set
calls, refusals and superseded calls, pending entries and bytes, relayed-node
sets held (`nodeSets`), and per
topic the observers, reads, failed reads, changes and wakes. On a command
node the subscription controller adds `relayedNodes`
([Relayed nodes](#relayed-nodes)): nodes with held keys, keys held across
them, downstream sets, node set calls and failures, sets answered from held
stamps without a node call, changes fanned out, resyncs, node `seq` gaps and
`limit` denials. Counts only, never a node id, key or stream id. The frames
themselves are counted with every other event in the stream metrics
(`push.changed`, `push.resync`). The client keeps its own counters
(`pushDiagnostics()`): frames, ignored changes, duplicates, `seq` gaps,
resyncs, set calls, failures, refusals and recovery reads that found a change.
It also records time spent processing push frames and elapsed time from a
local invalidation to projection application.

## Measured result

Measured 2026-11-19 against the baseline in to-do
[8102](../todo/transcripts-and-observation/8102-push-event-layer.md#the-polling-baseline-2026-11-15)
(task 7).

### Deterministic fixture

`apps/backend/tests/push-acceptance-fixture.ts` runs the real gateway on
loopback, the real push layer, `NativeAgentService` and `HttpBridgeProvider`
against an in-process fake Claude bridge that counts requests by route. Each
viewer is the live view's traffic: the real `PushSubscriptionClient` reading
a real SSE socket, background `get_native_agent_live_update` rounds at the
interval `nativeSessionReadDemand` gives, and an immediate read on a push
change or an activity announcement. Discovery reads are not modelled. One
manual clock drives the hub, the observer, the polls and the bridge.
"Before" is a backend whose streams offer no push, so the view keeps the old
cadence. Push runs against two bridges:

- **Cadence bridge:** a bridge before task 2, with no observe stream and no
  state revision. The observer reads at the old cadence.
- **Revisions bridge:** its `?observe=1` frames carry `stateRevision` and
  `transcriptRevision`, one frame per change, and its state route answers
  `unchanged`. The observer is in `revisions` mode: it reads on the bridge's
  hints, at most once per 150 ms after its previous read (the shared
  spacing), plus a 30 s backstop.

All runs use a running Claude turn. Wire bytes are socket bytes,
uncompressed: requests and answers, plus SSE including HTTP framing.
Latency is the time from the bridge change to the read that shows it:
virtual time (cadence, throttle, coalescing window) plus this host's wall
time (Linux, other work running). p95 is nearest-rank.

The 250 ms p95 target for a streamed delta set the shared spacing
(`PUSH_KEY_THROTTLE_MS`, also the bridge wake floor) at 150 ms. With it,
streaming reads per viewer rise to one per frame, while a bridge round fell
from five requests to two.

| Measure | Before, 1 viewer | Before, 2 viewers | Push, cadence bridge, 1 viewer | Push, cadence bridge, 2 viewers | Push, revisions bridge, 1 viewer | Push, revisions bridge, 2 viewers |
| --- | --- | --- | --- | --- | --- | --- |
| Quiet 10 min: reads/min per viewer | 120 | 120 each | 2 | 2 each | 2 | 2 each |
| Quiet: wire bytes/min per viewer | 172,560 | 172,560 each | 2,876 | 2,876 each | 2,876 | 2,876 each |
| Quiet: bridge requests/min, all viewers | 600 | 1,200 | 600 | 600 | 8.2 | 8.2 |
| Streaming 20 s: reads/min per viewer | 120 | 120 | 117 | 114 | 383 | 383 |
| Streaming: wire bytes/min per viewer (HTTP + SSE) | 380,417 + 0 | 380,300 + 0 | 376,191 + 24,320 | 370,369 + 23,726 | 915,857 + 79,794 | 915,857 + 79,789 |
| Streaming: bridge requests/min (rounds in 21 s) | 600 (42) | 1,200 (84) | 600 (42) | 600 (42) | 766 (134) | 766 (134) |
| Streamed delta to view, p50 / p95 ms | 252 / 452 | 502 / 751 | 301 / 501 | 351 / 551 | 151 / 201 | 151 / 201 |
| Single unannounced change to view, p50 / p95 ms | 337 / 469 | 338 / 468 | 386 / 536 | 386 / 536 | 50.5 / 50.7 | 50.5 / 50.6 |
| Announced change to view, p50 / p95 ms | 1.3 / 2.2 | 2.5 / 2.9 | 51.9 / 52.2 | 53.1 / 53.4 | 51.9 / 52.0 | 53.1 / 53.3 |
| Announced: reads per change per viewer | 1 | 1 | 1 | 1 | 1 | 1 |
| Announced: bridge requests/min | 653 | 1,307 | 653 | 653 | 104 | 104 |

The phases:

- **Streamed delta:** the tail grows every 100 ms.
- **Single unannounced change:** one delta about every 3 s, with no backend
  announcement.
- **Announced change:** a state change that the backend also announces.

Bridge requests per round:

- **Cadence bridge:** five requests: the state route, `/questions`,
  `/plan-approvals`, `/interactions` and `/transcript`.
- **Revisions bridge:** usually two, the state route (answered `unchanged`
  when nothing moved) and `/transcript`. The side routes are read only after
  the state revision moved. In the quiet runs: 40 state and 40 transcript
  requests in 10 minutes, from the 30 s backstop and the recovery polls.

- **Quiet: 98.3% fewer reads and bytes per viewer.** All that is left is the
  30 s recovery poll, which found no change in any run. With a revisions
  bridge, the bridge's quiet cost falls too: from 600 requests a minute to 8.
- **A second viewer adds no bridge reads** with either bridge, quiet or
  streaming. Under polling, two viewers doubled them.
- **Revisions bridge: under 250 ms p95 for every unannounced change.**
  - A single change wakes the observer at once. The view has it inside the
    hub's 50 ms coalescing window: p95 51 ms.
  - In a continuous stream, a delta waits at most one 150 ms spacing for the
    observer's next read. Its frame goes out at the throttle deadline, which
    trails that read by the leading edge's 50 ms window: p95 201 ms.
  - At a 200 ms spacing the same run measured p95 251 ms.
- **Revisions bridge, streaming: one provider round per frame however many
  viewers read.** 134 frames, 134 rounds. A bridge hint no longer drops the
  observer's settled answer, so each viewer's read after a frame takes it.
  Dropping it on every hint cost 80 rounds in place of 42 at the old spacing.
  The rounds cost 766 bridge requests a minute: more than one polling viewer
  (600), less than two (1,200), and the same for any number of viewers.
- **Cadence bridge, one viewer: the bridge costs the same as before.** The
  observer reads at the old single-viewer cadence, 500 ms while a turn runs,
  so a streamed or single unannounced change still takes up to about 550 ms.
- **Two polling viewers were slower than one.** A reader that is behind gets
  the cached view while it refreshes, so alternating viewers see each other's
  last read (p50 502 ms against 252 ms).
- **An announced change is one read per viewer.** While the subscription is
  healthy, the view does not read on an activity announcement for its own
  session; the push frame that follows is the read. A stamp gap or reset, or
  an unhealthy subscription, still reads at once. Before this change, both
  invalidations read: two reads per change per viewer, and the first raced
  the woken observer for about one extra bridge round per change (760
  against 653 requests a minute).

Faults through the real gateway (`apps/backend/tests/push-acceptance.test.ts`).
In each case the view ends on the bridge's revision and the authoritative
tokens, with a healthy subscription:

- **Dropped stream:** the view returns to the 500 ms cadence, then
  re-subscribes on reconnect.
- **Duplicate frame:** ignored, and it costs no read.
- **`seq` gap:** an immediate full invalidation and one re-sent set.
- **Backend restart:** a new gateway and push layer start over the same
  storage, and every subscription answers a new generation. Nothing is left
  in the old layer. Run against both bridges. With a revisions bridge, the
  new observer reads on hints again.

### Slow consumer, thirty minutes

`apps/backend/tests/gateway-push-slow-consumer.integration.test.ts` (slow
tier) runs 30 virtual minutes:

- A running session streams throughout, and 192 KiB/s of other
  authoritative events share each stream.
- A slow viewer stops reading its real socket for 40 s of every minute.
- Every 5 minutes the slow view closes and another opens.
- A fast viewer reads throughout.

| Measure | Result |
| --- | --- |
| Peak gateway queue for the slow socket | 4.3 MB (1 MiB soft limit, 8 MiB hard limit) |
| Peak hub pending | 2 entries, 342 bytes |
| Back-pressure holds; resyncs | 502–532; 0 |
| Fast viewer frames while the slow one stalled | 2,394 |
| Heap after each view cycle (MiB) | 47.6 at start, then 57.0, 57.9, 58.5, 59.6, 60.3; 55.6 with every view closed (another run: 56.9 to 59.0, then 55.4) |

Once the views close, the push connections, pending entries, observers and
gateway clients are all zero.

### Live spec B (loopback model, credential-free)

`conditional-reads-live.spec.ts` (Claude, `baseline` scenario) ran on an
isolated profile. The profile had stale Pi bridge sources from concurrent
edits, so it ran with `ORKESTRATOR_AGENT_TEST_ALLOW_STALE_BRIDGES=1`; this
Claude run does not use the Pi bridge.

- **Bridge state polls:** with two viewers, 40 in 20 s (the baseline had 80).
  With one viewer, also 40.
- **Renderer live updates while streaming:** 40 per viewer, the same as the
  baseline.

### Rerun

```bash
# The table (about 10 s): before; push on a cadence and a revisions bridge; one and two viewers
mise exec -- bun apps/backend/scripts/push-acceptance.ts \
  [--quiet-minutes 10] [--streaming-seconds 20] [--announced 20] [--out result.json]
# Budgets and faults (default tier)
mise run test:logged -- --name push-acceptance -- bun --cwd=apps/backend test \
  --preload ../../tests/setup-node.ts tests/push-acceptance.test.ts
# Slow consumer (slow tier); the file receives the figures above
PUSH_ACCEPTANCE_REPORT=/tmp/slow.json mise run test:logged -- --name push-slow-consumer -- \
  bun --cwd=apps/backend test --preload ../../tests/setup-node.ts \
  tests/gateway-push-slow-consumer.integration.test.ts
```

## Compatibility

The offer in `gateway.connected` is the capability: a client only subscribes
to a stream that offers version 1, and an older backend offers nothing, so a
current client keeps polling it exactly as before. An older client ignores
the extra field. Relayed-node sets follow the same rule one level down: a
client sends `nodeId` only to a stream whose offer says `nodes: true`, so an
older command node is never sent one and its window's leaf scopes keep
polling. An older node behind a current command node offers no push on the
relay's stream, and its keys are answered `unavailable`.

## Related

- [event-snapshot-recovery.md](event-snapshot-recovery.md): the transport
  recovery contract this extends, and the push stamp in its sequence table.
- [recurring-work.md](recurring-work.md): C01, the live view's cadence.
- To-do [8102](../todo/transcripts-and-observation/8102-push-event-layer.md):
  the design, the baseline and the decision record.
