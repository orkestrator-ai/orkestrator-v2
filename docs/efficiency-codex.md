# Remote Web and iOS Transport Efficiency

Date: 2026-07-28

Status: audit and implementation proposal

## Executive summary

Remote web and iOS performance can be improved substantially, but replacing all
JSON with a binary serialization format is not the highest-value first step.

The largest opportunities are:

1. Compress and cache the production renderer assets.
2. Reduce the initial JavaScript bundle and terminal-font payloads.
3. Move interactive terminal input and output to a multiplexed WebSocket, using
   binary frames for terminal bytes.
4. Add replay cursors to the gateway event stream so clients do not need broad
   periodic authoritative resyncs.
5. Send Codex message patches instead of repeated complete, growing message
   snapshots.
6. Recompress rewritten browser-preview HTML, CSS, and JavaScript.
7. Reduce the number of long-lived same-origin streams used by background
   environments on iOS.

Ordinary control messages and low-frequency state should remain JSON. The
current problems are dominated by uncompressed assets, repeated data, request
frequency, and base64-wrapped byte streams rather than by JSON property names.

## Scope

This audit covers the network path used by:

- the web client served by the standalone backend;
- the iOS app, which embeds the same web client in `WKWebView`;
- the backend gateway command and event routes;
- proxied Claude, Codex, and OpenCode bridge traffic;
- terminal input and output;
- loopback browser previews.

It does not propose exposing Codex app-server directly to a browser. The Codex
bridge remains responsible for supervision, normalization, approvals, replay,
durable reconciliation, and safety policy.

## Current transport

The remote path is:

```text
Browser or iOS WKWebView
        |
        | HTTPS, normally through Tailscale Serve
        v
Standalone backend gateway
        |
        +-- POST /__orkestrator/invoke
        |      JSON command and JSON result
        |
        +-- GET /__orkestrator/events
        |      SSE backend events
        |
        +-- /__orkestrator/proxy/loopback/<port>/...
        |      proxied Claude, Codex, OpenCode, and local services
        |
        +-- static renderer assets
```

The iOS client is not a separate native implementation of the live application
protocol. `RemoteWebView.swift` creates a non-persistent `WKWebView`, obtains the
gateway cookie, and loads the same renderer. Therefore, almost every web
transport optimization also benefits iOS.

Relevant entry points:

- `apps/backend/src/gateway.ts`
- `apps/web/src/lib/native/web-gateway.ts`
- `apps/ios/OrkestratorMobile/Views/RemoteWebView.swift`
- `apps/web/src/lib/claude-client.ts`
- `apps/web/src/lib/codex-client.ts`
- `apps/web/src/lib/opencode-client.ts`

## Existing efficiency and reliability work

Several important optimizations are already implemented and should be
preserved:

- PTY output is coalesced in `apps/backend/src/core/pty.ts` using a 16 ms
  bounded window. The first chunk after an idle period is delivered
  immediately so interactive echo does not inherit the batching delay.
- Terminal bytes use base64 strings rather than JSON arrays of numbers.
- Remote gateway clients receive authoritative non-terminal events plus only
  the terminal session streams they currently consume.
- Browser terminal subscriptions share one filtered `EventSource`, avoiding
  one long-lived request per mounted terminal in `WKWebView`.
- Slow gateway clients have soft and hard byte limits. Terminal output may be
  dropped only with an explicit desync signal and authoritative snapshot
  recovery.
- Claude sends an initial full assistant message followed by revision-checked
  `message.patched` events.
- OpenCode applies `message.part.updated` incrementally and reserves full
  transcript reads for reconciliation and failure recovery.
- Claude and Codex bridge SSE streams have bounded replay rings, cursor-based
  reconnection, bounded slow-consumer queues, and authoritative fallback when a
  cursor expires.
- Codex filters a session subscription so unrelated sessions receive only
  lightweight cursor frames.

These mechanisms are part of the background-environment reliability contract.
Transport changes must retain authoritative snapshots, replay-gap detection,
and inactive-environment recovery.

## Measurement snapshot

A production Vite build was generated in a temporary directory without
changing the repository. The build output was approximately:

