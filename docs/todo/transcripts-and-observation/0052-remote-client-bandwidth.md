# Remote client bandwidth

Checked against `main` at `2459b05c` (2026-10-15).

Remote and constrained clients (a browser over the tailnet, the hosted web
client, iOS) pay for every byte and request the backend sends them. Two
independent levers share one measurement baseline: wire encoding (gzip and
terminal transport choice) and client read scheduling (an optional data-saving
mode). Neither may trade away incremental delivery, exact terminal recovery or
responsive approvals. The telemetry and resource bounds shipped in #730, but no
representative remote measurement has been taken, so no default should change
yet.

## Current state

- Gateway compression modes are `off`, `body` and `on`
  (`GATEWAY_COMPRESSION_MODES` in `apps/backend/src/gateway-support-core.ts`),
  set by `--compression` or `ORKESTRATOR_GATEWAY_COMPRESSION`
  (`apps/backend/src/options.ts`). `resolveGatewayCompressionMode` defaults to
  `body`: eligible ordinary responses are compressed and SSE is not. The
  control listener is always `off` (`compressionModeForListener`).
- SSE gzip runs only in `on` mode. Direct `/events` streams use
  `GzipEventClientWriter` (`gateway-support-extra.ts`, wired in
  `gateway-handlers.ts`); proxied streams use `createSseGzipCompressor`
  (`gateway-proxy.ts`). Both flush synchronously. Streaming gzip contexts share
  a ceiling of `MAX_CONCURRENT_STREAMING_COMPRESSIONS` (8); when it is full the
  stream continues with identity encoding. The direct writer counts its input,
  compressor and response backlog in slow-consumer accounting.
- Gateway metrics separate serialised/source bytes from encoded SSE bytes, and
  report streaming gzip totals, terminal WebSocket payload bytes, framed bytes,
  ACKs, queue peaks, desyncs and lifecycle counts.
- Terminal WebSocket transport (`TerminalWebSocketGateway`,
  `apps/backend/src/terminal-websocket-server.ts`) has process-wide socket and
  channel limits (`TERMINAL_WEBSOCKET_MAX_SOCKETS`,
  `TERMINAL_WEBSOCKET_MAX_CHANNELS`) and a per-socket channel limit. It sets no
  WebSocket message compression, and HTTP body or SSE compression does not
  touch its binary frames. The browser uses it only when the `terminalTransport`
  option or the `orkestrator-terminal-transport` localStorage key
  (`TERMINAL_TRANSPORT_STORAGE_KEY`, `apps/web/src/lib/native/web-gateway.ts`)
  selects `websocket`; otherwise terminals use HTTP/SSE. Output ACKs are
  cumulative, coalesced for a short bounded interval (`acknowledgementDelayMs`
  in `terminal-websocket-client.ts`) and flushed before unsubscribe or recovery.
- Client reads go through `apps/web/src/lib/read-coordinator.ts` and
  `useCoordinatedRead`: one timer per read key, joined in-flight reads, one
  dirty trailing read, automatic reads paused while the document is hidden,
  and one coalesced, critical-first reconcile on return.
- Native session views (`apps/web/src/lib/native-session-read-policy.ts`)
  refresh every 500 ms in running, blocked, cancelling and recovering phases
  and every 1,500 ms when idle. Idle views do not stay at 1,500 ms for every
  provider: quiet backoff through 3, 5, 10 and 15 s
  (`NATIVE_QUIET_BACKOFF_TRIAL_MS`) already ships for Cursor, Pi, Grok and
  OpenCode (`NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS`) against backends that
  advertise observation events. Any invalidation, phase change or visible
  reconcile returns the view to 1,500 ms. Claude and Codex keep 1,500 ms.
- Other coordinated reads: the open Files panel every 5 s
  (`AUTO_REFRESH_INTERVAL`, `useFilesPanel.ts`) and an active reviewer tab every
  4 s (`REFRESH_INTERVAL_MS`, `MultiReviewReviewerTab.tsx`).
- The backend's activity sweep reads HTTP bridges through
  `POST /sessions/activity` in chunks of at most 64 ids
  (`packages/protocol/src/session-activity-batch.ts`); older bridges fall back
  to single no-touch reads.
