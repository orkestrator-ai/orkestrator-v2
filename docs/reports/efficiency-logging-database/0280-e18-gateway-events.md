# E18: Gateway events

This file combines 4 reports into one batch to build together. Same replay and event files.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0280](#0280-events-are-measured-and-encoded-again-for-each-subscriber) | Low | GW-5: Events are measured and encoded again for each subscriber |
| [0290](#0290-scoped-stream-replay-writes-one-cursor-frame-per-skipped-event) | Low | GW-12: Scoped stream replay writes one cursor frame per skipped event |
| [0300](#0300-replay-lookup-is-a-linear-filter-and-an-oversized-event-is-invisible) | Low | GW-14: Replay lookup is a linear filter and an oversized event is invisible |
| [0370](#0370-relayed-federation-events-share-one-name-and-the-main-replay-window) | Low | GW-11: Relayed federation events share one name and the main replay window |

## 0280: Events are measured and encoded again for each subscriber

### Task analysis

#### Tasks

1. **Share one encoded frame across subscribers**: keep a `Buffer` in the replay frame and pass the byte count to writers. Status: done (2026-11-04; see [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)).

#### 1. Share one encoded frame across subscribers

**Problem.** An event is serialised once, but each subscriber's writer measures the string again, and Node encodes it again per socket.

**Context.** The cost grows with subscribers and frame size. It is small per event, and the report rates it Medium-Low.

**Investigation.** `GatewayEvents.emit` serialises once (`apps/backend/src/gateway-events.ts:38-39`, `:62`) and already knows `messageBytes`. Writers take only a string: `IdentityEventClientWriter.write` (`apps/backend/src/gateway-support-extra.ts:660-661`) and `GzipEventClientWriter.write` (`:707-708`) call `Buffer.byteLength` again. `instrumentGatewayResponse` then measures the same chunk (`gateway-support-core.ts`, through `measureChunkBytes` at `:812-820`). Replay frames hold `message` and `encodedBytes` (`gateway-event-replay.ts:123-128`). Each gzip client compresses separately, which this does not change.

**Decisions.**

- **What does a frame hold?**
  - **A `Buffer` plus its length; writers take both (recommended).**
    - Pros: the report's fix; one encode per event, and no repeated measures.
    - Cons: touches the writer interface and its tests; the replay ring must not hold the string as well, or it doubles its memory.
  - **Keep strings and pass only the byte count.**
    - Pros: a smaller change.
    - Cons: Node still encodes per socket.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): the ring's 2 MiB and 2,048-frame bounds must count the same bytes as before.

### Needs verification

- Measured on 2026-11-04 (1202 task 11): frame measures per emit went from 13 to 0 with 4 subscribers. The time inside `emit` fell from 433–565 µs to 258–426 µs per 64 KiB event, and moves with host load. No production profile was taken.

## 0290: Scoped stream replay writes one cursor frame per skipped event

### Task analysis

#### Tasks

1. **Collapse skipped replay frames into one cursor**: track the highest skipped revision and emit it once. Status: done (2026-11-04; one cursor before the next matching frame and one at the end, as the report says. The budget decision below stays open, see [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)).

#### 1. Collapse skipped replay frames into one cursor

**Problem.** A filtered client reconnecting after a burst of unrelated events receives one cursor frame per event it does not care about.

**Context.** Live traffic already solved this: `flushOmittedCursor` costs one frame per keepalive rather than one per omitted event (`apps/backend/src/gateway-events.ts:109`).

**Investigation.** `writeReplayFrame` writes a cursor for each non-matching frame (`gateway-events.ts:214`), called per frame in the replay loop (`:316-319`). A matching frame carries its own newer id, so a pending skipped revision is superseded by it, which is what `emit` already relies on (`:58-60`).

A related cost: `replayFitsClientBudget` (`:226-233`) sums `encodedBytes` for every frame, including those a filtered client only gets a small cursor for, so a filtered client can be told `replay-too-large` when its real replay is small.

**Decisions.**

- **When to emit the cursor?**
  - **Only at the end of the replay, if the last frames were skipped (recommended).**
    - Pros: fewer frames than the report's "before the next matching frame", since that frame's own id already advances the client.
    - Cons: depends on every matching replay frame carrying an id, which it does today.
  - **Before each next matching frame and at the end, as the report says.**
    - Pros: the cursor never lags a matching frame, even if a later change drops ids.
    - Cons: one extra frame per run of skips.
- **Fix the replay budget for filtered clients at the same time?**
  - **Yes: count a small cursor for skipped frames (recommended).**
    - Pros: same loop; removes a needless reconcile.
    - Cons: the projected figure must still be an upper bound, or the guard it exists for fails.
  - **Leave it.**
    - Pros: a smaller change.
    - Cons: a filtered client keeps reconciling when it need not.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): missed events stay detectable. The final cursor must leave the client exactly as far on as the frames it replaces.

## 0300: Replay lookup is a linear filter and an oversized event is invisible

### Task analysis

#### Tasks

1. **Find the replay range by index**: replace the filter with a slice. Status: done (2026-11-04).
2. **Count oversized appends**: add a metric for an event that empties the window. Status: done (2026-11-04; `replay.ring.oversizedAppends`).

#### 1. Find the replay range by index

**Problem.** Each replay filters the whole window, though the range can be computed.

**Context.** Revisions are contiguous: `append` adds one per frame, and frames leave only from the front.

**Investigation.** `this.frames.filter((frame) => frame.revision > revision)` is at `apps/backend/src/gateway-event-replay.ts:162`. `oldestRevision` is `frames[0]?.revision` (`:110-111`). The `complete` check above it has already proved the range is held. The window is at most 2,048 frames (`:9`).

**Decisions.** None: `slice(revision + 1 - oldest)` is the report's fix and returns the same frames.

#### 2. Count oversized appends

**Problem.** One event larger than the byte limit evicts everything, including itself, and every reconnecting client then reconciles. Nothing reports that this happened.

**Context.** The eviction loop treats the new frame like any other. Only `droppedFrames` is counted (`:90`), which cannot tell this case from normal turnover.

**Investigation.** The loop is at `gateway-event-replay.ts:131-136`. After it the window is empty, `oldestRevision` is 0, and `since` answers incomplete (`:159`), so the cursor expires and the client reconciles.

**Decisions.** None: the report asks only for the metric. Keeping older frames across an event that cannot be retained would make that gap undetectable.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): missed events stay detectable, and metrics stay content-free. Count the event, and do not label it with payload data.

## 0370: Relayed federation events share one name and the main replay window

### Task analysis

#### Tasks

1. **Name relayed events per node**: let subscription filters scope them. Status: open.
2. **Give relayed traffic its own replay share**: stop a busy leaf forcing reconciles. Status: open.

#### 1. Name relayed events per node

**Problem.** Every client receives every relayed event and filters after receipt.

**Context.** Federation only. Clients that watch no node, or another node, still receive the bytes.

**Investigation.** All relayed frames use `RELAYED_NODE_EVENT` (`packages/protocol/src/node-events.ts:20`), emitted at `apps/backend/src/core/nodes/node-event-relay.ts:233` and `:248`. The web drops frames for an unwatched node after parsing (`apps/web/src/lib/federation/node-events.ts:70-74`). `eventMatchesSubscription` filters by prefix, so a per-node name would work with existing filters.

**Decisions.**

- **How to roll out the name?**
  - **`RELAYED_NODE_EVENT` as a prefix plus the node id, with the client subscribing per watched node (recommended).**
    - Pros: the report's fix; uses the existing filter.
    - Cons: changing a watch changes the filter, which reconnects a stream unless handled like terminal filters; an older client listens on the old name, so it needs a version-compatibility entry.
  - **Keep one name and accept the fan-out.**
    - Pros: no compatibility work.
    - Cons: the bytes stay.

#### 2. Give relayed traffic its own replay share

**Problem.** Relayed frames take from the 2 MiB and 2,048-frame window, so a busy leaf can expire other clients' cursors and force reconciles.

**Context.** The event name does not start with the droppable prefix, so `emit` appends it to the ring (`apps/backend/src/gateway-events.ts:32-36`). The relay already sends a `resync` frame on a gap it knows about (`node-event-relay.ts:246-248`).

**Investigation.** The limits are at `apps/backend/src/gateway-event-replay.ts:9` and `:15`. There is one window for all authoritative events.

**Decisions.**

- **How to separate them?**
  - **A second bounded ring for relayed events, with its own cursor (recommended).**
    - Pros: the report's fix; a busy leaf can only expire relayed cursors.
    - Cons: two replay positions per client, or a merged cursor, which touches the handshake and its invariants.
  - **Make relayed events droppable, recovering through the relay's `resync`.**
    - Pros: no second ring; the relay already has a recovery signal.
    - Cons: droppable events are not replayed, so a client's own disconnect has to be detected and answered with a resync, which does not happen today.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): missed events stay detectable; every ring has byte and count bounds. 1202 notes this touches replay invariants.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-5, GW-12, GW-14, GW-11)
- [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)

## Outcome

Checked item by item against this file on 2026-11-05, on branch `gateway-events-a349aeaade47-r1`, based on `main` at `1e6d56391`. Line numbers are at commit `5bd8f2233`. The findings marked done on 2026-11-04 were re-read in the code after #1783 and #1798, which did not change them.

| Part | Item | Outcome | Evidence |
| --- | --- | --- | --- |
| 0280 | Task 1: share one encoded frame across subscribers | Done | `encodeGatewayFrame` (`apps/backend/src/gateway-event-replay.ts:68`); the replay frame holds a `Buffer` and its count; `EventClientWriter.write(chunk, byteLength?)` (`apps/backend/src/gateway-support-extra.ts:654`). Test: "gateway event frames are encoded once" in `apps/backend/tests/gateway-frame-costs.test.ts`. |
| 0280 | Decision: a `Buffer` plus its length | Done, as recommended | The ring holds no string, and its bounds count `encodedBytes`. Test: the window cases in `apps/backend/src/gateway-event-replay.test.ts`. |
| 0280 | Needs verification: frame measures and `emit` time | Done; a production profile moved to a to-do | Measured on 2026-11-04 in [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md). No production profile was taken: to-do 5840, task 3. |
| 0290 | Task 1: collapse skipped replay frames into one cursor | Done | `writeReplayFrames` (`apps/backend/src/gateway-events.ts:308`). Test: "scoped replay cursor frames" in `gateway-frame-costs.test.ts`. |
| 0290 | Decision: when to emit the cursor | Done, not as recommended | Built on 2026-11-04 as one cursor before the next matching frame and one at the end. The recommended end-only form would still work, since every matching replay frame carries an `id`. Kept because it saves one small frame per run and would change what a client sees mid-window, and the test pinning that order stands. Decision recorded in 1202 task 11. |
| 0290 | Decision: fix the replay budget for filtered clients | Done, as recommended (settled here; it was open in 1202 task 11) | `replayFitsClientBudget` charges matching frames plus one cursor per run, using the newest cursor so the figure stays an upper bound (`gateway-events.ts:363`). Tests: "the replay budget of a scoped client" in `gateway-frame-costs.test.ts`, including an unscoped client still reconciling and the upper bound. |
| 0300 | Task 1: find the replay range by index | Done | `slice(revision + 1 - oldestRevision)` (`gateway-event-replay.ts:191`). Test: the window cases in `gateway-event-replay.test.ts`. |
| 0300 | Task 2: count oversized appends | Done | `oversizedAppends` (`gateway-event-replay.ts:155`), reported as `replay.ring.oversizedAppends`. Test: "oversized replay appends" in `gateway-frame-costs.test.ts`. |
| 0370 | Task 1: name relayed events per node | Done for renderers on the gateway transport; the desktop's main process moved to a to-do | `relayedNodeEventName` (`packages/protocol/src/node-events.ts`), emitted at `apps/backend/src/core/nodes/node-event-relay.ts:240` and `:255`; a client subscribes per watched node through `RelayedEventStream` (`apps/web/src/lib/native/relayed-event-stream.ts`) and `listenPerNode` (`apps/web/src/lib/federation/node-events.ts:132`). Tests: "per-node relayed streams" in `apps/backend/tests/gateway-relayed-events.test.ts`, `apps/web/src/lib/native/web-gateway-relayed-stream.test.ts`, `node-event-relay.test.ts`. Main's stream: to-do 5841. |
| 0370 | Decision: how to roll out the name | Done, as recommended | Prefix plus node id. A filter change reopens the one stream from its cursor rather than re-reading, handled like terminal filters but with replay. Older clients: `emit` and `writeLegacyRelayedResyncs` (`gateway-events.ts:55`, `:184`), tested in "a client on an older version" in `gateway-relayed-events.test.ts`. Older command nodes: "an older command node relays on the old name" in `apps/web/src/lib/federation/node-events.test.ts`. Both paths are in the version-compatibility register. |
| 0370 | Task 2: give relayed traffic its own replay share | Done | `relayedEventReplay` (`apps/backend/src/gateway-context.ts`), 512 frames and 512 KiB (`gateway-event-replay.ts`). Test: "a busy leaf expires relayed cursors only; a main cursor still replays" in `gateway-relayed-events.test.ts`. |
| 0370 | Decision: how to separate them | Done, as recommended | A second bounded ring with its own cursor, on its own stream rather than a merged cursor, so `Last-Event-ID` and the handshake are unchanged. Tests: the same file, plus the renderer's stream class against a real gateway. |
| 0370 | Live evidence: two real nodes in a real browser, and real older releases | Moved to a to-do | To-do 5840, tasks 1 and 2. |
