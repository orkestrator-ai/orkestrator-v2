# 07 — Forward application WebSockets and desktop tunnel streams

Status: Not started. Depends on: 04–06. Unlocks: 08 and 10.

## Outcome and integration boundary

Remote HMR and app WebSockets use the same authorized service identity as HTTP.
Desktop can carry service traffic over its existing authenticated backend
connection without exposing a raw port publicly. These are two distinct
protocols: an application's WebSocket and Orkestrator's own transport tunnel.

Add proposed `preview-websocket-proxy.ts` and `preview-tunnel-server.ts` modules.
Extend routing in [gateway base](../../../../apps/backend/src/gateway-base.ts)
without changing [terminal WebSocket](../../../../apps/backend/src/terminal-websocket-server.ts)
protocol semantics. Route by an exact known listener/path and reject everything
unhandled. The preview route must not steal terminal upgrades.

## Application WebSocket forwarding

1. Parse/validate the upgrade, authenticate the scoped preview access, apply
   origin policy, and resolve the fixed service generation before upgrading.
2. Count handshakes in admission limits. Set an upstream connect/handshake
   deadline. Return meaningful HTTP failures before `101` where possible.
3. Preserve the application's requested subprotocol list and the upstream's
   selected subprotocol. Reject invalid upstream selections. Do not insert the
   terminal subprotocol or a gateway token into app subprotocol strings.
4. Preserve binary/text messages, close semantics, and negotiated extensions.
   Prefer a transparent upgrade tunnel if validated by step 01; if terminating
   and recreating sockets, explicitly negotiate extensions and message-size
   limits on both legs. Do not promise exact semantics without tests.
5. Forward application auth/cookies through the HTTP header policy while removing
   transport auth. Support authenticated upgrades from both native and browser
   clients; a browser cannot attach arbitrary auth headers like a trusted native
   client can.
6. Tie socket lifetime to attachment, epoch/generation, and access revocation.
   Closing either leg releases both legs and all buffers/timers.

An app-generated `ws://localhost:3000` URL still needs public-origin configuration
or service-aware app routing. The transport should support the correct endpoint,
not silently reinterpret every outbound WebSocket destination.

## Desktop tunnel wire contract

The preferred initial design from step 01 is one authenticated outer WSS stream
per inner upstream connection. It avoids inventing a multiplexed scheduler in
the first release. Set a distinct versioned transport subprotocol and bounded
control messages. Reuse endpoint authorization, not terminal channel IDs.

Define the state machine:

`connecting -> authenticating -> opening -> open -> closing -> closed`.

Only a validated `OPEN` for the grant-bound service/generation can create the
upstream connection. The client cannot supply hostname, port, arbitrary socket
path, command, or container ID. Limit control frames and reject out-of-order
or duplicate operations. Do not buffer application bytes before authorization.

After `OPEN_OK`, bounded binary frames carry ordered bytes. Represent EOF,
cancellation, and failures explicitly. Decide and test half-close support for
the HTTP connections in scope. Close on malformed frames or protocol mismatch.
The backend must not reconnect an upstream behind the client's back after an
ambiguous disconnect; that can repeat application writes.

The outer WSS credential is consumed before raw application data. It must
never become an inner HTTP header. The desktop local ingress owns HTTP parsing,
credential stripping, application request-size policy, and public/private URL
mapping; the backend tunnel owns target authorization, byte-queue bounds,
connection counts, and lease lifetime. Document this distinction: a raw tunnel
cannot enforce an HTTP body limit without parsing HTTP. If server-side HTTP
policy is required for every native request, select a request-framed transport
in step 01 instead and amend this contract before coding.

The initial raw tunnel adapter supports HTTP upstream connections. HTTPS
upstreams need the explicitly proven TLS adapter/publication path; never feed
TLS bytes into an HTTP listener or disable certificate verification to make
the tunnel appear functional.

## Backpressure and fairness

Use step-02 frame, queue, count, and aggregate limits. Pause upstream reading
when the destination queue reaches its soft threshold; resume below a lower
threshold. At the hard ceiling, close the affected connection with a typed
failure. Bound bytes waiting for both WebSocket library send callbacks and
underlying socket writes; a library's `bufferedAmount` is not the whole budget.

Apply per-service admission so one preview cannot consume every backend slot.
Use ping/liveness only on Orkestrator's own tunnel where it controls the protocol.
Do not inject app-level heartbeats into arbitrary application sockets. Queue
metrics never contain payload data. Retire idle pooled connections with an
explicit policy; keepalive must not retain old endpoint generations.

## Tests and completion

Cover Vite HMR and a generic app echo socket with subprotocols/binary messages.
Verify terminal sockets still connect. Exercise cross-site upgrades, wrong
service grants, malformed control frames, oversized data frames, slow readers,
half-close, handshake timeout, token rotation, backend restart, and service
generation replacement. A mutation sent just before disconnect must not be
replayed automatically.

Test on two machines to detect client-local fallback and on a throttled link
to expose queue growth. Assert all counters return to baseline after each
failure. Backpressure tests must demonstrate unrelated services/control events
continue making progress. Exit with wire examples and bounds documented, app
WS semantics verified, and no regression to terminal upgrade handling.