- There is no data-saving preference in the web client.
- The staged measurement and rollout plan, with its decision-record template,
  is [`plans/stream-efficience.md`](../../../plans/stream-efficience.md) at the
  repository root.

## Outstanding work

### Qualification

Measure first; nothing has been measured since #730. Use isolated profiles
(`../development/agent-testing.md`) and `mise run test:logged` for
validation.

- Build the baseline matrix from the staged plan's Phase 2 through the
  supported remote route (see "Needs verification") at normal and constrained
  bandwidth, with synthetic output, several healthy clients and one slow
  client.
  - Workloads: quiet terminal with keepalives, interactive bursts, redundant
    build output, incompressible output, one to the maximum admitted streams,
    and agent event traffic with and without terminal output.
  - Compare HTTP/SSE in `body`, HTTP/SSE in `on`, and the opt-in terminal
    WebSocket without message compression.
  - Record source, encoded and WebSocket-framed bytes; bytes per minute; p50
    and p95 first-update and completion latency; backend CPU and retained
    memory; active and peak compressors; queue peaks; desync, reconnect,
    decline and failure counts; ACK frames per output frame.
- Check that `on` mode streams incrementally rather than buffering until a
  large chunk or stream end. Cover direct `/events` and proxied streams,
  reconnect and replay, empty keepalives, long idle periods, disconnect during
  compression, clients that do not negotiate gzip, and `Vary` and
  `Content-Encoding` behaviour.
- Measure terminal HTTP/SSE and the opt-in WebSocket separately. Decide
  whether removing SSE/base64 overhead already meets the bandwidth target
  before any WebSocket compression work.
- Measure encoded bytes of negotiated transcript part patches and of several
  remote clients on one session (only decoded bytes were measured).
- For data-saving mode, measure bytes and request counts against today's
  baseline, which already includes quiet backoff for four providers.

### Code

Each item is optional and waits for the measurements above. Record every
default change with the staged plan's decision-record template.

1. Change at most one default per decision: compression mode or terminal
   transport, never both together.
2. Add a client-local data-saving preference. It changes only the requesting
   client's demand and never a shared backend's cadence. Persist it with the
   existing client settings (candidates: the zustand `persist` store in
   `apps/web/src/stores/uiStore.ts`, UI in
   `apps/web/src/components/settings/ConnectionsSettings.tsx`; confirm before
   editing). Feed it to `read-coordinator.ts` as one more scheduling input, not
   new per-feature timers. Network hints are optional and may be absent or
   wrong about metered access.
3. Under that preference, trial a 1 s active native cadence and extend quiet
   backoff to other coordinated reads (Files panel, reviewer tab). These are
   experiment values. Reset on user action, a relevant invalidation, reconnect
   or return to visibility.
4. Keep approvals, completion, errors, queue and dispatch controls, and safety
   state responsive through invalidations. Use small status and interaction
   reads; never fetch history just to keep an activity indicator current.
5. Reduce or detach hidden terminal presentation subscriptions
   (`apps/web/src/components/terminal/TerminalContainer.view.tsx`) only where
   exact snapshot recovery exists. Unsubscribing never stops the terminal or
   agent process.
