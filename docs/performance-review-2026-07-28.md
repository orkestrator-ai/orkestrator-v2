# Performance & Efficiency Review — 2026-07-28

Scope: full codebase — `apps/backend`, `apps/desktop/electron`, `apps/web` (stores/data layer and components), `bridges/codex-bridge`, `bridges/claude-bridge`, `packages/protocol`. Five parallel audits, findings verified against source with file/line references.

Overall: the codebase shows a lot of deliberate, well-executed performance work (delta patch protocols, SSE replay cursors, diff budgets, transcript caches, watcher-driven diff stats, virtualized transcripts). The remaining costs cluster into a small number of systemic patterns rather than being scattered one-offs. Fixing the top ~8 items below removes the large majority of avoidable CPU, I/O, and cross-process traffic.

---

## Executive summary — top issues by expected win

| # | Issue | Where | Impact |
|---|-------|-------|--------|
| 1 | The 10-second activity-lease write loop: full `environments.json` rewrite + backup rotation → change announcement → every client refetches **all** projects → one `docker inspect` per environment | backend storage + frontend sync (compound loop) | High |
| 2 | OpenCode chat: full-transcript refetch (plus recursive subagent hydration) up to 5×/s per streaming session, continuing for background environments | `apps/web` | High |
| 3 | BuildChatTab ignores the claude-bridge's delta-patch protocol and refetches the full transcript up to 5×/s during build turns | `apps/web` + claude-bridge data path | High |
| 4 | Codex bridge rescans the entire Codex home (stat + open + head-read of every rollout on disk) on every thread hydration and every `/session/list` | codex-bridge | High |
| 5 | Claude tmux backend: ~4 process spawns per 250 ms tick per session (up to ~16–20 `docker exec`/s per container tab), plus full-transcript re-read on every append | backend | High |
| 6 | Terminal output crosses 4 serialization boundaries as JSON number arrays (~3.7× wire inflation, ~8 bytes heap per output byte), uncoalesced, broadcast to all SSE clients | backend → Electron → renderer | High |
| 7 | Per-frame re-normalization of the whole transcript defeats `memo(NativeMessage)` for every mounted row on every streaming frame | `apps/web` components | High |
| 8 | Selector-less Zustand subscriptions (55 occurrences in 38 files) turn every store write into app-wide re-renders | `apps/web` | High |

---

## 1. The environments.json write-amplification loop (compound, HIGH)

This is one loop spanning three processes. Each piece is individually modest; together they form a steady tax that runs whenever any agent is active.

**The chain:**

1. **Renderer**: every 10 s per active environment, the activity-lease renewal POSTs `setEnvironmentAgentActivity` and does two `updateEnvironment` store writes (`apps/web/src/hooks/useGlobalActivityMonitor.ts:832-897`; interval = `FRONTEND_AGENT_ACTIVITY_LEASE_MS/3` from `packages/protocol/src/agent-activity.ts:32`).
2. **Backend**: that mutation has no read cache and rewrites the **entire** `environments.json` — which also embeds each environment's `claudeModelCatalog` snapshot — plus a 5-backup rotation (~18 fs ops) and a lock create/write/read/delete cycle per save (`apps/backend/src/core/storage.ts:1011-1037`, `1224-1235`, `1180-1218`, `1565-1679`). `loadJson` re-reads and re-parses the file on every access (`storage.ts:1237-1256`).
3. **Announcement fan-out**: the write announces an `environment` resource change. `useEnvironmentListSync` can't map an environment id to a project, so it calls `refreshAll()` for **every** project (`apps/web/src/hooks/useEnvironmentListSync.ts:85-87`) — on every announcement, on every connected client.
4. **Docker amplification**: each `get_environments` runs `syncStoredEnvironmentStatus` per environment, spawning one `docker inspect` per containerized environment, including stopped ones (`apps/backend/src/core/commands.ts:5233-5251`, `2395-2398`).
5. **Render amplification**: `updateEnvironment` re-sorts and re-maps the whole list and replaces the array identity even for no-op patches (`apps/web/src/stores/environmentStore.ts:204-244`), re-rendering all `environments` subscribers — many of which are selector-less (§8).

