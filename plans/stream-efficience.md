# Stream efficiency plan

Status: implementation foundations complete; transport rollout remains
measurement-gated.

## Objective

Reduce remote terminal and agent-stream bandwidth without trading away
incremental delivery, bounded memory, exact terminal recovery, or reliable
background execution.

The immediate goal is observability and bounded resource use. The gateway's
default remains `body`, SSE gzip remains opt-in through compression mode `on`,
and the terminal WebSocket transport remains opt-in until representative
measurements justify changing either default.

## Completed foundation

- Gateway event metrics distinguish serialized SSE bytes from encoded response
  body bytes. The existing `wireBytes` event field remains as a compatibility
  alias for serialized bytes.
- Direct event streams report source and encoded body bytes. Streaming gzip
  reports its own source, encoded, active, peak, declined, and failure totals.
- Direct and proxied SSE gzip contexts share an explicit concurrency ceiling.
  When the pool is full, compression is declined and the stream continues with
  identity encoding.
- The direct gzip writer includes its input backlog, compressor output backlog,
  and response backlog in slow-consumer accounting.
- Terminal WebSockets have process-wide socket and channel limits plus a
  per-socket channel limit.
- Terminal WebSocket metrics report connection and channel lifecycle, logical
  payload bytes, output bytes, acknowledgement traffic, desyncs, peak queued
  bytes, and WebSocket-framed byte totals.
- The browser coalesces cumulative output acknowledgements for a short bounded
  interval and flushes the newest revision before unsubscribe or recovery.

## Invariants

Every experiment and rollout must preserve these properties:

1. Backend snapshots remain authoritative; live frames are incremental only.
2. Missed terminal output produces an explicit desync and exact snapshot
   recovery.
3. Authoritative events are never silently dropped.
4. Terminal output can be dropped only at a bounded backpressure threshold.
5. Compression buffers, socket queues, channels, and connections have explicit
   bounds.
6. Compression and browser work never block a provider or app-server stdout
   loop.
7. Reconnect, replay, generation, and revision ordering remain unchanged.
8. Telemetry contains counts and byte sizes only, never terminal output,
   prompts, files, credentials, attachments, or tokens.

## Phase 1: validate the foundation

- Run focused gateway and terminal WebSocket suites.
- Run changed-file tests, formatting, linting, and type checking.
- Run the complete repository suite before integration.
- Exercise compressor failure, disconnect, pool saturation, WebSocket socket
  saturation, per-socket channel saturation, and process-wide channel
  saturation.
- Confirm all gauges return to zero after close, failure, gateway stop, and
  credential rotation.

Exit criteria:

- No lost or duplicated terminal bytes across reconnect and desync recovery.
- No leaked compressor leases, sockets, channels, timers, or queued bytes.
- Existing `body` mode and HTTP/SSE fallback behavior are unchanged.

## Phase 2: establish representative baselines

Build a reproducible matrix using the supported remote access path, not only a
loopback microbenchmark.

Workloads:

- Quiet terminal with keepalives.
- Interactive shell with small bursts.
- Build/test output with redundant text.
- Incompressible output.
- One slow client and multiple healthy clients.
- One, several, and maximum admitted concurrent streams.
- Agent event traffic with and without terminal output.

Compare:

- HTTP/SSE in `body` mode.
- HTTP/SSE in `on` mode.
- Opt-in terminal WebSocket transport without message compression.

Record:

- Serialized/source bytes and encoded body bytes.
- WebSocket logical payload bytes and WebSocket-framed bytes.
- p50 and p95 first-update and completion latency.
- Backend CPU, retained memory, active/peak compressors, and queue peaks.
- Desync, reconnect, compression-decline, and compression-failure counts.
- Acknowledgement frames per output frame.

Run each case long enough to include idle periods and reconnect/replay. Store
only aggregate measurements and synthetic workload identifiers.

## Phase 3: decide the transport direction

Use the baseline to choose one of three outcomes:

1. Keep `body` as the default if streaming gzip has weak savings or material
   CPU, latency, or memory cost.
2. Recommend opt-in `on` mode for high-bandwidth remote sessions if it produces
   meaningful savings with stable latency and bounded resource use.
3. Prefer the existing terminal WebSocket transport if removing SSE/base64
   overhead captures most of the benefit without compression.

Do not combine a default transport change with a compression-default change.
Each needs its own evidence and rollback.

## Phase 4: optional WebSocket compression experiment

Only run this phase if WebSocket terminal payloads remain a material bandwidth
cost after ACK coalescing and binary framing.

- Prototype server-negotiated `permessage-deflate` behind an explicit setting.
- Use strict concurrency and memory settings and disable context takeover where
  measurements show it is needed to bound retained state.
- Avoid compressing small control, input, resize, and acknowledgement frames.
- Compare message batching thresholds against uncompressed binary frames.
- Include the compressor's retained and queued bytes in the slow-consumer
  budget.
- Verify that negotiation failure falls back to an uncompressed WebSocket or
  HTTP/SSE rather than making the terminal unavailable.

Exit criteria:

- Representative byte reduction outweighs CPU, memory, and latency cost.
- Slow clients cannot monopolize compressor or queue capacity.
- Exact snapshot recovery passes under disconnect and saturation.

## Phase 5: rollout and rollback

- Start with an explicit opt-in setting and expose the selected transport and
  compression mode in aggregate diagnostics.
- Compare opt-in measurements with the Phase 2 baseline.
- Promote a default only after the same workload matrix passes on supported
  desktop platforms and the real remote proxy path.
- Keep `body` mode and HTTP/SSE available as immediate rollback paths.
- Document threshold values, the evidence behind them, and the conditions that
  should trigger rollback.

## Decision record template

For each proposed default change, record:

- Date, build, platform, and remote route.
- Synthetic workload and concurrency.
- Old and new transport/configuration.
- Byte reduction and ACK reduction.
- CPU, retained-memory, first-update, and completion-latency deltas.
- Desync, reconnect, decline, and failure deltas.
- Decision, owner, rollback setting, and follow-up date.

## Definition of done

- Measurements cover direct and proxied streams, normal and constrained
  bandwidth, reconnect/replay, quiet periods, and slow consumers.
- The chosen configuration has explicit resource bounds and tested fallback.
- No correctness or background-rehydration invariant regresses.
- Metrics demonstrate the benefit in encoded or WebSocket-framed bytes rather
  than inferring it from serialized payload size.
- The default changes only when representative results support it.
