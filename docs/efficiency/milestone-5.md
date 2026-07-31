# Milestone 5 — Multiplexed terminal WebSocket

Status: In progress — implementation complete; opt-in measurement rollout remains

Depends on: Milestone 4

Unblocks: Milestone 6

## Outcome

Replace per-keystroke HTTP commands and base64/SSE terminal bytes with one
authenticated, multiplexed, bounded WebSocket while retaining HTTP/SSE fallback
and authoritative snapshot recovery.

## Scope

Primary areas:

- `apps/backend/src/gateway.ts`
- terminal command and output routing
- `apps/web/src/lib/native/web-gateway.ts`
- `apps/web/src/hooks/useTerminal.ts`
- terminal subscription ownership
- gateway and terminal integration tests

## Implementation checklist

### HTTP compatibility improvement

- [x] Add a 5–10 ms terminal input micro-batch to the HTTP path.
- [x] Flush Enter, control sequences, and explicit paste boundaries
      immediately.
- [x] Enforce a hard input buffer limit.
- [x] Preserve exact input ordering.
- [ ] Measure typing and paste behavior before making WebSocket the default.

### Protocol definition

- [x] Version the WebSocket protocol.
- [x] Define authentication and origin checks.
- [x] Define JSON control frames for subscribe, unsubscribe, resize, generation,
      lifecycle, acknowledgement, and errors.
- [x] Allocate compact numeric channel IDs after subscription.
- [x] Define binary input and output frames with frame type, channel ID,
      generation, revision, and raw bytes.
- [x] Define maximum control and binary frame sizes.
- [x] Define protocol-error and unsupported-version behavior.
- [x] Document ordering and resubscription rules.

### Gateway implementation

- [x] Open one socket per gateway client.
- [x] Multiplex every client terminal over that socket.
- [x] Authorize every terminal subscription.
- [x] Preserve session filtering.
- [x] Apply soft and hard byte limits per socket.
- [x] Apply limits and fairness per terminal channel.
- [x] Prevent one slow terminal from starving other channels.
- [x] Emit an explicit desync for dropped terminal output.
- [x] Preserve generation and revision gap detection.
- [x] Keep snapshot commands as the reconnect authority.
- [x] Clean up socket resources without stopping backend terminal processes.

### Browser adapter

- [x] Own the socket in the gateway adapter, not a terminal React component.
- [x] Maintain an authoritative registry of desired terminal subscriptions.
- [x] Reconnect with bounded backoff.
- [x] Resubscribe after reconnect and iOS foreground transitions.
- [x] Reconcile every channel from its known generation and revision.
- [x] Route binary bytes without base64 conversion.
- [x] Preserve HTTP/SSE fallback for unsupported or failed WebSocket sessions.
- [x] Ensure component unmount only updates consumption, not backend lifetime.

### Compatibility rollout

- [x] Add a transport option or negotiated fallback.
- [x] Start with opt-in WebSocket use.
- [ ] Compare bytes, latency, memory, and reconnect correctness.
- [ ] Make WebSocket the default only after target-client verification.
- [x] Keep HTTP/SSE available for one compatibility release.
- [x] Set and document the earliest fallback-removal release.

## Required tests

- [x] Authentication and origin rejection.
- [x] Protocol version and malformed-frame rejection.
- [x] Channel subscribe, unsubscribe, resize, input, and output.
- [x] Multiple terminals share one socket without cross-session bytes.
- [x] Input order survives batching and reconnect boundaries.
- [x] Generation and revision gaps trigger snapshot recovery.
- [x] Retained gaps recover incrementally.
- [x] One slow channel does not starve another.
- [x] A non-reading socket is bounded and disconnected at the hard limit.
- [x] Socket close releases adapter resources but not terminal processes.
- [x] Reconnect rebuilds the desired subscription set.
- [x] HTTP/SSE fallback remains functional.

## Manual verification

- [ ] Ordinary typing no longer creates one HTTP request per character.
- [ ] Test rapid key repeat, escape sequences, Ctrl combinations, IME, and paste.
- [ ] Run a 1 MiB terminal output workload and compare wire bytes.
- [ ] Measure key-to-echo p50 and p95 on LAN and 100 ms RTT.
- [ ] Use multiple terminals, including one output flood.
- [ ] Disconnect, background iOS, lock the screen, and restart the gateway.
- [ ] Verify exact output and controls after each recovery.
- [ ] Complete the inactive-environment path.

