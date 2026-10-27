# Remote client bandwidth

Checked against `main` at `2459b05c` (2026-10-15).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`.

### Tasks

1. **Confirm the remote route**: decide which supported route the matrix targets, and whether Tailscale Serve buffers or re-encodes SSE. Status: open.
2. **Baseline matrix**: Phase 2 of `plans/stream-efficience.md` through that route: `body`, `on` and the opt-in terminal WebSocket, at normal and constrained bandwidth, including encoded transcript-patch and multi-client bytes. Status: open (waits on task 1).
3. **`on`-mode streaming check**: prove that SSE gzip streams incrementally, directly and through the proxy, across reconnect, keepalives, idle, disconnect, non-gzip clients, and `Vary` and `Content-Encoding`. Status: open.
4. **Phase 1 exit-criteria audit**: confirm that the owning suites prove no leaked leases, sockets, channels, timers or queued bytes after close, failure, gateway stop and credential rotation. Status: partly done (most cases have tests; not mapped to the criteria).
5. **One default change**: compression mode or terminal transport, decided from task 2's data. Status: blocked (on task 2).
6. **Data-saving preference**: a client-local preference feeding `read-coordinator.ts`, a trial active cadence, wider quiet backoff and the approval budget. Status: open (whether it is still worth adding is undecided).
7. **Hidden terminal subscriptions**: reduce or detach hidden terminal presentation subscriptions where exact recovery exists. Status: deferred (waits on task 2).
8. **WebSocket `permessage-deflate`**: prototype only if task 2 shows large terminal WebSocket payloads. Status: deferred (waits on task 2).
9. **`remote-gateway.md` drift**: the doc omits `off`, the streaming gzip ceiling, the always-`off` control listener and the opt-in terminal WebSocket. Status: open.

### 1. Confirm the remote route

**Problem.** The matrix cannot be trusted until it runs over the route remote users really use. If Tailscale Serve buffers or recompresses SSE, the "proxied" measurement measures Serve rather than Orkestrator.

**Context.** `docs/architecture/remote-gateway.md` supports the Tailscale listener directly and through Serve (`--tailscale-serve`, `:116`), and the hosted client uses Serve. The live outage workload in 0051 and the 0031 batch need the same two-machine setup.

**Investigation.** Nothing has been recorded since `2459b05c`. The gateway's own proxied path (`createSseGzipCompressor`, `apps/backend/src/gateway-proxy.ts:62`) is Orkestrator's federation proxy, not Serve. The two are easy to confuse in the matrix and should be labelled apart.

**Decisions.**

- **Which route is the reference?**
  - **Tailscale Serve, with the direct tailnet listener as the control (recommended).**
    - Pros: Serve is what the hosted client and most remote browsers use; the control isolates Serve's effect.
    - Cons: two runs per cell; Serve behaviour can change with Tailscale versions, so record the version.
  - **The direct tailnet listener only.**
    - Pros: one variable fewer; Orkestrator's own encoding is measured cleanly.
    - Cons: misses buffering or re-encoding on the path most users take.
- **How to detect Serve buffering?**
  - **Timestamp SSE frames at the backend and at the client for a slow, steady synthetic stream (recommended).**
    - Pros: content-free; directly shows held frames; reusable in task 3.
    - Cons: needs clock alignment across two machines, or round-trip measurement from one.
  - **Read Tailscale's documentation and trust it.**
    - Pros: no run.
    - Cons: documentation may not cover `text/event-stream` flushing.

### 2. Baseline matrix

**Problem.** No representative remote measurement exists, so every default change in this file is blocked. Remote and iOS users pay for whatever the defaults are today.

**Context.** The telemetry and bounds shipped in #730. Phase 2 of `plans/stream-efficience.md` (`:71`) defines the matrix. The file says the benefit must be shown in encoded or framed bytes, never inferred from serialised size.

**Investigation.** The levers are unchanged since `2459b05c`. Compression modes are at `apps/backend/src/gateway-support-core.ts:63` and default to `body` (`resolveGatewayCompressionMode`, `:497`); the control listener is forced `off` (`:511`). The streaming ceiling is `MAX_CONCURRENT_STREAMING_COMPRESSIONS = 8` (`:241`), the direct writer is `GzipEventClientWriter` (`gateway-support-extra.ts:673`), and the WebSocket limits are at `terminal-websocket-server.ts:119` and `:121`. The client baseline has moved. Quiet backoff now ships for all six providers: `NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS` (`packages/protocol/src/native-agent-observation.ts:44`) lists Claude and Codex since #1182. The file's "Claude and Codex keep 1,500 ms" is stale. Since 0051, the read coordinator also pauses automatic reads while a transport is disconnected (`setDisconnected`, `apps/web/src/lib/read-coordinator.ts:261`). Both lower idle traffic before any wire work.

**Decisions.**

- **How much of the matrix to run first?**
  - **A reduced first pass: idle and active agent traffic plus one build-output burst, in `body` and `on`, at normal and constrained bandwidth, with one slow client (recommended).**
    - Pros: answers the main question (is SSE gzip worth turning on) cheaply; reuses `recurring-live-ab.ts`-style sampling.
    - Cons: defers the WebSocket and incompressible-output cells.
  - **The full Phase 2 matrix at once.**
    - Pros: one complete decision record.
    - Cons: a large two-machine session with many cells; harder to schedule.
- **How to constrain bandwidth?**
  - **Shape the client side with the browser's network throttling and a host-level shaper on the server side (recommended).**
    - Pros: repeatable, with no extra hardware.
    - Cons: synthetic; misses real cellular jitter.
  - **Use a real metered link (an iOS device on cellular).**
    - Pros: realistic.
    - Cons: not repeatable; conditions vary between runs.

### 3. `on`-mode streaming check

**Problem.** If SSE gzip buffered until a large chunk or the stream end, approvals and completions would arrive late in `on` mode, breaking the acceptance criterion that compression never delays them.

**Context.** Both writers flush synchronously, by design. The check covers direct `/events` and proxied streams.

**Investigation.** Deterministic tests already cover parts of this: `apps/backend/tests/gateway-support-extra.test.ts:674` ("bounds streaming compression contexts and records byte outcomes") and `:543` (identity under pool saturation). No test or record observes a real remote client receiving a gzip SSE frame promptly.

**Decisions.**

- **Where to prove it?**
  - **A deterministic gateway test that reads a gzip SSE response frame by frame and asserts each event decodes before the next is written, then one confirming live run through task 1's route (recommended).**
    - Pros: guards against regressions in CI; the live run catches proxy effects.
    - Cons: the test needs a streaming decompressor harness.
  - **Live only, as part of task 2.**
    - Pros: no new test code.
    - Cons: no regression guard; a later change to the writer could reintroduce buffering unnoticed.

### 4. Phase 1 exit-criteria audit

**Problem.** The file lists this as needing verification, so it is not yet established that the wire paths leak nothing under failure.

**Context.** Phase 1's exit criteria (`plans/stream-efficience.md:54`): no lost or duplicated terminal bytes, no leaked leases, sockets, channels, timers or queued bytes, and `body` and HTTP/SSE unchanged.

**Investigation.** Most cases already have owners in `apps/backend/tests/gateway-events.test.ts`: socket and subscription bounds (`:189`, `:251`), telemetry (`:271`), desync (`:466`), credential rotation and shutdown closing sockets (`:770`), connecting-gauge release (`:2033`, `:3096`). Compressor-pool bounds are in `gateway-support-extra.test.ts:577` and `:674`. Not found: a test asserting the streaming compressor count and queued bytes return to zero after credential rotation or gateway stop.

**Decisions.**

- **How to close it?**
  - **Map each criterion to its owning test in this file, and add the one missing gauges-to-zero assertion (recommended).**
    - Pros: cheap; turns "needs verification" into evidence; no live run.
    - Cons: a small new test in a large suite.
  - **Rerun the suites and record a pass.**
    - Pros: no code.
    - Cons: a pass does not show that each criterion is asserted.

### 5. One default change

**Problem.** Remote users may be paying for uncompressed SSE or base64 terminal frames, but changing a default blind could cost latency or CPU for every user.

**Context.** Code item 1 says one default per decision, recorded with the staged plan's template. The open question asks which one, if any.

**Investigation.** Both defaults are unchanged: `body` compression, and the terminal WebSocket only when `terminalTransport` or `orkestrator-terminal-transport` (`apps/web/src/lib/native/web-gateway.ts:50`) selects it.

**Decisions.**

- **Which default to consider first?**
  - **Compression mode (`body` to `on` for browser listeners) (recommended).**
    - Pros: server-side only and reversible by flag; `body` stays as rollback; affects every SSE stream.
    - Cons: CPU per stream, and the 8-context ceiling means a busy host falls back to identity anyway.
  - **Terminal transport (SSE to WebSocket).**
    - Pros: removes base64 and SSE framing overhead for terminals, likely the largest byte source in builds.
    - Cons: a larger behavioural change (reconnect, recovery, proxies that block WebSockets); terminal-only.
  - **Neither, if the baseline shows remote traffic is already small after quiet backoff.**
    - Pros: no risk.
    - Cons: leaves any measured saving unused.

### 6. Data-saving preference

**Problem.** Remote and metered clients cannot reduce their own demand, and any reduction today would have to change shared cadences.

**Context.** Code items 2 to 4 and the first and third open questions. The preference must affect only the requesting client, never a shared backend's cadence. Approvals and completions must stay inside a chosen budget (recurring-work's 2 s and 3 s p95 are suggested).

**Investigation.** There is no data-saving preference anywhere in `apps/web/src` (no `dataSaving` or similar identifier). The candidate homes exist: the `persist` store in `apps/web/src/stores/uiStore.ts:134` and `apps/web/src/components/settings/machines/ClientOptions.tsx`. The candidate reads are unchanged: active 500 ms and idle 1,500 ms (`apps/web/src/lib/native-session-read-policy.ts:14`, `:15`), Files panel 5 s (`apps/web/src/hooks/useFilesPanel.ts:25`) and reviewer tab 4 s (`apps/web/src/components/review/MultiReviewReviewerTab.tsx:60`). Because idle backoff now covers all six providers (task 2), the idle saving this preference was meant to add mostly exists already. What is left is active cadence and the non-agent reads.

**Decisions.**

- **Is the preference still worth adding?**
  - **Defer it until task 2 shows how much active-turn and Files/reviewer traffic remains (recommended).**
    - Pros: avoids a user-facing setting for a saving that may now be small; the measurement is already required.
    - Cons: metered users wait longer for any control.
  - **Build it now behind a client setting.**
    - Pros: gives remote users control immediately; client-local, so low risk to others.
    - Cons: adds a setting and scheduling input that may prove unnecessary; still needs its own measurement.
  - **Drop it, and extend quiet backoff to the Files panel and reviewer tab for everyone instead.**
    - Pros: no setting; benefits every client.
    - Cons: changes shared behaviour, so it needs freshness evidence for every user, not just remote ones.
- **Which budget applies under the preference?**
  - **Recurring-work's budgets (approval visible within 2 s p95, completion within 3 s) unchanged (recommended).**
    - Pros: one budget everywhere; data saving never makes approvals feel slower.
    - Cons: limits how far the active cadence can stretch.
  - **A relaxed budget (for example, 5 s) under data saving.**
    - Pros: larger savings.
    - Cons: a user who opted into saving data did not opt into slower approvals.

### 7. Hidden terminal subscriptions

**Problem.** Hidden terminals may keep streaming presentation output to a client that is not showing it.

**Context.** Code item 5, allowed only where exact snapshot recovery exists. Unsubscribing never stops the process.

**Investigation.** `apps/web/src/components/terminal/TerminalContainer.view.tsx` still exists. No hidden-detach behaviour has been added since `2459b05c`. Terminal recovery under backpressure is also still unproved live (0051).

**Decisions.**

- **When to do it?**
  - **After task 2 measures hidden-terminal bytes and 0051 proves recovery under backpressure (recommended).**
    - Pros: acts only on a measured cost, with recovery shown first.
    - Cons: no saving until both land.
  - **Now, for terminals hidden longer than a threshold.**
    - Pros: a likely saving for users with many terminals.
    - Cons: risks a visible recovery jump on return before recovery is proved live.

### 8. WebSocket `permessage-deflate`

**Problem.** Terminal WebSocket frames are uncompressed, which matters only if they turn out to be large on remote links.

**Context.** Code item 6. Behind an explicit setting, bounded, and with fallback.

**Investigation.** The backend pins `ws` 8.22.0 (`apps/backend/package.json:35`). No compression option is set on the terminal WebSocket server. The terminal WebSocket is still opt-in, so few users would be affected either way.

**Decisions.**

- **Keep or retire the item?**
  - **Keep it deferred, conditional on task 2 and on task 5 choosing the WebSocket transport (recommended).**
    - Pros: does no work for an opt-in path until it might become a default.
    - Cons: the item lingers.
  - **Retire it now and reopen it in a new file if task 2 shows a need.**
    - Pros: a shorter file.
    - Cons: loses the constraints already written (context takeover, small frames, fallback).

### 9. `remote-gateway.md` drift

**Problem.** The living doc misstates the compression flag's values and omits the opt-in terminal transport, which misleads anyone configuring a remote client.

**Context.** Listed under Related as living-doc drift.

**Investigation.** Still stale: `docs/architecture/remote-gateway.md:119` says "`body` (default) or `on`". It omits `off`, the 8-context streaming ceiling, the always-`off` control listener, and `orkestrator-terminal-transport`.

**Decisions.**

- **When to fix it?**
  - **Now, as a docs-only change (recommended).**
    - Pros: accurate today; needs only `mise run format:check`.
    - Cons: may need another touch if task 5 changes a default.
  - **With task 5.**
    - Pros: one edit.
    - Cons: the doc stays wrong for as long as the measurement takes.

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
   `apps/web/src/components/settings/machines/ClientOptions.tsx`; confirm before
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
