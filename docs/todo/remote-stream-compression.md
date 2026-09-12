# TODO: evaluate remote stream compression

Status: Active — telemetry and resource bounds implemented; representative
measurement remains pending.

The staged measurement and rollout work is tracked in
[`plans/stream-efficience.md`](../../plans/stream-efficience.md).

Establish results with redundant payloads removed before changing compression
defaults.

## Existing behavior

- Gateway compression defaults to `body`: eligible ordinary responses can be
  compressed, while SSE gzip requires `ORKESTRATOR_GATEWAY_COMPRESSION=on`.
- Direct gateway events and proxied event streams already have gzip paths with
  synchronous flush behavior. Control-listener compression stays off.
- Terminal WebSocket transport exists but is opt-in in the browser gateway;
  absent an override/preference, the HTTP/SSE path remains selected. Measure the
  selected transport rather than assuming all terminal traffic uses WebSockets.
- `TerminalWebSocketGateway` does not configure WebSocket message compression.
  HTTP body/SSE compression does not compress those binary WebSocket frames.
- Streaming gzip contexts, terminal WebSocket sockets, and terminal WebSocket
  channels now have explicit concurrency/admission bounds. Saturated streaming
  compression falls back to identity without changing the default mode.
- Gateway metrics now distinguish serialized/source bytes from encoded SSE
  bytes and report terminal WebSocket payload, framed-byte, ACK, queue, and
  lifecycle totals.
- Terminal WebSocket output ACKs are cumulative and coalesced over a short
  bounded interval.

## Investigation sequence

1. Establish baseline bytes, frame counts, flush latency, CPU, and peak retained
   memory for quiet and noisy terminals and any agent streams actually crossing
   the remote gateway. Use synthetic output, several clients, and a slow client.
2. In an isolated test profile, compare `body` with the existing `on` mode through
   the actual supported remote proxy/access route. Verify streaming appears
   incrementally and is not buffered until a large chunk or stream completion.
3. Exercise both direct `/events` and proxied streams, reconnect/replay, empty
   keepalives, long idle periods, disconnect during compression, and clients that
   do not negotiate gzip. Inspect encoding and `Vary` behavior.
4. Measure terminal HTTP/SSE and opt-in WebSocket transport separately. Determine
   whether reduced encoding overhead already meets the bandwidth target before
   adding WebSocket compression.
5. If large terminal output remains a significant cost, prototype optional
   negotiated WebSocket compression with explicit concurrency, memory, and
   output bounds. Compare thresholds and small bounded output batches; do not
   compress every tiny input/control frame indiscriminately.
6. Preserve exact terminal bytes, generation/revision order, fairness between
   channels, desync signaling, and authoritative snapshot recovery. Account for
   compressor buffers in existing slow-consumer limits; do not move backpressure
   onto the provider's stdout reader.
7. Document measured tradeoffs and recommend a default, optional setting, or no
   change. Do not enable compression globally without representative results.

The library's [official compression guidance](https://github.com/websockets/ws#websocket-compression)
documents server-side opt-in and CPU/memory overhead. Re-check current library
documentation through Context7 before implementing library-specific options.

## Likely implementation locations

- `apps/backend/src/gateway-support-core.ts`: modes, negotiation, budgets, metrics
- `apps/backend/src/gateway-support-extra.ts`: gzip event writer
- `apps/backend/src/gateway-handlers.ts`: direct event streams
- `apps/backend/src/gateway-proxy.ts`: proxied stream compression
- `apps/backend/src/terminal-websocket-server.ts`: binary transport and buffering
- `apps/web/src/lib/native/web-gateway.ts`: selection and fallback
- Owning gateway and terminal transport tests

## Acceptance and measurement

- [x] Report actual encoded bytes separately from pre-compression event/command
      counters, and include WebSocket framing/compression in its own measurement.
- [ ] Test local and remote proxy paths at normal and constrained bandwidth.
- [ ] Record p50/p95 first-update and completion latency, bytes/minute, backend
      CPU, memory, compression concurrency, and slow-client reconnect frequency.
- [ ] Compression never delays an approval/completion event indefinitely, loses
      authoritative state, or causes double encoding.
- [ ] Unsupported negotiation and codec failures have tested bounded behavior.
- [ ] Terminal output matches exact snapshot state after backpressure/reconnect.
- [ ] Rollback to `body` and HTTP/SSE remains available during any opt-in trial.
- [ ] Metrics/artifacts contain no terminal content, prompts, credentials,
      attachment data, or file contents.

Use the repository's isolated agent-testing workflow and `test:logged` for
validation. This TODO authorizes no production configuration changes.