| Asset | Raw size | Gzip | Brotli |
| --- | ---: | ---: | ---: |
| Main JavaScript | 2,968,466 B | 861,429 B | 687,336 B |
| Main CSS | 171,128 B | 25,144 B | 19,839 B |
| FiraCode Nerd Font Regular TTF | 2,642,616 B | 1,509,169 B | 1,285,326 B |
| FiraCode Nerd Font Bold TTF | 2,672,432 B | 1,517,552 B | 1,291,267 B |
| Complete build output | approximately 8.1 MB | not measured as one archive | not measured as one archive |

The fonts are demand-loaded by the browser and are not necessarily both
downloaded on every screen. The main JavaScript and CSS are part of the initial
application path.

The gateway itself currently serves static files without `Content-Encoding`,
ETag, or an explicit cache policy. A reverse proxy could independently alter
delivery, so live response headers should be recorded before and after any
change. Precompressed asset delivery from the gateway makes the result
deterministic regardless of proxy behavior.

A representative terminal frame was also measured using the current SSE
envelope:

| Raw terminal data | Current SSE/base64/JSON frame |
| ---: | ---: |
| 100 B | 245 B |
| 1,000 B | 1,445 B |
| 10,000 B | 13,445 B |

For large frames, raw binary transport can remove roughly 25% to 30% of the
current bytes. For small frames, the fixed JSON and SSE envelope dominates.
The existing PTY coalescer already reduces the number of small output frames.

## Ranked findings

### 1. Static renderer assets are not compressed or explicitly cached

Impact: very high for cold start, reload, and reconnection

Confidence: high

The production static-file path in `apps/backend/src/gateway.ts` sends only:

```text
Content-Type
Content-Length
```

It does not select a precompressed Brotli or gzip asset, set
`Content-Encoding`, add `Vary: Accept-Encoding`, issue an ETag, or mark
content-hashed assets immutable.

The iOS wrapper magnifies this cost:

- it uses `WKWebsiteDataStore.nonPersistent()`;
- its main request uses `reloadIgnoringLocalAndRemoteCacheData`;
- it sends `Cache-Control: no-store` on that navigation.

The non-persistent store can still reuse data during one view lifetime, but it
does not provide durable cross-launch caching. The gateway should therefore
make every avoidable transferred byte inexpensive.

#### Recommendation

At build time:

- generate `.br` and `.gz` variants of JavaScript, CSS, JSON, SVG, and other
  compressible assets;
- convert the two terminal TTF files to WOFF2;
- evaluate a subset font containing the glyphs actually needed by the terminal;
- preserve content hashes in asset filenames.

At serve time:

- prefer Brotli, then gzip, based on `Accept-Encoding`;
- add `Vary: Accept-Encoding`;
- serve hashed assets with
  `Cache-Control: public, max-age=31536000, immutable`;
- serve `index.html` with revalidation, such as `Cache-Control: no-cache`;
- add ETag or `Last-Modified` for non-hashed files;
- support `HEAD` consistently with `GET`.

Compression should be precomputed rather than performed at a high Brotli
quality on each request.

#### Initial bundle reduction

The main bundle is also large because pane routing statically imports most
feature surfaces. `PaneLeafContainer.tsx` imports file editing, browser,
Claude, Codex, OpenCode, build, and review components. `FileViewerTab.tsx`
statically imports Markdown and Monaco-backed editors.

Candidates for `React.lazy` or route-level dynamic imports include:

- Monaco file editor;
- diff viewer;
- Markdown editor;
- browser preview;
- looped review UI;
- settings and other infrequently opened dialogs;
- provider-specific tabs that are not present in the restored layout.

Code splitting reduces download, parse, compile, and initialization work. It is
valuable even after transport compression.

### 2. Terminal input uses one JSON HTTP command per xterm input callback

Impact: high for interaction over high-RTT links

Confidence: high

`PersistentTerminal` forwards each `terminal.onData` callback immediately.
`useTerminal` calls `terminal_write` or `local_terminal_write`, and the browser
gateway turns every command into a separate JSON `fetch()` POST to
`/__orkestrator/invoke`.

The callback is not awaited by xterm, so typing does not deliberately serialize
on each response. Nevertheless, every input callback still pays for:

- an HTTP request and response;
- headers and cookie/auth processing;
- JSON serialization and parsing;
- command dispatch;
- browser connection scheduling.

