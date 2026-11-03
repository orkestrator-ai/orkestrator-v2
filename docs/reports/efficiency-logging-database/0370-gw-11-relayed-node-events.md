# Relayed federation events share one name and the main replay window

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Name relayed events per node**: let subscription filters scope them. Status: open.
2. **Give relayed traffic its own replay share**: stop a busy leaf forcing reconciles. Status: open.

### 1. Name relayed events per node

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

### 2. Give relayed traffic its own replay share

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

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): missed events stay detectable; every ring has byte and count bounds. 1202 notes this touches replay invariants.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-11)
- [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
