# efficiency-plan

Date: 2026-07-28

Status: consolidated implementation plan

Sources:

- `docs/efficiency-codex.md`
- `docs/efficiency-claude.md`

Iteration documents:

- `docs/efficiency/README.md`
- `docs/efficiency/milestone-0.md` through
  `docs/efficiency/milestone-6.md`

## Goal

Reduce remote web and iOS startup time, transferred bytes, request frequency,
and connection pressure without weakening background-environment recovery,
stream ordering, approval safety, or bounded backpressure.

The plan intentionally does not replace all JSON with a binary serialization
format. The measured costs come primarily from uncompressed assets and streams,
missing cache validation, repeated complete snapshots, per-keystroke requests,
base64 byte transport, and unconditional polling. JSON remains appropriate for
small control messages and low-frequency state.

## Target architecture

```text
Browser / iOS WKWebView
        |
        | HTTPS or tailnet HTTP
        v
Standalone gateway
        |
        +-- cached, precompressed renderer assets
        +-- compressed JSON command responses
        +-- replayable, revisioned SSE for authoritative state
        +-- one multiplexed WebSocket for terminal bytes
        +-- compressed/re-written preview responses
        +-- proxied bridge streams with bounded compression
        |
        +-- authoritative snapshot and reconciliation APIs
```

The Codex, Claude, and OpenCode bridges remain responsible for their existing
supervision, normalization, replay, approvals, and safety rules. Codex
app-server must not be exposed directly to the browser.

## Non-negotiable invariants

Every milestone must preserve these rules:

1. Long-running state lives in the backend, bridge, persistent store, or
   external process, not only in mounted React state.
2. A component unmount or inactive environment does not stop background work.
3. Live events are incremental updates over authoritative snapshots, never the
   only source of truth.
4. Every missed event is detectable through a revision gap, generation change,
   expired cursor, or explicit reconciliation frame.
5. Terminal output may be dropped only under bounded backpressure, with an
   explicit desync signal and exact snapshot recovery.
6. Authoritative state events must not be silently dropped.
7. Replay subscribes before it calculates and flushes the replay range.
8. A connected SSE frame echoes the client's cursor; it must not jump the
   client to the latest server revision before replay completes.
9. Codex app-server's stdout loop never awaits rendering, SSE writes, browser
   work, or other consumers.
10. Approval timeout, disconnect, malformed answers, and generation death deny
    rather than approve.
11. Every queue, replay ring, decoded request, rewritten response, and
    compression buffer has explicit byte and count bounds.
12. Metrics and logs never contain prompts, terminal contents, file contents,
    credentials, tokens, or attachment data.

## Success measures

Capture a baseline before implementation, then report the same measures after
each milestone:

- cold and warm application load transferred bytes;
- time to first usable shell and restored-layout readiness;
- main JavaScript raw, gzip, and Brotli sizes;
- request and response bytes by gateway route and encoding;
- invoke count, bytes, and duration by command;
- gateway and bridge event frames and bytes by event type;
- terminal input requests, raw bytes, wire bytes, and key-to-echo latency;
- reconnect count, replay hit rate, cursor expiry rate, and full reconciliations;
- open, connecting, dropped, and stalled streaming connections;
- event receipt-to-render latency;
- compression time and backend event-loop lag;
- iOS foreground/background recovery time.

Measure desktop browsers, Electron, iPhone `WKWebView`, and iPad `WKWebView`
over LAN and a constrained link representative of 100 ms RTT, 2–5 Mbps, and
intermittent loss.

## Milestone 0 — Baseline, instrumentation, and rollout controls

### Work

- Add privacy-safe counters and timings for the success measures above.
- Record live `Accept-Encoding`, `Content-Encoding`, cache, HTTP protocol, and
  transfer-size behavior through both raw tailnet HTTP and Tailscale Serve.
- Add `compression?: "off" | "body" | "on"` to gateway options:
  - `off`: identity responses everywhere;
  - `body`: compress eligible non-SSE bodies only;
  - `on`: also compress SSE streams.
- Resolve the option from constructor configuration first, then
  `ORKESTRATOR_GATEWAY_COMPRESSION`.
- Add `--compression <mode>` to backend CLI options.
- Gate compression on `listenerKind`, not the bind address. The control
  listener stays identity even when a remote browser listener also binds
  loopback under Tailscale Serve.