This is particularly inefficient for single-character typing and key repeat.

Terminal output is better optimized than input:

- the PTY implementation already coalesces burst output;
- active-session filtering avoids unrelated terminal downloads;
- backpressure and snapshot recovery are implemented;
- output still pays base64 and SSE/JSON framing overhead.

#### Recommendation

Add one authenticated, multiplexed WebSocket per gateway:

- use JSON control frames for subscribe, unsubscribe, resize, and lifecycle;
- assign a compact numeric channel ID after subscription;
- send terminal input and output as binary frames containing a small frame type,
  channel ID, generation/revision where needed, and raw bytes;
- multiplex every mounted terminal over the same socket;
- retain `get_terminal_output_snapshot` as the reconnect authority;
- retain generation and revision gap detection;
- apply the existing soft/hard backpressure policy per socket and per terminal.

The WebSocket must be owned by the browser gateway adapter, not by individual
terminal React components. Component unmount means "not visible" in several
application paths and must not accidentally destroy background-authoritative
state.

#### Lower-risk intermediate option

Before introducing WebSocket transport, terminal input could use a very small
client buffer:

- flush after approximately 5 to 10 ms;
- flush immediately for Enter, control sequences, and explicit paste
  boundaries;
- place an upper byte limit on the buffer;
- preserve input order across flushes.

This reduces HTTP request frequency, but a WebSocket is a cleaner long-term fit
for bidirectional terminal bytes.

### 3. The gateway event stream has no replay cursor

Impact: high for steady-state request volume and reconnect recovery

Confidence: high

The main gateway event stream does not emit SSE IDs or retain a replay ring.
The frontend therefore treats every stream reconnection as a possible missed
window and refetches active authoritative state.

A global 60-second safety timer also requests a full resource resync. The
minimum periodic request count is approximately:

```text
2 + (3 * environment count) + (2 * project count)
```

This represents:

- project list;
- config;
- prompt queues per environment;
- sessions per environment;
- looped reviews per environment;
- environment lists per project;
- build pipelines per project.

Opened boards, project notes, and feature plans add more. With 10 environments
and 3 projects, the lower bound is approximately 38 backend command requests
per minute even when nothing has changed.

The timer exists for correctness: background work can continue while the
browser is inactive, and live events are not authoritative history. Removing
the timer without a replacement would violate the background-environment
reliability contract.

#### Recommendation

Port the bounded bridge replay model to the gateway:

1. Give every authoritative gateway event a monotonically increasing revision.
2. Send the revision as the SSE `id`.
3. Accept `Last-Event-ID` and an explicit `since` parameter.
4. Subscribe before calculating replay and buffer events emitted during the
   replay handshake.
5. Retain a bounded main-event ring by both event count and encoded bytes.
6. Keep terminal output outside the authoritative main ring; terminal
   generations, revisions, desync notices, and output snapshots already solve
   that problem.
7. If a cursor is too old or from a dead generation, emit
   `reconcile-required` and perform the existing snapshot hydration.
8. Replace the 60-second broad resync with a substantially slower safety check
   or a cheap revision-manifest request.

The connected handshake must echo the client's cursor, not the latest server
revision. Both bridge implementations already document why anchoring the
connected frame at the latest revision can skip replay frames if the
connection dies mid-handshake.

#### Optional revision manifest

A small endpoint can complement the replay ring:

```json
{
  "generation": "gateway-generation",
  "revision": 1234,
  "resources": {
    "projects": 12,
    "config": 7,
    "environments": 44,
    "pipelines": 83
  }
}
```

Clients can compare known resource revisions and fetch only changed snapshots.
This is safer than either constant full polling or trusting an indefinitely
live socket.

### 4. Codex live streaming repeatedly sends complete message snapshots

Impact: potentially very high for long or tool-heavy turns

Confidence: high

`AppServerRuntime.publishAssistantMessage` rebuilds the normalized assistant
message and emits `message.updated` with the entire message.

The adaptive interval is:

- 100 ms below 256 KiB;
- 250 ms at or above 256 KiB;
- 500 ms at or above 1 MiB.

