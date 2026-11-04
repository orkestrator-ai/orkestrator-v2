# E19: Terminal WebSocket

This file combines 3 reports into one batch to build together. Same server and client pair.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0100](#0100-terminal-websocket-flush-ignores-the-socket-buffer-and-desyncs-quiet-channels) | Medium | GW-6: Terminal WebSocket flush ignores the socket buffer and desyncs quiet channels |
| [0375](#0375-small-per-chunk-and-per-frame-gateway-costs) | Low | GW-16: Small per-chunk and per-frame gateway costs |
| [0610](#0610-the-terminal-websocket-rebuilds-every-channel-on-every-visibility-change) | Low | WEB-11: The terminal WebSocket rebuilds every channel on every visibility change |

## 0100: Terminal WebSocket flush ignores the socket buffer and desyncs quiet channels

### Task analysis

#### Tasks

1. **Stop flushing channel frames above a low watermark**: leave backlog in the per-channel queues and resume when the socket drains. Status: open.

#### 1. Stop flushing channel frames above a low watermark

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

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): live events stay incremental with missed events detectable. The revision-gap and desync paths must keep working unchanged.

### Needs verification

- How `bufferedAmount` and the `ws.send` callback behave under Bun's `ws` compatibility layer. The backend runs `ws` under Bun, and this was read from code only.
- The desync itself was reasoned from the code; no flooding run was observed.

## 0375: Small per-chunk and per-frame gateway costs

### Task analysis

#### Tasks

1. **Refresh idle timers**: use `timer.refresh()` rather than recreating a timer per chunk. Status: open.
2. **Reuse `TextDecoder`s**: stop creating one per WebSocket message. Status: open.
3. **Batch operation results**: stop sending one JSON frame per keystroke. Status: open.
4. **Reduce terminal acks**: acks every 50 ms per channel reset only an error counter. Status: open.

#### 1. Refresh idle timers

**Problem.** Each proxied chunk clears a timer and creates another.

**Context.** The sites are all idle deadlines, with no per-call state.

**Investigation.** `apps/backend/src/gateway-proxy.ts:301-308` and `:550-558` (run again at `:574`), and `packages/protocol/src/node/preview-forward.ts:318-319`.

**Decisions.** None: `refresh()` keeps the same deadline semantics. Each site still needs its existing clear on settle.

#### 2. Reuse `TextDecoder`s

**Problem.** Each control message and each input frame allocates a decoder.

**Context.** Neither decode uses `stream: true`, so a decoder holds no state between calls.

**Investigation.** `apps/backend/src/terminal-websocket-server.ts:400` (fatal) and `:555` (non-fatal).

**Decisions.** None: two module-level decoders with the same options.

#### 3. Batch operation results

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

#### 4. Reduce terminal acks

**Problem.** A client sends an ack per channel every 50 ms during output. The server uses them only to reset `invalidChannelFrames`.

**Context.** Acks are cumulative and advisory (see the comment in `flushAcknowledgement`).

**Investigation.** The client: `apps/web/src/lib/native/terminal-websocket-client.ts:97` and `:867-876`. The server: `terminal-websocket-server.ts:478-487`, plus a metric that counts them (`:415`).

**Decisions.**

- **Send fewer, or use them?**
  - **Send them less often, for example once a second (recommended).**
    - Pros: a client-only constant; no protocol change.
    - Cons: revisit if flow control later wants them, such as after [0100](#0100-terminal-websocket-flush-ignores-the-socket-buffer-and-desyncs-quiet-channels).
  - **Use them as flow-control credit.**
    - Pros: gives the server a true view of client progress.
    - Cons: a much larger change, and GW-6's `bufferedAmount` watermark covers the same socket problem.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): live events stay incremental, and metrics stay content-free.
- Tasks 3 and 4 only reach users of the opt-in terminal WebSocket.

### Needs verification

- `timer.refresh()` under Bun on these paths was not exercised. Nothing here was run.

## 0610: The terminal WebSocket rebuilds every channel on every visibility change

### Task analysis

#### Tasks

1. **Rebuild only when needed**: stop replacing a healthy socket when the page becomes visible. Status: deferred after review (2026-11-04; [1202 task 3](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)). The mobile-only 5 s policy was reverted because an independently stalled terminal socket has no liveness probe; foreground replacement remains required on all hosts.

#### 1. Rebuild only when needed

**Problem.** Each return to the page closes the socket and re-subscribes every terminal channel, and each channel then reconciles from a snapshot.

**Context.** The rebuild exists for a real reason: mobile WebViews can keep an apparently open, dead socket while backgrounded (`apps/web/src/lib/native/terminal-websocket-client.ts:361-362`). This transport is opt-in: it is on only when set in `localStorage` or the options (`apps/web/src/lib/native/web-gateway.ts:153-160`).

**Investigation.** `onVisibilityChange` has no condition beyond "visible with channels" (`terminal-websocket-client.ts:359-372`). `resetChannelsForReconnect` clears every channel (`:822`, called at `:370`). A separate path drops a socket when the link goes silent (`dropConnection`, `:378`, called from `web-gateway.ts:851`). The client has no ping or pong frame that I could find, and browser code cannot send a WebSocket ping, so the report's "no frame or pong for X seconds" can only mean "no frame", which a quiet terminal also shows.

**Decisions.**

- **What decides a rebuild?**
  - **Keep foreground replacement until terminal-specific liveness exists (recommended, implemented after review).**
    - Pros: recovers stalled terminal connections without user input on every host.
    - Cons: retains the per-return channel reconciliation cost.
  - **Limit the rebuild to mobile hosts and to a page hidden for longer than a short bound (rejected after review).**
    - Pros: a desktop alt-tab costs nothing; needs no new frame; keeps the protection where the comment says it matters.
    - Cons: the main-stream silence path never fires when only the terminal socket stalls.
  - **Add an application-level echo and rebuild only if it goes unanswered.**
    - Pros: tests the socket directly on every host.
    - Cons: a protocol addition with a version-compatibility entry, and a delay on return while it waits.

### Constraints and rationale

The report's [invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) require missed events to stay detectable; a kept channel must still detect a gap through its revision and generation (`apps/web/src/hooks/useTerminal.ts:485-540`).

### Needs verification

- How many users have turned this transport on. Local windows and default web clients use other paths.

## Related

- [Efficiency report, A](../2026-10-27-efficiency.md#a-gateway-and-transport) (GW-6, GW-16)
- [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), which recommends this as the gateway's next step (not yet decided)
- [0052 remote client bandwidth](../../todo/transcripts-and-observation/0052-remote-client-bandwidth.md) (terminal transport choice)
- [1202 task 11](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [Efficiency report, D](../2026-10-27-efficiency.md#d-renderer-appswebsrc)
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), task 3
