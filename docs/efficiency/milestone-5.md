# Milestone 5 — Multiplexed terminal WebSocket

Status: In progress — protocol and HTTP input batching implemented

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

- [ ] Open one socket per gateway client.
- [ ] Multiplex every client terminal over that socket.
- [ ] Authorize every terminal subscription.
- [ ] Preserve session filtering.
- [ ] Apply soft and hard byte limits per socket.
- [ ] Apply limits and fairness per terminal channel.
- [ ] Prevent one slow terminal from starving other channels.
- [ ] Emit an explicit desync for dropped terminal output.
- [ ] Preserve generation and revision gap detection.
- [ ] Keep snapshot commands as the reconnect authority.
- [ ] Clean up socket resources without stopping backend terminal processes.

### Browser adapter

- [ ] Own the socket in the gateway adapter, not a terminal React component.
- [ ] Maintain an authoritative registry of desired terminal subscriptions.
- [ ] Reconnect with bounded backoff.
- [ ] Resubscribe after reconnect and iOS foreground transitions.
- [ ] Reconcile every channel from its known generation and revision.
- [ ] Route binary bytes without base64 conversion.
- [ ] Preserve HTTP/SSE fallback for unsupported or failed WebSocket sessions.
- [ ] Ensure component unmount only updates consumption, not backend lifetime.

### Compatibility rollout

- [ ] Add a transport option or negotiated fallback.
- [ ] Start with opt-in WebSocket use.
- [ ] Compare bytes, latency, memory, and reconnect correctness.
- [ ] Make WebSocket the default only after target-client verification.
- [ ] Keep HTTP/SSE available for one compatibility release.
- [ ] Set and document the earliest fallback-removal release.

## Required tests

- [ ] Authentication and origin rejection.
- [ ] Protocol version and malformed-frame rejection.
- [ ] Channel subscribe, unsubscribe, resize, input, and output.
- [ ] Multiple terminals share one socket without cross-session bytes.
- [ ] Input order survives batching and reconnect boundaries.
- [ ] Generation and revision gaps trigger snapshot recovery.
- [ ] Retained gaps recover incrementally.
- [ ] One slow channel does not starve another.
- [ ] A non-reading socket is bounded and disconnected at the hard limit.
- [ ] Socket close releases adapter resources but not terminal processes.
- [ ] Reconnect rebuilds the desired subscription set.
- [ ] HTTP/SSE fallback remains functional.

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

- [ ] Ordinary typing uses neither one request per character nor base64 on the
      WebSocket path.
- [ ] Key-to-echo p95 does not regress on LAN.
- [ ] Key-to-echo p95 improves or remains stable at 100 ms RTT.
- [ ] A 1 MiB output workload transfers materially fewer bytes.
- [ ] Socket and per-channel memory remain bounded under slow readers.
- [ ] All disconnect and restart cases recover from authoritative state.
- [ ] Multiple terminals remain isolated and fair.
- [ ] HTTP/SSE fallback remains available and tested.
- [ ] Focused tests, typechecks, and the full suite pass.

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
- HTTP fallback batching: 8 ms, 64 KiB accumulated-input ceiling, serialized
  per terminal. Enter, C0/DEL controls, escape sequences, and paste-sized chunks
  flush immediately with any preceding printable input.
- Automated verification on 2026-07-31:
  - terminal batcher plus browser gateway: 69 passed;
  - shared protocol package: 157 passed;
  - terminal hook recovery suite: 44 passed;
  - backend, web, desktop, and protocol TypeScript checks: passed.
- WebSocket is not yet the default. Baseline latency/transfer measurements,
  gateway implementation, browser socket ownership, and compatibility results
  remain to be recorded.