Adaptive slowing protects CPU and React, but the wire cost still grows with the
entire message. A 200 KiB assistant message updated ten times per second can
produce approximately 2 MiB/s of raw message payload before SSE and JSON
framing.

The Codex event ring collapses superseded retained snapshots and the route
filters unrelated sessions, which reduces replay and cross-tab costs. It does
not reduce the complete snapshots sent to the live subscriber.

Claude already provides the desired reference implementation:

- send the complete message once;
- compare normalized parts against the last published version;
- send only changed part indexes;
- include an authoritative `partCount`;
- increment a message revision;
- require a recipient to reconcile if it does not hold `revision - 1`.

OpenCode similarly applies part-level updates from its upstream event stream.

#### Recommendation

Add `message.patched` to the Codex bridge and client:

- publish a complete `message.updated` for a new message;
- retain the last published part identities for the active message;
- publish changed parts plus final part count;
- revision-guard application in the Codex store;
- fall back to `/session/:id/messages` when the base revision is missing;
- flush any pending patch before status, approval, interaction, idle, or error
  events whose ordering depends on the visible transcript.

Prefer adapting app-server item/delta information where possible, but do not
let message rendering or SSE delivery block the app-server stdout read loop.

### 5. Rewritten browser-preview text is returned uncompressed

Impact: high while remotely previewing JavaScript-heavy applications

Confidence: high

The browser-preview proxy currently:

1. forces the upstream request to use `Accept-Encoding: identity`;
2. buffers up to 8 MiB;
3. rewrites root-relative HTML, CSS, and JavaScript URLs;
4. removes `Content-Encoding`;
5. returns the rewritten body with an uncompressed `Content-Length`.

Requesting identity is reasonable because the gateway must inspect and rewrite
the decoded text. Returning the result uncompressed is unnecessary because the
complete rewritten buffer already exists.

#### Recommendation

After rewriting:

- select Brotli or gzip from the browser request's `Accept-Encoding`;
- compress the rewritten buffer;
- set `Content-Encoding`;
- set `Vary: Accept-Encoding`;
- update or remove `Content-Length` as appropriate;
- preserve the existing decoded and encoded byte limits.

For development servers where latency matters more than ratio, use a moderate
compression level. Do not run maximum-quality Brotli synchronously on the main
backend event loop.

### 6. Background agent sessions can consume many long-lived browser requests

Impact: medium to high on iOS, depending on active environment count

Confidence: medium

The browser terminal adapter already documents that `WKWebView` has a small
per-origin allowance for long-lived requests. It solved the terminal-specific
case by sharing one filtered `EventSource`.

Other sources remain:

- the main gateway SSE stream;
- one shared Claude stream per active environment;
- one shared OpenCode stream per active environment;
- Codex streams for running sessions;
- terminal stream;
- other long-lived proxied development connections.

Mobile deliberately keeps every pane mounted. The application also mounts
hidden background-processing environments so pipelines and active turns can
continue. This is correct for reliability but can increase connection pressure.

HTTP/2 may multiplex these requests below the browser API, depending on the
live Tailscale Serve and WebKit path. The source already records observed
WebKit pressure for terminal streams, so the remaining streams should be
instrumented rather than assumed safe.

#### Recommendation

Measure:

- number of open `EventSource` or streaming fetch requests;
- time to stream open;
- streams stuck in connecting state;
- reconnect frequency after iOS background and foreground transitions;
- whether the live client-to-Tailscale connection negotiates HTTP/2 or HTTP/3.

If pressure is confirmed:

- share one Codex bridge subscription per environment where practical;
- broker bridge events through a gateway-level multiplexed stream;
- or use the proposed gateway WebSocket for both terminal and namespaced bridge
  events.

A full event broker is a larger architectural change and should follow static
delivery, terminal transport, gateway replay, and Codex patches.

### 7. Large JSON requests and image attachments are not request-compressed

Impact: medium for large persisted snapshots and image prompts

Confidence: high

Gateway command bodies can carry durable snapshots up to tens of megabytes.
The browser sends these as uncompressed JSON. Inline prompt images are data
URLs, so already-compressed PNG, JPEG, GIF, or WebP bytes receive base64's
approximately 33% expansion before JSON and HTTP framing.