6. Only if Phase 2 shows large terminal WebSocket payloads remain: prototype
   negotiated `permessage-deflate` behind an explicit setting, with strict
   concurrency and memory bounds, context takeover disabled where needed, no
   compression of small control, input, resize and ACK frames, and fallback to
   an uncompressed WebSocket or HTTP/SSE when negotiation fails. Read the
   current `ws` documentation through Context7 first; the library's
   [compression guidance](https://github.com/websockets/ws#websocket-compression)
   covers its CPU and memory cost.

### Acceptance criteria

- Compression never delays an approval or completion event indefinitely,
  loses authoritative state, or encodes twice.
- Unsupported negotiation and codec failures have tested, bounded behaviour.
- Terminal output matches the exact snapshot after backpressure and reconnect.
- `body` mode and HTTP/SSE stay available as rollback during any opt-in trial.
- The data-saving preference affects only the requesting client; two clients
  with different preferences keep their own freshness.
- Returning or reconnecting restores exact state, including pending approvals,
  errors, queued prompts and parked dispatch controls.
- Offline periods and missed invalidations recover through authoritative reads
  with bounded retries and no prompt resubmission.
- Idle and active bytes and requests improve measurably against the baseline
  with the mode off.
- Completion and approval visibility stay within an explicitly chosen budget,
  reported as p50 and p95.
- Isolated browser QA covers backgrounding, screen lock and resume, tab
  switches, two clients with different preferences, reload, and throttled or
  disconnected links.
- Metrics and artifacts hold no terminal content, prompts, credentials,
  attachment data or file contents.

## Constraints and rationale

- The staged plan's invariants hold for every experiment: snapshots stay
  authoritative, missed terminal output produces a desync and exact snapshot
  recovery, authoritative events are never silently dropped, terminal output
  is dropped only at a bounded backpressure threshold, every buffer, socket,
  channel and compressor is bounded, and reconnect, replay, generation and
  revision ordering are unchanged.
- Compression and browser work never block a provider or app-server stdout
  loop. Compressor buffers count against existing slow-consumer limits rather
  than moving backpressure onto the provider's reader.
- Reducing repeated source work comes before tuning wire size.
- Benefit is shown in encoded or WebSocket-framed bytes, not inferred from
  serialised payload size.
- Keep a recovery poll until a provider's event coverage is demonstrated. An
  event-only design is an experiment, not a replacement.
- One client's preference never changes a shared backend's cadence for other
  clients.
- This work authorises no production configuration change on its own.

## Open questions

- Is a user-facing data-saving preference still worth adding now that quiet
  idle backoff ships for four providers?
- Which default, if any, should change: compression mode or terminal
  transport?
- Which approval and completion budget applies under data-saving mode? The
  recurring-work budgets (approval visible within 2 s p95, turn completion
  within 3 s) in
  [recurring-work.md](../../architecture/recurring-work.md#latency-budgets)
  are the natural starting point.

## Needs verification

- The remote route the matrix should target. `../architecture/remote-gateway.md`
  supports the Tailscale listener directly and through Tailscale Serve (HTTPS,
  used by the hosted client). Confirm whether Serve buffers or re-encodes SSE
  before treating it as the proxied case.
- Whether the staged plan's Phase 1 exit criteria (no leaked compressor
  leases, sockets, channels, timers or queued bytes after close, failure,
  gateway stop and credential rotation) are fully covered by the owning
  gateway and terminal WebSocket suites.

## Related

- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md):
  qualifying Claude and Codex for quiet backoff.
- [0051-client-reconnect-and-freshness.md](0051-client-reconnect-and-freshness.md):
  transport disconnect signals and jittered reconnect.
- [0050-transcript-history-efficiency.md](0050-transcript-history-efficiency.md): source
  work and decoded byte reductions.
- [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md): latency
  budgets and live client QA.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md):
  shared prerequisites for remote and iOS runs.
- `../architecture/event-snapshot-recovery.md` (read coordinator, quiet
  backoff contract).
- Living-doc drift to fix:
  - `../architecture/remote-gateway.md` lists `--compression` as "`body`
    (default) or `on`", omitting `off`. It does not mention the streaming gzip
    ceiling, that the control listener never compresses, or the opt-in
    terminal WebSocket transport and its localStorage key.

## Replaces

- `docs/todo/remote-stream-compression.md` (all)
- `docs/todo/remote-client-data-saving-mode.md` (all; its claim that visible
  idle reads stay at 1,500 ms is corrected above)
- `docs/improvements/efficiency/README.md` (compression and data-saving
  guidance)
- `docs/improvements/efficiency/frontend-and-workflows.md` (E11 and the remote
  gateway row of "Areas inspected")
- `docs/improvements/efficiency/validation.md` (remote-path rows)
- `docs/improvements/efficiency/plan/01-baselines-and-instrumentation.md`
  (remote baseline row)
- `docs/improvements/efficiency/plan/14-part-level-deltas.md` (encoded and
  multi-client bytes)
- `docs/improvements/efficiency/plan/17-read-scheduling-and-activity.md`
  (scheduling shipped; preference and backoff left)
- `docs/improvements/efficiency/plan/19-integration-and-rollout.md` (remote
  proxy and compression rows)
- `docs/improvements/recurring-processes/plan/00-index.md` (data-saving
  deferral and the compression relationship)
- `docs/improvements/recurring-processes/plan/06-client-read-coordination.md`
  (task 9, the data-saving preference)