**Related:** the backend lease sweep parses `environments.json` every 15 s even when idle (`apps/backend/src/core/index.ts:52-59`); `ClaudeStatePollManager` parses it every second per running container *before* its no-change short-circuit (`apps/backend/src/core/tmux.ts:2024-2059`).

**Fixes (in order):**
- Cache the parsed stores in `StorageService` (single-writer process) and invalidate on write.
- Split volatile fields (`lastActivityAt`, `agentActivitySources`, observer leases) into a small separate file, or at least skip backup rotation for activity-only mutations.
- Exclude pure lease renewals from resource-change announcements (they change no user-visible field), and/or include `projectId` in environment announcements so clients refresh one project.
- Batch container status into one `docker ps -a --filter label=…` per `get_environments` call instead of N `docker inspect`.
- In `updateEnvironment`, bail out when the merged record is field-equal; skip `sortByOrder` unless `order` changed.
- Reorder `ClaudeStatePollManager.poll` to check `state !== lastState` before touching storage.

---

## 2. OpenCode full-transcript refetch loop (HIGH)

`message.updated` / `session.updated` events trigger a full `getSessionMessages` refetch, debounced to only 200 ms (`apps/web/src/components/opencode/OpenCodeChatTab.tsx:1349`, `1427-1479`, `1585-1596`). `getSessionMessages` has no pagination or cursor, and with `includeSubagents` on it also calls `session.children` + `session.status` and **recursively fetches every child session's full transcript** (`apps/web/src/lib/opencode-client.ts:1303-1350`, `1471-1537`). The subscription deliberately survives unmount, so background environments keep this loop running at up to 5 Hz per streaming session.

Each refetch then goes through `setMessages`, whose merge returns the fresh array — every message/part gets a new identity, breaking memoization for the entire list — and when optimistic messages are pending it `JSON.stringify`s **every message including tool outputs** twice for fingerprinting (`apps/web/src/stores/createNativeChatStore.ts:245-255`, `apps/web/src/lib/chat/client-only-messages.ts:149-196`).

**Fixes:**
- Make `message.part.updated` (already applied incrementally) the primary path; refetch only on `session.idle` and on part-application failure.
- Pass `includeSubagents: false` for streaming refreshes; hydrate subagents on final events.
- In the merge, reuse existing message objects when id + cheap revision check say unchanged; fingerprint only optimistic candidates and exclude `toolOutput`.
- Also fix the per-event O(sessions × messages) subagent scan in the SSE loop (`OpenCodeChatTab.tsx:1643-1671`) with a maintained `Set<childSessionId>`.

---

## 3. BuildChatTab negates the claude-bridge delta protocol (HIGH)

The claude-bridge implements a well-designed `message.patched` delta protocol (full frame once, revision-guarded index patches after). `ClaudeChatTab` uses it. `BuildChatTab` does not — by its own comment it "never applies an event payload — it always refetches", so every patch frame (~10/s during streaming) triggers a full `GET /session/:id/messages`, rate-limited only to 200 ms (`apps/web/src/components/build-pipeline/BuildChatTab.tsx:436-499`; server serializes the whole transcript at `bridges/claude-bridge/src/routes/session.ts:221-238`).

A build session with a 5 MB accumulated transcript sustains ~25 MB/s of serialize + parse + GC across both processes for the duration of the turn — and build turns are exactly the long, heavy-transcript case the patch protocol was built for.

**Fix:** reuse ClaudeChatTab's handler shape — upsert full `message.updated` payloads, apply `message.patched` via `applyClaudeMessagePatch` (`apps/web/src/lib/claude-client.ts:468-495`), refetch only on patch failure and `session.idle`.

---

## 4. Codex bridge: whole-home catalog scans (HIGH)