Response compression does not solve request uploads. Browsers do not
automatically gzip arbitrary `fetch` request bodies.

#### Recommendation

For image prompts:

- add a binary or multipart attachment-upload endpoint;
- return a short-lived attachment handle;
- send the handle in the prompt JSON;
- retain size, MIME, authorization, cleanup, and request-deduplication checks.

For large text-heavy durable snapshots:

- prefer smaller revisioned updates over whole-snapshot writes;
- optionally support `Content-Encoding: gzip` for command requests above a
  threshold;
- enforce limits on both encoded and decoded bytes;
- decompress as a bounded stream rather than buffering an untrusted expanded
  body without a cap.

Binary image upload is a natural use of binary transport. A general protobuf
conversion is not required.

### 8. Dynamic JSON responses are not compressed

Impact: medium, concentrated in large snapshots and transcripts

Confidence: high

The gateway's JSON response helper serializes and returns raw JSON with
`Cache-Control: no-store`. Small command results do not justify compression,
but environment snapshots, build-pipeline state, prompt queues, terminal
snapshots, and agent transcripts can be large.

#### Recommendation

Add threshold-based dynamic compression for non-streaming responses:

- no compression below approximately 1 to 4 KiB;
- gzip at a moderate level for dynamic JSON;
- Brotli only if asynchronous implementation and measured CPU cost are
  acceptable;
- `Vary: Accept-Encoding`;
- preserve `no-store` for private dynamic state.

Do not apply a generic buffering compression middleware to SSE. Streaming
compression can delay frames until an internal buffer fills. If SSE compression
is tested, it must flush after frames and be verified in Safari and `WKWebView`
under low-volume token output as well as heavy output.

## JSON versus binary

| Traffic | Recommended representation | Reason |
| --- | --- | --- |
| Small commands and status | JSON | Low volume, easy validation and debugging |
| Resource change announcements | JSON with revision/cursor | Repetition and recovery matter more than encoding |
| Full state snapshots | Compressed JSON, then reduce snapshot frequency | Compatible and highly compressible |
| Claude/OpenCode/Codex message deltas | JSON patches | Data elimination is larger than codec savings |
| Terminal input/output | Binary WebSocket frames | Natural byte stream; removes base64 and POST overhead |
| Image/file upload | Multipart or binary upload | Removes base64 expansion and large JSON allocation |
| Static application assets | Brotli/gzip with immutable caching | Largest measured cold-load improvement |

CBOR or MessagePack could modestly reduce metadata payloads and parse overhead,
but they would introduce:

- a second schema/versioning surface;
- custom debugging tooling;
- additional browser bundle code;
- conversion boundaries around APIs that remain JSON;
- more complicated backward compatibility.

They should be considered only after instrumentation shows JSON parsing itself
is a material CPU cost on target iPhones. Repeated full messages and
uncompressed assets are already demonstrably larger problems.

## Proposed delivery plan

### Phase 0: instrumentation

Add counters before changing protocols:

Backend and bridges:

- response bytes by route and content encoding;
- event frames and bytes by event type;
- terminal raw bytes versus encoded frame bytes;
- invokes by command, count, request bytes, response bytes, and duration;
- active, connecting, and dropped streaming clients;
- replay hits, cursor expirations, and full reconciliations;
- compression CPU time.

Browser:

- `PerformanceResourceTiming.transferSize`;
- `encodedBodySize` and `decodedBodySize`;
- application boot milestones;
- open streaming connection count;
- terminal input-to-visible-echo latency;
- event receipt-to-render latency;
- reconcile request count and bytes.

Metrics must not contain prompt text, terminal contents, file contents, tokens,
or credentials.

### Phase 1: static delivery and code splitting

Implement:

- precompressed assets;
- immutable cache headers;
- index revalidation;
- WOFF2 terminal fonts;
- lazy Monaco and secondary feature chunks.

Suggested acceptance criteria:

- main JavaScript transfer is below 900 KiB with gzip and below 750 KiB with
  Brotli for the current feature set;
- a repeat load does not transfer unchanged hashed assets;
- restoring a layout without a file tab does not download Monaco;
- the desktop `file://` renderer path continues working;
- iOS cold-load and repeat-load behavior are measured separately.

### Phase 2: terminal transport

