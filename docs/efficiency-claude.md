# Remote connection efficiency — 2026-07-28

Scope: the data path between the backend and remote clients — the web UI loaded
over Tailscale and the iOS app. Covers `apps/backend/src/gateway.ts`,
`apps/backend/src/core` (terminal/tmux payloads), the `apps/web` data layer,
`bridges/codex-bridge`, `bridges/claude-bridge`, and
`apps/ios/OrkestratorMobile`.

This complements `docs/performance-review-2026-07-28.md`, which audited CPU, I/O
and cross-process traffic. That review never examined the **wire** — neither it
nor `docs/performance-remediation-status-2026-07-28.md` mentions compression at
all. This document covers that axis plus the payload-shape issues that survived
the earlier remediation.

Overall: the flow-control and delta machinery on this path is genuinely good —
SSE replay cursors, per-client subscription filters, soft/hard backpressure with
explicit desync recovery, the claude-bridge patch protocol, watcher-driven diff
stats. The remaining cost is almost entirely that **none of it is compressed**,
plus a small number of payloads that are structurally larger than they need to
be.

---

## Executive summary — top issues by expected win

| # | Issue | Where | Impact |
|---|-------|-------|--------|
| 1 | Nothing is compressed on any hop — JSON responses, the SSE event stream, and the static bundle all travel raw over the tailnet | `gateway.ts` | High |
| 2 | Static assets have no `ETag`, `Last-Modified` or `Cache-Control` whatsoever; a multi-MB un-code-split bundle is re-downloaded every load | `gateway.ts:1754-1758` | High |
| 3 | Codex bridge re-sends the entire transcript message on every 100 ms frame — quadratic in message size (~77 MB pushed for a 256 KB result) | codex-bridge | High |
| 4 | tmux emits clear-screen + a full pane repaint per change at up to 4 Hz; the dedup check only catches byte-identical frames | `core/tmux.ts:2595-2607` | Medium |
| 5 | Terminal bytes carry a 1.33× base64 tax that buys nothing — the data is UTF-8 text `JSON.stringify` already makes safe | `core/commands.ts:2516`, `core/tmux.ts:237` | Medium |
| 6 | Terminal reconnect replays the whole 500 KB buffer; both sides already track revisions, only the `?since=` parameter is missing | `core/commands.ts:7571` | Medium |
| 7 | `get_environments` returns raw records including up to 32 MB of base64 attachments, a per-environment duplicated model catalog, and two backend-internal fields | `core/models.ts:102-186` | Medium |
| 8 | Four polling loops refetch full snapshots on a timer with revisions available but ungated | `apps/web` | Medium |

---

## Transport shape (what exists today)

Worth stating plainly, because it constrains every option below.

There is exactly **one** remote-facing server: `OrkestratorGateway`
(`apps/backend/src/gateway.ts`), a hand-rolled `node:http` `createServer` with
no framework and no middleware layer. Route dispatch is a chain of
`if (url.pathname === …)` (`gateway.ts:1225-1293`).

**There are no WebSockets anywhere.** A repo-wide search for
`WebSocket|ws://|wss://` across `apps/backend/src`, `apps/web/src`,
`apps/desktop/electron`, `packages`, `bridges/*/src` and `apps/ios` returns zero
non-test hits. Everything is HTTP/1.1 + JSON, with SSE as the only push channel:

- **RPC** — `POST /__orkestrator/invoke`, `{command, args}` → `{result}` or
  `{error}`. Request bodies up to 48 MB (`MAX_INVOKE_BODY_BYTES`,
  `gateway.ts:79`); responses unbounded.
- **Events** — `GET /__orkestrator/events`, one frame per backend event:
  `` `data: ${JSON.stringify({ event, payload })}\n\n` `` (`gateway.ts:995`).
- **Bridge streams** — Claude/Codex/OpenCode SSE reached through the gateway's
  loopback proxy `/__orkestrator/proxy/loopback/<port>/…`
  (`gateway.ts:1498-1519`, `proxyToTarget` at `1543`).

Remote reach is Tailscale-only: raw tailnet HTTP (`gateway.ts:136-162` refuses
non-tailnet binds), or `tailscale serve` HTTPS terminating on the same host
(`apps/backend/src/tailscale-serve.ts:168-174`). TLS termination is a plain Go
reverse proxy with no compression configured, and WireGuard does not compress.
**The wire is uncompressed end to end.**