- **Per thread hydration**: `hydrateMessagesFromPersistedSession` calls `listPersistedSessionsForCwd(...).find(id)` before falling back to the direct per-thread lookup (`bridges/codex-bridge/src/history/rollout.ts:590-599`). The listing builds the full transcript catalog — a recursive walk of `sessions/` and `archived_sessions/` with a stat + open + up-to-64KB head read + JSONL parse **per rollout on disk** (`rollout.ts:283-317`, `395-447`). This runs on every re-attach after the 30-minute idle detach, resume, fork, and dispatch recovery. Thousands of rollouts → thousands of file opens to hydrate one thread. **Fix:** invert the lookup — try `getPersistedSessionMeta(threadId)` (bounded per-thread cache, one head read) first; fall back to the listing only on miss.
- **Per `/session/list` request**: same full catalog rebuild per request with no caching, and the generated-title index is read and line-parsed **twice** per request (`bridges/codex-bridge/src/app-server-runtime.ts:3457`, `3473`). **Fix:** short-TTL or mtime-keyed catalog cache; return the title map the listing already computed.

---

## 5. Claude tmux backend polling and transcript I/O (HIGH)

- **Poll loop** (`apps/backend/src/core/tmux.ts:1276-1354`, 250 ms tick): each tick does two `listDir`s (pending + timeout dirs), a transcript `stat`, and a `tmux has-session` spawn — in container mode that's ~16–20 `docker exec` process spawns per second per open tab, running even while Claude is idle. **Fix:** merge the two dir listings (one exec running a small script that lists both dirs and stats the transcript), check tmux liveness every Nth tick or via an exit sentinel, and use `fs.watch` in local mode (pattern already exists in `worktree-watcher.ts`).
- **`TranscriptTail.readNew`** re-reads the **whole** transcript file on every append and discards everything before the offset (`tmux.ts:888-914`) — O(file²) cumulative; a 5 MB transcript costs ~1 GB of reads over its life, piped through `docker exec cat` in container mode. **Fix:** read from offset (local: file handle + positioned read; container: `tail -c +<offset+1>`).
- **`ClaudeStatePollManager`**: one `docker exec cat /tmp/.claude-state` + one full `environments.json` parse per second per container (`tmux.ts:1892-2059`) — see §1 for the storage half.
- **Interactive tmux terminal** polls `tmux capture-pane -e` every 250 ms per attached terminal (`tmux.ts:1758-1795`; output is diffed, but the spawn happens regardless), and the renderer separately polls `claude_tmux_capture_pane` at 500–1000 ms with no server-side change marker (`tmux.ts:2178-2180`, `apps/web/src/components/claude/ClaudeTmuxChatTab.tsx:904-924`). **Fix:** share one tick, return "unchanged" markers, consider `tmux pipe-pane` streaming.
- **`listPreviousSessions`** reads full transcript files (up to 50, potentially MBs each, `docker exec cat` per file) just to derive a title and count (`tmux.ts:802-835`) — the same anti-pattern the codex bridge already fixed ("never let a metadata scan read whole rollout files"). **Fix:** head read + `wc -l`.

---

## 6. Terminal output data path (HIGH)

PTY bytes are converted to a JavaScript **number array** (`Array.from(Buffer)`, `apps/backend/src/core/commands.ts:2176-2178`; same in `tmux.ts:154-156`, `1794`), JSON-stringified for SSE (~3.7× wire inflation vs 1.33× for base64; ~8 heap bytes per output byte), re-parsed in Electron main (`apps/desktop/electron/backend-process.ts:131-143`), structured-cloned to every window (`main.ts:49-53`), and re-received in the renderer as `number[]` (`apps/web/src/hooks/useTerminal.ts:326-331`). A 10 MB `cat` crosses four boundaries as ~37 MB of JSON with ~80 MB of transient heap.

There is **no coalescing** — one event per PTY read callback (hundreds/sec for fast producers) — and the gateway broadcasts every event to **every** SSE client with no per-client filtering and no backpressure handling (`apps/backend/src/gateway.ts:889-895`; `client.write` return ignored, so a slow remote Tailscale client buffers unboundedly).