First, measure current input request frequency and existing output coalescing.
Then implement either input micro-batching or a multiplexed WebSocket prototype.

Suggested acceptance criteria:

- ordinary typing does not create one HTTP request per character;
- a 1 MiB terminal output test transfers materially fewer bytes;
- key-to-echo p95 does not regress on LAN;
- key-to-echo p95 improves or remains stable at 100 ms RTT;
- output snapshot recovery remains exact after a forced disconnect;
- one slow terminal does not grow backend memory without bound;
- inactive mounted terminals do not receive other sessions' output.

### Phase 3: gateway replay and revision-aware sync

Implement cursor-based replay for authoritative gateway events and keep the
current snapshot fallback.

Suggested acceptance criteria:

- a short network interruption replays events without full resource hydration;
- an expired cursor produces one explicit reconcile path;
- a stable remote client no longer performs broad full resyncs every minute;
- background/foreground transitions on iOS converge projects, environments,
  pipelines, prompts, sessions, pending interactions, and terminal output;
- subscribe-before-replay ordering is covered by tests;
- replay storage is bounded by both frames and bytes.

### Phase 4: Codex message patches

Port the proven Claude patch model to Codex.

Suggested acceptance criteria:

- after the initial message, ordinary text streaming sends only changed parts;
- missed or out-of-order revisions trigger authoritative reconciliation;
- approvals and interactions remain ordered relative to visible message state;
- a large command-output turn no longer sends the complete accumulated output
  on every scheduled update;
- the app-server stdout loop never awaits rendering or client delivery.

### Phase 5: preview and large-payload optimization

Implement:

- recompression after browser-preview rewriting;
- threshold compression for dynamic JSON responses;
- binary or multipart prompt attachments;
- request compression only where measurement justifies it.

### Phase 6: connection multiplexing

Use iOS connection telemetry to decide whether bridge event brokerage is
necessary. Avoid committing to a gateway-wide event protocol rewrite without a
reproducible connection-limit or energy-use result.

## Validation matrix

Every phase should be tested under:

| Dimension | Cases |
| --- | --- |
| Client | Desktop browser, Electron renderer, iPhone `WKWebView`, iPad `WKWebView` |
| Link | LAN, 100 ms RTT, 2–5 Mbps constrained bandwidth, packet loss/interruption |
| App state | Foreground, background, screen lock, foreground recovery |
| Workload | Idle, terminal flood, ordinary typing, paste, long Codex turn, multiple active environments |
| Reconnect | Short replayable gap, expired cursor, backend restart, bridge restart |
| Assets | Cold load, warm load, new release with changed hashes |

The inactive-environment path is mandatory:

1. Start work in environment A.
2. Switch to environment B or another project.
3. Let A stream, request an interaction, or finish.
4. Background and foreground iOS where applicable.
5. Return to A.
6. Verify status, transcript, pending prompts, approvals, terminal output, and
   controls against authoritative backend snapshots.

## Risks and invariants

Transport optimization must not weaken these invariants:

- Long-running state remains in the backend, bridge, persistent store, or
  external process, not only in mounted React state.
- Live events are incremental hints over an authoritative snapshot.
- A missed event is detectable through a revision gap, generation change, or
  explicit reconcile frame.
- Terminal frames may be dropped only with bounded recovery.
- Authoritative state events must not be silently dropped.
- Reconnect logic must not duplicate prompt dispatch.
- Approval timeout, disconnect, generation death, and malformed answers deny
  rather than approve.
- A Codex app-server stdout reader must never await browser or SSE work.
- Replay registration happens before replay calculation.
- Every streaming and compression buffer has byte and count bounds.
- Compression decisions include `Vary: Accept-Encoding`.
- No metric or diagnostic log contains credentials or user content.

## Recommended order of work

The recommended priority is:

1. Instrumentation.
2. Static compression, caching, WOFF2, and code splitting.
3. Terminal input transport and binary WebSocket prototype.
4. Gateway replay and removal of frequent broad resyncs.
5. Codex message patches.
6. Browser-preview and large JSON compression.
7. Binary attachment upload.
8. Broader bridge-stream multiplexing if iOS data supports it.

This order captures the largest measured gains early while keeping protocol and
correctness risk controlled.