The iOS app is a SwiftUI + WKWebView shell
(`apps/ios/OrkestratorMobile/Views/RemoteWebView.swift`) that logs in natively
for the cookie and then loads the same web bundle. It has no independent fetch
logic, so every finding here applies to it with worse RTT and bandwidth.

---

## Measurements

Run against Bun 1.3.14 in this workspace. These are measurements, not estimates,
and they drive the recommendations below.

| Measurement | Result |
| --- | --- |
| gzip-6 on realistic tmux pane frames (13.8 KB, high-entropy content) | **14.2×** |
| Same content, repetitive | 40.4× |
| CPU per 13.8 KB frame at level 6 | 0.065 ms → 4 clients × 10 fps = **0.26 % of one core** |
| Level 1 vs level 6 | 0.061 ms vs 0.065 ms — level 1 is not worth the ratio loss |
| brotli q4 vs gzip-6 on a 1.16 MB invoke body | **20,214 B vs 49,093 B**, both ~2 ms |
| brotli q11 on the same body | 1318 ms — build-time only |
| brotli q4 vs gzip-6 at small sizes | 532→79/113; 3182→146/234; 16102→435/847 (br wins at every size) |
| Shared deflate context vs stateless per-frame gzip | 14.2× vs 12.0× — **+19 %** for keeping the stream |
| Sync-flush per frame vs coalescing 10 frames (100 B events) | 8.5× vs 19.8× — ~7 bytes/event difference |
| `gzipSync` vs async `zlib.gzip` on 18.8 MB | **33 ms vs 2 ms** event-loop lag (Bun runs async zlib off-thread) |

---

## 1. No compression on any hop (HIGH)

`zlib` is imported at `gateway.ts:16` but **only to decompress** upstream
browser-preview bodies (`browserPreviewContentDecoder`, `gateway.ts:575-583`).
`Accept-Encoding` from the client is never inspected. The only other mentions
are the gateway *forcing encoding off* toward a preview target
(`gateway.ts:1572`) and deleting `content-encoding` after rewriting a preview
body (`gateway.ts:1657`).

All three response paths ship raw:

```ts
// jsonResponse — gateway.ts:228-233
response.writeHead(statusCode, {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  ...headers,
});
response.end(JSON.stringify(payload));
```

```ts
// handleEvents — gateway.ts:1453-1458
response.writeHead(200, {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
});
```

```ts
// serveStatic — gateway.ts:1754-1758
response.writeHead(200, {
  "content-type": mimeType(filePath),
  "content-length": fileStat.size,
});
createReadStream(filePath).pipe(response);
```

Both client types — browsers and WKWebView/`URLSession` — already send
`Accept-Encoding: gzip, deflate, br` and decompress transparently. **This is a
server-only change; iOS needs no work.** `tailscale serve` forwards
`Accept-Encoding` and `Content-Encoding` transparently, so gzip added at the
gateway survives that hop.

### Both gzip and brotli are required

Not a preference. Chrome and Firefox advertise `br` only over HTTPS, and the two
remote paths differ: raw tailnet `http://100.x.y.z:34121` is **gzip-only**, while
`tailscale serve` HTTPS is br-capable. Honour `Accept-Encoding` and implement
both.

Recommended per path:

| Path | Encoding | Threshold |
| --- | --- | --- |
| `jsonResponse` | brotli q4 preferred, gzip 6 fallback, **async** one-shot | 1024 B |
| SSE `/events` | gzip only, streaming, `flush: Z_SYNC_FLUSH` | none — a repeat frame costs 9 bytes |
| `serveStatic` | precompressed `.br` (q11) / `.gz` (9) siblings; on-the-fly br q5 / gzip 6 fallback | 1024 B |
| Loopback proxy | gzip sync-flush for `text/event-stream`, brotli q4 otherwise | 1024 B |

The async requirement on `jsonResponse` is not optional: `/invoke` accepts up to
48 MB, and a synchronous compress of that stalls the event loop — and therefore
every connected SSE client — for ~85 ms.

