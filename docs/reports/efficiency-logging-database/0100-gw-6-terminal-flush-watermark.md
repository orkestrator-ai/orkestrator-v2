# Terminal WebSocket flush ignores the socket buffer and desyncs quiet channels

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Stop flushing channel frames above a low watermark**: leave backlog in the per-channel queues and resume when the socket drains. Status: open.

### 1. Stop flushing channel frames above a low watermark

**Problem.** A flooding channel moves its backlog into the socket's buffer. The next frame on a quiet channel then trips the 2 MiB socket soft limit, so the quiet channel is desynced and has to refetch its snapshot, although it did nothing wrong.

**Context.** The per-channel soft limit (512 KiB) already exists to desync only the noisy channel, but it cannot work while the flush drains that channel's queue into the socket as fast as it can. The terminal WebSocket is opt-in, so only users of that transport are affected.

**Investigation.** `flush` (`apps/backend/src/terminal-websocket-server.ts:868`) spends a 64 KiB budget per pass and reschedules itself with `setImmediate` (`:864-865`) while anything is queued. It never reads `ws.bufferedAmount`, which is used only for accounting and limits (`:780`, `:803`, `:845`, `:857`). The quiet channel's check is `socketProjected` at `:780`, and exceeding the soft limit desyncs it at `:793-797`. The limits are in `packages/protocol/src/terminal-websocket.ts:21-23`.

With a 256 KiB watermark, one flooding channel holds at most about 768 KiB (its 512 KiB queue plus the watermark), which stays under the 2 MiB socket limit. Several flooding channels together could still reach it, and that is correct: the socket really is behind.

**Decisions.**

- **How should a paused flush resume?**
  - **From the `ws.send` callback, once `bufferedAmount` is below the watermark (recommended).**
    - Pros: the report's fix; no work while the socket is stalled; `flush` already passes a callback to every send.
    - Cons: needs a guard so a callback and a scheduled flush do not both run, and a flush with nothing in flight must still restart on the next enqueue.
  - **Keep rescheduling with `setImmediate` and skip while above the watermark.**
    - Pros: the smallest change.
    - Cons: spins the event loop for as long as a slow client stays behind.
- **Do control frames obey the watermark?**
  - **No: only channel frames stop (recommended).**
    - Pros: operation results and desync notices keep flowing to a client whose output is backed up; control frames have their own hard limit check at `terminal-websocket-server.ts:845-846`.
    - Cons: a control-heavy client can still grow the socket buffer up to that limit.
  - **Yes: everything stops.**
    - Pros: one rule.
    - Cons: a keystroke's result waits behind another terminal's output.

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): live events stay incremental with missed events detectable. The revision-gap and desync paths must keep working unchanged.

## Needs verification

- How `bufferedAmount` and the `ws.send` callback behave under Bun's `ws` compatibility layer. The backend runs `ws` under Bun, and this was read from code only.
- The desync itself was reasoned from the code; no flooding run was observed.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-6)
- [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), which recommends this as the gateway's next step (not yet decided)
- [0052 remote client bandwidth](../../todo/transcripts-and-observation/0052-remote-client-bandwidth.md) (terminal transport choice)