**Fixes:** (a) base64-encode payloads end to end; (b) coalesce PTY output per session with a ~16 ms flush timer; (c) per-client event-prefix subscriptions (terminal events are already namespaced) and pause/drop on `write() === false`; (d) longer-term, a dedicated binary channel for terminal streams.

Related renderer-side costs: the rolling terminal buffer does an O(500 KB) string copy per chunk at cap (`commands.ts:2180-2189` — keep `string[]` + running length instead); `PersistentTerminal` allocates a `TextDecoder` and decodes every chunk even after readiness detection is done (`apps/web/src/components/terminal/PersistentTerminal.tsx:384-458`), and its ResizeObserver does synchronous fit + backend resize IPC per observation during pane drags (`:1157-1177` — use the existing RAF `scheduleFit`).

---

## 7. Transcript rendering: identity churn defeats memoization (HIGH)

`upsertMessage` correctly preserves identities of unchanged messages (`apps/web/src/stores/createNativeChatStore.ts:215-232`), but all three chat tabs then map the array through `normalizeNativeMessage`, which unconditionally returns new objects with new part objects for **every** message on **every** streaming frame (~10/s) (`apps/web/src/lib/chat/native-message-adapters.ts:325-333`; consumed at `CodexChatTab.tsx:435-438`, `OpenCodeChatTab.tsx:321-326`, `ClaudeChatTab.tsx:573-576`). Result: `memo(NativeMessage)` fails for every mounted row every frame, each re-rendered row re-runs normalization a second time internally (`NativeMessage.tsx:1546-1559`), and downstream `useMemo`s keyed on the array (fork plan, context usage) rerun per frame:

- `buildMessageForkPlan` — O(N), some paths O(N²), rebuilt ~10×/s (`CodexChatTab.tsx:457-491` and equivalents).
- OpenCode context usage recomputed per frame and written to a store whose `setContextUsage` has no equality bail (`OpenCodeChatTab.tsx:529-532`, `stores/codexStore.ts:344-350`).

**Fix (single highest-leverage frontend change):** a module-level `WeakMap<NativeMessage, NativeMessage>` cache in `normalizeNativeMessage` so identity-preserved source messages return the same normalized object. This makes the existing memoization actually hold, collapses per-frame work to the one streaming message, and removes double normalization. Then key the fork-plan memo on a message-boundary signal and add equality bails to `setContextUsage`/`setSlashCommands`.

---

## 8. Selector-less Zustand subscriptions (HIGH)

55 occurrences in 38 files call `useXStore()` with no selector, re-rendering on every store write. The worst offenders sit on hot stores:

- `useEnvironments.ts:205-225` (mounted 5× — App, sidebar, ActionBar, FeaturesView, useBuildPipeline) on `environmentStore`, which is rewritten every activity tick.
- `OpenCodeChatTab.tsx:251-284`, `OpenCodeComposeBar.tsx:174`, `ClaudeChatTab.tsx:173-211`, `ClaudeComposeBar.tsx:100-139`, `BuildChatTab.tsx:245,265` — chat tabs/compose bars re-render on every streamed token of **any** session in any environment. With background environments fully mounted (`App.tsx:645-670`), one streaming session re-renders every mounted tab.
- Terminal stack: `TerminalContainer.tsx:355-542`, `PersistentTerminal.tsx:204,515-524`, `TerminalPortalHost.tsx:62-68` (which also recomputes `getAllLeaves` un-memoized every render, defeating its own stable-key design, `:120-183`).
- Sidebar: `EnvironmentItem.tsx:184-192` subscribes to entire activity-state records (any environment's tick re-renders every row), is un-memoized, and mounts a 1,047-line settings dialog per row even when closed (`:609-615`). `HierarchicalSidebar.tsx:343-362` subscribes to the whole UI store and re-sorts all environments per change.

`CodexChatTab.tsx:301-366` and `CodexComposeBar.tsx:118-136` demonstrate the correct narrow-selector pattern already in-repo. **Fix:** mechanical migration to per-key selectors / `useShallow`; also move `useEnvironments`' global event listeners into a singleton hook mounted once at App root (currently 5 duplicate registrations, `useEnvironments.ts:292-394`).

---

## Medium-impact findings

### Backend / Electron
- **`get_environments` / 60 s resync**: idle steady state with 20 environments and 5 projects is ~70+ IPC/HTTP reads per minute; per-environment session/queue refetches always rewrite store Maps even when nothing changed (`apps/web/src/lib/store-resource-sync.ts:96-132`, `apps/web/src/stores/sessionStore.ts:95-129`). `useEnvironmentListSync` double-fires — it has its own 60 s interval **and** subscribes to the global resync (`useEnvironmentListSync.ts:12,88-94`). Scope the safety net to running/visible environments; diff before writing; drop the duplicate interval.
- **Files panel**: full git-status + full file-tree fetch every 5 s with no response diffing while open (`apps/web/src/hooks/useFilesPanel.ts:9,98-181,265-277`). Digest-compare before store writes; fetch the tree lazily.
- **`buildFileTree`** recurses the whole worktree serially with no cap (container path caps at 5000; local doesn't) and skips only `.git`/`node_modules` (`apps/backend/src/core/commands.ts:3714-3745`). Use `git ls-files -co --exclude-standard` or apply the cap.

### Codex bridge
- **SSE re-serialization**: each subscriber and each ring replay independently `JSON.stringify`s the same frame, and `message.updated` frames embed the entire message snapshot (`bridges/codex-bridge/src/index.ts:441-452`, `1273-1294`). Memoize the serialized string per (event, sessionId).
- **Full-turn re-render per coalesced publish**: `renderTurn` rebuilds every part of the turn each tick — O(turn²) cumulative for long turns (`messages/render-turn.ts:249-331`). Cache `NormalizedPart[]` per completed (immutable) item. Trivial adjacent win: `collectTurnItems` is computed unconditionally at `render-turn.ts:253` but only used inside the 2 s probe branch — ~95% of streaming renders throw it away.
- **Diff-budget accounting** is O(total baseline bytes) per check, recomputed per evicted entry, and runs on the polled `/global/health` path (`messages/diff-budget.ts:82-111`, `app-server-runtime.ts:1152-1170`). Keep a running byte counter.
- **RPC inbound buffer** rescans from offset 0 while a giant line (multi-MB `thread/read` response) streams in — O(n²) (`app-server/jsonl-rpc-client.ts:185-207`). Track a `searchFrom` offset.

### Claude bridge
- **Per-flush full-turn rebuild**: every 100 ms flush rebuilds the whole turn's parts and re-concatenates all text — O(turn size) at 10 Hz — and per-token delta accumulation rebuilds the block string, O(n²) for large thinking blocks (`bridges/claude-bridge/src/services/session-manager.ts:2887-3029`, `3101-3119`). Track the dirty message, rebuild only its slice; append-only accumulators per block.
- **No transcript eviction**: hydrated transcripts stay pinned in bridge memory forever (per-part caps bound single parts, not the aggregate; one bridge per environment). Add idle eviction that resets `persistedMessagesLoaded` — disk is the rehydration source, so this is safe (`session-manager.ts:49`, `1265-1461`). The codex bridge's idle detachment is the in-repo precedent.
- **`execFileSync`** (`which`, `claude --version`) blocks the whole bridge event loop for up to seconds, stalling all sessions' streaming while it runs (`session-manager.ts:455`, `4177-4181`). Both call sites are async — switch to `execFile`.
- **Claude SSE has no reconnect cursor** (unlike Codex): every blip forces a full transcript refetch; the abort listener also leaks per subscription cycle (`apps/web/src/lib/claude-client.ts:1347-1477`). Mirror the Codex `?since=`/revision design.

### Components
- **`TerminalContext` provider value** recreated per render; consumers include `EditToolPart` in every mounted transcript (`apps/web/src/contexts/TerminalContext.tsx:125-148`). Split state vs stable-actions contexts.
- **Background environment host** (`App.tsx:645-670`): hidden xterms still paint per PTY chunk under `opacity-0`. After the H1–H3 render fixes, consider `content-visibility: hidden`/`display:none` with `refresh()` on reveal (already called at `PersistentTerminal.tsx:1091-1100`).

---

## Low-impact (worth batching opportunistically)

- Codex bridge: slash-command directory walk + full file reads per `/command` prompt; shell spawn per prompt for env refresh (add short TTL); `GET /session/:id/config` reloads the whole session store; session-title index unbounded append-only JSONL fully re-parsed per read.
- Claude bridge: per-subscriber SSE stringify; SSE backlog cap counts UTF-16 code units not bytes (`events.ts:45` — use `Buffer.byteLength`); uncached slash-command file scans per tab mount; full transcript read to resolve one uuid on fork/rewind.
- Backend: `sendInteractiveData` rebuilds the key-sequence array per character and spawns one `tmux send-keys` per special key (`tmux.ts:1827`); setup-terminal buffers (500 KB each) retained until environment removal; `jsonContainsSessionId` deep-recurses all JSON values during session binding.
- Frontend: `useElapsedTimer` re-renders whole chat tabs at 1 Hz during turns (isolate into a tiny label component); tmux TUI hidden-pane capture at 1 Hz could drop to 2–5 s; `waitForSetupInitiation` busy-polls at 50 ms; Maps without eviction (`githubIssuesStore.details`, `terminalSessionStore.serializedBuffer` + duplicated base64/dataUrl image drafts, module-level request maps); agent-activity state duplicated across three renderer locations (2–3 writes per transition); `EnvironmentItem` does `new Date().toLocaleDateString()` per row per render; part keys include array index, remounting siblings on mid-message inserts.

---

## Verified-good (preserve these patterns)

- **Codex bridge**: head-only metadata scans, LRU transcript cache with byte budgets and incremental tail reads, diff budget with per-turn cache, idle-thread detachment, bounded SSE ring + per-connection write budget, O(1) recorder read loop, RPC read loop never awaits consumers, adaptive snapshot cadence, bounded accumulators everywhere.
- **Claude bridge**: `message.patched` delta protocol with revision continuity, 100 ms delta coalescing with synchronous flush before non-delta events, stat-fingerprinted `json-file-cache`, UTF-8-safe part budgets, allocation-guarded debug logging, SSE backpressure with close-on-stall, no idle polling.
- **Backend**: DiffStatsService (watcher-driven, single-flight, diffed-before-emit, generation-guarded — the acd2a603 work is solid), GitFetchScheduler (TTL + single-flight + common-dir dedupe), parallel local git status with streamed line counting and `core.untrackedCache`/`fsmonitor`, lightweight id-only resource announcements.
- **Frontend**: Codex SSE replay cursor + whole-message upserts, identity-checked approval/interaction snapshots, `useStalledTurnWatchdog` rate bounding, PR monitor polling only the active environment, 50 ms announcement coalescing, `MessageMarkdown` content-keyed memo, react-virtuoso everywhere, `upsertMessage` identity preservation, xterm portal architecture, stable empty singletons.
- **Protocol**: no zod on hot paths; flat structural guards with prebuilt Sets; id-only high-frequency events; single shared lease-renewal interval.

---

## Suggested execution order

1. **Storage cache + activity-write decoupling + announcement scoping + `docker ps` batching** (§1) — kills the largest steady-state loop; mostly backend, low risk.
2. **`normalizeNativeMessage` WeakMap cache** (§7) — one small change that makes all existing frontend memoization work.
3. **BuildChatTab → patch protocol** (§3) and **OpenCode refetch → part-event primary path** (§2) — the two big transcript-traffic wins; the handler logic already exists in-repo for both.
4. **Codex-bridge hydration lookup inversion + `/session/list` catalog cache** (§4) — two small changes in the rollout layer.
5. **Zustand selector migration** (§8) — mechanical; prioritize `useEnvironments`, the chat tabs/compose bars, terminal stack, `EnvironmentItem`.
6. **tmux tick consolidation + `TranscriptTail` offset reads** (§5).
7. **Terminal base64 + coalescing + per-client SSE filtering** (§6).
8. Medium/low batches as adjacent files are touched.