Excluded content types: `font/woff2` (already brotli'd internally), images, and
`application/octet-stream` — which is `mimeType()`'s default, so never compress
unknown bytes.

### The `Vary` trap

`applyCorsHeaders` (`gateway.ts:1127-1129`) sets `vary: Origin` via
`setHeader`. A later `writeHead(200, { vary: "Accept-Encoding" })` **silently
clobbers it** (verified). Any code adding `Vary` must merge with the existing
value, or CORS caching breaks quietly.

### SSE compression must not defeat the existing flow control

This is the one genuinely hard part, and it is worth spelling out because the
obvious implementation is silently wrong.

`emit()` (`gateway.ts:982-1031`) implements per-client flow control by reading
`client.writableLength` on the `ServerResponse`: terminal frames are dropped past
`SSE_CLIENT_SOFT_BUFFER_BYTES` (1 MB, `gateway.ts:97`) with an explicit desync
notice, and the client is destroyed past `SSE_CLIENT_HARD_BUFFER_BYTES` (8 MB,
`gateway.ts:104`).

Measured: with `gz.pipe(response)` and a stalled client, `res.writableLength`
**pins at 16977 bytes forever** while 25 MB accumulates in `gz.writableLength`.
Both limits become dead code, on exactly the slow links this work targets.

Three accounting strategies were evaluated:

- **Sum `gz.writableLength + gz.readableLength + res.writableLength`** — works
  arithmetically today, but depends on an undocumented internal
  (`WritableState.length`) matching between Bun and Node, and mixes pre- and
  post-compression units in one number compared against a pre-compression
  threshold. Rejected as an implicit contract on a safety mechanism.
- **`gz.flush(Z_SYNC_FLUSH, cb)` and account in the callback** — **empirically
  broken**: under backpressure only **17 of 400** flush callbacks fired. The
  accounting freezes precisely when the client is falling behind.
- **Track pre-compression bytes in the `gz.write(chunk, cb)` callback** —
  tracked the true backlog within ~5 % and returned to exactly 0 on recovery.
  **Recommended.**

The clean way to express this is to notice that `emit()` only ever touches three
members of its map key:

```ts
export interface EventClientWriter {
  readonly writableLength: number;   // ALWAYS uncompressed bytes still owed
  write(chunk: string): boolean;
  destroy(): void;
}
```

A plain `ServerResponse` satisfies it natively, so the identity path stays
byte-for-byte what ships today and `emit()` needs **zero logic changes** — only
the loop variable's type. The soft/hard constants keep their exact
justification: they bound the uncompressed strings retained in the backend heap,
which is unchanged; those bytes simply sit in the compressor's queue instead of
the socket's. Compression makes the limits fire *less* often, which is the point
— 1 MB of owed bytes drains ~14× faster.

Three details that are easy to get wrong:

- **Use `createGzip({ flush: Z_SYNC_FLUSH })` as a constructor option**, not a
  per-frame `.flush(cb)` call. Every `write()` then becomes its own flushed
  deflate block and lands immediately.
- **`destroy()` must destroy the gzip explicitly.** `res.destroy()` leaves a
  piped compressor alive (`gz.destroyed === false`, verified), leaking ~256 KB
  of native context per client — on `dropBufferedClient`, the path that fires
  when things are already going badly.
- **Write one extra `:\n\n` priming frame at connect.** A compressed stream's
  first decompressed chunk is withheld by the client until a second arrives —
  measured 400 ms delay on `: connected`, and on a quiet stream that could
  stretch to the 25 s keepalive. Costs ~10 bytes.

Consequent edits are mechanical: `flushDesyncNotices` (`gateway.ts:1074`) and
`markTerminalFrameDropped` (`gateway.ts:1033`) take the interface and keep their
pre-compression arithmetic; `droppedTmuxFrames` (`gateway.ts:745`) rekeys to the
writer; the `drain` handler (`gateway.ts:1474`) moves to the compressor's
writable side; the keepalive (`gateway.ts:1482`) reads the writer's true backlog
rather than becoming dead code.

**Do not coalesce frames before flushing.** The measured gain is ~7 bytes per
small event, bought with a latency source and a re-entrancy hazard in the most
correctness-sensitive code in the file. Large tmux frames lose almost nothing to
per-frame flushing (14.2× vs 14.4×).

`cache-control: no-store, no-transform` (`gateway.ts:1455`) should **stay**. It
forbids intermediaries from re-encoding; it does not constrain the origin
choosing its own content-coding.

### Where to compress the bridge hop

Compress **at the gateway**, forcing `accept-encoding: identity` upstream, not
with hono's `compress()` at the bridges. Hono's
`COMPRESSIBLE_CONTENT_TYPE_REGEX` begins `text\/(?!event-stream(?:[;\s]|$))` —
it explicitly excludes event streams, so bridge transcript deltas would get
nothing. The gateway is also the only remote-facing hop, already knows
`listenerKind`, and is source-controlled where the bridges are vendored build
artifacts.

`pipeline()` gives correct backpressure for free on this path — a slow client
pauses `proxyResponse`, which pauses the bridge. Unlike `emit()` there is no
shared broadcast buffer to protect, so none of the `EventClientWriter` machinery
belongs here. Worth a comment saying so.

Note the existing `delete headers["content-encoding"]` at `gateway.ts:1657` is
**not** a bug and should be left alone: it sits inside the browser-preview
branch (`gateway.ts:1598`), which decodes and rewrites bodies and separately
forces `accept-encoding: identity` upstream at `gateway.ts:1572`. The
non-preview path already passes encoded bodies through verbatim.

### Kill switch, and the loopback gate

Add `compression?: "off" | "body" | "on"` to `OrkestratorGatewayOptions`
(default `"on"`), resolved constructor-option-first then
`ORKESTRATOR_GATEWAY_COMPRESSION`, matching the existing `keepaliveMs` /
`ORKESTRATOR_GATEWAY_DISABLED` pattern (`gateway.ts:768-775`), plus a
`--compression <mode>` flag in `apps/backend/src/options.ts`. The `"body"` middle
setting compresses JSON/static/proxy but leaves SSE identity — the field escape
hatch if WKWebView turns out to buffer compressed event streams.

**Gate on `listenerKind`, never on the bind address.** The gateway creates two
listeners (`gateway.ts:806-829`) and `listenerKind` is already threaded through
`handle()`. The `control` listener is Electron main ↔ backend over loopback,
where compression is pure loss. An `isLoopbackAddress()` check would be actively
wrong: under `--tailscale-serve` and `--desktop-web-client` the *browser*
listener also binds `127.0.0.1` (`apps/backend/src/main.ts:45-47`) while serving
genuinely remote clients.

---

## 2. Static assets have no caching at all (HIGH)

`serveStatic` (`gateway.ts:1720-1759`) sends no `ETag`, no `Last-Modified`, no
`Cache-Control` and no `Range` support. There is no revalidation path, so every
cache miss is a full uncompressed body.

What is being re-downloaded: `apps/web/package.json` pulls in `monaco-editor`,
`@xterm/xterm` plus three addons, the full TipTap suite, `react-markdown` +
`unified` + `remark-*` + `marked`, `react-virtuoso` and 18 Radix packages.
`apps/web/vite.config.ts` has **no `build` block at all** — no `manualChunks`, no
`rollupOptions` — and there is no `React.lazy` code splitting in production
source, so this is essentially one giant entry chunk.

On iOS it is worse: `websiteDataStore = .nonPersistent()`
(`RemoteWebView.swift:16`) discards the HTTP cache with the app process, so the
entire bundle is re-fetched on **every cold launch**. The main document also uses
`.reloadIgnoringLocalAndRemoteCacheData` with a `Cache-Control: no-store` request
header (`RemoteWebView.swift:122-128`) — correct for the navigation, but it means
subresource caching is the only thing that can help, and there is none.

For contrast, the Vercel-hosted shell already does this properly:
`apps/web-public/vercel.json` sets `Cache-Control: public, max-age=31536000,
immutable` on `/assets/*`. The Bun gateway has no equivalent.

**Fixes:**

- `ETag` + `Last-Modified` from size and mtime, with `304` handling for
  `If-None-Match` / `If-Modified-Since`. The ETag **must include the encoding** —
  identity and br of the same file cannot share a validator, or a cache can hand
  a br body to a client that cannot decode it.
- `Cache-Control: public, max-age=31536000, immutable` for hashed `/assets/*`
  (Vite emits content-addressed names); `no-cache` for `index.html` and the SPA
  fallback, which name the hashed bundles and must revalidate every load.
- `Vary: Accept-Encoding` on **every** static response, including identity.
- Serve precompressed `.br`/`.gz` siblings when present, **guarded on
  `sibling.mtimeMs >= source.mtimeMs`** so a leftover from an earlier build is
  never pinned behind `immutable`. Fall back to on-the-fly compression so a plain
  `vite build` still benefits.
- Derive the sibling path from the already-validated `filePath`, never from the
  raw URL, so the existing traversal guard (`gateway.ts:1734`) still covers it.
- Generate siblings with a new `apps/web/scripts/precompress.ts` (a Bun script,
  matching the `apps/backend/scripts/build.ts` convention — no new dependency) at
  brotli q11 / gzip 9, skipping any sibling larger than its source. `apps/web/turbo.json`
  already declares `outputs: ["dist/**"]` and the root packaging copy uses filter
  `**/*`, so siblings ride along with no packaging change.

Build-time beats on-the-fly decisively here: brotli q11 is 1318 ms/MB — unusable
per request, ideal once per build, and ~10-30 % better than q4 on JS.

---

## 3. Codex bridge re-sends the whole message every frame (HIGH)

`publishAssistantMessage` (`bridges/codex-bridge/src/app-server-runtime.ts:1910-1934`):

```ts
const rendered = await renderTurn(turn, { … });
message.parts = rendered.parts;
message.content = rendered.content;
state.lastPublishedSnapshotChars = normalizedMessageSnapshotChars(message);
this.bumpMessageRevision(context);

for (const sessionId of context.bridgeSessionIds) {
  this.options.emit({ type: "message.updated", sessionId, data: { message } });
}
```

`bridges/codex-bridge/src/messages/coalescer.ts:10-12` documents this as
deliberate — "each publish is a **full normalized snapshot** rather than a patch,
[so] a dropped intermediate frame is unobservable."

The cost is quadratic in message size. At the base 100 ms interval
(`messageSnapshotIntervalMs`, `app-server-runtime.ts:169-173`), a message growing
to 256 KB over 60 s emits ~600 frames averaging ~128 KB — **~77 MB pushed to each
subscriber for a 256 KB result**. The interval backoff (250 ms above 256 KB,
500 ms above 1 MB) only softens the constant: a 1 MB message still sends 1 MB
every 500 ms. Every completed tool part, reasoning block and `ToolDiffMetadata`
(`before`/`after` up to 256 KB each, `diff-budget.ts:30`) is re-serialized in
every frame.

The mitigations in place are real but partial: per-session filtering collapses
other sessions' frames to a 64-byte cursor (`frameFor`, `index.ts:1520-1544`),
retained ring entries are superseded by tombstones
(`supersedeRetainedSseEvent`, `index.ts:204-222`), and serialization is lazy with
no subscriber. None of them help the subscriber actually watching the turn.

**Fix:** port the claude-bridge protocol. It already solves exactly this —
`message.patched` with `changedParts`
(`bridges/claude-bridge/src/services/session-manager.ts:4028-4093`, type at
`bridges/claude-bridge/src/types/index.ts:477-491`), where `isSamePublishedPart`
(`session-manager.ts:2767-2780`) compares tool parts **by object identity** so a
completed 512 KB diff is sent once rather than every 100 ms. Include the revision
guard and the full-snapshot resend when the message id changes.

This can be sequenced last: compression alone already buys ~14× on these frames.

---

## 4. tmux full-pane repaints (MEDIUM)

`apps/backend/src/core/tmux.ts:2595-2607`:

```ts
const snapshot = await terminal.tmux.capturePane({ ansi: true, joinWrapped: false });
if (!force && snapshot === terminal.lastSnapshot) { /* back off */ return; }
context.emit(`terminal-output-${terminal.id}`,
  bytesPayload(`\x1b[H\x1b[2J${snapshot.replaceAll("\n", "\r\n")}`));
```

Every change emits clear-screen plus the entire pane with ANSI attributes. A
200×50 coloured pane is ~30-60 KB, and `INTERACTIVE_SNAPSHOT_MIN_MS = 250`
(`tmux.ts:2478`) allows up to ~240 KB/s per visible terminal for what is usually
a few changed cells. The `snapshot === lastSnapshot` guard only suppresses
byte-identical frames — a blinking cursor or a spinner defeats it entirely.

**Fix:** `terminal.lastSnapshot` is already retained right there. Emit a
line-level diff against it, with a full repaint on desync or on `force`.

Related, at a lower cadence: `apps/web/src/lib/claude-tmux-polling.ts:1-2` polls
a full pane capture at 500 ms visible / 3 s hidden, and
`getClaudeTmuxCapturePolling` returns `enabled: showTui || running` — so every
*running* Claude-tmux environment polls at 3 s even when not visible, N
environments × full pane each.

---

## 5. Terminal base64 buys nothing (MEDIUM)

`apps/backend/src/core/commands.ts:2516-2527` and
`apps/backend/src/core/tmux.ts:237-239` encode terminal bytes as base64, decoded
client-side with `atob` plus a per-byte `charCodeAt` loop
(`apps/web/src/hooks/useTerminal.ts:31-50`).

The comment at `commands.ts:2508-2515` explains the history correctly: base64 at
1.33× replaced JSON number arrays at up to 4×, which was a clear win and is
recorded as item 6 in `docs/performance-remediation-status-2026-07-28.md`. But
PTY data is UTF-8 text, and `JSON.stringify` already makes it JSON-safe — so the
remaining 1.33× buys nothing. Sending the string directly is a flat 25 % off the
highest-frequency stream, plus it removes the decode loop.

**Fix:** add a plain-string payload form; the client already accepts several
shapes, so keep the base64 branch for one release. This supersedes rather than
contradicts the earlier remediation.

Compression makes this a secondary concern — gzip's 14× dwarfs 1.33× — but it is
cheap and also removes client CPU.

---

## 6. Terminal reconnect replays the whole buffer (MEDIUM)

`get_terminal_output_snapshot` (`apps/backend/src/core/commands.ts:7571-7579`)
returns the entire rolling buffer — `MAX_TERMINAL_OUTPUT_BUFFER_CHARS = 500 * 1024`
(`commands.ts:239`). `useTerminal.ts:400` calls it on mount and on **every**
reconcile, including after a single dropped frame.

Both halves of the information needed to do better already exist: the client
tracks `lastAppliedRevision` with gap detection
(`useTerminal.ts:354-540`), and the backend tracks per-chunk revisions in
`terminalOutputBuffers`. Only the `?since=<revision>` parameter is missing.

**Fix:** accept `since` and return only the delta, falling back to the full
buffer when the requested revision has aged out. Turns reconnect cost from
O(buffer) into O(gap) — meaningful when N terminals are mounted on a flaky mobile
link.

---

## 7. The `Environment` wire record is fat (MEDIUM)

`get_environments` (`apps/backend/src/core/commands.ts:6323`) returns raw stored
records with no field projection. From `apps/backend/src/core/models.ts:102-186`:

| Field | Line | Why it is waste on the wire |
|---|---|---|
| `initialPromptAttachments` | 183 | Up to 32 MB of base64, relevant only pre-launch |
| `claudeModelCatalog` | 161 | 2-4 KB duplicated per environment — 20 envs ≈ 40-80 KB of identical data per response |
| `agentActivitySources` | 134 | Documented in-file as "Backend-internal observations" |
| `frontendAgentActivityObservers` | 141 | Other clients' per-renderer lease bookkeeping |
| `initialPrompt`, `pendingRenamePrompt` | 181, 185 | Full prompt text, relevant only pre-launch |

Worse, `InitialPromptImageAttachment` (`models.ts:95-100`) stores the same image
**twice**: `previewUrl` is literally `"data:image/png;base64," + base64Data`
(`CreateEnvironmentDialog.tsx:547-563`). Both halves are persisted and both are
returned to every client on every list refetch until the environment launches —
with an 8 MB image that is ~21 MB of base64 per response.

**Fixes:** project the record for the wire; drop `previewUrl` from the model and
reconstruct it client-side with one concat.

Related: `useGlobalActivityMonitor.ts:892` renews leases every 10 s per
environment, and `setEnvironmentAgentActivity` returns a **complete**
`Environment` from which the handler (`:874-877`) reads exactly two fields. The
broadcast half of this loop was already fixed — `storage.ts:2039-2050` suppresses
the announcement for a pure lease renewal — but the response shape was not.

---

## 8. Ungated polling loops (MEDIUM)

The revisions needed to make these conditional already exist in every case; only
the conditional request is missing.

- **Build tab, 1 Hz full transcript.** `CodexBuildChatTab.tsx:1451` polls every
  second, and the refetch condition (`:1317-1329`) includes
  `previous.messageRevision !== status.messageRevision`. The bridge bumps that
  revision on every 100 ms coalescer publish, so during a running build the
  condition is true on essentially every tick — **the entire transcript is
  re-downloaded once per second**. There is no `?since=` on `getSessionMessages`.
- **60 s global resync.** `resource-sync.ts:43` → `store-resource-sync.ts:96-132`
  fires prompt-queue, session, looped-review and build-pipeline hydration for
  every environment and project unconditionally — ~70 full-snapshot round trips
  per client per minute at 20 environments / 5 projects. The heavy ones are
  opaque snapshots capped at 32 MB each (`storage.ts:2534`, `:2669`, `:3506`),
  and `hydrateBuildPipeline` compares `backendRevision` **after** downloading the
  whole thing.
- **Files panel, 5 s full tree.** `useFilesPanel.ts:10,337` refreshes both the
  file tree and the change list; the tree is capped at
  `MAX_LOCAL_FILE_TREE_NODES = 5_000` (`commands.ts:4565`), serializing to
  ~500-700 KB.
- **Environment announcements lack `projectId`.**
  `useEnvironmentListSync.ts:80-85` refetches **every** project's environment
  list on **any** environment announcement, with a comment explaining why: the
  announcement carries only the environment id, so a newly created environment
  cannot be mapped to a project. Adding `projectId` collapses this to one
  project. `announce("environment", …)` fires from ~54 call sites in
  `storage.ts`, including status transitions during an agent turn.

The global resync's breadth is **intentional** and documented in
`docs/performance-remediation-status-2026-07-28.md` — background environments
keep running while their React tree is inactive and must rehydrate after missed
events. The fix is to make each refetch conditional, not to narrow the sweep.

---

## 9. Smaller items

- **Redundant derived fields.** `GitFileChange` (`commands.ts:4623-4631`) carries
  `filename` and `directory` alongside `path`; file-tree nodes
  (`commands.ts:4583-4621`) carry `name` and `extension` alongside `path`. Both
  are ~40 % redundant bytes on payloads refetched every 5 s.
- **`DiffViewerTab` sends two whole files instead of a diff.**
  `DiffViewerTab.tsx:207-224` calls `readLocalFile` plus `readLocalFileAtBranch`
  — ~1 MB transferred for a one-line change in a 500 KB file, with no caching or
  de-duplication of the base-branch side across files or tabs.
- **`/invoke` buffers up to 48 MB before parsing** (`gateway.ts:79`, `322-357`).
- **Per-keystroke HTTP POST** for terminal input — the one direction with no
  coalescing at all. PTY *output* is well handled: 16 ms window with leading-edge
  immediate delivery and a 256 KB pending cap (`core/pty.ts:38-47`, `119-150`).
- **N fetch streams per terminal** for bearer/cross-origin clients
  (`web-gateway.ts:388-422`), where same-origin clients share one filtered
  EventSource.
- **Monaco is fetched from a CDN at runtime.** `@monaco-editor/react` is imported
  (`MonacoFileEditor.tsx:2-6`) with no `loader.config({ monaco })` anywhere in
  the repo, so it defaults to jsdelivr: a multi-MB third-party fetch when opening
  the file editor, a hard failure on a network-isolated tailnet, and a violation
  of `apps/web-public/vercel.json`'s `script-src 'self'` CSP.

For reference, `packages/protocol/src/diff-stats.ts` plus
`useEnvironmentDiffStats.ts` is the pattern to copy throughout: backend-computed,
three-integer delta events, full snapshot only on reconnect.

---

## What is already right

Worth recording so it does not get "optimized" away:

- Gateway SSE frames are serialized **once and shared** across clients
  (`gateway.ts:994-997`).
- Per-client subscription filters (`gateway.ts:669-712`) mean a browser receives
  only the terminal sessions it is displaying.
- Soft/hard backpressure with explicit desync recovery
  (`gateway.ts:982-1101`) — dropping is only defensible because the client is
  told, and it is.
- The claude-bridge `message.patched` protocol, its 4 MB / 512-frame replay ring,
  and the `WeakMap`-cached `serializeEventData` (`routes/events.ts:20-32`).
- The codex-bridge cursor-collapse and tombstone-supersede machinery
  (`index.ts:204-222`, `1520-1544`).
- PTY coalescing with leading-edge delivery (`core/pty.ts:38-47`).
- `no-transform` on the SSE stream, and `Accept-Encoding: identity` forced toward
  browser-preview targets.

---

## Suggested sequencing

1. **Shared primitives** — `negotiateEncoding`, `appendVary`,
   `isCompressibleContentType`, async `compressBody`, `COMPRESSION_MIN_BYTES`,
   the compression option/env/flag, and the `listenerKind` gate.
2. **`serveStatic` caching and validators**, without compression. Independently
   valuable and probably the single largest win.
3. **Precompressed siblings** plus the on-the-fly fallback.
4. **`EventClientWriter` with only the identity implementation** — retype
   `emit`, `flushDesyncNotices`, `markTerminalFrameDropped`, `droppedTmuxFrames`,
   the keepalive and `stop`. Confirm the existing suite is green before going
   further.
5. **`GzipEventWriter`**, the priming frame, and the drain rewiring.
6. **The loopback proxy hop.**
7. **Payload reduction** — items 4-8 above, in any order.
8. **Codex deltas** — item 3.

Steps 1-3 have no interaction with the flow-control machinery and can ship
independently of 4-6 if the iOS SSE check (below) turns up trouble.

---

## Verification

**The existing suite must pass untouched.** `tests/unit/electron/gateway.test.ts`
(~2145 lines) already has the scaffolding: `openEventStream`,
`pinBufferedBytes`/`releaseBufferedBytes`, `eventClients(gateway)`, `requestUrl`,
and it already imports `gzipSync`. That the identity-path fake-client tests at
`gateway.test.ts:237-530` keep passing unmodified is the primary evidence that
`emit()`'s semantics survived.

New tests, same file:

- **The critical one — a client that never reads.** Open a real stream over a
  `net.Socket` that never reads, then emit terminal frames of **incompressible**
  random bytes in a loop. Assert the client is dropped at the hard limit and
  leaves `eventClients(gateway)`. Incompressible payload is essential —
  repetitive data would legitimately never fall behind. This test fails against
  the naive `gz.pipe(response)` implementation, which is the point.
- **Soft-limit parity** — pinned above 1 MB → frame dropped, `desyncedSessions`
  records the session, and on drain the retained tmux full-pane frame (not the
  generic `{"desynced":true}` notice) is rewritten. Mirrors
  `gateway.test.ts:274-450` for the compressed writer.
- **Keepalive parity** (drive with `keepaliveMs: 10`), and no leaked gzip context
  after close or drop.
- **Priming frame** — pipe through `createGunzip()` and assert `: connected` is
  decodable *before any event is emitted*.
- **`vary`** contains both `Origin` and `Accept-Encoding` on a CORS invoke.
- **Static** — sibling selection, stale-sibling rejection via mtime, `304`
  round-trip, `immutable` on `/assets/*` vs `no-cache` on the SPA fallback, and
  the traversal guard still holding with the sibling lookup in place.
- **Proxy** — upstream sees `accept-encoding: identity`; an SSE frame is
  decodable before the upstream ends; an already-encoded body is not
  double-encoded; the browser-preview path is unchanged.
- **Kill switch** — `"off"` → identity everywhere; `"body"` → SSE identity only.

**Commands:** `bun test tests --parallel`,
`bun run --cwd apps/backend typecheck`, `bun run --cwd apps/web typecheck`.
`tests/unit/docs/remote-gateway-docs.test.ts` asserts against
`docs/remote-gateway.md`, so document the new flag and env var there.

**End to end:** `bun run dev`, enable the web client, load the UI from another
device on the tailnet. Confirm in devtools that `/invoke` responses carry
`content-encoding`, the event stream carries `content-encoding: gzip`, assets
return `304` on reload, and compare transferred bytes against `main` for an
equivalent session.

**Manual, and the one item that must be checked before defaulting to `"on"`:**
compressed `text/event-stream` through the real iOS WKWebView shell. This was not
verified during the review. If it buffers, ship `"body"` mode — note that the
usual padding workaround does not apply here, since 2 KB of padding compresses to
~30 bytes. Revisit `websiteDataStore = .nonPersistent()`
(`RemoteWebView.swift:16`) alongside the static caching work.