## Commands

```bash
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/desktop typecheck
bun test tests/unit/electron/gateway.test.ts --parallel
bun test tests --parallel
bun run test
```

## Exit criteria

- [x] Ordinary typing uses neither one request per character nor base64 on the
      WebSocket path.
- [ ] Key-to-echo p95 does not regress on LAN.
- [ ] Key-to-echo p95 improves or remains stable at 100 ms RTT.
- [ ] A 1 MiB output workload transfers materially fewer bytes.
- [x] Socket and per-channel memory remain bounded under slow readers.
- [ ] All disconnect and restart cases recover from authoritative state.
- [x] Multiple terminals remain isolated and fair.
- [x] HTTP/SSE fallback remains available and tested.
- [x] Focused tests, typechecks, and the full root suite pass.

## Evidence and decisions

Record:

- protocol version and wire-frame specification;
- typing request rate and p50/p95 latency before/after;
- 1 MiB workload transfer totals;
- slow-reader memory results;
- target client compatibility;
- default and fallback-removal decisions;
- test command results.

Initial implementation evidence:

- Protocol version: v1, negotiated as `orkestrator-terminal.v1`.
- Wire specification: [`terminal-websocket-protocol.md`](terminal-websocket-protocol.md).
- Binary codec and bounds: `packages/protocol/src/terminal-websocket.ts`.
- JSON control-frame parsers enforce version, shape, atomic cursor, scalar, and
  UTF-8 byte bounds in `packages/protocol/src/terminal-websocket.ts`.
- HTTP fallback batching: 8 ms, 64 KiB per-request payloads, and a 1 MiB
  outstanding-input ceiling per terminal. Larger pastes are split on UTF-8
  boundaries; Enter, C0/DEL controls, escape sequences, and paste chunks flush
  immediately with any preceding printable input. Sends time out after 30
  seconds and fail closed without dispatching a queued suffix.
- The ceiling applies backpressure rather than discarding input. Input that fits
  the ceiling waits, strictly in order, for room; only input too large to ever
  fit is rejected. Resize and close commands flush accepted *and* parked input
  before changing terminal lifecycle state, so neither can overtake a write the
  caller already issued.
- A queue that failed closed is re-armed by a session restart, by a close, or by
  the next resize that succeeds — a resize proves the transport recovered. The
  failure toast also offers an explicit reconnect. Without a recovery path a
  single transient write failure would leave a terminal that still streams
  output but silently refuses every keystroke.
- A close marks the input queue closed only once it reaches the backend. A close
  that fails leaves a live terminal behind, and that terminal stays writable.
- Automated verification on 2026-07-31:
  - terminal batcher plus browser gateway: 114 passed;
  - shared protocol package: 185 passed;
  - terminal hook recovery suite: 49 passed;
  - backend, web, desktop, and protocol TypeScript checks: passed;
  - renderer production build: passed.
- WebSocket is not yet the default. Baseline latency/transfer measurements,
  real-device compatibility results, and the default-promotion decision remain
  to be recorded.
- Gateway implementation: `apps/backend/src/terminal-websocket-server.ts`,
  attached to each existing HTTP listener from `apps/backend/src/gateway.ts`.
- Accepted input and resize operations use a gateway-owned per-session ordering
  tail, so reconnecting onto a new channel cannot overtake work accepted from
  the previous socket. Hard-limit closure has a bounded forced-termination
  backstop for peers that do not complete the close handshake.
- Browser ownership and opt-in fallback:
  `apps/web/src/lib/native/terminal-websocket-client.ts` and
  `apps/web/src/lib/native/web-gateway.ts`.
- Retained snapshot deltas now preserve revision boundaries for binary replay;
  the additive `deltas` field is ignored by older HTTP clients.
- Rollout: `http-sse` remains the default. Browser profiles opt in through
  `orkestrator-terminal-transport=websocket`; fallback removal is no earlier
  than v2.9.0 and still requires one full compatibility release after default
  promotion.
- Final automated verification: 161 gateway tests, 31 terminal protocol tests,
  133 focused browser/terminal tests, backend and web TypeScript checks, and the
  3,574-test root suite (3,573 passed, 1 environment-dependent test skipped).
