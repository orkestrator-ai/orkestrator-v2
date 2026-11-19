# Push events

The push event layer tells a client that something it shows has moved, so a
mounted view reads when there is something to read instead of polling on a
timer. It carries the live agent view today (the `native-session` topic); a
later surface adds a topic rather than a poller. The design and its baseline
are in to-do [8102](../todo/transcripts-and-observation/8102-push-event-layer.md);
this file describes what is built.

## In one paragraph

Every authoritative event stream (`GET /__orkestrator/events`) gets a push
connection, advertised in its `gateway.connected` frame as
`push: { versions: [1], streamId }`. A client sends its whole subscription
set for that stream with `push_set_subscriptions`. For each subscribed
`native-session` key one backend observer reads the session's live update
with tokens of its own at the cadence a single viewer used to poll at, and
when a token moves the gateway writes `push.changed` to the connections
subscribed to that key. The view then reads through the conditional read it
already had. While its subscription is healthy the view's own poll falls to a
30 s recovery poll; while it is not, the view keeps its old cadence.

## Where the code is

| Part | File |
| --- | --- |
| Wire contract: events, envelopes, bounds, key format, parsers | `packages/protocol/src/push-events.ts` |
| Client controller (set, `seq`, health states), shared by every client | `packages/protocol/src/push-client.ts` |
| Command definitions (`push_set_subscriptions`, `get_push_metrics`) | `packages/protocol/src/contract/domains/system/push-subscriptions.ts` |
| Hub: per-connection sets, coalescing map, throttle, bounds, metrics | `apps/backend/src/core/push/push-hub.ts` |
| `native-session` topic: one observer per subscribed session | `apps/backend/src/core/push/native-session-push-topic.ts` |
| Composition, gateway port | `apps/backend/src/core/push/index.ts` |
| Gateway: connection per stream, offer, frames, subscribe command, `/metrics` | `apps/backend/src/gateway-handlers.ts`, `gateway-events.ts` |
| Settled-read share between the observer and the viewers | `NativeAgentProgressiveReads.observeSession` (`native-agent-progressive-reads.ts`) |
| Transport: `push-stream-state` from each `gateway.connected` | `apps/web/src/lib/native/node-transport.ts` |
| Per-node client slot and `usePushSubscription` | `apps/web/src/lib/push/push-subscriptions.ts` |
| Live view integration and recovery cadence | `useNativeAgentSession.ts`, `native-session-read-policy.ts` |

## Wire contract

### The offer

`gateway.connected` carries `push: { versions, streamId }` on an
authoritative main stream of a backend that has the layer. A terminal-only
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
- A frame holds at most 64 changes and 16 KiB.

### Stamps

A key's `generation` is the lifetime of the observer behind it (a new one each
time a session starts being observed, and after a backend restart);
`revision` counts the changes it announced. Stamps are compared only within
one generation of one key.

## Backend

### The hub

Per connection the hub keeps the set, a contiguous `seq`, and a coalescing
map of pending changes keyed by subscription that holds the latest stamp and
the union of parts. Its size follows the subscription count, not the change
rate. Bounds: 512 entries and 256 KiB; past either, the map is replaced by
one `push.resync` naming its topics, never a silent drop.

Throttle per key, leading edge: the first change after a quiet period goes
out within 50 ms (the coalescing window shared by every key of the
connection), and later changes of the same key wait until 500 ms after its
previous frame. A key that keeps changing is therefore announced at most twice
a second per connection, today's poll rate, while a quiet one costs nothing.

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
- treats its first full answer as the baseline (the views read on mount, and
  once more on their subscription's first answer);
- announces `transcript` or `state` when its token moves, or when the part
  becomes `missing` or `unavailable` (once, not on every read), and
  `discovery` as well when the turn phase changes;
- reads every 500 ms while the turn is running, blocked, cancelling or
  recovering, every 1.5 s idle, and through 3, 5, 10 and 15 s while idle for a
  provider qualified for quiet backoff (the same rule as the view's C01
  backoff); a part answered `pending` is read again after 250 ms and a failed
  read after 2 s;
- wakes at once on the session's `native-agent-session-activity`
  announcement or `resource-changed` invalidation (the backend's one emit
  passes every event to the push layer).

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
never take it; an epoch change, a wake and the end of observation drop it.

## Client

`PushSubscriptionClient` holds one node's set and turns frames into change
notifications. One per node scope (`pushClientFor(scope)`); views use
`usePushSubscription(scope, topic, key, enabled, onChange)`, which returns
whether the subscription is healthy.

| State | Meaning | Views |
| --- | --- | --- |
| `connecting` | No `gateway.connected` seen yet. | Old cadence |
| `unavailable` | No offer (older backend, Electron main-process stream) or the stream was refused. | Old cadence |
| `snapshotting` | A set was sent and not answered yet. | Old cadence |
| `live` | The newest set is answered and no frame was lost. | Recovery poll for `ok` keys |
| `recovering` | The stream dropped, a `seq` gap or `push.resync` arrived, or the set call failed (retried 1 s, doubling to 30 s). | Old cadence |
| `closed` | Disposed. | — |

Ordering rules (design D5): a frame is applied whatever the state of the set
call; a change for a key not in the set, or at or below the stamp the client
holds, is ignored; a duplicate `seq` is ignored; a gap applies the frame and
re-sends the set, whose answer names what moved. An answer for an older
`setRevision` is ignored. The first answer for a new key always reads once,
which covers a change between the view's mount read and the registration.
Nothing in the client infers that work completed from a stream closing: a
closed stream only makes keys unhealthy.

The live view (`useNativeAgentSession`) subscribes while it is enabled and
active. A change invalidates its coordinated read (and marks discovery due
when it names `discovery` or everything). While healthy, its demand is the
30 s recovery poll with no quiet backoff; a recovery-poll read that finds a
new projection is counted as `recoveryFoundChange` (a frame that should have
been sent was not).

## Metrics

Content-free (no keys, ids or revisions), in the gateway's
`/__orkestrator/metrics` under `push` and from `get_push_metrics`:
connections, connections with subscriptions, subscriptions and observed keys
by topic, frames, changes and frame bytes sent, changes published and
coalesced, back-pressure holds, resyncs by reason, denials by reason, set
calls, refusals and superseded calls, pending entries and bytes, and per
topic the observers, reads, failed reads, changes and wakes. The frames
themselves are counted with every other event in the stream metrics
(`push.changed`, `push.resync`). The client keeps its own counters
(`pushDiagnostics()`): frames, ignored changes, duplicates, `seq` gaps,
resyncs, set calls, failures, refusals and recovery reads that found a change.

## Compatibility

The offer in `gateway.connected` is the capability: a client only subscribes
to a stream that offers version 1, and an older backend offers nothing, so a
current client keeps polling it exactly as before. An older client ignores
the extra field. Remote node scopes reached through a command node's relay
get no offer on their relayed stream today and keep polling; the command-node
subscription controller of design D10 is not built.

## Related

- [event-snapshot-recovery.md](event-snapshot-recovery.md): the transport
  recovery contract this extends, and the push stamp in its sequence table.
- [recurring-work.md](recurring-work.md): C01, the live view's cadence.
- To-do [8102](../todo/transcripts-and-observation/8102-push-event-layer.md):
  the design, the baseline and the work still open.