- Document the option, environment variable, and rollback behavior in
  `docs/remote-gateway.md`.

### Primary files

- `apps/backend/src/gateway.ts`
- `apps/backend/src/options.ts`
- `apps/web/src/lib/native/web-gateway.ts`
- `apps/ios/OrkestratorMobile/Views/RemoteWebView.swift`
- `docs/remote-gateway.md`

### Exit criteria

- Baseline results are recorded for desktop web and a real iOS device.
- Instrumentation adds no user-content logging.
- Compression modes are parsed, documented, and tested before any response
  path uses them.
- The control listener remains byte-for-byte identity.

## Milestone 1 — Static delivery and initial bundle

This is the first production optimization because it has the largest measured
cold-start benefit and does not alter live-state protocols.

### 1.1 Cache validation and response semantics

- Add encoding-specific ETags and `Last-Modified`.
- Handle `If-None-Match` and `If-Modified-Since` with `304`.
- Serve hashed `/assets/*` files with
  `Cache-Control: public, max-age=31536000, immutable`.
- Serve `index.html` and the SPA fallback with `Cache-Control: no-cache`.
- Include `Vary: Accept-Encoding` on identity and compressed variants.
- Merge `Vary` values so `Origin` is never clobbered.
- Support `HEAD` consistently with `GET`.
- Keep the existing path traversal protection. Derive compressed sibling paths
  only from the already-validated source path.

### 1.2 Precompressed build artifacts

- Add a Bun build script that creates `.br` at Brotli quality 11 and `.gz` at
  gzip level 9 for compressible renderer assets.
- Skip already-compressed images, WOFF2, and unknown octet-stream content.
- Skip a compressed sibling if it is larger than its source.
- Prefer Brotli and fall back to gzip according to `Accept-Encoding`.
- Reject stale precompressed siblings when their mtime predates the source.
- Keep moderate on-the-fly compression as a development/build fallback.

### 1.3 Bundle and font reduction

- Convert the two terminal TTF files to WOFF2 and evaluate a terminal-specific
  glyph subset.
- Lazy-load Monaco, diff viewing, Markdown editing, browser preview, looped
  review, settings, and provider tabs that are absent from the restored layout.
- Ensure Monaco is bundled and self-hosted rather than fetched from jsDelivr.
- Add explicit chunking only where measured dynamic imports do not already
  produce stable, useful chunks.
- Preserve the desktop `file://` renderer path.

### Primary files

- `apps/backend/src/gateway.ts`
- `apps/web/vite.config.ts`
- `apps/web/package.json`
- `apps/web/src/components/pane-layout/PaneLeafContainer.tsx`
- `apps/web/src/components/terminal/FileViewerTab.tsx`
- `apps/web/src/components/terminal/MonacoFileEditor.tsx`
- `apps/web/scripts/precompress.ts` (new)

### Exit criteria

- Main JavaScript transfer is below 900 KiB with gzip and 750 KiB with Brotli
  for the current feature set.
- A repeat load transfers no unchanged hashed asset bodies.
- `index.html` revalidates and a release with new hashes loads correctly.
- Restoring a layout without a file editor does not download Monaco.
- Static tests cover sibling selection, stale-sibling rejection, validators,
  `HEAD`, cache policies, merged `Vary`, and traversal protection.
- Desktop `file://`, remote browser, iPhone, and iPad load successfully.

## Milestone 2 — Dynamic body, event-stream, and proxy compression

Build shared compression primitives once, then apply them to each path with
path-specific streaming and safety behavior.

### 2.1 Shared primitives

Add and test:

- `negotiateEncoding`;
- `appendVary`;
- `isCompressibleContentType`;
- asynchronous `compressBody`;
- a measured `COMPRESSION_MIN_BYTES`, initially 1 KiB;
- consistent header and validator behavior for identity, gzip, and Brotli.

Use asynchronous compression for large bodies. Never synchronously compress
the gateway's potentially large invoke responses on the shared event loop.

### 2.2 JSON and rewritten preview bodies

- Prefer asynchronous Brotli quality 4, then gzip level 6, for eligible dynamic
  JSON above the threshold.
- Preserve `Cache-Control: no-store` for private dynamic state.
- After browser-preview HTML, CSS, or JavaScript is decoded and rewritten,
  recompress the complete bounded body for the client.
- Preserve the current upstream `Accept-Encoding: identity` behavior for
  rewriteable preview content.
