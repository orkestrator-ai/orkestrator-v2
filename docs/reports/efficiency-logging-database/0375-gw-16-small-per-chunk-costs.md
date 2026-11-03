# Small per-chunk and per-frame gateway costs

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Refresh idle timers**: use `timer.refresh()` rather than recreating a timer per chunk. Status: open.
2. **Reuse `TextDecoder`s**: stop creating one per WebSocket message. Status: open.
3. **Batch operation results**: stop sending one JSON frame per keystroke. Status: open.
4. **Reduce terminal acks**: acks every 50 ms per channel reset only an error counter. Status: open.

### 1. Refresh idle timers

**Problem.** Each proxied chunk clears a timer and creates another.

**Context.** The sites are all idle deadlines, with no per-call state.

**Investigation.** `apps/backend/src/gateway-proxy.ts:301-308` and `:550-558` (run again at `:574`), and `packages/protocol/src/node/preview-forward.ts:318-319`.

**Decisions.** None: `refresh()` keeps the same deadline semantics. Each site still needs its existing clear on settle.

### 2. Reuse `TextDecoder`s

**Problem.** Each control message and each input frame allocates a decoder.

**Context.** Neither decode uses `stream: true`, so a decoder holds no state between calls.

**Investigation.** `apps/backend/src/terminal-websocket-server.ts:400` (fatal) and `:555` (non-fatal).

**Decisions.** None: two module-level decoders with the same options.

### 3. Batch operation results

**Problem.** Each keystroke's input is answered by its own JSON `operation-result` frame.

**Context.** The result carries a per-operation id, which the client uses to settle a pending write.

**Investigation.** `operationResult` is at `terminal-websocket-server.ts:1040`, called from `:452`, `:516`, `:532`, `:544`, `:982`, `:1005` and `:1016`. It goes through the control queue. `flush` sends control frames first and one at a time (`:872`).

**Decisions.**

- **How to batch?**
  - **A cumulative result per channel per flush: "all input up to id N succeeded", with failures still sent alone (recommended).**
    - Pros: the report's per-flush batching; failures keep their message.
    - Cons: a new frame type, so an older client needs a negotiation through the subprotocol.
  - **Leave it.**
    - Pros: no protocol change, and the frames are small.
    - Cons: one frame per key remains.

### 4. Reduce terminal acks

**Problem.** A client sends an ack per channel every 50 ms during output. The server uses them only to reset `invalidChannelFrames`.

**Context.** Acks are cumulative and advisory (see the comment in `flushAcknowledgement`).

**Investigation.** The client: `apps/web/src/lib/native/terminal-websocket-client.ts:97` and `:867-876`. The server: `terminal-websocket-server.ts:478-487`, plus a metric that counts them (`:415`).

**Decisions.**

- **Send fewer, or use them?**
  - **Send them less often, for example once a second (recommended).**
    - Pros: a client-only constant; no protocol change.
    - Cons: revisit if flow control later wants them, such as after [0100](0100-gw-6-terminal-flush-watermark.md).
  - **Use them as flow-control credit.**
    - Pros: gives the server a true view of client progress.
    - Cons: a much larger change, and GW-6's `bufferedAmount` watermark covers the same socket problem.

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): live events stay incremental, and metrics stay content-free.
- Tasks 3 and 4 only reach users of the opt-in terminal WebSocket.

## Needs verification

- `timer.refresh()` under Bun on these paths was not exercised. Nothing here was run.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-16)
- [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
