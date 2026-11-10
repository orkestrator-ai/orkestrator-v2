# Remote client bandwidth

Checked against `main` at `0bd214ee` (2026-11-01) for tasks 1, 2, 3, 5, 6 and 9,
and at `cbe0f9a5b` (2026-11-05) for task 8; the other tasks were last checked at
`863b5782` (2026-10-27).

## Task analysis

Analysed 2026-10-27 against `main` at `863b5782`; tasks 1, 3 and 9 updated
2026-11-01.

### Tasks

1. **Confirm the remote route**: decide which supported route the matrix targets, and whether Tailscale Serve buffers or re-encodes SSE. Status: done (route decided; the live run on 2026-11-01 found no buffering or re-encoding, see "Live probe" under Measurements).
2. **Baseline matrix**: Phase 2 of `plans/stream-efficience.md` on one host: `body`, `on` and the opt-in terminal WebSocket against a real gateway on a `dev:test` profile with a loopback fake model, at normal and client-throttled bandwidth, including encoded transcript-patch and multi-client bytes. Status: open (no longer blocks the compression default, see D14; it still decides the terminal transport and the wider-matrix questions; the same matrix through Tailscale Serve from a second machine moved to 7568 on 2026-11-10).
3. **`on`-mode streaming check**: prove that SSE gzip streams incrementally, directly and through the proxy, across reconnect, keepalives, idle, disconnect, non-gzip clients, and `Vary` and `Content-Encoding`. Status: done (proved directly, through test proxies, in real browsers and through real Serve; two proxied-stream bugs fixed).
4. **Phase 1 exit-criteria audit**: confirm that the owning suites prove no leaked leases, sockets, channels, timers or queued bytes after close, failure, gateway stop and credential rotation. Status: done (2026-11-03: every criterion mapped to its owning test, and the missing gauges-to-zero test after rotation and stop added; one gap found and filed as 3900).
5. **One default change**: compression mode or terminal transport. Status: done for compression (`on` since 2026-11-01, D14); terminal transport unchanged.
6. **Data-saving preference**: a client-local preference feeding `read-coordinator.ts`, a trial active cadence, wider quiet backoff and the approval budget. Status: built, and left as it is (see task 6's recommendation); its real-browser byte measurement (Playwright on one host, mode off and on, approval and completion p50/p95) is owed with task 2.
7. **Hidden terminal subscriptions**: reduce or detach hidden terminal presentation subscriptions where exact recovery exists. Status: deferred (waits on task 2, and on live recovery over a real link, 7568: 0048 task 16).
8. **WebSocket `permessage-deflate`**: prototype only if task 2 shows large terminal WebSocket payloads and task 5 makes the WebSocket the terminal transport. Status: deferred (waits on tasks 2 and 5; re-checked 2026-11-05, the WebSocket is still opt-in, and the Bun check D6 asked for is done).
9. **`remote-gateway.md` drift**: the doc omits `off`, the streaming gzip ceiling, the always-`off` control listener and the opt-in terminal WebSocket. Status: done.

### 1. Confirm the remote route

**Problem.** The matrix cannot be trusted until it runs over the route remote users really use. If Tailscale Serve buffers or recompresses SSE, the "proxied" measurement measures Serve rather than Orkestrator.

**Context.** `docs/architecture/remote-gateway.md` supports the Tailscale listener directly and through Serve (`--tailscale-serve`, `:116`), and the hosted client uses Serve. The live outage workload in 0051 and the 0031 batch need the same two-machine setup.

**Investigation.** The gateway's own proxied path (`createSseGzipCompressor`, `apps/backend/src/gateway-proxy.ts`) is Orkestrator's federation proxy, not Serve. The two are easy to confuse in the matrix and should be labelled apart.

Read on 2026-11-01 from Tailscale's source at v1.102.4 (the version on this machine; `ipn/ipnlocal/serve.go`) and Go's `net/http`. Nothing here was measured on a tailnet.

- Serve's handler is a plain `httputil.ReverseProxy` with only `Rewrite` and `Transport` set. Go's `flushInterval` returns "immediately" for `text/event-stream`, so Serve should not hold a frame, whatever the `FlushInterval`.
- `serve.go` never touches `Accept-Encoding`, `Content-Encoding` or gzip, so Serve should not re-encode a body. Tailscale's own Serve documentation says nothing about either point.
- The Serve listener's `http.Server` sets no `WriteTimeout`, `ReadTimeout` or `IdleTimeout`, so nothing there should end a quiet stream.
- `fixLocationHeaderResponseWriter`, which hides `Flush`, wraps directory serving only, not the proxy branch.
- **A real difference:** the transport leaves `DisableCompression` off. A request with **no** `Accept-Encoding` gets `gzip` added by Go and is decoded again on the way back. So through Serve, such a client takes a streaming gzip context and still receives identity, with no `Content-Encoding`. Browsers always send the header and an explicit `identity` is left alone, so this only touches non-browser clients. A matrix run must send a browser's header: `curl` without `--compressed` measures something else.

The live half stays open because it needs a Serve handler on a tailnet node, and this work must not change this machine's Tailscale setup. Steps are under "Live run through Tailscale Serve".

**Decisions.**

- **Which route is the reference?** Decided 2026-11-01: Serve, with the direct listener as the control.
  - **Tailscale Serve, with the direct tailnet listener as the control (recommended).**
    - Pros: Serve is what the hosted client and most remote browsers use; the control isolates Serve's effect.
    - Cons: two runs per cell; Serve behaviour can change with Tailscale versions, so record the version.
  - **The direct tailnet listener only.**
    - Pros: one variable fewer; Orkestrator's own encoding is measured cleanly.
    - Cons: misses buffering or re-encoding on the path most users take.
- **How to detect Serve buffering?** Decided 2026-11-01: timestamped frames, in `apps/backend/scripts/sse-route-probe.ts`. It needs no clock alignment, because delay is measured against the fastest tick of the run, which cancels the clocks' offset. It also compares the bytes the client read with the bytes the gateway encoded, which is what catches re-encoding.
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

**Scope (2026-11-10).** This task is the single-host part of the matrix: a
real gateway on a `dev:test` profile, a loopback fake model, Playwright
clients with network throttling, and `remote-bandwidth-baseline.ts` for the
synthetic cells, recording encoded transcript-patch bytes, several clients on
one session and task 6's data-saving bytes. The 2026-11-01 probe showed Serve
neither holds nor re-encodes gzip SSE, so these cells stand for the route's
bytes. The same matrix through Tailscale Serve from a second tailnet machine,
with a browser through Serve, needs two real machines and moved to the
[manual-test checklist](../manual-test/7568-manual-test-checklist.md).

### 3. `on`-mode streaming check

**Problem.** If SSE gzip buffered until a large chunk or the stream end, approvals and completions would arrive late in `on` mode, breaking the acceptance criterion that compression never delays them.

**Context.** Both writers flush synchronously, by design. The check covers direct `/events` and proxied streams.

**Investigation.** Before this work, `gateway-streaming-compression.test.ts` covered most of the direct cases. It did not cover `gateway.keepalive` under gzip (added in #1499), any hop between gateway and client, or a proxied stream beyond flushing, and no real client had been observed.

`apps/backend/tests/gateway-sse-gzip-routes.test.ts` now covers each case below for direct `/events` and for proxied streams, each one directly, through an HTTP/1.1 test proxy and through an HTTP/2 test proxy (Serve's browser hop). Every frame is proved in lockstep: the next is not written until this one has decoded, whole, and the wire bytes end on a sync flush, so the proof rests on no timing assumption.

| Case | Direct `/events` | Proxied stream |
| --- | --- | --- |
| Incremental, including a frame larger than the compressor's chunk | Yes | Yes |
| Terminal-only stream | Yes | n/a |
| Keepalive comments and idle | Yes | Yes |
| `gateway.keepalive` at connect and on each tick | Yes | Forwarded and flushed |
| Reconnect | `Last-Event-ID` and `since`: replay, no duplicate, new gzip stream | Cursor reaches upstream, new gzip stream |
| Disconnect | Idle and mid-burst: compressor released, no failure | Upstream closed, compressor released |
| Non-gzip clients (none, `identity`, `gzip;q=0`, `br`) | Identity, flushed, no compressor | Identity, no compressor |
| `Content-Encoding` and `Vary` | `gzip` once, `Vary: Accept-Encoding`, `no-transform` | `gzip` once, `Vary: Accept-Encoding`; upstream cache-control is preserved, not augmented with `no-transform`. A `no-transform` or already coded upstream is untouched |
| `off`, `body`, control listener | Identity, no `Vary` | n/a |

Negative controls show the checks can fail: a hop that holds bytes and an encoder that does not sync-flush are both caught. Seven deliberate breaks were also caught on 2026-11-01: no sync flush in each writer, no `gateway.keepalive` at connect, comment-only ticks, `Vary` only when gzipping, and each of the two bugs below restored.

`e2e/SseGzipStreaming.spec.ts` runs a browser's own decoder in lockstep against a real gateway, through both `EventSource` (including `gateway.keepalive`) and a fetch reader. It passed on Chromium, Firefox and WebKit on 2026-11-01, over loopback HTTP/1.1. The compressor count shows that `EventSource` negotiates gzip too.

Direct streams were already right. The checks found two bugs in proxied streams, both fixed with regression tests:

- **A proxied gzip stream that ended cleanly had no gzip trailer.** `createSseGzipCompressor` set `finishFlush: Z_SYNC_FLUSH`, so a strict decoder failed the whole response at the end. Bun's `fetch` threw `ZlibError` and lost the body.
- **A quiet proxied stream held back its response headers until the first frame,** in both gzip and identity. A client could not tell an open stream from a dead link. Proxied event streams now flush their headers at once.

**Decisions.**

- **Where to prove it?** Decided 2026-11-01: as recommended. The test is in; the live run is task 1's.
  - **A deterministic gateway test that reads a gzip SSE response frame by frame and asserts each event decodes before the next is written, then one confirming live run through task 1's route (recommended).**
    - Pros: guards against regressions in CI; the live run catches proxy effects.
    - Cons: the test needs a streaming decompressor harness.
  - **Live only, as part of task 2.**
    - Pros: no new test code.
    - Cons: no regression guard; a later change to the writer could reintroduce buffering unnoticed.

### 4. Phase 1 exit-criteria audit

**Problem.** The file lists this as needing verification, so it is not yet established that the wire paths leak nothing under failure.

**Context.** Phase 1's exit criteria (`plans/stream-efficience.md:65`): no lost or duplicated terminal bytes across reconnect and desync recovery; no leaked compressor leases, sockets, channels, timers or queued bytes; and `body` mode and the HTTP/SSE fallback unchanged. Its checklist (`:59`, `:62`) also asks for compressor failure, disconnect, pool, socket and channel saturation to be exercised, and for every gauge to return to zero after close, failure, gateway stop and credential rotation.

**Investigation.** Checked 2026-11-03 against `main` at `7b48c23f`. The mapping below names each owning test by its title, because line numbers in these suites move with every change. Paths are under `apps/backend/tests/` unless given in full.

Before this work, compressor release after rotation and stop was asserted (`gateway-streaming-compression.test.ts`, "credential rotation and gateway stop release every compressor lease"), and so were sockets closing on both ("closes active sockets on credential rotation and gateway shutdown"). No test showed that queued bytes, channels, the operation queue, per-socket timers or the keepalive interval were released at the same points. `gateway-events.test.ts` now has "returns compressor count and queued bytes to zero after credential rotation and gateway stop". Before each revocation, that test puts real bytes on every queue the gateway owns:

- a gzip SSE writer whose compressor is corked, so its input stays pending;
- terminal output in a channel queue (held by the scheduler latch across asynchronous token persistence and stop; an event-loop turn confirms it stays queued);
- a terminal write the backend has accepted but not finished;
- a second socket still waiting to authenticate, with its timer armed.

Each revocation must then leave every gauge at zero: compressor leases, event clients and their queued bytes, open and connecting streams, proxy requests, terminal sockets, upgrades and channels (state and metrics), queued terminal bytes, and the operation count, bytes and sessions. The per-socket authentication, credential-expiry and close timers must be cleared on the socket states the test held, and after stop the keepalive interval must be cleared too. The original test passed 25 consecutive runs. Review found that token persistence could yield to a normal terminal flush before rotation. The corrected test holds the flush scheduler latch, confirms real bytes remain after an event-loop turn, and passes the full gateway-events owner file. A rotation-specific negative control that removed the disposal byte reset failed with 8,208 retained bytes. Two original deliberate breaks made it fail: keeping a terminal socket's queued bytes on dispose, and not destroying event clients on rotation.

The operation queue is the exception, and the test pins it. A terminal write the backend has already accepted is not cancelled by revocation: its bytes are released when the backend settles the write, not when the socket goes. That is bounded (`TERMINAL_WEBSOCKET_MAX_PENDING_OPERATION_BYTES`). While checking it, I found that a write queued *behind* that accepted write is also delivered to the backend after the rotation, because revocation does not clear the socket's `authenticated` flag. Filed as 3900.

| Exit criterion | Owning tests |
| --- | --- |
| No lost or duplicated terminal bytes across reconnect | `gateway-events.test.ts`: "multiplexes isolated terminal channels, raw input, resize, and retained replay"; "preserves accepted input order across a socket reconnect"; "answers a stale generation or sequence per channel without closing the socket". `apps/web/src/lib/native/terminal-websocket-client.test.ts`: "owns one socket, multiplexes channels, acknowledges operations, and reconnects cursors"; "ignores a snapshot that predates already-applied output"; "keeps a reconnecting channel unavailable when its snapshot lands before resubscribing"; "clears a delayed acknowledgement on reconnect instead of sending it later" |
| No lost or duplicated terminal bytes across desync recovery | `gateway-events.test.ts`: "escalates repeated unknown channels and reports generation and oversized-output desync"; "reports current, duplicate, unavailable, failed, unsubscribe, and desync subscription paths"; "drops projected soft-limit terminal frames and flushes a desync notice on drain"; "flushes a desync notice to a quiet stream once its socket drains"; "buffers terminal output emitted during an authoritative replay handshake"; "preserves compressed SSE soft-limit recovery and keepalives". `terminal-websocket-client.test.ts`: "bounds output while awaiting a snapshot and resubscribes from the snapshot cursor"; "retries after snapshot failure and recovers a desynchronized channel"; "resubscribes for snapshot recovery when the renderer rejects output" |
| No leaked compressor leases | `gateway-events.test.ts`: "sync-flushes compressed SSE immediately and cleans up its compressor" (close); "destroys a compressed SSE response and clears pending bytes on codec failure" (failure); "falls back to identity when the streaming compression pool is full" (saturation); "returns compressor count and queued bytes to zero after credential rotation and gateway stop" (rotation, stop). `gateway-streaming-compression.test.ts`: "a disconnect in the middle of a burst releases the compressor without a failure"; "credential rotation and gateway stop release every compressor lease". `gateway-sse-gzip-routes.test.ts`: "a client that hangs up on an idle stream gives back its compressor", "a client that hangs up mid-burst gives back its compressor without a failure", and, for proxied streams, "a client that hangs up closes the upstream and gives back the compressor". `gateway-support-extra.test.ts`: "bounds concurrent on-the-fly compression admission without failing requests"; "bounds streaming compression contexts and records byte outcomes" |
| No leaked sockets | `gateway-events.test.ts`: "bounds terminal WebSocket sockets and subscriptions" (socket saturation, gauges back to zero after close); "bounds unauthenticated sockets and accepts a same-origin session cookie"; "releases a socket that never answers the close handshake"; "rejects an upgrade whose request the WebSocket server refuses"; "closes active sockets on credential rotation and gateway shutdown"; the new rotation-and-stop test (terminal sockets, upgrades, event clients, open and connecting stream gauges, proxy requests); "counts a desync recovery frame and keeps the connecting gauge released"; "releases the connecting gauge and unregisters a client that throws mid-handshake" |
| No leaked channels | `gateway-events.test.ts`: "bounds terminal WebSocket sockets and subscriptions" (per-socket and process-wide saturation with `maxChannelsPerSocket: 1`, `maxChannels: 1`); "enforces the exported terminal WebSocket admission defaults without overrides"; "reports terminal WebSocket payload, ACK, queue, and transport telemetry" (`channelsOpen: 0` after close); the new rotation-and-stop test (channel count and `channelsOpen`). `apps/backend/src/remote-bandwidth-baseline.test.ts`: "real gateway supports the 256-channel boundary and rejects overcapacity before allocation" |
| No leaked timers | The new rotation-and-stop test (authentication, credential-expiry and close timers cleared on rotation and stop; the keepalive interval cleared on stop). `gateway-events.test.ts`: "releases a socket that never answers the close handshake" (close timer); "closes a cookie-authenticated terminal socket when its agent-test session expires" (credential-expiry timer); "stops retaining replay payloads once the gateway stops". `terminal-websocket-client.test.ts`: "discards a pending acknowledgement when the socket is no longer open" |
| No leaked queued bytes | The new rotation-and-stop test (SSE writer bytes, terminal channel bytes, operation bytes once the backend settles). `gateway-events.test.ts`: "destroys a compressed SSE response and clears pending bytes on codec failure"; "disconnects a non-reading socket when its aggregate queue reaches the hard limit"; "acknowledges rejected operations and bounds a blocked per-session queue"; "bounds aggregate operation bytes across independently blocked sessions"; "drops a real non-reading incompressible compressed stream at the hard limit"; "disconnects instead of growing the replay-handshake buffer without bound". `gateway-support-extra.test.ts`: "sums pending input, compressor backlog, and response buffer for gzip SSE writers". `remote-bandwidth-baseline.test.ts`: "blocked downstream stays bounded and backpressures the producer" |
| `body` mode unchanged | `gateway-events.test.ts`: "keeps SSE identity in off and body modes"; "compresses eligible invoke bodies above the threshold with Brotli then gzip". `gateway-sse-gzip-routes.test.ts`: "modes that never gzip an event stream" (`off`, `body`) and "the control listener stays identity while the browser listener gzips". `gateway-support-extra.test.ts`: "keeps small dynamic bodies identity while allowing static compression on browser listeners"; "parses gateway compression modes and rejects unknown values" |
| HTTP/SSE fallback unchanged | `gateway-events.test.ts`: "does no per-event work when no terminal socket is attached"; "delivers backend events to authenticated event streams". `terminal-websocket-client.test.ts`: "falls back and retries when socket construction or subscription fails"; "times out missing operation acknowledgements and reconnects through fallback"; "drops a socket on a silent link, falling back and keeping the ladder". `apps/web/src/lib/native/web-gateway.test.ts`: "keeps fallback per channel until its WebSocket snapshot succeeds"; "retains fallback and retries a channel when its snapshot fails"; "does not re-arm a terminal fallback that a ready WebSocket channel retired" |

The checklist's own cases map to the same tests: compressor failure ("destroys a compressed SSE response…"), disconnect ("a disconnect in the middle of a burst…"), pool saturation ("falls back to identity when the streaming compression pool is full"), and socket, per-socket channel and process-wide channel saturation ("bounds terminal WebSocket sockets and subscriptions").

None of this is live evidence. Whether terminal output matches the exact snapshot after backpressure and reconnect on a real remote link is still the acceptance criterion under Outstanding work, and it is owed with 0051.

**Decisions.**

- **How to close it?** Decided 2026-11-03: as recommended.
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

**Recommendation, 2026-11-01.** Stop treating this as undecided. The investigation below is out of date: the preference is already in the tree (`uiStore.dataSaving`, `DataSavingSetting.tsx`, `lib/data-saving-policy.ts`; see "Current state" and decisions D2 to D4). Keep it, off by default, on recurring-work's budgets, and do not widen it or add another setting until task 2 and the real-browser measurement show what it saves. This work's evidence covers only that it exists and has a request budget, not its bytes. Nothing was changed for this task.

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

**Context.** Code item 6. Behind an explicit setting, bounded, and with fallback. This task also owns efficiency finding GW-7, whose report (`docs/reports/efficiency-logging-database/0390-gw-7-websocket-compression.md`) was checked back and deleted on 2026-11-05; its requirements are carried below. The efficiency report's invariants (`git show 413bd6219:docs/reports/2026-10-27-efficiency.md`) apply: every compression buffer has byte and count bounds.

**Investigation.** The backend pins `ws` 8.22.0 (`apps/backend/package.json:35`). No compression option is set on the terminal WebSocket server. The terminal WebSocket is still opt-in, so few users would be affected either way.

Re-checked on 2026-11-05 against `cbe0f9a5b`:

- **The finding still holds.** `TerminalWebSocketGateway` builds its `WebSocketServer` with `noServer`, `maxPayload` and `handleProtocols` only (`apps/backend/src/terminal-websocket-server.ts:220-229`), so no `perMessageDeflate` is set.
- **D6's condition is not met.** A browser uses the WebSocket only when `terminalTransport` or the `orkestrator-terminal-transport` localStorage key says `websocket` (`terminalTransportEnabled`, `apps/web/src/lib/native/web-gateway.ts:177-184`); otherwise `startTerminalEventStream` takes the SSE fallback (`:1304-1307`). The shared terminal stream work (GW-3) put every web client's terminals on one filtered SSE stream (`openSharedTerminalConnection`, `:1116`), not on the WebSocket, and local desktop windows pin `terminalTransport: "http-sse"` (`installLocalDesktopGateway`, `:1671`). Task 2 is still open and task 5 left the terminal transport unchanged, so bulk terminal output still travels as `on`-mode gzip SSE.
- **Bun's `ws` layer (D6's check), done.** Under Bun the bare `ws` import resolves to Bun's built-in module (`Bun.resolveSync("ws", "apps/backend/src")` returns `ws`, not a `node_modules` path), so the 8.22.0 pin is not the code the backend runs; any prototype must be measured under Bun. A loopback probe on Bun 1.4.4 (16 cores), with a `node:http` server handing upgrades to `WebSocketServer({ noServer: true, perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true, serverMaxWindowBits: 10, concurrencyLimit: 2 } })` through `handleUpgrade`, as the gateway does, and a raw RFC 6455 client offering `permessage-deflate; client_max_window_bits`:
  - Negotiation works: the 101 answered `permessage-deflate; server_no_context_takeover; client_no_context_takeover; server_max_window_bits=10`, and `ws.extensions` read `permessage-deflate`.
  - The threshold is honoured: 64 B and 900 B messages went out uncompressed (RSV1 clear, payload unchanged).
  - Frame payloads: synthetic coloured test-runner output 16 KiB to 1,650 B and 64 KiB to 6,159 B (about 10 times, on repetitive text, so an upper bound); 64 KiB of random bytes grew to 66,182 B (1 % larger).
  - CPU, 1,000 messages (200 of each of the five sizes, 29.7 MB of source): 911 to 993 ms of send CPU with deflate against 37 to 57 ms without, three runs each, so roughly 30 ms of extra CPU per MB sent. Wire bytes were 15.0 MB against 29.7 MB, most of the remainder being the random payloads.
  - Not shown: whether Bun's built-in module honours `concurrencyLimit` or bounds per-socket zlib memory; the probe did not measure heap. The probe was a throwaway script under the git-ignored `output/benchmarks/` and was not committed.

**When to start, and what the work must include.** Start only when task 2's baseline shows large terminal WebSocket payloads on the remote route *and* task 5 (or a later decision) makes the WebSocket the terminal transport for remote clients. Then:

1. Set `perMessageDeflate` on `TerminalWebSocketGateway` with a threshold of about 1 KiB, so keystroke echoes and ACKs stay uncompressed, and with `serverNoContextTakeover`/`clientNoContextTakeover` and a small window, so no socket holds a long-lived zlib context.
2. Bound compressor memory by bytes and count across all sockets: show under Bun, with a heap measurement at the socket limit, that per-socket zlib state is released, or add a process-wide ceiling with an uncompressed fallback, as SSE's `MAX_CONCURRENT_STREAMING_COMPRESSIONS` does.
3. Keep compression off on the control listener, as `compressionModeForListener` does for HTTP, and off when the gateway compression mode is `off`.
4. Measure frame sizes and CPU on loopback and through the remote route with `apps/backend/scripts/remote-bandwidth-baseline.ts` (its raw client must offer the extension), and keep it only if the encoded saving outweighs the CPU.
5. Tests: negotiation, the threshold, a client that offers no extension, backpressure and the 256 KiB flush watermark (GW-6) counted on uncompressed bytes, and the gauges returning to zero after close, credential rotation and stop.
6. A compatibility note: the extension is negotiated, so a client or proxy that does not offer it keeps uncompressed frames; record it in `docs/architecture/remote-gateway.md`.

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

**Investigation.** Done, and mostly before this check. On 2026-11-01 `docs/architecture/remote-gateway.md` already had all four points, each checked against the code: `off` (`GATEWAY_COMPRESSION_MODES`; `allowCompression` and `canTransform` both refuse it), the ceiling of 8 with identity fallback counted as declined (`tryStartStreamingCompression`), the always-`off` control listener (`compressionModeForListener`), and the opt-in terminal WebSocket (`terminalTransport`, `orkestrator-terminal-transport`, limits of 64, 256 and 4,096, no message compression, 50 ms ACKs). One small drift remained and was fixed: it said only direct streams send `Vary`, when proxied streams do too. It now also covers `gateway.keepalive` flushing, untouched proxied upstreams and what is known about Serve.

**Decisions.**

- **When to fix it?** Decided: now, as recommended.
  - **Now, as a docs-only change (recommended).**
    - Pros: accurate today; needs only `mise run format:check`.
    - Cons: may need another touch if task 5 changes a default.
  - **With task 5.**
    - Pros: one edit.
    - Cons: the doc stays wrong for as long as the measurement takes.

Remote and constrained clients (a browser over the tailnet, the hosted web
client, iOS) pay for every byte and request the backend sends them. Two
independent levers share one measurement baseline: wire encoding (gzip and
terminal transport choice) and client read scheduling (the data-saving
preference). Neither may trade away incremental delivery, exact terminal
recovery or responsive approvals.

Done on 2026-10-27: a client-local data-saving preference that slows only the
requesting client's background reads, an in-process baseline harness with a
first matrix (normal and constrained links, several healthy clients and one
slow client), and tests for incremental `on`-mode streaming, encoding
negotiation, replay, keepalives and compressor release. No default changed.

Done on 2026-11-01: the reference route is decided, gzip SSE is proved
incremental directly, through test proxies, in real browsers and through real
Tailscale Serve, two proxied stream bugs are fixed, and the compression default
is `on` (D14).

What is left needs the real remote route: the matrix through the Tailscale
listener and Serve, the data-saving byte
measurement in a real browser, and the browser QA in the acceptance criteria.

## Current state

- Gateway compression modes are `off`, `body` and `on`, defaulting to `on`
  (`GATEWAY_COMPRESSION_MODES` in `apps/backend/src/gateway-support-core.ts`),
  set by `--compression` or `ORKESTRATOR_GATEWAY_COMPRESSION`
  (`apps/backend/src/options.ts`). `resolveGatewayCompressionMode` defaults to
  `on`; `body` compresses only eligible ordinary responses and is the rollback.
  The control listener is always `off` (`compressionModeForListener`).
  `../../architecture/remote-gateway.md` now documents all three modes, the
  streaming ceiling, the control listener and the opt-in terminal WebSocket.
- SSE gzip runs in `on` mode. Direct `/events` streams use
  `GzipEventClientWriter` (`gateway-support-extra.ts`, wired in
  `gateway-handlers.ts`); proxied streams use `createSseGzipCompressor`
  (`gateway-proxy.ts`). Both flush synchronously. Streaming gzip contexts share
  a ceiling of `MAX_CONCURRENT_STREAMING_COMPRESSIONS` (8); when it is full the
  stream continues with identity encoding. A browser holds two event streams
  (main and one shared terminal stream), so four browsers fill the pool.
- `apps/backend/tests/gateway-streaming-compression.test.ts` covers, in `on`
  mode: each small frame flushed while the stream stays open (direct and
  proxied), one encoding only, identity plus `Vary: Accept-Encoding` for
  clients that do not negotiate gzip (none, `identity`, `gzip;q=0`, `br`),
  replay after a compressed reconnect, decodable keepalives over a long idle
  stream, a disconnect mid-burst, and compressor release on credential
  rotation and gateway stop.
- `apps/backend/tests/gateway-sse-gzip-routes.test.ts` runs the wider set in
  task 3 on three routes, and `e2e/SseGzipStreaming.spec.ts` does it in a real
  browser.
- `apps/backend/scripts/sse-route-probe.ts` measures whether a route holds or
  changes a gzip stream. It has no Tailscale dependency.
- Gateway metrics separate serialised/source bytes from encoded SSE bytes, and
  report streaming gzip totals, terminal WebSocket payload bytes, framed bytes,
  ACKs, queue peaks, desyncs and lifecycle counts.
- Terminal WebSocket transport (`TerminalWebSocketGateway`,
  `apps/backend/src/terminal-websocket-server.ts`) is opt-in through the
  `terminalTransport` option or the `orkestrator-terminal-transport`
  localStorage key, has socket and channel limits, and uses no message
  compression. Output ACKs are cumulative and coalesced for 1 s (50 ms until 2026-11-04).
- `apps/backend/scripts/remote-bandwidth-baseline.ts` runs the real gateway in
  process (temporary data directory, ephemeral `127.0.0.1` port, random token
  never printed) against synthetic workloads and reports aggregate bytes,
  latency, CPU, heap and gauges. `--rate-kbps`/`--latency-ms` put each client
  behind a userspace link limiter. See "Measurements" below.
- Client reads go through `apps/web/src/lib/read-coordinator.ts` and
  `useCoordinatedRead`. A resume (visibility, focus, page-show) now restarts
  every quiet backoff: a backed-off key reads at once if its base cadence is
  overdue, otherwise it continues on its base grid.
- Data saving (new): `uiStore.dataSaving`, persisted with the client's UI
  state, toggled in Settings > General (`DataSavingSetting.tsx`) and fed to the
  coordinator by `lib/data-saving.ts` (`setDataSaving`). A read's demand may
  carry a `dataSaving` variant; trial values are in
  `apps/web/src/lib/data-saving-policy.ts`: native running/blocked/cancelling/
  recovering views 1 s (500 ms otherwise), the Files panel backs off through
  10, 15 and 30 s on a watched worktree (10 s on an unwatched target), a
  running reviewer tab backs off through 8, 15 and 30 s. Invalidations,
  explicit refreshes, resume and reconnect are never slowed; announced Files
  revisions, mutations, reviewer checkpoints and status changes call
  `noteActivity()` to restore the base cadence. Idle native views keep their
  existing quiet backoff (all six providers qualify, Claude and Codex only
  while `turn.quietObservation`).
- Only the selected environment's `TerminalContainer` is mounted
  (`App.tsx`); other environments hold no terminal subscriptions. Hidden
  terminals are background tabs of the open environment, and they stay
  subscribed (decision D5).
- The backend's activity sweep reads HTTP bridges through
  `POST /sessions/activity` in chunks of at most 64 ids
  (`packages/protocol/src/session-activity-batch.ts`).
- The staged plan and its decision-record template are
  [`plans/stream-efficience.md`](../../../plans/stream-efficience.md).

## Measurements

### Live probe through Tailscale Serve, 2026-11-01

`sse-route-probe.ts` at `0bd214ee4`. Server node `omarchy-hp` (Linux, Tailscale
1.104.1), client a Mac on the same LAN over a direct tailnet path (Tailscale
1.102.4). Each run sent 30 ticks at 1 s, a 60 s idle gap and one last tick, using
a browser's `Accept-Encoding` unless stated. The node's existing Serve handler on
443 was left alone; the probe used 8443 and removed it afterwards.

| Run | Encoding | Missing / duplicates | Held ticks | Delay p50 / p95 / max ms | Keepalives | Client vs gateway bytes |
| --- | --- | --- | --- | --- | --- | --- |
| Serve, HTTP/2 | gzip | 0 / 0 | 0 | 1 / 2 / 10 | 4 | 941 = 941 |
| Serve, HTTP/1.1 | gzip | 0 / 0 | 0 | 1 / 2 / 64 | 5 | 976 = 976 |
| Direct tailnet (control) | gzip | 0 / 0 | 0 | 2 / 53 / 68 | 4 | 940 = 940 |
| Serve, `identity` | none | 0 / 0 | 0 | 1 / 48 / 53 | 5 | 4,260 = 4,260 |
| Serve, reconnect after tick 10 | gzip | 0 / 0 | 0 | 1 / 35 / 83 | 5 | n/a across two connections |

Findings: Serve neither holds nor re-encodes gzip SSE, a quiet stream survives
the 60 s gap, and a reconnect replays with no loss or duplicate
(`streamingActiveAfterClose` was 0 in every run). This workload is 4.5 times
smaller with gzip. It is a slow synthetic stream on a good link, so it proves
route behaviour, not bandwidth or CPU under load.

### In-process baseline, 2026-10-27

Command: `mise exec -- bun apps/backend/scripts/remote-bandwidth-baseline.ts
--sessions 1,4 --duration-ms 6000 --idle-ms 2000` at `863b5782`, macOS arm64,
Bun 1.4.4, on a machine busy with other builds (CPU figures are noisy and
include the clients, which share the process). Three healthy clients and one
slow client that never reads; keepalive scaled to 5 s (production 25 s);
loopback, no limiter. Bytes are TCP bytes a healthy client read, per minute.
Latency is emit to arrival over every frame; "Missing" counts frames a healthy
client never received.

| Workload | Terminals | Transport | KiB/min per client | Source KiB | Encoded/framed KiB | p50 / p95 ms | CPU ms | Compressors peak | Slow-client desyncs | Missing |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| quiet | 1 | body / on / websocket | 0.3 / 0.4 / 0.1 | 0.1 | 0.1 | n/a | 7 / 11 / 8 | 0 / 8 / 0 | 0 | 0 |
| interactive | 1 | body | 41.5 | 21.2 | 21.2 | 0.3 / 1.6 | 41 | 0 | 0 | 0 |
| interactive | 1 | on | 18.0 | 21.2 | 8.6 | 0.9 / 5.3 | 36 | 8 | 0 | 0 |
| interactive | 1 | websocket | 17.2 | 6.4 | 9.1 | 0.3 / 0.8 | 36 | 0 | 0 | 0 |
| interactive | 4 | body | 163.7 | 83.6 | 83.6 | 0.2 / 0.6 | 31 | 0 | 0 | 0 |
| interactive | 4 | on | 66.9 | 83.6 | 32.0 | 1.6 / 11.3 | 72 | 8 | 0 | 0 |
| interactive | 4 | websocket | 66.7 | 24.6 | 35.6 | 0.2 / 0.6 | 37 | 0 | 0 | 0 |
| build | 1 | body | 3,774 | 2,007 | 2,007 | 0.2 / 0.9 | 95 | 0 | 0 | 0 |
| build | 1 | on | 469 | 2,051 | 244 | 0.6 / 3.5 | 218 | 8 | 0 | 0 |
| build | 1 | websocket | 3,517 | 1,856 | 1,877 | 0.2 / 0.5 | 94 | 0 | 0 | 0 |
| build | 4 | body | 15,259 | 7,903 | 7,903 | 0.2 / 0.6 | 150 | 0 | 115 | 0 |
| build | 4 | on | 1,723 | 8,144 | 893 | 0.6 / 5.6 | 508 | 8 | 0 | 0 |
| build | 4 | websocket | 14,070 | 7,422 | 7,507 | 0.2 / 0.7 | 163 | 0 | 0 | 0 |
| incompressible | 1 | body | 4,352 | 2,313 | 2,313 | 0.2 / 0.5 | 90 | 0 | 0 | 0 |
| incompressible | 1 | on | 3,297 | 2,297 | 1,752 | 0.5 / 4.8 | 261 | 8 | 0 | 0 |
| incompressible | 1 | websocket | 4,163 | 2,200 | 2,222 | 0.2 / 1.5 | 102 | 0 | 0 | 0 |
| incompressible | 4 | body | 17,340 | 8,731 | 8,731 | 0.2 / 0.4 | 129 | 0 | 233 | 0 |
| incompressible | 4 | on | 13,316 | 9,056 | 6,104 | 0.5 / 2.9 | 509 | 8 | 110 | 0 |
| incompressible | 4 | websocket | 16,719 | 8,832 | 8,918 | 0.3 / 0.5 | 174 | 0 | 0 | 0 |
| agent events | 0 | body | 345 | 183 | 183 | 0.2 / 0.5 | 29 | 0 | 0 | 0 |
| agent events | 0 | on | 38.5 | 183 | 19.1 | 0.3 / 1.0 | 36 | 8 | 0 | 0 |
| agent events | 0 | websocket | 340 | 180 | 180 | 0.2 / 0.3 | 23 | 0 | 0 | 0 |
| agent + build | 1 | body | 4,203 | 2,233 | 2,233 | 0.2 / 0.3 | 105 | 0 | 0 | 0 |
| agent + build | 1 | on | 505 | 2,226 | 262 | 0.5 / 4.0 | 220 | 8 | 0 | 0 |
| agent + build | 1 | websocket | 3,941 | 2,079 | 2,101 | 0.2 / 0.5 | 110 | 0 | 0 | 0 |
| agent + build | 4 | body | 15,719 | 8,130 | 8,130 | 0.2 / 0.4 | 138 | 0 | 123 | 0 |
| agent + build | 4 | on | 1,763 | 8,326 | 913 | 0.6 / 5.3 | 492 | 8 | 0 | 0 |
| agent + build | 4 | websocket | 14,727 | 7,768 | 7,855 | 0.2 / 0.4 | 153 | 0 | 0 | 0 |

WebSocket ACK frames per output frame: 0.25 for 50 ms bursts, 0.75 for
interactive bursts. The slow WebSocket client was never desynced within a
case; its queue peaked at 1.1 to 1.5 MiB with four build terminals.

Findings:

- `on` cuts redundant output and agent events 8 to 9 times and random
  printable output about 25 %, for 2 to 3 times the CPU of `body` (clients
  included) and a few ms of extra p95 latency. No frame was buffered or lost.
- Removing SSE and JSON overhead (the WebSocket) matches `on` only for small
  interactive frames; for bulk output it saves about 7 %, so it does not meet
  a bandwidth target on its own.
- Every `on` case ran the compressor pool full: three healthy browsers plus
  the slow one hold eight streams. A fifth browser would get identity.
- A slow SSE client is desynced at the soft limit (the expected recovery
  path); with `on`, compression keeps it under the limit for redundant output.

### Constrained link, 2026-10-27

Same harness and build, `--rate-kbps 512 --latency-ms 40 --idle-ms 3000`: each
client connection behind its own 512 kbit/s, 40 ms userspace limiter.
"Backlog" counts frames still queued behind the link when the case ended
(9 s); no stream was dropped or desynced in any case.

| Workload | Terminals | Transport | KiB/min per client | p50 / p95 ms | Completion ms | Backlog frames |
| --- | --- | --- | --- | --- | --- | --- |
| quiet | 1 | body / on / websocket | 0.2 / 0.3 / 0.2 | n/a | n/a | 0 |
| interactive | 1 | body / on / websocket | 36.9 / 16.0 / 15.4 | ~44 / ~45 all | ~44 | 0 |
| interactive | 4 | body / on / websocket | 145.5 / 59.5 / 59.4 | ~44 / ~44 all | ~43 | 0 |
| agent events | 0 | body / on / websocket | 302 / 33.7 / 307 | ~44 / ~44 all | ~43 | 0 |
| build | 1 | body | 3,466 | 1,211 / 2,230 | 2,332 | 0 |
| build | 1 | on | 415 | 43.5 / 43.9 | 42 | 0 |
| build | 1 | websocket | 3,265 | 963 / 1,720 | 1,878 | 0 |
| build | 4 | body | 3,761 (link full) | 3,614 / 6,950 | not reached | 2,418 |
| build | 4 | on | 1,538 | 44.7 / 51.6 | 54 | 0 |
| build | 4 | websocket | 3,769 (link full) | 3,596 / 6,870 | not reached | 2,349 |
| incompressible | 1 | body | 3,742 | 1,691 / 3,099 | not reached | 45 |
| incompressible | 1 | on | 3,039 | 695 / 1,280 | 1,340 | 0 |
| incompressible | 1 | websocket | 3,750 | 1,577 / 2,892 | not reached | 12 |
| incompressible | 4 | body / on / websocket | ~3,800 each (link full) | ~3,500-3,800 / ~6,900-7,300 | not reached | 2,296-2,544 |

Findings: on a 512 kbit/s link one terminal of build output already saturates
`body` and the WebSocket (seconds of terminal lag), while `on` keeps it at the
link's latency, and four terminals stay under 55 ms p95 only with `on`. Small
interactive frames and quiet streams are latency-bound in every mode.

### Data-saving read budget

`apps/web/src/lib/data-saving-policy.test.ts` runs the coordinator on a fake
clock with the demands the hooks build and counts scheduled reads for ten
quiet, visible minutes (no invalidations):

| View | Off | On | Change |
| --- | --- | --- | --- |
| Running native view | 1,200 | 600 | −50 % |
| Idle qualified native view | 42 | 42 | 0 |
| Files panel, watched worktree | 120 | 22 | −82 % |
| Files panel, unwatched target | 120 | 60 | −50 % |
| Running reviewer tab | 150 | 22 | −85 % |

Each Files panel read is a list and (on All files) a tree request. These are
request counts; bytes per request need a real client (see "Needs
verification").

## Live run through Tailscale Serve

Run on 2026-11-01; the results are under Measurements. Repeat it when Tailscale
or the gateway's stream handling changes. It adds a Serve handler to a tailnet
node, so never run it on a machine whose Tailscale setup must not change. It
uses a synthetic gateway only, so no real data, token or provider is involved.
It takes about ten minutes.

Use a node that is not serving production, and a second tailnet device as the
client. Tailscale Serve needs HTTPS enabled for the tailnet; if `tailscale serve`
asks for that, it is an administrator's decision. In the commands, `PROBE` is
`mise exec -- bun apps/backend/scripts/sse-route-probe.ts`, run from a checkout
of this branch or later.

On the server node:

1. Record `tailscale version`, and check that `tailscale serve status` shows
   nothing on port 8443. Stop if it does.
2. Start the gateway Serve will proxy, in its own terminal. Serve only proxies
   to the local machine, so this one stays on loopback:
   `PROBE serve --port 34990`
3. Start the control, in another terminal, on the tailnet address:
   `PROBE serve --bind "$(tailscale ip -4)" --port 34991`
4. Each prints a `url` and a `tokenFile`. If a port was taken, the gateway moved
   on to another, so use the port in `url` below. Copy both token files to the
   client, for example to `serve.token` and `direct.token`, and keep them private.
5. Publish the first gateway:
   `tailscale serve --bg --yes --https=8443 http://127.0.0.1:34990`

On the client, with `SERVE=https://<node>.<tailnet>.ts.net:8443` and
`DIRECT=http://<tailscale-ip>:34991`. Each run takes about 90 seconds and exits 0
when `incremental` is true:

```bash
PROBE measure --url "$SERVE"  --token-file serve.token  --label serve-gzip-h2 --http2 --out serve-gzip-h2.json
PROBE measure --url "$SERVE"  --token-file serve.token  --label serve-gzip-h1 --out serve-gzip-h1.json
PROBE measure --url "$DIRECT" --token-file direct.token --label direct-gzip   --out direct-gzip.json
PROBE measure --url "$SERVE"  --token-file serve.token  --label serve-identity --accept-encoding identity --out serve-identity.json
PROBE measure --url "$SERVE"  --token-file serve.token  --label serve-reconnect --reconnect-after 10 --out serve-reconnect.json
```

Then clean up on the server node. Do not use `tailscale serve reset`, which
removes every handler on the node:

1. `tailscale serve --yes --https=8443 off`
2. Check `tailscale serve status`, then press Ctrl+C in both `serve` terminals.

Reading the results:

- **Serve does not hold frames** if `serve-gzip-h2` and `serve-gzip-h1` have
  `heldTicks: 0` and `missing: 0`, and their delay is close to `direct-gzip`'s.
  A run over a bad link can show held ticks on the control too, which is the
  link rather than Serve.
- **Serve does not re-encode** if they have `contentEncoding: "gzip"` and
  `bytesMatch: true`.
- **Idle survives** if the last tick arrives (`missing: 0`) after the 60 s gap,
  with `keepalives` of at least 2.
- `serve-reconnect` should show `reconnects: 1`, `missing: 0`, `duplicates: 0`
  and `streamingActiveAfterClose: 0`. A tick missed during the gap can count as
  held, because it really was late.

Record the Tailscale version and the five results under "Measurements", then
update tasks 1 and 3. If Serve holds or changes frames, the matrix must label
that route as measuring Serve, and turning `on` into a default has a new
question to answer.

## Outstanding work

### Qualification

- Run the matrix on one host against a real gateway (task 2) at normal and
  constrained bandwidth, and record the Phase 2 fields. The run through
  Tailscale Serve from a second machine is in 7568.
- Measure encoded bytes of negotiated transcript part patches and of several
  remote clients on one session (only decoded bytes were measured). The
  harness's agent-event workload is synthetic, not real part patches.
- Data saving: measure bytes and requests per minute in a real browser with
  the mode off and on (running agent, open Files panel, running reviewer),
  and check the approval and completion budgets as p50/p95 with it on.
- Isolated browser QA from the acceptance criteria: backgrounding, screen
  lock and resume, tab switches, two clients with different preferences,
  reload, throttled and disconnected links.

### Code

1. Change at most one default per decision. Compression changed to `on` (D14);
   revisit the terminal transport with the remote baseline using the
   decision-record template.
2. Done: client-local data-saving preference (D2, D3).
3. Done: 1 s responsive cadence and quiet backoff for the Files panel and
   reviewer tab under data saving, reset on checkpoints and status changes,
   invalidation, reconnect and return (D4). Files-panel user actions also reset
   backoff; a no-op manual reviewer refresh preserves it.
4. Done: approvals, completion, errors and queue state still arrive through
   invalidations that read at once; data saving only slows backstop polls.
5. Decided: hidden terminal subscriptions stay attached (D5).
6. Deferred: `permessage-deflate` for the terminal WebSocket is needed only if
   Phase 3 chooses the WebSocket for bulk output; the in-process data says it
   would be required in that case (bulk output is about 7.5 times larger than
   `on` SSE). Decide the direction with the remote baseline first (D6).
   Re-checked 2026-11-05: still opt-in, and Bun negotiates the extension
   through `handleUpgrade`; the trigger and requirements are in task 8.

### Acceptance criteria

- Compression never delays an approval or completion event indefinitely,
  loses authoritative state, or encodes twice. (Covered in process: every
  frame flushes on its own, one encoding.)
- Unsupported negotiation and codec failures have tested, bounded behaviour.
  (Covered: identity for non-gzip clients, codec failure, pool saturation.)
- Terminal output matches the exact snapshot after backpressure and reconnect.
- `body` mode and HTTP/SSE stay available as rollback during any opt-in trial.
- The data-saving preference affects only the requesting client; two clients
  with different preferences keep their own freshness. (Unit-covered, plus
  `e2e/DataSavingGateway.spec.ts`: two isolated browser clients use the real
  setting, persisted UI store, shared coordinator and gateway against synthetic
  state. Checks reload, hidden/resume, a dropped SSE connection, response bytes
  and approval/completion budgets; emits content-free measurement JSON.
  Provider-backed remote-route qualification is still owed.)
- Returning or reconnecting restores exact state, including pending approvals,
  errors, queued prompts and parked dispatch controls.
- Offline periods and missed invalidations recover through authoritative reads
  with bounded retries and no prompt resubmission.
- Idle and active bytes and requests improve measurably against the baseline
  with the mode off. (Requests: see the budget table; bytes owed.)
- Completion and approval visibility stay within an explicitly chosen budget,
  reported as p50 and p95. (Budget chosen in D4; live p50/p95 owed.)
- Isolated browser QA covers backgrounding, screen lock and resume, tab
  switches, two clients with different preferences, reload, and throttled or
  disconnected links.
- Metrics and artifacts hold no terminal content, prompts, credentials,
  attachment data or file contents. (The harness emits aggregates and
  synthetic workload ids only.)

Regression coverage for the baseline harness lives in
`apps/backend/src/remote-bandwidth-baseline.test.ts`. It covers capacity
validation and subscription refusal/close/timeout cleanup, partial final-frame
arrival across clients and producers, all three transport metrics, raw-frame
parsing, paced forwarding and a stopped downstream reader with bounded queues
and gateway desync. Files-panel tests also cover revision/mutation resets and
watch-coverage changes while open; the reviewer test preserves D4's no-op
manual-refresh behaviour.

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

## Assumptions and decisions

### Tasks 1 and 3: review repairs (2026-11-01)

The probe uses a bounded header wait and owns pending and active streams until
cleanup. Real socket and wall-clock qualification lives in the slow integration
test file; arrival analysis and option parsing remain in the default tier.
The evidence table describes preserved upstream cache-control rather than claiming
the proxy adds no-transform. These choices keep production compression policy
unchanged while making failed measurements terminate and the evidence precise.


Decisions made on 2026-10-27 for this round, with the options weighed.

- **D1. Defaults.**
  - Options: (a) make `on` the default; (b) make the terminal WebSocket the
    default; (c) change nothing until the remote route is measured.
  - Choice: (c).
  - Why: the in-process data favours `on` for bytes, but the plan requires
    the supported remote route before promotion, Tailscale Serve's handling
    of SSE is unknown, and the eight-context pool is already full with three
    browsers plus one slow client, so a default `on` would quietly decline
    for the fifth browser. The WebSocket alone does not meet a bandwidth
    target for bulk output. The constrained run makes the case for `on`
    stronger (bulk output stays at link latency instead of seconds behind),
    which is exactly why the real route has to confirm it.
  - Pros: no unmeasured production change; `body` and HTTP/SSE stay the
    rollback. Cons: remote users keep paying uncompressed SSE until then.
- **D2. Where the preference lives.**
  - Options: (a) the persisted `uiStore`; (b) a new device-wide store; (c)
    backend config.
  - Choice: (a).
  - Why: it is client-local by construction (localStorage) and the todo named
    it. In Electron `uiStore` presentation state is kept per machine window,
    so the preference is per machine there, which suits a remote machine
    reached over a slow link while Local stays fast. (c) would change other
    clients.
  - Pros: no backend change, no new storage key. Cons: an Electron user sets
    it per machine; a browser per origin.
- **D3. Where the switch is shown.**
  - Options: (a) Settings > Machines "This device" (`ClientOptions`); (b)
    Settings > General.
  - Choice: (b), labelled "Applies to this device only".
  - Why: `ClientOptions` renders only in Electron (it needs
    `window.orkestrator.connections`), and the remote browser and hosted
    client are the main users.
  - Pros: visible on every client. Cons: General otherwise shows machine
    settings, so the wording has to say it is device-local.
- **D4. Trial values and budget.**
  - Options: slow everything uniformly; or slow only backstops whose changes
    are announced, more where coverage is complete.
  - Choice: the second, with the values in `data-saving-policy.ts`. Native
    running backstop 1 s (approval ≤ 2 s and completion ≤ 3 s budgets
    unchanged, since both arrive as invalidations); idle native unchanged;
    Files panel 10/15/30 s when watched, 10 s when unwatched (budget ≤ 2 s
    after an announced revision, ≤ 11 s unwatched, explicit ≤ 1 s); reviewer
    8/15/30 s with checkpoints immediate. Recorded in
    `../../architecture/recurring-work.md`.
  - Why: keeps safety and responsiveness on the event path and leaves a
    bounded recovery poll everywhere, as the constraints require.
  - Pros: 50 to 85 % fewer scheduled reads where it applies. Cons: an
    unwatched Files panel can lag by up to ~10 s for that client; a manual
    reviewer refresh that changes nothing does not reset its backoff.
- **D4a. Return restarts backoff for every client.**
  - Options: restart quiet backoff on resume only with data saving on, or
    always.
  - Choice: always. The coordinator's resume reconcile now resets every
    quiet streak and reads a key whose base cadence is overdue.
  - Why: `event-snapshot-recovery.md` already promised that a visible
    reconcile returns a native view to 1.5 s; the code only did so when the
    backed-off interval was overdue.
  - Pros: one rule, matches the documented contract. Cons: a focus event can
    now cost one read for a view that had backed off.
- **D5. Hidden terminal subscriptions.**
  - Options: (a) detach hidden tabs' output while data saving is on and
    reconcile from the state snapshot on return; (b) leave them attached.
  - Choice: (b).
  - Why: the item allows detaching only where recovery is exact. The state
    snapshot keeps the current screen exactly but halves scrollback to fit its
    byte target (`serializedState` in `apps/backend/src/core/terminal-history.ts`),
    so a detached tab would come back with less history than it had. Other
    environments' terminals are already unmounted.
  - Pros: no scrollback loss, no change to the terminal recovery path. Cons:
    background tabs of the open environment still stream.
- **D6. WebSocket compression.**
  - Options: (a) prototype `permessage-deflate` now; (b) wait for the
    direction decision.
  - Choice: (b).
  - Why: it matters only if the WebSocket becomes the bulk transport; with
    `on` SSE the bytes are already compressed. The backend runs `ws` under
    Bun, whose compression support behind `handleUpgrade` needs checking
    first.
  - Pros: no unused code path. Cons: if the WebSocket is chosen, this becomes
    a prerequisite.
- **D7. Harness location and scope.**
  - Options: a root `scripts/` file, or `apps/backend/scripts/`; real
    `ws` client or a raw RFC 6455 client.
  - Choice: `apps/backend/scripts/remote-bandwidth-baseline.ts` with a raw
    client.
  - Why: it imports the gateway directly; Bun's `ws` client hides the socket,
    so wire bytes and a truly non-reading slow client need the raw one. Each
    browser is modelled as main SSE plus one shared terminal stream, as
    `web-gateway.ts` does. Reconnect/replay is covered by the test suite, not
    the matrix.
  - Pros: exact wire bytes, no real data or ports. Cons: not the remote route;
    CPU includes the clients.

Decisions made on 2026-11-01 for tasks 1, 3 and 9.

- **D8. Reference route for the matrix.**
  - Options: (a) Tailscale Serve with the direct tailnet listener as the
    control; (b) the direct listener only.
  - Choice: (a), as the task recommended.
  - Why: Serve is what the hosted client uses, and reading its source gave no
    reason to avoid it. Nothing there buffers or re-encodes SSE.
  - Pros: measures what users take; the control isolates Serve. Cons: two runs
    per cell, and the version has to be recorded.
- **D9. Leave Serve's live half open.**
  - Options: (a) add a handler on this machine for a quick run; (b) write the
    steps and leave it open; (c) close it on source reading alone.
  - Choice: (b).
  - Why: (a) is ruled out, since this machine's Tailscale setup must not change
    and it runs production. (c) would claim a measurement nobody took. Source
    reading is good evidence for what to expect, not for what happens over a
    real link and a real HTTP/2 client.
  - Pros: an honest status; the run takes about ten minutes. Cons: task 2 cannot
    start until someone runs it.
- **D10. Test proxies stand in for Serve in the regression test.**
  - Options: (a) test proxies written in the test; (b) Go's real reverse proxy;
    (c) no hop.
  - Choice: (a), on HTTP/1.1 and HTTP/2.
  - Why: (b) needs a Go toolchain the repository does not have, and (c) would not
    meet the ticket. Each proxy only forwards bytes, so it guards the gateway's
    side of the bargain: headers and flushed bytes that a pass-through hop can
    carry. It says nothing about Serve itself, which is why the live run stays.
  - Pros: fast, deterministic, in the default suite. Cons: not Go's proxy.
- **D11. A dedicated probe rather than extending the bandwidth harness.**
  - Options: (a) a new `sse-route-probe.ts`; (b) add a remote target to
    `remote-bandwidth-baseline.ts`; (c) `curl` steps.
  - Choice: (a).
  - Why: the harness runs its gateway in process and its case runner assumes
    that, and (c) cannot compare bytes or time ticks. Task 2 will need (b) too,
    so the probe's client may be reused then.
  - Pros: small and needs no shell timing. Cons: one more script.
- **D12. Fix both proxied-stream bugs here.**
  - Options: fix them with regression tests, or record them and move on.
  - Choice: fix. Both are small, and the ticket asks for it.
  - Pros: a proxied stream now ends validly, and a quiet one opens at once. Cons:
    the headers fix also changes identity event streams in `body` mode, which is
    the rollback mode. Only the timing of the headers changes, not their content.
- **D13. Keep the older compression test file.**
  - Options: merge `gateway-streaming-compression.test.ts` into the new file, or
    keep both.
  - Choice: keep both. The older file owns credential rotation and gateway stop,
    and some cases overlap.
  - Pros: no churn in tests that pass. Cons: some overlap.

- **D14. Make `on` the compression default without waiting for task 2.**
  - Options: (a) switch once the Serve probe passes; (b) wait for the full
    remote matrix; (c) change nothing.
  - Choice: (a), decided by the maintainer on 2026-11-01. D1's reason for waiting
    was that Serve's handling of SSE was unknown, and the live probe has now
    settled that.
  - Pros: remote users get the 8 to 9 times reduction on redundant output now;
    `--compression body` stays the rollback. Cons: 2 to 3 times the CPU of `body`
    under bulk output; the eight-context pool still falls back to identity for a
    fifth browser; CPU and bytes through Serve under real load are unmeasured
    (task 2).

### Task 4: exit-criteria audit (2026-11-03)

- **Name owning tests by title, not line number.** The suites move by tens of
  lines with each change; the line numbers task 4's investigation cited on
  2026-10-27 had already drifted by about 80 lines. Titles survive that and are
  what `bun test -t` takes.
- **Hold real bytes instead of pinning `writableLength`.** The new test corks
  the gzip writer's compressor and holds terminal output with the scheduler
  latch before rotation and `stop()`. The harness's `pinBufferedBytes` overrides
  the getter, so a release
  could not change what it reports, and an assertion of zero would prove
  nothing.
- **Pin, rather than fix, the in-flight operation exception.** A write the
  backend has already accepted keeps its operation bytes until the backend
  settles it. The test asserts exactly that, then that the bytes drain. The
  related bug (a write queued behind it still runs after rotation) is outside
  this task's files, so it is filed as
  3900 instead of
  being changed here.
- **Keep the new test in `gateway-events.test.ts`.** It covers terminal
  sockets as well as SSE, and the ticket names that file.
  `gateway-streaming-compression.test.ts` keeps its compressor-only rotation
  test (D13).

### Task 4: hold channel bytes across token persistence (2026-11-03 review fix)

The test now drains earlier scheduled flushes, sets the socket's `flushScheduled`
latch before queuing real terminal output, and checks that bytes remain after
another event-loop turn. This prevents token persistence from draining the queue
before revocation. The same hold applies to rotation and stop. The private state
belongs to the disposable test socket; production code is unchanged.

- **Hold the scheduler latch (recommended, chosen).** Pros: retains real channel
  bytes through asynchronous persistence and makes a missing disposal reset fail
  during rotation. Cons: depends on private scheduler state.
- **Narrow the claim to stop only.** Pros: avoids another test-internal field.
  Cons: leaves rotation cleanup coverage incomplete.

Validation: the full gateway-events file passes. Removing only the disposal byte
reset makes the rotation assertion fail with 8,208 bytes; the production source
was restored immediately after this negative control. Backend test-project
checking reports an unrelated TS2339 at `commands-registry-pr.test.ts:1338`.

### Task 8: GW-7 re-check from efficiency report 0390 (2026-11-05)

- **Do not reopen D6; keep task 8 deferred.** The terminal WebSocket is still
  opt-in and the shared terminal stream went to SSE, so the condition D6 waits
  for is not met. No compression code was added. Options: (a) prototype and
  keep `permessage-deflate` now, which would add an untested-in-use code path
  and zlib memory for a transport no client uses by default; (b) record the
  evidence and the trigger here (chosen), which keeps the work waiting on the
  measurement that decides it.
- **Run D6's Bun check now anyway.** It costs a throwaway loopback script and
  no product change, and it removes the one open technical doubt D6 named: Bun's
  built-in `ws` does negotiate and compress through `handleUpgrade`. Its memory
  bound is still unproven, so it is a requirement of the work, not a finding.
- **Carry 0390's requirements into task 8 rather than a new to-do.** Task 8
  already owns the item, its constraints and its decision; a second file would
  split one piece of work across two places.

## Needs verification

- Data saving in a real browser: bytes per minute with the mode off and on,
  approval and completion p50/p95, and two clients with different
  preferences.

## Related

- [Manual-test checklist](../manual-test/7568-manual-test-checklist.md): the human-only parts of this to-do (the user part of task 2: the matrix and a browser through Tailscale Serve from a second machine, with exact terminal recovery over that link) moved there on 2026-11-10.
- [0049-native-agent-idle-observation.md](0049-native-agent-idle-observation.md):
  qualifying Claude and Codex for quiet backoff.
- `0051-client-reconnect-and-freshness.md` (deleted 2026-11-06):
  transport disconnect signals and jittered reconnect.
- [0050-transcript-history-efficiency.md](0050-transcript-history-efficiency.md): source
  work and decoded byte reductions.
- [0048-recurring-work-qualification.md](0048-recurring-work-qualification.md): latency
  budgets and live client QA.
- [0031-live-provider-and-platform-qualification.md](../cross-cutting/0031-live-provider-and-platform-qualification.md):
  shared prerequisites for remote and iOS runs.
- `../architecture/event-snapshot-recovery.md` (read coordinator, quiet
  backoff contract).
- Efficiency, logging and database outcome (`git show 413bd6219:docs/reports/2026-11-06-efficiency-logging-database-outcome.md`):
  GW-7 and the closing note for report 0390, which task 8 now owns.

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