- Enforce both decoded and encoded size limits.

### 2.3 Gateway SSE

Introduce an `EventClientWriter` abstraction whose `writableLength` always
means uncompressed bytes still owed:

```ts
interface EventClientWriter {
  readonly writableLength: number;
  write(chunk: string): boolean;
  destroy(): void;
}
```

- First retype the existing identity path without changing behavior.
- Implement gzip event output with `Z_SYNC_FLUSH` at the stream level.
- Track pre-compression backlog in each compressor write callback.
- Do not infer backlog only from `ServerResponse.writableLength`; that hides
  bytes queued inside the compressor and defeats the soft/hard limits.
- Explicitly destroy the compressor when the response closes or a client is
  dropped.
- Write a small priming comment frame so the connected event is immediately
  decodable on quiet streams.
- Keep `Cache-Control: no-store, no-transform`.
- Do not coalesce independent event frames merely to improve compression.
- Keep all current terminal soft-limit desync and hard-limit disconnect
  semantics.

Default production behavior to `body` until compressed SSE has been tested
through the real iOS shell. Promote `on` only after low-volume events arrive
without buffering. If WebKit buffers compressed SSE, retain `body` as the
default rather than weakening latency or flow control.

### 2.4 Proxied bridge streams

- Compress at the remote-facing gateway and force identity upstream.
- Use pipeline backpressure for a single proxied client.
- Use gzip sync-flush for `text/event-stream`.
- Use threshold-based Brotli/gzip for eligible non-streaming proxy bodies.
- Do not double-encode an upstream response that is already encoded.
- Leave the browser-preview decode/rewrite branch logically separate.

### Exit criteria

- Eligible `/invoke` responses negotiate Brotli or gzip and remain identity on
  the control listener.
- `Vary` contains both `Origin` and `Accept-Encoding` where both apply.
- A connected compressed SSE frame is decodable before any application event.
- A non-reading compressed client is still dropped at the existing hard limit.
- Soft-limit desync recovery, keepalive, tmux retained-frame behavior, and
  compressor cleanup match the identity path.
- `off`, `body`, and `on` provide tested rollback paths.
- Real iOS testing determines whether `on` can become the default.

## Milestone 3 — Remove repeated data before adding new transport

Compression reduces wire bytes; this milestone removes unnecessary work and
allocation at the source.

### 3.1 Codex message patches

Port the proven Claude `message.patched` protocol to Codex:

- send one complete `message.updated` when a message first appears or its ID
  changes;
- compare normalized parts with the last published state;
- send only changed part indexes plus authoritative `partCount`;
- increment and validate a message revision;
- reconcile from `/session/:id/messages` if the base revision is absent,
  duplicated, or out of order;
- flush pending patches before status, approval, interaction, error, or idle
  events whose ordering depends on the visible transcript;
- retain completed large tool parts by identity so they are sent once;
- keep rendering, diffing, and client delivery off the app-server stdout loop.

### 3.2 Terminal payload and recovery improvements

- Add a plain UTF-8 terminal string payload while retaining base64 decoding for
  one compatibility release.
- Add `sinceRevision` to terminal snapshot commands.
- Return only missing chunks when the requested revision is retained; return an
  explicit full snapshot when it has aged out or the generation changed.
- Change tmux full-pane repainting to a line-level or region-level diff, with a
  full repaint on first attach, force, generation change, or desync.
- Reduce hidden Claude tmux capture traffic while preserving background status
  and authoritative recovery.

These changes remain useful even if terminal bytes later move to WebSocket.

### 3.3 Environment and command response projection

- Stop returning storage records directly from `get_environments`.
- Define an explicit client wire projection that excludes:
  - `initialPromptAttachments`;
  - duplicated per-environment model catalogs;
  - backend-only activity observations and renderer lease bookkeeping;
  - launch-only prompt fields once no longer needed.
- Store attachment base64 once and reconstruct `previewUrl` client-side.
- Return a narrow activity-update result instead of a complete `Environment`
  when callers consume only activity fields.
- Review redundant path-derived fields in file-tree and Git-change payloads.

### 3.4 Conditional refreshes

- Add `projectId` to environment announcements so only the affected project's
  environment list refreshes.
- Gate the build transcript, global resource sync, and files-panel refreshes on
  cheap resource revisions or conditional snapshot commands.
- Add incremental message retrieval to build polling where live patches are not
  sufficient.
