# Efficiency review: data transfer and processing

Date: 2026-10-27. Checked against `main` at `1aabf049`.

## Scope and method

The review covered the whole repository, split into seven areas that were
read in parallel:

1. Backend gateway and transport (`apps/backend/src/gateway*.ts`, terminal
   WebSocket, preview proxy, web gateway client).
2. Native-agent transcript pipeline (`native-agent-*`,
   `http-bridge-*`, `packages/protocol/src/native-agent*.ts`).
3. The five bridges (`bridges/*`).
4. Renderer (`apps/web/src`: hooks, stores, chat, terminal, bundle).
5. Storage, change tracking, git and file endpoints.
6. Backend background loops and external process use (tmux, Docker, `gh`,
   workflows, mail).
7. Electron desktop, toolchain, Docker image and container data transfer,
   protocol and CLI.

Every finding below cites code that was read at the commit above. The
highest-impact claim in each area was then checked by hand a second time
(marked **[re-checked]**).

**Nothing was measured.** No benchmarks, test suites or live profiles were
run, so impact ratings are reasoned from the code: how often a path runs,
what it scales with, and how large its inputs are bounded to be. Treat them
as priorities for measurement, not as measured costs. The repository already
has the instruments to confirm them (see
[Measuring before changing](#measuring-before-changing)).

Ratings:

- **Impact.** High: runs continuously or on every user action and scales with
  history, environments or tabs. Medium: runs often but has a smaller
  working set, or is large but occasional. Low: occasional and bounded.
- **Confidence.** High: the mechanism was traced end to end. Medium: the
  mechanism is clear but frequency or size depends on the workload. Low:
  inferred.

### Relationship to existing work

The codebase has already done substantial efficiency work. Several findings
extend or add evidence to tracked items instead of opening new ones:

| Existing item | Overlap with this report |
| --- | --- |
| [0050 transcript history efficiency](../todo/transcripts-and-observation/0050-transcript-history-efficiency.md) | TX-1 to TX-18 sit on top of the shipped v2 summary routes. TX-10 is already owned by 0232. |
| [0052 remote client bandwidth](../todo/transcripts-and-observation/0052-remote-client-bandwidth.md) | GW-2 (SSE gzip default) and GW-7 (WebSocket compression) are 0052's code items 1 and 6, still waiting on measurement. GW-1 / WEB-1 are relevant to its data-saving work. |
| [0048 recurring work qualification](../todo/transcripts-and-observation/0048-recurring-work-qualification.md) | BG-1 to BG-7 are candidates for its busy live profile and soak runs. ST-7 generalises the keyed row read 0048 landed for feature planning. |
| [0022 container resource budgets](../todo/containers-and-environments/0022-container-resource-budgets-and-performance.md) | DK-7 to DK-14 (image layering, clone and input copies). 0022 records a decision against BuildKit cache mounts in `docker/Dockerfile`, which affects one of DK-9's suggested fixes. |
| [0027 multi-review scale and cost](../todo/coordinator-and-multi-review/0027-multi-review-scale-and-cost.md) | BG-10 (per-reviewer drift check in snapshot mode). |

## Executive summary

The app's design is mostly sound:

- Reads are conditional, revision tokens answer `unchanged`, and patches are
  negotiated.
- Recurring work is keyed, coalesced and bounded.
- Large bodies move behind locators, and every buffer has explicit bounds.

The remaining cost comes from a few repeated patterns, where a small change
still pays O(everything):

1. **Keyed reads decode whole stores.** `getEnvironment(id)`,
   `getNativeAgentSession(key)`, `getPromptQueue`, `getComposeDraft` and
   `getPaneLayout` each parse and validate every row of their store. They run
   on every transcript and state poll, and in several 2 s background jobs. A
   single-row primitive (`loadStoreRow` / `readStoreRow`) already exists and
   is used elsewhere. (ST-7, ST-8, TX-4, BG-4, BG-5)
2. **Live views poll instead of receiving pushes.** Each visible agent tab
   sends three POSTs every 500 ms while running. Each container tmux tab runs a
   250 ms exec loop that also repeats transcript discovery until a transcript
   exists. Mail presence refreshes every mailbox every 2 s, even with messaging
   disabled. The PR monitor polls every open PR every 20 s for as long as it
   stays open. (WEB-1, BG-1, BG-2, BG-3, BG-6)
3. **Whole structures are re-serialised or re-hashed for an incremental
   change.** This shows up in:
   - the delta base cache (one entry per view key, so a lagging client is
     stuck on full snapshots);
   - change-tracking captures, which read and hash every file and recount
     every diff on each pass;
   - ACP state persistence, which runs about every 25 ms while a turn streams;
   - bridges re-measuring whole transcripts and tool cards on each update.

   (TX-1, TX-3, ST-1, ST-4, BR-1 to BR-6)
4. **Quadratic stream framing.** The shared SSE decoder rescans its pending
   buffer from the start on every chunk. ACP stdout framing does the same.
   Codex already has the incremental version. (GW-4, BR-12)
5. **The local desktop skips the optimised transport.** Electron main opens
   an unfiltered event stream and relays every event, terminal output
   included, to every window over IPC. The browser path filters terminal
   output out and uses the binary terminal WebSocket. (DK-1, DK-2)
6. **Startup and image transfer.**
   - Every desktop launch SHA-256s about 1.2 GB of tool binaries twice before
     the backend starts.
   - Image layer order makes every bridge release re-pull about 225 MB of
     unchanged layers.
   - npm caches and a second Bun copy are probably left in the image.

   (DK-3, DK-7 to DK-9)

### Top opportunities

Ordered by expected payoff for the effort. "Size" is a rough guide to how
much code has to change.

| # | Finding | Impact | Size | Notes |
| --- | --- | --- | --- | --- |
| 1 | ST-7 / ST-8: route keyed getters through `loadStoreRow`; update the row cache in place on `updateStoreRow` | High | Small–Medium | Removes whole-store parses from every poll and background job. |
| 2 | WEB-2: stop the "unchanged" poll path from writing a fresh `identity` object, and drop the `lastKey` bail-out condition | High | Small | Stops a full `AgentNativeTab.controller` re-render on every unchanged poll. |
| 3 | WEB-3: hydrate per-environment workflow lists once per new environment ID, not on every change to the `environments` array | High | Small | 3 × N RPCs on every environment change today. |
| 4 | BG-1 / BG-2: throttle tmux transcript discovery; fold liveness and capture into the snapshot exec; back off when idle | High | Small–Medium | About 16 `docker exec`/s per idle unbound container tab. |
| 5 | TX-2: stop the unlimited raw `/messages` read after every dispatch or control change | High | Small–Medium | Up to 16 MiB per prompt send on long sessions. |
| 6 | TX-1: keep a small ring of recent views as delta bases | High | Medium | Fixes a lagging or second viewer being stuck on full snapshots. |
| 7 | ST-1 / ST-4: skip the read and hash when the stat stamp matches; memoise line counts by blob pair | High | Small–Medium | Change tracking during long turns. |
| 8 | BR-1: debounce ACP persistence to about 1–2 s, or persist at row and turn edges | High | Small | The only bridge that persists per chunk. |
| 9 | BG-3: gate mail presence on messaging enabled and environment running | Medium-High | Small | Runs every 2 s over every tab. |
| 10 | GW-4: make the SSE decoder incremental | Medium | Small | One fix in `packages/protocol` covers desktop, web, bridges and federation. |
| 11 | DK-3: stamp-based toolchain verification | High (startup) | Medium | About 2.4 GB of hashing per launch. |
| 12 | DK-1: local windows use the filtered gateway transport | High | Medium–Large | Removes terminal output fan-out over IPC. |
| 13 | WEB-1 / TX-5: take discovery out of the 500 ms round; add a combined update read or long-poll | High | Medium–Large | The largest structural request-count win. |
| 14 | BG-6: PR monitor backoff by `updatedAt` and batched GraphQL or REST with ETags | Medium-High | Medium | GitHub budget, and one `gh` process per PR every 20 s. |
| 15 | DK-7 / DK-8 / DK-9: image layer order, duplicate Bun, npm cache | Medium-High | Small | Pull size on every update. |

## Cross-cutting themes

### T1. Whole-store decode on keyed reads

The SQLite layer keeps raw row text in its cache. `readStore` re-parses every
row on each call (`apps/backend/src/core/storage-database.ts:422-426`,
`packages/protocol/src/node/storage-database.ts:44-56`) **[re-checked]**, and
`updateStoreRow` drops that cache. Keyed getters are written as "load all,
then find" (`storage-projects.ts:551-556`, `storage-native.ts:424-433`)
**[re-checked]**. These getters sit on the transcript and state poll path, the
activity sweep, mail presence and the human-prompt monitor. The cost therefore
scales as stored records × open views × poll rate. Environment rows can also
carry base64 launch attachments while a launch is pending.

### T2. Polling a pushable source at a fixed rate

| Source | Rate | Pushed signal that exists but doesn't drive it |
| --- | --- | --- |
| Native session views (3 POSTs/tick) | 500 ms running, 1.5 s idle | Observation invalidations, session-activity events |
| tmux tab loop | 250 ms per tab | Hook directories (a doorbell pattern exists for Claude state and worktrees) |
| Mail presence | 2 s × every mailbox | Environment and tab lifecycle events |
| PR monitor | 20 s per open PR | `updatedAt`, ETag LRU in `github-pull-requests.ts` |
| Rebuild progress (web) | 2 s | `container-lifecycle-updated` with revision |
| Claude state poll on images without the doorbell | 1 s per running container | — |

### T3. O(total) work per incremental change

Delta bases, per-chunk ACP persistence, transcript-bound measurement in the
bridges, change-tracking capture, legacy projection fingerprinting and the
renderer's pane-layout persistence all serialise or hash the whole structure
for a one-row change. The repository already has the right tool, memoised
per-object encodings (`native-agent-projection-encoding.ts`), but it isn't
used consistently.

### T4. Duplicated stream helpers with uneven quality

Codex's JSONL client, event ring and rollout cache are the best versions in
the repo. The Claude event ring, ACP stdout framing, the shared SSE decoder,
and the near-identical Pi and Cursor `transcript.ts` helpers each carry one
or more of the issues the Codex versions avoid. Moving the good versions into
`packages/protocol/src/node` would mean fixing each issue once.

## Detailed findings

Paths are relative to the repository root unless a section says otherwise.

---

### A. Gateway and transport

**GW-1. Native session views send three requests every 500 ms, and there is no batch route.** Impact High (request count) · Confidence High
- Where: `apps/web/src/lib/native-session-read-policy.ts:14-15`;
  `apps/web/src/hooks/useNativeAgentSession.ts:2175,2314,2378`. Only `/invoke`
  exists in `apps/backend/src/gateway-auth.ts`.
- Now: each tick sends transcript, session-state and discovery as separate
  POSTs. Bodies are small when `unchanged`, but every tick still pays headers,
  auth, CORS and an HTTP/1.1 connection slot. Discovery almost never changes.
- Fix:
  - Short term: read discovery only on mount, resync, invalidation and phase
    change (or at most every 30 s).
  - Then: add one combined progressive-update command, or a bounded
    `/invoke-batch`.
  - Longer term: long-poll with `knownToken`, or push transcript patches on
    the event stream, keeping snapshot-on-mount.

  See also WEB-1.

**GW-2. SSE is uncompressed by default, and terminal output over SSE is inflated by JSON escaping.** Impact High for remote clients · Confidence High
- Where: `apps/backend/src/gateway-support-core.ts:497-509` (default
  `body`); `gateway-handlers.ts:161-168`; `gateway-events.ts:57-58`.
  `apps/web/src/lib/native/web-gateway.ts:141-148` (the WebSocket terminal
  transport is opt-in).
- Now: control bytes become `\u001b` (6 bytes for 1). Escape-heavy TUI output
  grows by about 1.2–1.5x (estimate) before any other overhead.
- Fix: the decision belongs to 0052. Gzip on terminal-only streams is the
  cheapest win, because escaping compresses away almost entirely. Change one
  default per decision, as 0052 requires.

**GW-3. Bearer-token web clients open one event stream per terminal.** Impact Medium · Confidence Medium
- Where: `apps/web/src/lib/native/web-gateway.ts:888-900`. Same-origin
  clients already share one filtered EventSource (`:761-879`).
- Cost:
  - On HTTP/1.1 the browser allows 6 connections per host, so 5 terminals
    starve `/invoke`.
  - In `on` mode each stream takes one of the 8 streaming-gzip slots.
- Fix: reuse the shared-stream logic (`includeEvents=a,b,c`) on the fetch
  path.

**GW-4. The shared SSE frame decoder is quadratic on large frames.** Impact Medium · Confidence High **[re-checked]**
- Where: `packages/protocol/src/gateway-event-stream.ts:145-162` and
  `exceedsUtf8Bytes` at `:112-132`.
- Now: `pending += chunk`, then `/\r?\n\r?\n/` is run from index 0 on every
  chunk. Once pending exceeds about 2.8 M characters, every chunk also
  re-walks the whole buffer to count bytes. A 4–8 MiB frame in 64 KiB chunks
  costs on the order of 100 MB of scanning.
- Used by: Electron main (`apps/desktop/electron/backend-process.ts:565`),
  the web client, bridge observation streams
  (`http-bridge-observation-stream.ts:158`) and node event streams
  (`nodes/node-event-stream.ts:104`).
- Fix:
  - Resume the boundary search at `max(0, previousLength - 3)`.
  - Add each chunk's UTF-8 byte count as it arrives.
  - Keep pending data as a chunk list joined only when a frame completes.
  - Extract `data:` lines with `indexOf` rather than split/filter/map/join
    (`:79-93`).

**GW-5. Events are serialised once but measured and UTF-8 encoded again for each subscriber.** Impact Medium-Low · Confidence High
- Where:
  - `gateway-events.ts:35-60` serialises once (good).
  - The byte length is measured again in
    `gateway-support-extra.ts:657-662` and `gateway-support-core.ts:1290-1291`.
  - Node encodes the string once per socket.
- Fix: store a `Buffer` in the replay frame, write that buffer to every
  client, and pass the byte count to writers.

**GW-6. The terminal WebSocket flush ignores `ws.bufferedAmount`, so a noisy channel can desync quiet ones.** Impact Medium · Confidence Medium
- Where: `apps/backend/src/terminal-websocket-server.ts:857-904`, `:769-787`.
- Now: a flooding channel fills the socket buffer, and the next frame on a
  quiet channel trips the 2 MB socket soft limit. The quiet channel is
  desynced and has to refetch its snapshot.
- Fix: stop flushing above a low watermark (about 256 KB) and resume on the
  send callback. The backlog then stays in per-channel queues, where the
  512 KB per-channel limit desyncs only the noisy channel.

**GW-7. No WebSocket message compression.** Impact Medium · Confidence Medium
- Where: `terminal-websocket-server.ts:185-190`. This is tracked in 0052.
- Fix: deflate with a threshold of about 1 KB, bounded memory, and a check
  that it behaves under Bun's `ws` compatibility layer.

**GW-8. The service preview proxy never reuses upstream connections.** Impact Medium-High during preview page loads · Confidence High **[re-checked]**
- Where: `apps/backend/src/preview-http-proxy.ts:103-119` returns no `reuse`
  hook. `packages/protocol/src/node/preview-forward.ts:65-69, 247, 335` then
  sets `keepAlive: false` and destroys the socket after each exchange.
- Now: a Vite dev page makes hundreds of module requests. Each one pays a TCP
  connect plus TLS (`preview-upstream.ts:301-312`) or a container relay
  channel setup (`:261-299`).
- Fix: a small pool keyed by target and endpoint generation, with idle and
  count bounds, revoked when the generation changes or access is revoked.

**GW-9. The legacy preview and loopback proxy strips ETag, so the browser can never revalidate.** Impact Medium · Confidence High
- Where: `apps/backend/src/gateway-proxy.ts:367, 581` →
  `stripTransformedRepresentationHeaders`
  (`gateway-support-extra.ts:505-511`).
- Now: every reload re-downloads, re-rewrites and re-compresses each module.
- Fix: send a derived weak ETag (`W/"<upstream>|<encoding>|rw<prefix-hash>"`).
  On `If-None-Match`, map it back to the upstream tag and forward it.

**GW-10. The preview body rewrite makes up to 10 full regex passes and about 4 copies.** Impact Low-Medium · Confidence High
- Where: `gateway-proxy.ts:345-352`; `gateway-support-extra.ts:552-606`.
- Fix: one combined regex per content kind, plus a cheap check that skips the
  rewrite when nothing matches. GW-9 removes most of this work on reloads.

**GW-11. Relayed federation events share one event name and go to every client.** Impact Medium-Low (federation only) · Confidence High
- Where: `apps/backend/src/core/nodes/node-event-relay.ts:233,248`; the web
  filters after receiving them (`apps/web/src/lib/federation/node-events.ts:65-72`).
- Now: these events also consume the 2 MiB / 2,048-frame authoritative replay
  window, so a busy leaf can force needless reconciles.
- Fix: per-node event names so subscription filters can scope them, and a
  separate bounded replay share for relayed traffic.

**GW-12. Scoped stream replay writes one cursor frame per skipped event.** Impact Low-Medium · Confidence High
- Where: `gateway-events.ts:209-211, 313-317`.
- Fix: track the highest skipped revision and emit one cursor frame before
  the next matching frame and once at the end.

**GW-13. The web client polls for state that the backend already pushes.** Impact Low-Medium · Confidence High
- Where:
  - `EnvironmentRebuildSection.tsx:111-115` polls every 2 s.
  - The backend already emits `container-lifecycle-updated` with a revision
    (`container-lifecycle-service.ts:120-123`), and nothing in the web app
    listens for it.
  - The same pattern: `ProjectCopyDialog.tsx:171` (3 s) and
    `useUserCommands.ts:68` (3 s).
- Fix: `listenAuthoritative`, with a slow safety poll at most.

**GW-14. Replay window lookup is a linear filter, and one oversized event empties the window.** Impact Low · Confidence High
- Where: `apps/backend/src/gateway-event-replay.ts:162` (`frames.filter`);
  `:131-136`.
- Fix:
  - Revisions are contiguous, so `slice(revision + 1 - oldest)` finds the
    range in O(1).
  - Add a metric for oversized appends.

**GW-15. Static fallback compression runs before the 304 check.** Impact Low · Confidence High
- Where: `gateway-proxy.ts:761-774` versus `:828-840`. This only affects
  files without precompressed siblings.
- Fix: evaluate `If-None-Match` first, and add a small bounded result cache.

**GW-16. Small per-chunk and per-frame costs.** Impact Low · Confidence High
- Idle timers are recreated per chunk (`preview-forward.ts:271-282`,
  `gateway-proxy.ts:279-287, 521-529`). Use `timer.refresh()`.
- A new `TextDecoder` is created per WebSocket control and input message
  (`terminal-websocket-server.ts:389, 544`).
- A JSON `operation-result` frame is sent per keystroke (`:986-1053`). Batch
  these per flush.
- Client acks are sent every 50 ms per channel but are used only to reset an
  error counter (`apps/web/src/lib/native/terminal-websocket-client.ts:97,
  866`). Either use them as flow-control credit or send them less often.

---

### B. Native-agent transcript pipeline

Abbreviations: `P` = `apps/backend/src/core/native-agent-transcript-projection.ts`,
`S` = `native-agent-service.ts`, `HBP` = `http-bridge-provider.ts`.

**TX-1. A delta can only be built from the single newest cached view.** Impact High · Confidence Medium-High **[re-checked]**
- Where: `P:3057-3065, 3068, 3095-3107`; the one-entry-per-key cache is at
  `P:2810-2869`.
- Now: when `knownToken` is not the cached token, the client gets the whole
  cached view as a snapshot (up to 512 KiB), and a background read moves the
  cache on again. While a turn streams, a client that fell behind once keeps
  receiving full snapshots, one poll stale. Two viewers of the same session
  never get deltas.
- Fix: a ring of 4–8 recent token → view entries per key. Views share row
  objects, so the ring costs only arrays. Build the delta from whichever base
  the client holds, and fall back to a snapshot only for unknown tokens.

**TX-2. Dispatches and control changes trigger a full, unlimited raw transcript read.** Impact High · Confidence High
- Where:
  - `refreshProjectionOnce` → `interactiveSnapshot` (`P:4820-4829`)
    **[re-checked]** → `transcripts.legacy(sessionId)` with no limit
    (`HBP:617, 740`).
  - Triggered after dispatch, settle and retire (`S:1567, 1581, 1591,
    1600-1626, 1661`).
  - `updateProjectionControls` reads twice (`S:2497, 2605`). Fork and stop
    also trigger it.
  - `getProjection({messageLimit: 1})` reads everything anyway
    (`apps/backend/src/core/index.ts:983-988, 1216-1221`).
  - Each refresh also fetches the uncached MCP inventory
    (`http-bridge-catalog.ts:154`).
- Now: the Claude bridge's `/messages` returns up to 16 MiB of raw rows.
  Clients render from the summary path, so this read mostly refreshes side
  caches.
- Fix:
  - Pass `limit` through `interactiveSnapshot`/`legacy`, or build from the
    summary representation.
  - Make the post-dispatch refresh state-only.
  - Give `messageLimit: 1` callers a state-only read.

**TX-3. The legacy commit re-serialises the whole projection to fingerprint it.** Impact Medium · Confidence High
- Where: `P:5484-5491` (`JSON.stringify` of up to 4,096 rows, bypassing the
  per-object memo).
- Fix: use `digestWithMessages` (`native-agent-projection-encoding.ts:141-148`).

**TX-4. Every transcript and state read parses every session row and every prompt queue.** Impact Medium-High · Confidence High **[re-checked]**
- Where:
  - `S:2689` → `storage-native.ts:361-379, 424-436`.
  - `getPromptQueue` → `storage-prompts.ts:184-189` (`P:3197, 4838`).
  - `workerProjection` adds a full `listNativeAgentSessions()`
    (`index.ts:1202`).
- Fix: see ST-7.

**TX-5. Session-state reads have no conditional path from the bridge to the backend.** Impact Medium · Confidence Medium-High
- Where: `P:3173-3447, 3480`; `http-bridge-progressive.ts:217-367`.
- Now: each poll fetches `/session` or `/status` (plus `/config` for Codex
  and `/queue` for Pi), interactions, the queue and a steer probe. It then
  hashes `JSON.stringify(state)`, which includes the full `composer.models`
  catalogue.
- Fix:
  - A bridge state revision or ETag that the backend sends as `knownToken`.
  - Cache the composer catalogue separately, keyed by catalogue revision.

**TX-6. Bridge transcript windows are always sent whole.** Impact Medium · Confidence High
- Where: `http-bridge-transcript-v2.ts:123-163`; `P:2885-2895`.
- Now: any change re-sends and re-parses up to 100 rows / 512 KiB, when
  usually only the tail row moved.
- Fix: a v2 `delta` answer keyed on `knownToken` that carries changed rows,
  the id order and `revisedMessages`. The bridges already track revisions
  (`RecentlyRevisedRows`). Fall back to a snapshot on an unknown base.

**TX-7. Head-row recovery re-reads the raw transcript on every streaming revision.** Impact Medium (High when it happens) · Confidence Medium
- Where: `P:2139, 2240, 2260`, discard around `P:2200-2206`; the comment at
  `P:2380-2385`.
- Fix: debounce until the source token stops moving, and prefer a page or
  detail read of the head row.

**TX-8. A tool-detail cache miss runs a sync-v1 refresh that can't recreate remote references.** Impact Medium · Confidence Medium-High
- Where: `P:4245-4258, 4998-5007`.
- Now: the refresh projects with `remote = undefined`, so for summary-backed
  sessions it creates local refs only and the miss still fails afterwards.
- Fix: resolve from the registered remote details or the direct page cache.
  Otherwise run a summary read, never the raw sync path.

**TX-9. `valueFingerprint` isn't memoised, though its comment says it is.** Impact Medium-Low · Confidence High
- Where: `native-agent-projection-encoding.ts:63-66`; `P:1630-1632`.
- Fix: a WeakMap memo next to `encodings`.

**TX-10. Joined (v1) history pages read the whole transcript per page and hash each message to find the cursor.** Impact Medium · Confidence High
- Where: `P:3924-4004`. This is owned by todo 0232.
- Interim fix: an id → index map per history epoch.

**TX-11. Patch building re-serialises and hashes whole rows in a JavaScript loop.** Impact Low-Medium · Confidence High
- Where: `packages/protocol/src/native-agent-transcript-patch.ts:71-81, 148,
  177, 251`.
- Fix: derive the digest from the memoised encoding, use a native hash, and
  compare content-less parts field by field.

**TX-12. Already-encoded rows are stringified again on the way out.** Impact Low-Medium · Confidence High
- Where: `apps/backend/src/gateway-handlers.ts:122`; `P:2844, 3112-3118`.
- Fix: an update serialiser that splices the memoised per-message JSON. Count
  `revisedMessages` in the memoised measure.

**TX-13 to TX-18. Smaller items.** All Confidence High unless stated.
- TX-13: the view token hashes the whole window (`P:2818-2842`). Hash
  memoised per-row fingerprints instead.
- TX-14: restart-preview checkpoints are serialised three times and cloned
  (`native-agent-display-tails.ts:141, 158, 160`;
  `native-agent-display-tail-store.ts:206, 222, 232, 259`). Serialise once
  and freeze instead of cloning.
- TX-15: the legacy and summary paths cache the same rows separately
  (`P:1460-1465, 5004-5006` vs `2365-2373`). Fixing TX-2 removes most of
  this. Confidence Medium.
- TX-16: inline tool bodies are re-hashed whenever their row misses the cache
  (`P:1094-1100, 1301-1306`). Add a per-part memo.
- TX-17: small linear scans (`P:1220, 2034-2040, 2118-2124`).
- TX-18: the `/messages` fallback ignores the `limit` it already has in scope
  (`http-bridge-transcript-reader.ts:66`).

---

### C. Bridges

The backend subscribes only to the content-free `?observe=1` SSE (Claude,
Codex) and polls Cursor, Pi and Grok over HTTP. So the cost here is mostly
per-event CPU and disk, and the work done to answer polled routes, rather
than SSE bytes.

**BR-1. ACP rewrites its whole state file about every 25 ms while a turn streams.** Impact High · Confidence High **[re-checked]**
- Where: `bridges/acp-bridge/src/acp-persist-writer.ts:223-247` (25 ms
  timer), `36-58, 103-219, 255-266`. Callers: `acp-session.ts:1925`,
  `acp-tools.ts:184`.
- Now: each write snapshots every session (up to 256) with at least three
  full `JSON.stringify` passes, then mkdir, write and rename, up to the 16 MB
  cap. Cursor and Pi persist only at turn and request edges.
- Fix:
  - Persist transcript changes on a 1–2 s trailing debounce with a max-wait,
    or only at row and turn boundaries.
  - Keep `persistState()` barriers for the dispatch journal.
  - Cache each clean session's serialised fragment.

**BR-2. Codex `GET /session/:id/config` reads every session record from disk.** Impact High/Medium · Confidence High
- Where: `bridges/codex-bridge/src/app-server-runtime-sessions.ts:1601-1616,
  1639` → `sessions/persistence.ts:312-365, 418-431, 467-492`. It is called on
  every Codex `interactiveSnapshot` (`HBP:741-747`).
- Now: the call lists the records directory, then chmods, reads and parses
  every record, and may adopt login records, which can write files.
- Fix: read only `recordPath(id)`, or keep an in-memory digest of the last
  config written durably.

**BR-3. ACP measures the full transcript every 64 KB of output.** Impact High/Medium · Confidence High
- Where: `acp-context.ts:891`; triggers at `acp-session.ts:1628, 1909-1913`
  and `acp-tools.ts:176-180`.
- Now: a full serialisation of up to 16 MB per 64 KB appended. Pi and Cursor
  use 1 MB (`pi-bridge/src/transcript.ts:31`,
  `cursor-bridge/src/transcript.ts:34`).
- Fix: use the 1 MB interval, and see BR-4.

**BR-4. Every dirty read re-serialises the whole transcript to bound it.** Impact Medium · Confidence High (mechanism)
- Where: `packages/protocol/src/node/transcript-budget.ts:85-86, 185-232`,
  called from Pi, Cursor and ACP reads (`pi-bridge/src/http.ts:553-588`).
- Fix: `planOldestFirstTrim` already accepts `options.measure`. Pass a
  `WeakMap<row, {version, bytes}>`-backed measure, bumped by the existing
  `rowChanged` hooks.

**BR-5. Pi and ACP re-serialise the whole tool card on every update; Cursor charges only what was appended.** Impact Medium · Confidence High
- Where: `pi-bridge/src/translate.ts:409-489, 975-981`;
  `acp-bridge/src/acp-tools.ts:165-186`. The good version is
  `cursor-bridge/src/translate.ts:552-574`.
- Now: O(n²) for a streaming command with up to 512 KB of output plus 1 MB
  of diff.
- Fix: port Cursor's `continues` fast path.

**BR-6. `appendBounded` re-measures the whole string on every delta.** Impact Low/Medium · Confidence High (mechanism)
- Where: `pi-bridge/src/transcript.ts:46-63`;
  `cursor-bridge/src/transcript.ts:49-66`;
  `acp-bridge/src/acp-transcript.ts:690-700`.
- Fix: keep running byte counts per carrier in the existing `WeakMap`.

**BR-7. Codex re-renders and re-sends running tool cards every publish tick.** Impact Medium CPU, Low wire · Confidence High
- Where: `codex-bridge/src/messages/render-turn.ts:854-905`;
  `app-server-runtime-base.ts:289-299`; `app-server-runtime-rows.ts:458-484`
  (`content` is duplicated into every `message.patched`).
- Fix: cache in-progress item parts by `accumulator.version`, and send
  `content` only when it changed.

**BR-8. Claude breaks its own part-identity diffing on every flush.** Impact Medium · Confidence High
- Where: `claude-bridge/src/services/session-manager-messages.ts:978-984`
  (returns a fresh `{...tool, createdAt}`); `session-manager-persistence.ts:1004-1014`;
  `session-manager-prompt-stream.ts:451-460`.
- Now: every 100 ms patch lists every tool part on the row, including
  subagent cards. This contradicts the identity rule in
  `bridges/claude-bridge/AGENTS.md`.
- Fix: stamp `createdAt` into the tracker entry once.

**BR-9. Claude moves the transcript token even when nothing changed.** Impact Low/Medium · Confidence Medium
- Where: `session-manager-prompt-stream.ts:543` versus the no-op return at
  `:462-466`; `routes/session-activity.ts:71-75`.
- Fix: `emitRow` returns whether anything changed, and the transcript is
  marked changed only then.

**BR-10. Pi `/session/list` fully parses every session file on each call, uncached.** Impact Medium (infrequent) · Confidence High
- Where: `pi-bridge/src/agent-session.ts:1164-1185`. Large histories hit
  `CATALOG_TIMEOUT_MS`, and the route then quietly returns `[]`.
- Fix: cache by path, size and mtime, or do a head-only read.

**BR-11. Codex reads the whole `session_index.jsonl` on every hydrate.** Impact Low/Medium · Confidence High
- Where: `codex-bridge/src/history/rollout.ts:280-290, 1072-1093`.
- Fix: cache by size and mtime and parse only the appended tail, as
  `transcript-cache.ts` already does.

**BR-12. ACP stdout framing is O(n²) for large frames.** Impact Low/Medium · Confidence High
- Where: `acp-bridge/src/acp-context.ts:1302-1321` (`Buffer.concat` per
  chunk, then `indexOf` from 0). The good version is
  `codex-bridge/src/jsonl-rpc-client.ts:225-277`.
- Fix: a chunk list plus a scan offset.

**BR-13. Codex `SerialQueue` allocates 3 promises per notification and has no count bound.** Impact Low · Confidence Medium
- Where: `jsonl-rpc-client.ts:556-571`.
- Fix: an array per key, drained in one microtask loop.

**BR-14. Pi persistence serialises every session on each write.** Impact Low · Confidence High
- Where: `pi-bridge/src/persistence.ts:66-77, 152-180`. It only runs at
  edges. Cursor's `persistence-budget.ts:130-187` (encode each message once)
  is the better model.

**BR-15. Duplicated helpers.**
- Pi and Cursor `transcript.ts` are near-identical, and ACP has its own
  variants.
- There are two SSE replay rings. Codex (`event-ring.ts`) collapses
  superseded frames and serialises lazily. Claude (`routes/events.ts:98-145`)
  does neither, and re-runs `Buffer.byteLength` per frame per subscriber.
- Fix: move them into `packages/protocol/src/node` so BR-4 to BR-6 land
  once.

**BR-16. ACP's Cursor-provider replay spawns a full agent child per pass.** Impact Low · Confidence Medium
- Where: `acp-tools.ts:740-775`. It is gated on `provider === "cursor"`, but
  the ACP bridge is Grok-only, so this is likely dead code and a deletion
  candidate.

---

### D. Renderer (`apps/web/src`)

**WEB-1. Transcript, state and discovery are polled together every 500 ms per visible tab.** Impact High · Confidence High
- This is the client side of GW-1. Claude and Codex idle views stay at
  1.5 s, because quiet backoff only ships for Cursor, Pi, Grok and OpenCode.
  Discovery is the cheapest to take out of the round.

**WEB-2. An "unchanged" poll still re-renders the whole agent tab.** Impact High · Confidence High **[re-checked]**
- Where:
  - `hooks/useNativeAgentSession.ts:2244-2250, 2325-2330` pass
    `identity: update.identity`, a freshly parsed object.
  - `stores/nativeAgentProjectionStore.ts:141-150` compares entries with
    `Object.is`.
  - The bail-out at `:241-248` also requires the session to be the last key
    written.
- Now: every poll writes a new entry, copies Maps of up to 128 entries and
  re-renders `AgentNativeTab.controller` (3.7k lines). With two visible
  sessions, the `lastKey` condition alone defeats the bail-out.
- Fix:
  - Include `identity` only when `!sameProgressiveIdentity(...)`.
  - Drop the `lastKey` condition.
  - Subscribe to the fields actually read.

**WEB-3. The App root refetches three lists for every environment on any environment change.** Impact High · Confidence High (mechanism) **[re-checked]**
- Where: `App.tsx:279, 351-371`. The hydrators don't dedupe
  (`lib/prompt-queue-persistence.ts:129-148`,
  `lib/looped-review-persistence.ts:79-100`,
  `lib/multi-review-persistence.ts:33-49`).
- What changes the array:
  - `setEnvironments` on every resync (`lib/store-resource-sync.ts:381`),
    which already hydrates prompt queues itself (`:397-400`);
  - `updateEnvironmentStatus` and `setEnvironmentPR` without no-op guards
    (`stores/environmentStore.ts:101-115`);
  - activity-state changes stored on the environment record.
- Cost: with 20 environments, about 60 RPCs per working/idle transition, plus
  an `AppShell` re-render.
- Fix:
  - Key the effects on the set of environment IDs and hydrate only new ones.
  - Add no-op guards to the store setters.

**WEB-4. Pane-layout persistence serialises every environment's layout on every pane-store write.** Impact High · Confidence High
- Where: `lib/pane-layout-persistence.ts:767-816`. The changed-object check at
  `:816` comes after `sanitizeRoot` and `JSON.stringify`.
- Fix: move the identity check (and the hydration-transition check) ahead of
  the serialisation.

**WEB-5. Background polls toggle two loading flags, causing two extra renders per tick.** Impact Medium · Confidence High
- Where: `useNativeAgentSession.ts:908-914, 2136, 2394, 2549`. The controller
  ignores these flags once state is authoritative
  (`AgentNativeTab.controller.tsx:2523-2534`).
- Fix: track in-flight state in a ref for background reads.

**WEB-6. The live-head merge serialises the head row's parts on every update, with no identity shortcut.** Impact Medium · Confidence Medium-High
- Where: `useNativeAgentSession.ts:161-233, 249-300, 1543`.
- Fix: return early when `local === head` or `local.parts === head.parts`,
  and cache per-part serialisation in a WeakMap.

**WEB-7. Broad subscriptions re-render the shell and action bar.** Impact Medium · Confidence High
- Where:
  - `components/layout/AppShell.tsx:138` subscribes to the whole
    `paneEnvironments` Map.
  - `hooks/usePullRequest.ts:54` calls `useEnvironmentStore()` with no
    selector; it is used by `useActionBarController.ts:422`.
  - None of these heavy children is memoised.
- Fix: primitive or shallow selectors.

**WEB-8. The agent-info header normalises the whole transcript on every update, only for two click handlers.** Impact Medium · Confidence High
- Where: `components/layout/AgentInfoButton.tsx:332-334, 393-396, 1142, 1211`.
- Fix: compute it inside the handlers with `getState()`.

**WEB-9. Heavy chat code is in the startup closure (about 3.76 MB minified across 76 chunks).** Impact Medium · Confidence High (measured once from a throwaway build)
- What's included: `native-message-search` (529 KB), `MessageMarkdown`
  (193 KB) and `uiStore` (497 KB, which pulls in xterm via
  `stores/index.ts:15` → `terminalPortalStore.ts`).
- Why: always-loaded modules (`AgentMailPanel` → `MailTile` →
  `MessageMarkdown`, and `ArtifactLiveHost`) defeat the lazy `AgentNativeTab`.
- Fix:
  - Lazy-load mail markdown and the find/search module.
  - Stop re-exporting `terminalPortalStore`.
  - Consider `manualChunks` (`vite.config.ts` has no build options).

**WEB-10. With find open, the whole transcript is re-indexed on every update, and the 512-entry LRU can thrash.** Impact Medium (find open only) · Confidence Medium
- Where: `components/chat/AgentChatFind.tsx:110-118`;
  `lib/chat/rich-markdown/markdown-search.ts:255-290`.
- Fix: cache per message object in a WeakMap, skip caching parts that are
  still streaming, and debounce.

**WEB-11. The terminal WebSocket rebuilds every channel on every visibility change.** Impact Medium · Confidence Medium-High
- Where: `lib/native/terminal-websocket-client.ts:148, 359-371, 801-822`;
  `hooks/useTerminal.ts:487-537`.
- Fix: rebuild only when the socket is suspect (no frame or pong for X
  seconds), or limit the rebuild to mobile and web hosts.

**WEB-12 to WEB-19. Smaller items.** Impact Low · Confidence High unless stated.
- WEB-12: one environment change refetches the whole project's environment
  list (`hooks/useEnvironmentListSync.ts:84-92`). Confidence Medium.
- WEB-13: expanded truncated folders are re-read every 5 s without a digest
  (`hooks/useFilesPanel.ts:638-657, 744-752`).
- WEB-14: projection-store writes copy four Maps even when only one changes
  (`stores/nativeAgentProjectionStore.ts:170-237`).
- WEB-15: unmemoised copy, reverse and `findLastIndex` on every controller
  render (`AgentNativeTab.controller.tsx:979-993`).
- WEB-16: `TerminalContainer.view.tsx:157-159` subscribes to the whole
  environment object. Confidence Medium.
- WEB-17: 1 s timers at the component root re-render whole tabs
  (`ClaudeTmuxChatTab.tsx:1190-1199`, `MultiReviewTab.tsx:493`,
  `BuildChatTab.tsx:311`). Move them into a leaf component, as `LiveElapsed`
  already does.
- WEB-18: polls that are not paused when the window is hidden:
  - Docker probe, 60 s (`App.tsx:666-673`);
  - user commands, 3 s (`useUserCommands.ts:66-69`);
  - dialog polls at 2–5 s;
  - annotation selection, 400 ms (`useAnnotationCapture.ts:492`).

  Route these through the read coordinator.
- WEB-19: streaming markdown parses incrementally but rebuilds the HAST and
  React tree for the whole message (`components/chat/MessageMarkdown.tsx:341-373`).
  Confidence Medium.

---

### E. Storage, change tracking, git and files

Paths in this section are relative to `apps/backend/src/core/` unless they
start with `packages/`.

**ST-1. Each capture reads and SHA-1 hashes every file, even when its stat stamp is unchanged.** Impact High · Confidence High **[re-checked]**
- Where: `change-tracking/capture.ts:296-325`;
  `change-tracking/confined-read.ts:68-99`.
- Now: the stat cache saves only the object write, not the read or hash.
  Captures run at most once per second per worktree during a turn, over up to
  100k candidate files.
- Fix: `fstat` after `openat`. If the stamp matches, return the cached `oid`
  without reading.

**ST-2. `confinedRead` loads libc and reopens every ancestor directory for each file.** Impact Medium · Confidence High
- Where: `confined-read.ts:34-40` (the `dlopen` runs inside the per-file
  function **[re-checked]**), `:51-61`, and blocking `*Sync` calls at `:76,
  99, 101-102`.
- Fix: `dlopen` once at module scope, and cache directory handles within one
  capture.

**ST-3. Reused objects get one-at-a-time `utimes`, plus a second `stat` per entry.** Impact Medium · Confidence High
- Where: `change-tracking/object-store.ts:96-106, 132-135`;
  `capture.ts:884-888`.
- Fix: skip the closure check for objects proven present in this pass, skip
  `utimes` inside the grace window, and run `reuse` outside `exclusive`.

**ST-4. Line counts are recomputed for unchanged blob pairs on every provisional pass.** Impact High (long turns) · Confidence High
- Where: `change-tracking/snapshot-diff.ts:79-110, 228`;
  `measurement-service.ts:924-943`; `turn-boundaries.ts:626-680`.
- Now: with 200 changed files, that is about 400 inflate-and-diff jobs per
  second, nearly all repeats.
- Fix: an LRU cache from `(oldOid, newOid, policyId)` to counts. Content
  addressing means entries never go stale.

**ST-5. Manifests are never cached, and diff pages do a linear `find` per row.** Impact Medium · Confidence High
- Where: `change-tracking/capture.ts:928-937`;
  `change-tracking/diff-bodies.ts:121-154, 300-322`.
- Fix: an LRU cache of parsed manifests by oid, plus binary search (entries
  are sorted). Render once in the whitespace-ignore view.

**ST-6. Synchronous zlib and fsync on the event loop for blobs up to 16 MiB.** Impact Medium · Confidence High
- Where: `change-tracking/object-store.ts:139, 144, 250-261`.
- Fix: async zlib or a worker, and batch fsyncs per capture.

**ST-7. Single-key accessors decode the whole store.** Impact High · Confidence High **[re-checked]**
- Where: `storage-projects.ts:551-556` (`getEnvironment`, about 243 call
  sites), `storage-native.ts:424-433` and more than 20 lease-held mutations,
  `storage-prompts.ts:184-189`, `storage-drafts.ts:160-163` (drafts up to
  32 MB each), `storage-sessions.ts:227-233`.
- Fix: use `loadStoreRow` / `readStoreRow` (`storage-context.ts:558-582`) and
  validate one record. `storage-reviews.ts:197` already does this.

**ST-8. The store cache holds raw text, and single-row writes discard it.** Impact High (with ST-7) · Confidence High
- Where: `storage-database.ts:422-426, 754-757`; `storage-context.ts:607-609`.
- Fix:
  - In `updateStoreRow`, replace the row in the cached map and bump the
    revision.
  - Optionally cache the parsed value per revision, handed out as frozen or
    copy-on-write.

**ST-9. Agent mail decodes the whole envelope (up to 32 MiB) every 2 s and stringifies it twice per save.** Impact High (with messaging history) · Confidence High
- Where: `index.ts:1736-1751`; `agent-mail-service.ts:308-319`;
  `storage-agent-mail-directory.ts:521`; `storage-agent-mail-store.ts:182-184,
  262-298, 306` (a pretty-printed `JSON.stringify(store, null, 2)` used only
  to measure size).
- Fix:
  - Gate presence on messaging being enabled (BG-3).
  - Keep the pending-inject list as its own collection.
  - Serve the mailbox list without message bodies.
  - Track bytes from row stats.

**ST-10. One-field changes rewrite the whole value.** Impact Medium · Confidence High
- Where: `storage-projects.ts:676-689, 1046-1057`;
  `storage-database.ts:563, 1278-1304`; `storage-drafts.ts:207-243` (a global
  lease and a full load roughly every 400 ms while typing);
  `storage-sessions.ts:200, 241-278`.
- Fix:
  - Use `updateStoreRow` for record stores.
  - Extend it to keyed array layouts; it currently throws for them
    (`storage-database.ts:670-672`).

**ST-11. Inserting a row scans its whole collection to find the next position.** Impact Low-Medium · Confidence High
- Where: `storage-database.ts:719-727`; the schema at `:155-164` has no
  position index.
- Fix: an index on `(store, collection, position)`, or keep the next position
  in `stores`.

**ST-12. PRAGMA and lease write costs.** Impact Low-Medium · Confidence Medium
- Where: `storage-database.ts:256-266` (`synchronous=FULL` with WAL,
  `secure_delete=ON`, no `cache_size`/`mmap_size`), `:1177-1213` (about
  three fsynced commits per leased mutation; waiters retry every 25 ms).
- These are documented durability decisions. Worth re-checking:
  - `NORMAL` for high-churn stores;
  - a larger `cache_size`;
  - lease backoff.

**ST-13. Hourly `VACUUM INTO` and `quick_check` block the event loop.** Impact Low-Medium · Confidence High
- Where: `storage-database.ts:944-952`; `storage-backups.ts:93-110`.
- Fix: run them in a Bun `Worker` with its own connection.

**ST-14. Each local diff scan spawns about 7–9 git processes, including two diffs with rename detection.** Impact Medium · Confidence High
- Where: `commands-files.ts:978-996, 1235-1255, 2537-2565`; containers too
  (`:652-654`).
- Fix:
  - One `git diff --raw --numstat -z -M` pass.
  - Ensure the exclude file once per worktree.
  - Reuse the resolved base oid.

**ST-15. Untracked files are re-read on every scan, with no stat cache.** Impact Medium · Confidence High
- Where: `commands-files.ts:1013-1052, 1113-1168`; `git-scopes.ts:341-366`
  (reads one file at a time).
- Fix: a per-worktree cache from `(ino, size, mtime, ctime)` to count, plus
  `mapWithConcurrency` in git-scopes.

**ST-16. Local scans have no minimum spacing under constant writes.** Impact Medium-High while installs or builds run · Confidence High
- Where: `worktree-watcher.ts:126-145, 180-210`;
  `diff-stats-service.ts:1074-1114`. Containers already enforce a 2 s gap
  (`CONTAINER_WORKTREE_SIGNAL_MIN_HINT_GAP_MS`).
- Fix: a 1–2 s minimum gap with a trailing run. Drop hints whose paths are
  all under ignored directories.

**ST-17. Recursive `fs.watch` covers the whole worktree, `node_modules` included.** Impact Medium · Confidence Medium
- Where: `worktree-watcher.ts:147-148, 233-247`.
- Fix: watch non-ignored subtrees only, or rely on git's fsmonitor, which
  `enableGitScanCaches` already turns on. This depends on Bun's Linux
  watcher, which was not inspected. (2026-10-28: fsmonitor is no longer
  turned on; see [git-scan-caches.md](../architecture/git-scan-caches.md).
  Only the first option remains.)

**ST-18. Git-scope demand never expires.** Impact Medium · Confidence High
- Where: `git-scopes.ts:143-170, 199-203`; `change-tracking/service.ts:286-287`.
- Now: one look at a scope view makes every later scan recompute it for the
  rest of the environment's life. In containers each recompute is several
  `docker exec`s.
- Fix: a TTL since the last read, or tie demand to live subscriptions.

**ST-19. Change-ledger rows grow without bound, and `activeTurns()` is a full scan on every hint.** Impact Medium (grows over time) · Confidence Medium
- Where: `change-tracking/change-ledger.ts:916-921` (`NOT IN`); no delete
  path was found for measurements, files or boundaries.
  `measurement-service.ts:258-276` writes a new measurement per provisional
  pass.
- Fix: prune superseded provisional measurements, and query with
  `lifecycle IN (...)` or a partial index.

**ST-20. Hourly retention walks the object store three times while holding its mutex.** Impact Low-Medium · Confidence High
- Where: `change-tracking/retention.ts:80-88, 116-147`;
  `object-store.ts:186-239`.
- Fix:
  - Keep `usedBytes` up to date incrementally.
  - Take reachability from cached manifests (ST-5).
  - Sweep without holding the write mutex.

**ST-21. Whole files go over RPC as base64, and branch reads spawn several processes.** Impact Low-Medium · Confidence High
- Where: `commands-registry-terminal.ts:907-936, 1157-1178`;
  `commands-files.ts:2288-2310`.
- Fix:
  - An HTTP route with Range support, like
    `transcript-artifacts/media-stream-route.ts`.
  - One `git cat-file --batch` process.
- Related: the usage report parses up to 20k rows per request even when
  filtered (`usage-history-store.ts:119-140, 283-299`). Query by owner and
  cache by revision.

---

### F. Background loops and external processes

Paths in this section are relative to `apps/backend/src/core/`.

#### Periodic loop inventory

| Loop | Interval | Work per tick | Scales with | Idle and stopped handling |
| --- | --- | --- | --- | --- |
| `activity` (`index.ts:1718`) | 2 s | Env and session store loads, then batched bridge reads per due group | env × agent groups | Stable-idle backoff; skips stopped envs |
| `tmux-queues` (`index.ts:1732`) | 2 s | Lists prompt queues; drains non-empty tmux ones | queues | Cheap when empty |
| `mail-presence` (`index.ts:1736`) | 2 s | 3–4 full-store reads per mailbox, plus `tmux has-session` | **every mailbox** | **Not gated** |
| `mail-injection` (`index.ts:1745`) | 2 s | Drain | pending mail | Gated on messaging |
| `claude-state` (`index.ts:1808`) and its poll (`tmux-poll.ts:245-277`) | 2 s reconcile; 1 s poll, 30 s once the doorbell is confirmed | One `docker exec` per container | **every running container** | Stops with the container |
| **tmux session loop** (`tmux-session-manager.ts:596-743`, `tmux-shared.ts:40`) | **250 ms** | Snapshot exec, discovery until bound, tail, capture (3 s / 0.5 s), `has-session` every 8 ticks | **every tmux tab** | No idle backoff |
| Human-prompt monitor (`agent-human-prompt-monitor.ts:163`) | 5 s | Up to 8 bridge reads of ≤512 KB | working sessions | Working only |
| PR monitor (`pr-monitor-policy.ts:18-26`) | 1 s / 5 s / **20 s open** / 5 min terminal | One `gh pr view` per PR, plus a rollup at most every 60 s | **open PRs** | Container pause only |
| Diff stats (`diff-stats-service.ts:235-244`) | 15 s / 120 s / 60 s | git scan | tracked envs | Coalesced |
| Claude login keeper (`container-claude-login-keeper.ts:42`) | 5 min | Marker `docker exec` per container | running containers | Serial |
| Workflow supervisors | 1–3 s keyed; 30 s discovery | Per owed workflow | active workflows | Idle when nothing is owed |
| Coordinator repair, mail retention, tab teardown and orphans | 60 s | Storage scans | stores | — |
| Others (public API, node relay, annotations, log lease, preview access, activity lease, change-tracking retention) | 3 s – 1 h | Small | — | — |

**BG-1. tmux transcript discovery repeats an expensive search every 250 ms until a transcript exists.** Impact High · Confidence High **[re-checked]**
- Where: `tmux-session-manager.ts:253-264, 613-621`;
  `tmux-hooks.ts:880-896, 920-960`; `tmux-backend.ts:100-115`.
- Now: each tick runs a stat, a `test -f` and a `find`, each its own
  `docker exec` in containers. Then it runs `cat` on every recent `.jsonl` and
  parses every line. A tab binds only after its first prompt. That is about
  16 execs/s per idle unbound container tab, and sibling transcripts are
  re-read four times a second.
- Fix:
  - Throttle discovery (2 s, backing off to 10 s).
  - Fold it into `pollSnapshotScript`.
  - Check ownership with `transcriptHead` on a bounded head.
  - Remember rejected `(path, size)` pairs.

**BG-2. The tmux loop is a fixed 250 ms per tab, with up to four separate execs.** Impact High · Confidence High
- Where: `tmux-session-manager.ts:596-743, 893-896, 1278-1285`;
  `tmux-shared.ts:40-50, 475-491`; `tmux-backend.ts:328-347`.
- Now: about 5 execs/s idle and 11/s busy, per tab. The lifecycle doc
  measures about 19 ms of host CPU per `docker exec`.
- Fix:
  - Put `has-session` and `capture-pane` in the same `sh -c` snapshot.
  - Back off to 1–2 s when idle and no hook is pending.
  - Ideally: one long-lived `docker exec -i` co-process per container, or a
    doorbell on the hook directories, reusing the `claude-state-signal`
    pattern.

**BG-3. Mail presence refreshes every mailbox every 2 s, even with messaging disabled.** Impact Medium-High · Confidence High **[re-checked]**
- Where: `agent-mail-service.ts:297-353` (no enabled check; only the drain
  checks, at `:473`); `prompt-queue-drainer.ts:181-203`;
  `tmux-commands.ts:337-343`; `native-agent-service.ts:2998-3058`.
- Fix:
  - Skip the refresh when messaging is disabled or paused, or compute
    presence lazily on `list_mailboxes`.
  - Skip environments that are not running before any store read.
  - Reuse the tmux loop's liveness result instead of spawning another
    `has-session`.

**BG-4. Single-key getters decode whole stores.** This is ST-7 seen from the background jobs. Combined with BG-3, that means mailboxes × four full-store parses every 2 s, run synchronously in `bun:sqlite`.

**BG-5. Several jobs decode the full environment and session stores independently each cycle.** Impact Medium · Confidence High (path), Medium (CPU share)
- Where: `native-agent-launch-activity-reconciler.ts:513-518`;
  `tmux-poll.ts:426-437`; `index.ts:540-568`; pending renames; presence.
- Fix: one decoded snapshot per store revision, shared by read-only
  background callers.

**BG-6. The PR monitor polls every open PR every 20 s for as long as it stays open, one `gh` process each.** Impact Medium-High · Confidence High (cadence), Medium (budget)
- Where: `pr-monitor.ts:211, 748-758, 900-905`;
  `packages/protocol/src/pr-monitor.ts:59-63`;
  `commands-pr-monitor.ts:85-130, 242-342`.
- Now: ten open PRs make about 2,400 GraphQL queries an hour, plus rollups.
  That is a large share of the 5,000-point hourly budget the PR viewer also
  uses. Local environments never pause.
- Fix:
  - Back off by `updatedAt` (2–5 min after an hour with no activity).
  - Batch all PRs per host into one aliased GraphQL query, or use REST
    `GET /pulls/{n}` through the existing ETag LRU in
    `github-pull-requests.ts` (GitHub does not count 304s against the rate
    limit).

**BG-7. The Claude state poll runs on every running container, used or not.** Impact Medium on older images, Low otherwise · Confidence High
- Where: `tmux-poll.ts:245-277, 426-437`.
- Fix: start the poll only while the environment has a Claude or tmux
  terminal session.

**BG-8. Container state changes are found by polling and failed execs.** Impact Low-Medium · Confidence Medium
- Where: `container-oom-events.ts:47-60` (follows `event=oom` only);
  `docker-container-state-cache.ts:8`.
- Fix: widen the follower to `start|die|stop|destroy`. Use it to invalidate
  the state cache and retire the tmux, state, diff and PR loops at once.

**BG-9. The human-prompt monitor re-fetches each working session every 5 s.** Impact Medium-Low · Confidence Medium
- Where: `agent-human-prompt-monitor.ts:161-196`;
  `http-bridge-provider.ts:501-513`; `opencode-provider.ts:821-827`.
- Fix: pass `contentRevision` so an unchanged session costs nothing. For
  OpenCode, scan only appended messages.

**BG-10. Multi Review snapshot mode runs a full drift check per reviewer.** Impact Low-Medium · Confidence High
- Where: `review-fanout.ts:594-602, 1128-1146`;
  `multi-review-service.ts:3414-3428, 4735-4763`;
  `review-worktree-fingerprint.ts:133-175`.
- Now: 2N `git status --untracked-files=all` runs for N reviewers.
  `beforeAdmission` is wired only in package mode.
- Fix: one check per admission pass in both modes.

**BG-11. Build-pipeline reviewer prompts are rebuilt per reviewer, with fresh config and notes reads.** Impact Low · Confidence High
- Where: `build-pipeline-review-fanout.ts:428-442`;
  `build-pipeline-service-supervisor.ts:172-177`.
- Fix: build the shared prefix once per pass.

**BG-12. The login keeper execs a marker read per container before its in-memory digest check.** Impact Low · Confidence High
- Where: `agent-accounts-containers.ts:1030-1076, 1115-1122`;
  `container-claude-login-keeper.ts:200-204`.
- Fix: compare digests first, and load config and environments once per
  pass.

**BG-13. `get_environments` triggers a whole-installation PR-monitor sync and git spawns.** Impact Low · Confidence High (path)
- Where: `commands-registry-environments.ts:116-159`;
  `pr-monitor-runtime.ts:70-99`; `project-home-environment.ts:150-155, 207-213`.
- Fix: coalesce on the environment store revision, or limit the sync to the
  requested project.

**BG-14. Reopening a tmux tab replays its whole transcript through `docker exec`.** Impact Low-Medium · Confidence Medium
- Where: `tmux-session-manager.ts:266-291`;
  `apps/web/src/components/agent/ClaudeTmuxChatTab.tsx:396-405`.
- Fix: page from the tail, or resume from the client's last offset.

**BG-15. The tmux mail-inject drain repeats the presence work.** Impact Low · Confidence High
- Where: `prompt-queue-drainer.ts:117-170`; `agent-mail-service.ts:592-600`.
- Fix: pass the presence snapshot through. Fixing BG-3 and ST-7 mostly cures
  this.

---

### G. Desktop, toolchain, Docker image, protocol and CLI

**DK-1. Local desktop relays every backend event, terminal output included, to every window.** Impact High · Confidence High **[re-checked]**
- Where: `apps/desktop/electron/backend-process.ts:548-569` (`/__orkestrator/events`
  with only a cursor, no filter); `connection-manager.ts:981-991, 1747-1751`;
  `desktop-window-contexts.ts:118-134`; `preload-api.ts:340-344`.
- Now: every PTY and tmux byte in every environment is JSON-encoded, parsed
  on the Electron main thread, and structured-cloned to each window. It is
  dropped in the preload only after the clone. The web gateway client avoids
  exactly this (`apps/web/src/lib/native/web-gateway.ts:380-394`).
- Fix (either):
  - Let local windows use the direct gateway transport, with filtered SSE
    and the binary terminal WebSocket, via
    `installRemoteGatewayRequestAuth`.
  - Or report preload listener sets to main, filter before `send`, and open
    the main stream with `excludeEvents=terminal-output-`.

**DK-2. Every local `invoke` goes through main with four serialisations.** Impact Medium · Confidence High (mechanism)
- Where: `preload-api.ts:347-349`; `ipc.ts:287-296`;
  `backend-process.ts:396-421`.
- Now: renderer clone → `JSON.stringify` + fetch → `response.json()` in
  main → clone back to the renderer. Large terminal snapshots, transcripts
  and base64 reads are parsed on the main thread.
- Fix: the DK-1 transport change removes this hop. At minimum, pass the raw
  body through without parsing it in main.

**DK-3. Toolchain startup SHA-256s about 1.2 GB of binaries twice per launch, blocking backend start.** Impact High (startup) · Confidence High **[re-checked]**
- Where: `packages/toolchain/src/manager.ts:162-166, 371-417, 429-466` (Pi
  bundle: 210 files), `1824-1826` (initial status), `1940-1946` (final
  verification, unconditional). It is awaited at
  `apps/desktop/electron/main.ts:1273`.
- macOS: re-signed OpenCode and Pi also get a `copyFile`, `codesign --verify`
  and `--version` on every launch (`manager.ts:1145-1197, 1903-1915`).
- Fix:
  - Persist a per-file stamp (`dev, ino, size, mtimeNs, ctimeNs, digest`) and
    re-hash only on a mismatch, or periodically.
  - Skip final verification for artifacts that were valid and untouched in
    this run.
  - Keep re-signed copies whose stamp is unchanged.

**DK-4. Toolchain downloads have a 5-minute total deadline and no resume.** Impact Medium · Confidence High
- Where: `manager.ts:40, 730-731, 749, 1823`.
- Now: below about 3.5 Mbit/s, a 133 MB archive can never finish, and every
  retry starts from zero.
- Fix: an idle timeout instead of a total deadline, plus `Range:` resume of
  the `.partial` file (re-hash the partial before appending).

**DK-5. Preview captures cross IPC as data URLs of up to about 11 MB, after up to 12 PNG encodes.** Impact Low · Confidence Medium
- Where: `apps/desktop/electron/browser-preview-capture-image.ts:45-69`;
  `browser-preview-capture.ts:597`; `browser-preview-capture-store.ts:732-740`.
- Fix: serve spooled PNGs through a privileged custom protocol.

**DK-6. The preview tunnel opens a new WebSocket plus hello/open per TCP connection.** Impact Low · Confidence Medium
- Where: `apps/desktop/electron/preview-tunnel-client.ts:130-205`.
- Fix: multiplex streams over one socket per attachment.

**DK-7. Image layer order makes every bridge change re-pull about 225 MB of unchanged layers.** Impact Medium-High · Confidence High
- Where: `docker/Dockerfile:328-332` (bridge `COPY --from`) sits before
  `:346-359` (starship) and `:374-397` (mise plus Bun, 213 MB). The build
  stage copies all bridge sources (`:37-42`) before any build (`:47-58`).
- Bridge layers are 260 MB (claude), 198 MB (pi), 52 MB (cursor), 7 MB
  (codex) and 2 MB (acp). Because claude is first, a claude change also
  re-pulls pi and cursor.
- Fix:
  - Move starship and mise above the bridges.
  - Order the bridge `COPY`s by churn, most volatile last.
  - In the build stage, copy each bridge's sources just before its own
    `RUN`.

**DK-8. Bun is installed twice.** Impact Medium · Confidence Medium-High
- Where: `docker/Dockerfile:63` (the `oven/bun` base); `:388-391` (`mise
  install --system bun@1.4.4`, then `ln -sf`).
- Fix: point mise at the existing install. Verify with
  `du $(mise where bun@1.4.4)`.

**DK-9. Global `npm install -g` probably leaves npm's cache in the image.** Impact Medium · Confidence Medium **[re-checked: no cleanup present]**
- Where: `docker/Dockerfile:201` (claude-code), `:229` (codex), `:302`
  (playwright).
- Evidence: the Claude layer is 371 MB for a ~293 MB binary, and the Codex
  layer is 627 MB for about 385 MB of binaries. Direct-download layers match
  their binaries.
- Fix: `&& npm cache clean --force` in the same `RUN`, or install with
  `--cache /tmp/npm` and remove it. 0022 decided against BuildKit cache
  mounts, so prefer cleanup in the same `RUN`. Verify with
  `du -sh /home/node/.npm` in the image.

**DK-10. Two Claude Code native binaries ship (global CLI and SDK vendor).** Impact Low-Medium · Confidence Low
- Where: `docker/Dockerfile:47-49, 191-192, 201`. The CLI and SDK
  deliberately follow separate release trains, so this may not be fixable.

**DK-11. A leftover `apt-get update` sits after the script COPYs.** Impact Low (rebuild time only) · Confidence High
- Where: `docker/Dockerfile:449-473`.
- Fix: remove it, or move `util-linux` into the first apt layer.

**DK-12. The workspace clone is copied byte for byte within the same volume.** Impact Medium (large repos) · Confidence High
- Where: `docker/workspace-setup.sh:471-483` (`cp -a -n`, then `rm -rf`).
- Fix: `find "$CLONE_DEST" -mindepth 1 -maxdepth 1 -exec mv -n -t /workspace {} +`.
  This stays resumable under the existing marker logic.

**DK-13. Each environment clones from the remote again, with no shared mirror.** Impact Medium · Confidence High (mechanism)
- Where: `docker/workspace-setup.sh:385-397`;
  `apps/backend/src/core/commands-containers.ts:366`.
- Fix: a per-project bare mirror, mounted read-only and cloned with
  `--reference-if-able --dissociate`. (Unverified: blobless clones may also
  pay many lazy round trips for history-heavy diffs.)

**DK-14. Agent-home inputs are copied in full per environment, then copied again on every start.** Impact Medium · Confidence High (mechanism), Medium (size)
- Where: `apps/backend/src/core/portable-inputs.ts:61-67, 236-241, 316-322,
  504-545, 769-870`; `docker/network-policy-entrypoint.sh:165-196`;
  `docker/entrypoint.sh:438-578, 705-748`.
- Fix:
  - Write a stamp in `$HOME` from the existing `DOCKER_LABEL_INPUTS_REVISION`
    label and skip the copy when it matches.
  - Use a content-addressed host cache with hard links or reflinks.
  - Copy with bounded parallelism.

**DK-15. Environment-move fallback copies the whole worktree, even on the same device.** Impact Low · Confidence High
- Where: `apps/backend/src/core/environment-move.ts:238-256, 395-401`.
- Fix: try `rename` plus `git worktree repair` first, and copy only on
  `EXDEV`.

**DK-16. CLI `session transcript --follow` re-downloads the page every ≤2 s, for up to 24 h.** Impact Low-Medium · Confidence High
- Where: `packages/cli/src/client/commands/session.ts:1063-1068`;
  `packages/protocol/src/public-api-inputs.ts:1130-1150`;
  `packages/cli/src/client/wait.ts:63-71`.
- Fix: an optional `knownToken` that returns `unchanged`. `attention
  --follow` probably has the same pattern; not checked.

**DK-17. The CLI transport buffers each response three times.** Impact Low · Confidence High
- Where: `packages/cli/src/client/transport.ts:109-121, 160-169, 179`.
- Fix: decode the bounded bytes directly.

**DK-18. The log sink runs `mkdir` and `appendFile` per line.** Impact Low · Confidence High
- Where: `packages/protocol/src/node/application-logging.ts:353-363`.
- Fix: keep the file handle open, coalesce lines into one write per tick, and
  `mkdir` only on rollover.

The quadratic SSE decoder also appeared in this area's review; it is reported
once, as GW-4.

## Already done well

These patterns are worth keeping. Several are the reference implementations
the fixes above should copy:

- **Serialise once, share everywhere.**
  - Gateway events are serialised once per event, and terminal events lazily.
  - Claude SSE memoises serialisation per event. Codex SSE serialises only
    when someone is subscribed and collapses superseded frames.
  - Per-object memoised JSON in `native-agent-projection-encoding.ts`.
- **Conditional reads everywhere.** `knownToken` → `unchanged` on bridge
  transcripts, backend projections and renderer reads. ETag LRU on the PR
  viewer. Digest-based file trees.
- **Bounded, coalesced recurring work.**
  - `RecurringScheduler`, `WorkAdmissionPool`, keyed workflow supervision.
  - The native observation broker with no-touch, batched `/sessions/activity`.
  - Doorbell signals for Claude state and worktrees, and the client read
    coordinator with hidden-document pause.
- **Codex bridge stream handling.** Incremental JSONL framing, a read loop
  that never awaits, a rollout block index with `dev:ino`/size/mtime checks,
  and adaptive 100/250/500 ms publishing.
- **Transcript architecture.** v2 summaries move bodies behind locators, part
  patches are negotiated only when smaller, history windows are bounded, and
  display-tail writes are debounced.
- **Renderer rendering.** Virtuoso virtualisation, Shiki in a worker that
  highlights only appended lines, incremental streaming markdown parse, and
  WeakMap identity caches in the message adapters.
- **Static delivery.** Precompressed assets, immutable caching for hashed
  files, working 304s, and a dynamic-compression concurrency cap with an
  identity fallback.
- **Containers.**
  - Content hashing runs inside the container, and only missing blobs are
    transferred, in batches.
  - A shared `docker ps` snapshot, one stats sampler, one shared leased
    `docker logs -f` per container, and OOM via `docker events`.
  - Blobless, tag-free clones. Account-home entries are symlinked, not
    copied.
- **SQLite basics.** WAL, cached prepared statements (`db.query`), row-diffed
  writes, and no-op saves skipped.

## Suggested roadmap

### Phase 1: quick wins (each a small, local change)

1. WEB-2, WEB-3, WEB-4, WEB-5, WEB-8, WEB-15: renderer re-render and refetch
   fixes.
2. ST-7 and ST-8: keyed getters and in-place row-cache updates. TX-4, BG-4
   and much of BG-5 come along with them.
3. BG-3: gate mail presence.
4. BG-1: throttle tmux discovery and use a bounded head check.
5. BR-1 and BR-3: ACP persistence debounce and the 1 MB bound interval.
6. BR-8: Claude `createdAt` identity fix.
7. GW-4 and BR-12: incremental stream framing.
8. ST-1, ST-2, ST-4: change-tracking stamp short-circuit, module-level
   `dlopen`, and the count memo.
9. TX-3, TX-9, TX-18: memoised fingerprints, and passing `limit` through.
10. DK-7, DK-8, DK-9, DK-11: Dockerfile ordering and cleanup. Verify sizes
    with `docker history` before and after.
11. GW-13, WEB-18: replace pollable dialogs with authoritative listeners;
    pause polls when the window is hidden.

### Phase 2: medium projects

1. TX-1: delta-base ring.
2. TX-2: summary-based post-dispatch refresh and state-only reads.
3. WEB-1 / GW-1: move discovery off the hot round, then add a combined
   progressive-update command.
4. BG-2: one tmux snapshot exec per tick, with idle backoff.
5. BG-6: PR monitor activity backoff, plus batching or ETags.
6. DK-3: stamp-based toolchain verification. DK-4: resumable downloads.
7. GW-8 and GW-9: preview upstream pooling and derived ETags.
8. ST-14, ST-15, ST-16: one-pass git diff, untracked stat cache, and a
   minimum scan gap.
9. ST-9 and ST-10: agent mail envelope split, and `updateStoreRow` for keyed
   arrays.
10. BR-4, BR-5, BR-6, BR-15: shared bridge transcript helpers with cached
    measurement.

### Phase 3: structural

1. DK-1 and DK-2: the local desktop uses the filtered gateway transport and
   the terminal WebSocket.
2. TX-5 and TX-6: bridge state ETags and transcript deltas, wired to the
   push or long-poll delivery from WEB-1.
3. BG-2 (full) and BG-8: a per-container co-process or doorbell for tmux
   hooks, and a `docker events` lifecycle follower.
4. DK-13 and DK-14: per-project git mirror and content-addressed agent-home
   inputs.
5. GW-2 and GW-7: compression defaults, decided by 0052's measurement plan.

## Measuring before changing

The repository already records most of what is needed to confirm or reject
these findings:

- **Recurring work.** `get_recurring_work_diagnostics` and the
  `recurringWork` block of `/__orkestrator/metrics` count `git-spawn`,
  `gh-spawn`, `docker-exec`, `storage-read` (with bytes) and
  `provider-request` per job kind. Recommended checks:
  - Before ST-7: compare `storage-read` bytes for `mail-presence` and
    `activity`.
  - Before BG-1 and BG-2: compare `docker-exec` counts with an idle tmux tab
    open.
  - BG-6: track `gh-spawn` per hour.
- **Gateway.** The gateway metrics separate serialised and encoded SSE bytes,
  WebSocket payload and framed bytes, ACKs and desyncs, which covers GW-2,
  GW-6 and GW-7. Follow 0052's baseline matrix in
  `plans/stream-efficience.md`.
- **Change tracking.** The existing capture benchmark (warm 10k files) should
  add a large-asset fixture before and after ST-1, and a long-turn,
  200-changed-files fixture for ST-4.
- **Renderer.** React Profiler with two visible agent tabs, idle and
  streaming, for WEB-2, WEB-5 and WEB-7. Count backend RPCs per environment
  activity transition for WEB-3.
- **Startup.** Time from launch to backend ready, with a warm and a cold page
  cache, for DK-3.
- **Image.** `docker history` and `du` inside the image for DK-7 to DK-9.

## Invariants every fix must keep

These are summarised from `AGENTS.md`. Several of the fixes above touch them
directly:

- Live events stay incremental over authoritative snapshots. Missed events
  must remain detectable (revision gap, generation, expired cursor). This
  matters for TX-1, TX-6, GW-12 and WEB-1.
- Every queue, ring, cache and compression buffer has byte **and** count
  bounds. The new caches proposed in TX-1, ST-4, ST-5, BR-4, GW-8 and BG-5
  need explicit bounds.
- Unmount is not cancel. Moving reads off timers (WEB-1, BG-3) must not make
  background work depend on a mounted view.
- Codex's stdout loop never awaits consumers (BR-7, BR-13).
- A transcript row is one model response. TX-6's bridge deltas must carry
  `revisedMessages` for rows outside the live tail.
- Durability trade-offs in ST-12 are product decisions, not oversights.
  Change them only with explicit sign-off.
- Metrics added to measure these changes must stay content-free.
