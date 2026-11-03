# Events are measured and encoded again for each subscriber

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Share one encoded frame across subscribers**: keep a `Buffer` in the replay frame and pass the byte count to writers. Status: open.

### 1. Share one encoded frame across subscribers

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

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): the ring's 2 MiB and 2,048-frame bounds must count the same bytes as before.

## Needs verification

- Whether this shows in a profile at all, since it was reasoned, not measured. Low priority until it does.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-5)
- [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