- Cache or revision-key the base-branch side of diff viewing.
- Keep the broad inactive-environment safety sweep until gateway replay and a
  revision manifest have proven equivalent recovery.

### Exit criteria

- A long Codex turn does not resend every completed tool part in each frame.
- Missing Codex patch revisions trigger one authoritative reconciliation.
- Terminal reconnect cost is proportional to the missed gap when retained.
- A forced terminal generation change still performs an exact full recovery.
- Environment list responses never contain inline prompt attachments or
  backend lease internals.
- Pure activity renewals do not return complete environment records.
- Stable build, file, and global resources do not transfer unchanged full
  snapshots on each timer tick.

## Milestone 4 — Gateway replay and revision-aware synchronization

Replace the one-minute broad full-resync safety net with bounded replay plus a
cheap authoritative revision check. Do not remove the safety net until all
background and inactive paths pass.

### Work

- Assign a monotonic revision within a gateway generation to every
  authoritative non-terminal event.
- Emit the revision as the SSE `id`.
- Accept both `Last-Event-ID` and an explicit `since` query.
- Subscribe before replay calculation, buffer concurrent events during the
  handshake, replay the requested range, then flush newer buffered events.
- Bound the replay ring by frame count and encoded bytes.
- Keep terminal output out of the main replay ring; its generation, revisions,
  desync notices, and snapshot command remain authoritative.
- Emit `reconcile-required` when the cursor is expired, invalid, or belongs to a
  prior generation.
- Add a small revision manifest for resources such as projects, config,
  environments, pipelines, prompt queues, sessions, and reviews.
- Make each snapshot command conditional on the client's known resource
  revision and return unchanged without the full body.
- After soak testing, replace the 60-second broad transfer with a slower
  revision-manifest check and targeted hydration.

### Exit criteria

- A short disconnect replays missed events without broad hydration.
- An expired cursor follows one explicit reconciliation path.
- Replay storage remains bounded under event bursts.
- Subscribe-before-replay and disconnect-during-handshake races are covered.
- A stable remote client no longer downloads broad snapshots every minute.
- Inactive and background iOS paths converge projects, environments, pipelines,
  prompts, sessions, approvals, interactions, reviews, and terminal output.
- Backend restart and gateway generation change reconcile correctly.

## Milestone 5 — Multiplexed terminal WebSocket

Use one authenticated WebSocket owned by the browser gateway adapter, not by
individual React terminal components.

### Compatibility step

Before or during the WebSocket rollout, micro-batch HTTP terminal input for
approximately 5–10 ms:

- flush Enter, control sequences, and explicit paste boundaries immediately;
- enforce a hard buffered-byte limit;
- preserve input ordering.

This supplies a low-risk improvement and remains the fallback transport.

### WebSocket protocol

- Open one socket per gateway client.
- Use JSON control frames for subscribe, unsubscribe, resize, generation,
  lifecycle, and errors.
- Allocate compact numeric channel IDs after subscription.
- Use binary frames for raw input and output bytes with a small frame type,
  channel ID, generation, and revision header.
- Multiplex all mounted terminals over the same socket.
- Preserve filtered subscriptions so a client receives only terminals it is
  consuming.
- Preserve snapshot recovery and revision-gap detection.
- Apply soft and hard queue limits per socket and per terminal.
- Ensure one slow terminal cannot starve other channels.
- Reconnect and resubscribe from the adapter's authoritative subscription
  registry after network or foreground transitions.
- Never tie terminal backend lifetime to a React component unmount.

### Exit criteria

- Ordinary typing does not issue one HTTP request per character.
- Key-to-echo p95 does not regress on LAN and improves or remains stable at
  100 ms RTT.
- A 1 MiB output workload transfers materially fewer bytes than SSE/base64.
- Forced disconnect, dropped frame, expired revision, and backend restart all
  recover exactly from authoritative snapshots.
- One socket serves multiple terminals without cross-session output.
- Slow-reader tests prove bounded memory and per-channel fairness.
- The HTTP/SSE fallback remains available for one compatibility release.

## Milestone 6 — Large payloads and optional connection brokerage

### 6.1 Attachments and large request bodies

- Add an authenticated multipart or binary upload endpoint for prompt images
  and files.
- Return short-lived attachment handles for use in prompt JSON.
- Enforce MIME, encoded bytes, decoded bytes, ownership, cleanup, expiry, and
  request-deduplication rules.
- Prefer revisioned small durable-state updates over whole-snapshot writes.
- Add bounded `Content-Encoding: gzip` request support only for measured,
  text-heavy command bodies that remain large after payload reduction.

### 6.2 Bridge connection multiplexing

Instrument first. Add gateway-level brokerage only if real iOS measurements
show excessive connection count, connection stalls, reconnect churn, or energy
cost.

If justified:

- share one provider subscription per environment where practical;
- multiplex namespaced bridge events through a gateway-managed stream or the
  established WebSocket;
- retain every bridge's cursor, authoritative hydration, and approval routing;
- do not merge protocols in a way that lets one provider's backpressure stall
  another provider or the main gateway event stream.

### Exit criteria

- Image prompts no longer pay base64 expansion in command JSON.
- Upload cleanup and authorization are tested.
- Decoded-body limits prevent compressed request expansion attacks.
- Connection brokerage is either supported by measured iOS evidence and passes
  recovery tests, or is explicitly deferred with the measurements recorded.

## Verification strategy

### Automated tests

Add focused tests alongside existing gateway, bridge, store, terminal, and
resource-sync tests. The most important new cases are:

- a compressed SSE client that never reads and is dropped at the hard limit;
- compressed soft-limit terminal desync and exact recovery;
- no leaked compressor after normal close or forced drop;
- immediate decoding of the initial compressed SSE frame;
- merged `Vary: Origin, Accept-Encoding`;
- precompressed sibling selection and stale-sibling rejection;
- encoding-specific ETag and `304`;
- immutable asset versus revalidated SPA fallback;
- loopback/control listener identity;
- proxy identity upstream, no double encoding, and streaming first-frame
  delivery;
- all three compression modes;
- Codex patch success, duplicate, gap, out-of-order, and full reconciliation;
- terminal `sinceRevision` hit, expiry, and generation mismatch;
- gateway replay success, expiry, restart, and handshake race;
- WebSocket channel isolation, ordering, reconnect, slow-reader, and fallback;
- environment wire projection and conditional unchanged responses.

### Required commands

```bash
bun run --cwd apps/backend typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/desktop typecheck
bun test tests --parallel
bun test bridges --parallel
bun run test
```

Run focused files first while iterating, always using `--parallel` for a suite.
The final full run must include the iOS group.

### Manual matrix

| Dimension | Cases |
| --- | --- |
| Client | Electron, desktop browser, iPhone WKWebView, iPad WKWebView |
| Link | LAN, 100 ms RTT, constrained bandwidth, packet loss |
| State | Foreground, inactive tab/environment, background, screen lock, recovery |
| Workload | Idle, typing, paste, terminal flood, long Codex turn, multiple active environments |
| Reconnect | Replayable gap, expired cursor, gateway restart, bridge restart |
| Assets | Cold load, warm load, release with changed hashes |

For every milestone, explicitly test the inactive-environment path:

1. Start work in environment A.
2. Switch to environment B or another project.
3. Let A stream, request an interaction, or finish.
4. Background and foreground iOS where relevant.
5. Return to A.
6. Verify status, transcript, pending prompts, approvals, terminal output, and
   controls against authoritative snapshots.

## Release and rollback strategy

- Ship milestones independently; do not combine caching, SSE flow-control
  changes, replay, and WebSocket into one release.
- Keep identity behavior covered throughout the compression refactor.
- Start production compression in `body` mode, then promote to `on` after real
  WKWebView validation.
- Roll out Codex patches with authoritative full-message fallback.
- Keep base64 terminal decoding for one release after introducing strings.
- Keep HTTP/SSE terminal transport for one release after WebSocket becomes the
  default.
- Keep the broad resource resync until replay and revision-manifest behavior
  has soaked across inactive and background clients.
- Record before/after metrics and the rollback setting in each milestone's pull
  request.

## Explicitly deferred

- Protobuf, CBOR, or MessagePack for ordinary commands and state.
- Exposing Codex app-server directly to clients.
- A gateway-wide event broker without measured iOS connection pressure.
- Removing authoritative snapshots or the ability to reconcile.
- Maximum-quality synchronous Brotli on dynamic responses.
- Compression on the Electron control listener.

These may be reconsidered only if post-plan profiling shows that JSON parsing,
schema size, or connection count remains a material bottleneck after repeated
data and transfer compression have been addressed.
