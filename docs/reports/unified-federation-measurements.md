# Unified federation: wave 0 measurements

Status: Measured 2026-11-07. Plan items
[0004](../../plans/unified/0004-measurement-report.md),
[0001](../../plans/unified/0001-realm-request-drift.md),
[0002](../../plans/unified/0002-attention-without-realm.md),
[0003](../../plans/unified/0003-hidden-realm-visibility.md) and
[0006](../../plans/unified/0006-grant-scope-live-evidence.md). The design these
numbers feed is [unified-federation.md](unified-federation.md) (§8.2 budgets,
§15 evidence).

## What ran

- **Date:** 2026-11-07.
- **Code:** branch `unified-federation-b4c9ee65814d` at `9ee281002`, in a
  separate detached worktree, plus the development memory diagnostic from
  `112938cd5` applied on top. 0002 and 0003 were also run with their fix
  reverted in that worktree (Vite hot reload), to get a before and an after.
- **Host:** one Mac, `arktech-mini` (macOS 27.2, build 26B123, 18 cores,
  64 GB). Every node ran on this host and talked over loopback
  (`127.0.0.1`). No other host was used.
- **Nodes:**
  - two `dev:test` profiles, `uf-live-cmd` (command node) and `uf-live-leaf`
    (attached as a leaf with `add_node`). Both used `--fixture
    --no-agent-credentials --headless --agent-platforms claude` and
    `ORKESTRATOR_HOST_REACHABILITY_CHECK=off`;
  - five more current leaves (Leaf2–Leaf6), backends from source with
    throwaway data directories, attached to `uf-live-cmd`;
  - for the desktop numbers, a Playwright-launched Electron 45.0.0 command
    node (agent-test profile, development mode, renderer from the Vite dev
    server) with four leaves from source;
  - for 5740 task 2, the published `orkestrator@2.35.1-beta` npm CLI as a
    command node, with a throwaway data directory, random loopback ports and
    `ORKESTRATOR_CONTROL_MCP_PORT=0`. It served the v2.35.1-beta web client,
    built from the `v2.35.1-beta` tag. One current leaf was attached to it.
- **Browsers:**
  - Chrome for Testing 156.0.8078.4 (`--headless=new`), driven over CDP;
  - Playwright WebKit (build 2370, reports 27.2). This is the nearest thing
    to Safari available here. It is not Safari.
- **No billed turns** and no real logins. Scripts and raw JSON are in the
  ignored `output/agent-testing/uf-live/`. No tokens, prompts, transcripts or
  file contents were recorded.

**Caveat for every desktop number.** The Electron renderer loaded unbundled
modules from the Vite dev server, so a development realm is larger than a
packaged one. Treat the desktop figures as an upper bound until a packaged
build is measured.

## Memory per realm

### Desktop (Electron, development build)

Sampled with the new development diagnostic (below), cross-checked against
`app.getAppMetrics()` directly. Working set in MB, after 20 s of settling.
`privateBytes` is not reported on macOS.

| State | Total | Browser | GPU | Utility | Window renderer | Realm renderers |
|---|---|---|---|---|---|---|
| 0 realms | 726 | 236 | 109 | 75 | 306 | — |
| 1 realm, project board (idle) | 1142 | 246 | 110 | 76 | 307 | 402 |
| 1 realm, environment with terminal | 1131 | 245 | 114 | 76 | 308 | 388 |
| 1 realm, empty agent tab (no turn) | 1099 | 247 | 110 | 76 | 308 | 357 (peak 410) |
| 3 realms (renderer cap `MAX_OPEN_REALMS`), one shown | 1893 | 258 | 116 | 80 | — | 364, 372, 383 |
| 4 realms (main cap `DEFAULT_MAX_VIEWS`), one shown | 2189 | 258 | 116 | 81 | — | 363, 335, 342, 375 |

- Each realm is one renderer process of about **340–410 MB**. Hidden realms
  shrink only slightly (343–381 MB).
- A fifth view is refused by main with "Too many machines are open in this
  window."
- "With a transcript open" was measured only as an empty agent tab. A real
  transcript needs a provider turn, and none was run.

### Browser (iframe realms)

`crossOriginIsolated` is false and `performance.measureUserAgentSpecificMemory`
is undefined on the hosted page, so neither browser can use that API today.

Chromium was measured with CDP `Runtime.getHeapUsage` after
`HeapProfiler.collectGarbage`. The window and its same-origin iframes share
one isolate, so the heap is the page's whole JS heap. RSS is from `ps` for
the page's renderer process. Six nodes were attached.

| Realms open | JS heap used (MB) | Δ | Renderer RSS (MB) | Δ |
|---|---|---|---|---|
| 0 | 49.8 | — | 562 | — |
| 1 | 82.4 | +32.6 | 620 | +58 |
| 2 | 104.8 | +22.4 | 706 | +86 |
| 3 (cap) | 127.9 | +23.1 | 790 | +84 |
| 4th opened (one evicted, still 3) | 127.8 | −0.1 | 909 | +119 |

- Each iframe realm costs about **22–33 MB of JS heap** and **60–90 MB of
  RSS**.
- Evicting a realm and opening another frees the heap, but the renderer
  keeps the pages: RSS rose another 119 MB.
- A seventh realm cannot be open at once. The renderer keeps three
  (`MAX_OPEN_REALMS`), so "6 nodes" here means six attached nodes with three
  realms open.

WebKit was measured as the RSS of Playwright WebKit's processes, in MB. One
`WebContent` process holds the window and every iframe realm, which confirms
the premise of P3.

| Realms open | WebContent | Δ | Networking | GPU |
|---|---|---|---|---|
| 0 | 574 | — | 75 | 86 |
| 1 | 745 | +171 | 89 | 91 |
| 2 | 801 | +56 | 97 | 97 |
| 3 (cap) | 845 | +44 | 105 | 98 |
| 4th opened (one evicted) | 964 | +119 | 114 | 98 |

### iPad

**Not done: no iPad reachable from this host.** WebContent memory with 1, 3
and 6 realms, and the jetsam point, are still unmeasured.

## Hidden realms

### Request rate from a hidden browser realm (0003)

Measured in Chromium with three realms open:

- Leaf2: hidden by the region (display:none);
- Leaf3: hidden by the region, and its document also forced to
  `visibilityState: hidden` by script, which is what a hidden window's
  realm sees;
- Leaf4: shown.

Each run counted every `/__orkestrator/` request per frame for 120 s.

| Frame | Before 0003 (fix reverted) | After 0003 |
|---|---|---|
| Leaf2, hidden realm | **13.0 /min** (`get_system_usage` 12, `check_docker` 1) | **0 /min** |
| Leaf3, hidden-window rate | 0 /min | 0 /min |
| Leaf4, shown realm | 13.0 /min | 13.0 /min |
| Window | 97 /min | 97 /min |

After 0003, a hidden realm drops to the hidden-window rate. Before it, it
read at the shown rate.

The window's own 97 /min is mostly `invoke_on_node`, about 72 /min with three
realms open. The rest is `get_system_usage` 12, `watch_node_events` 12 and
`check_docker` 1. It is worth a look in Phase 4.

### Does a hidden desktop `WebContentsView` report hidden?

**No.** A realm view hidden with `setVisible(false)` reported
`visibilityState: "visible"`, and a 100 ms `setInterval` ticked 100 times in
10 s, so its timers were not throttled. This held in every case:

- with the window in agent-test hidden-windows mode;
- in a normal shown window;
- with the whole window minimized.

The window's own document also stayed visible when minimized. That is
unexpected, so repeat this on a workstation with someone at the display
before relying on the minimized case. The setVisible case is unambiguous: on
desktop, the 0003 `visibility` message is the only thing that tells a hidden
realm it is hidden. **It is not redundant.**

The run deliberately left out the spec suite's
`--disable-background-timer-throttling` and related switches.

## Transport

### `nextHopProtocol`

| Route | Observed |
|---|---|
| Direct, loopback, to a leaf (`http://127.0.0.1:<leaf>`) | `http/1.1` (CDP `response.protocol`). Resource timing shows `""` because the leaf is cross-origin and sends no `Timing-Allow-Origin`. |
| Relay through the command node (same origin as the page) | `http/1.1` (resource timing `nextHopProtocol` and CDP) |
| Direct over the LAN | Not measured: one host, and `dev:test` binds loopback only |
| Tailscale Serve | Not measured: `dev:test` never configures Tailscale Serve, and the production instance was not touched |

Todo 5380 task 2 stays open for the LAN and Tailscale Serve rows.

### Long-lived requests per origin (P5)

Chromium, with the relay forced: every leaf origin was blocked with CDP
`Network.setBlockedURLs`, with no client-side interception. All realm traffic
then went to the command node's origin over HTTP/1.1.

| Realms through the relay | Long-lived requests on the command-node origin | Requests waiting with no response after 30 s |
|---|---|---|
| 1 | Per realm: 2 × relayed `/nodes/<n>/__orkestrator/events` and 1 × portal `/__orkestrator/events`. A keepalive `client-metrics` POST is also never reported finished by CDP. | 0 |
| 2 | The second realm got 1 stream, then the pool was full | **50**. 13 were the window's own: `watch_node_events` 6, `invoke_on_node` 6, `get_system_usage` 1. |
| 3 | The third realm never rendered within 60 s | **55** |
| Direct, 3 realms (control) | 3 streams per realm, each on its own leaf origin | 0. Realms opened in 551–842 ms. |

**P5 is confirmed, and it is worse than §3 estimated.** A relayed realm holds
three event streams, not one or two. With **two** relayed realms, Chromium's
six-connections-per-host limit on HTTP/1.1 is used up. From then on every new
request on that origin waits, the window's included, and a third realm cannot
open. The window's own event transport did not appear in the page's CDP
Network domain (it is probably in a worker), so the sixth connection is
inferred rather than attributed.

One run was discarded: its harness blocked its own event loop while
intercepting requests, which stalled every request for about 86 s.

### Recommendation on 5005

**Needed** for the relay over plain HTTP/1.1. Two relayed realms in a
Chromium browser freeze the window today.

The alternatives are to guarantee HTTP/2 on every relay route, or to cut each
realm to one stream before Phase 4. Whether Tailscale Serve already
negotiates `h2` is unmeasured. If it does, the routes it fronts are
unaffected, but loopback, LAN and SSH-tunnelled HTTP relays are not.

## Cold open to first paint (this host only)

| Client | Measure | Values |
|---|---|---|
| Desktop realm (Electron, development build) | `realm.boot-step` `first-render` `sinceOpenMs` | 419–628 ms over 9 cold opens. `fan-out-complete` 597–795 ms. |
| Browser realm, Chromium | click to realm toolbar rendered | 471–842 ms (direct), 547–733 ms (relay). `first-render` `sinceStartMs` 278–304 ms. |
| Browser realm, WebKit | click to realm toolbar rendered | 485–715 ms |

Other hosts (Linux, iPad, real LAN or tailnet latency) were not measured.

## §8.2 budgets

Keep §8.2 as a placeholder for now, for three reasons:

- the desktop numbers come from a development renderer;
- the iPad was not measured;
- per-realm cost is not per-scope cost, because a scope shares the window's
  bundle and stores.

Still, these give the order of magnitude:

- a realm is a whole client: about 350–400 MB per realm on a development
  desktop, and about 25–30 MB of JS heap plus 60–90 MB of RSS per iframe in
  Chromium;
- WebKit puts every realm in one WebContent process, at +45–170 MB each.

Measure a packaged desktop build and an iPad before setting defaults.

## Other live evidence from the same run

- **0001.** A cold desktop realm was opened through the same preload API the
  window uses (`workspaceViews.open`), once with each field. Main's URL
  carried each field, and the realm acted on it:
  - `boardTab=home`: Home tab selected;
  - `workType=graph-run` with `workId`: a "Graph run 1" tab opened;
  - `bugReport=1`: the Report a bug sheet opened;
  - `dialog=environment-rebuild`: Environment Settings opened.
- **0002.** Attention on a leaf with no realm open was raised by a
  `terminal_finished` badge edge from an activity-tracked terminal, with no
  agent turn:
  - before the fix (reverted), the window played nothing;
  - after it, the window played one cue;
  - with the leaf's realm open but hidden, the realm played one cue and the
    window none.

  A question notification could not be produced without a provider turn.
- **0006 / 5740.**
  - Through the browser realm, by direct grant and with the relay forced, a
    terminal command, an agent tab (no turn), the agent and usage popovers,
    repository settings and the project boards all worked. None of the realm
    requests returned 403; the only 500s were `read_local_file` for a missing
    `orkestrator-ai.json`.
  - `update_global_config` and `request_host_update` returned 403, both
    with the grant and through the relay.
  - A v2.35.1-beta realm favourited a model on the current leaf: its
    `update_global_config` returned 200, and the leaf's
    `workspace-grant.config-echo` counter went from 0 to 1.
  - Details and the command list are in the 5740 todo.

## The development memory diagnostic

`apps/desktop/electron/process-memory-diagnostic.ts` (`112938cd5`) is on only
when both of these hold:

- the desktop runs in development mode (`ELECTRON_DEV=1` on an unpacked app);
- `ORKESTRATOR_DEV_PROCESS_MEMORY_MS` names an interval (clamped to
  1 s–10 min).

Each interval it logs one `[desktop] process-memory` line with the working
set per process type. It then logs one `[desktop] process-memory.realm` line
per workspace realm, labelled by the SHA-256 prefix of the node id that its
storage partition already uses.

A packaged app never samples. The lines hold numbers only.

## 5005: one relayed request for N leaves' event streams

Measured 2026-11-07 for plan item
[5005](../../plans/unified/5005-multiplexed-relay-stream.md), after it was
built (the "Recommendation on 5005" above).

### What ran

- **Code:** branch `unified-federation-b4c9ee65814d` at `0fb112063`, in a
  separate detached worktree with a frozen install.
- **Host:** the same Mac, loopback only.
- **Nodes:** two `dev:test` profiles, `uf-5005-cmd` (command node) and
  `uf-5005-leaf` (attached with `add_node`), both `--fixture
  --no-agent-credentials --headless --agent-platforms claude` with
  `ORKESTRATOR_HOST_REACHABILITY_CHECK=off` and the agent session's
  `ORKESTRATOR_*`/`CLAUDE*` variables removed; two more leaves (Leaf2,
  Leaf3) run from the worktree's source with throwaway data directories,
  attached to `uf-5005-cmd`. Each leaf had one local environment.
- **Browser:** Playwright Chromium (build 1248), headless, one fresh
  context per run. Every leaf origin was blocked with CDP
  `Network.setBlockedURLs`, so every leaf took the relay. All three leaves
  were shown in the window's own tree (4001's `in-tree-nodes` setting,
  written to the page's storage before load). Leaves were opened one after
  another; each stays warm (the browser suspends a hidden scope after
  5 min), so with N opened, N relayed leaves were warm at once.
- **Before and after on the same build.** "Before": the page's request to
  `/__orkestrator/nodes/events` was answered 404 (CDP `Fetch`, only that
  path), which is exactly what an older command node answers, so every
  relayed leaf read its own stream as before 5005. "After": the route as
  built.
- **Counting:** after the last leaf opened, 10 s to settle, then a 30 s
  window. A long-lived request had a response before the window and was
  still open at its end; a stalled request had no response after 30 s.
  Counted from Playwright's context events (which include the window's own
  streams), cross-checked with the page target's CDP Network domain (same
  totals in every run). Scripts and JSON are in the ignored
  `output/agent-testing/uf-5005/`. No tokens, prompts, transcripts or file
  contents were recorded.

### Results (command node's origin, HTTP/1.1)

| Relayed in-tree leaves warm | Long-lived, before | Long-lived, after | Stalled > 30 s, before | Stalled > 30 s, after | Most requests in flight, before / after |
|---|---|---|---|---|---|
| 1 | 5 (`/events` ×2, `/session`, `/client-metrics`, 1 relayed leaf `/events`) | 5 (the same: one leaf keeps its own stream) | 0 | 0 | 5 / 5 |
| 2 | 6 (2 relayed leaf `/events`): the pool is full | 5 (1 `/nodes/events` for both) | 0 | 0 | 6 / 6 |
| 3 | 8 (4 relayed leaf `/events`, see below) | 5 (1 `/nodes/events` for all three) | **12** (`invoke` 3 of the window's own, relayed leaf `invoke` 9) | **0** | 23 / 5 |

- `nextHopProtocol` and CDP's response protocol were `http/1.1` on the
  command origin in every run; no response came from a leaf origin.
- **Relief:** with the shared request the command origin holds five
  long-lived requests whatever the number of relayed leaves (up to 8 per
  request), so one of HTTP/1.1's six connections stays free for commands.
  Before it, a third warm relayed leaf left 12 commands, the window's own
  among them, waiting more than 30 s.
- **Every leaf's events arrived on the one request.** After each window, one
  `backend-profile-changed` was raised on each leaf (its profile saved
  unchanged, through `invoke_on_node`), and the shared request's body
  (CDP `Network.streamResourceContent`) carried it for every leaf: with
  three leaves, Leaf, Leaf2 and Leaf3 each had their `gateway.connected`
  and their `backend-profile-changed` as node frames, beside 2
  `mux.connected` and 5 `mux.node` control frames.
- **Joins cost one reopen.** With three leaves the page made two shared
  requests: one when the second leaf joined (both nodes), one when the third
  did (all three, each resuming from its own cursor, so the first two
  leaves' second `gateway.connected` was a caught-up handshake). The first
  leaf moved off its own stream onto the shared one when the second joined.
- **All leaves opened in 159–219 ms** in both modes; the stall shows in the
  commands that followed, not in the open.
- **The "before, 3" row counts four relayed leaf streams for three leaves.**
  One relayed `/events` that had answered was never reported finished by
  either Playwright or CDP while the pool was exhausted; Chromium also keeps
  separate HTTP/1.1 pools for credentialed and uncredentialed requests, so
  eight responded requests can be open at once. The stall count is the
  number that matters there.
- Not measured: a real LAN or tailnet, WebKit, and the desktop (its node
  traffic goes over IPC, so 5005 does not apply to it).

## 4006: six in-tree leaves in one window, switching and budgets

Measured 2026-11-07 for plan item
[4006](../../plans/unified/4006-multi-node-qualification.md) with its e2e,
`e2e/agent-testing/multi-node-window.spec.ts`.

### What ran

- **Code:** branch `unified-federation-b4c9ee65814d` at `72ae46d49` (in-tree
  by default since 6001), in a separate detached worktree with a frozen
  install; development renderers (Vite).
- **Host:** the same Mac, loopback only, direct routes (the browser's leaf
  traffic went to the leaves' own origins).
- **Nodes:** `uf-4006-cmd` (command node, renderer with
  `VITE_ORKESTRATOR_SHIM_GUARD=throw`) and `uf-4006-leaf`, both `dev:test
  --fixture --no-agent-credentials --headless --agent-platforms codex`, plus
  five standalone leaves from source: six leaves, seven nodes, one started
  local environment with a terminal tab on each.
- **Clients:** headless Chromium on the command profile's page (1440×900),
  and an Electron launched by the spec and connected to the command profile
  as a remote command node (windows hidden).
- **Measures:** click on the sidebar row to the environment's terminal
  visible; tiers from `ScopeLifecycle.tiers`; the page's JS heap after a full
  collection (CDP `HeapProfiler.collectGarbage`, `Runtime.getHeapUsage`).

### Results

| Measure | Browser (Chromium) | Desktop (Electron) |
|---|---|---|
| First open of a leaf (6 leaves, one after another) | 244–285 ms | 217–272 ms |
| First open of the command node's environment | 695 ms | 579 ms |
| Warm switch between leaves (rounds 2 and 3, 12 switches) | 175–268 ms | 174–244 ms |
| First open of a leaf as a realm (realm path, 3 leaves) | 1.84–1.93 s | not run |
| Reload: snapshot painted (since navigation) | 1.9 s | 0.7 s |
| Reload: live workspace (grant held 3 s on purpose) | 5.3 s | 4.2 s |
| JS heap after GC, six leaves warm (one shown) | 105.2 MB | 102.8 MB |
| JS heap after GC, one shown, five back to summary | 98.1 MB | 97.0 MB |
| Per warm scope (difference / 5) | 1.4 MB | 1.2 MB |
| Reopen of a leaf from summary | 253 ms | 212 ms |
| Grant lapse to new grant, no reload | 0.56 s | grant reopened; terminal input did not recover (4006 Finding 2) |

- **Budgets.** With six leaves warm the lifecycle's estimate was 168 MiB
  (4002's 24 MiB per warm scope) against a measured heap of 164–179 MiB
  (`performance.memory`, before GC), well inside the 512 MiB (browser) and
  1 GiB (desktop) placeholders. A budget of the estimate minus 2.5 scopes
  suspended the three least recently shown leaves (`suspended ×3, warm ×2,
  live`); a budget of one scope took every hidden leaf back to summary,
  leaving only the shown one. Both hosts behaved the same.
- **The estimate is high for warm scopes.** A warm in-tree scope cost about
  1.2–1.4 MB of collected JS heap here (an environment with one terminal,
  no transcript), against 24 MiB estimated. A realm cost 22–33 MB of JS heap
  in Chromium and 340–410 MB of process memory on the desktop (above). The
  estimate only matters where heap cannot be measured (iOS); it should be
  re-based once an iPad is measured with transcripts open.
- **Hidden leaves stay mounted.** All six leaves stayed mounted (warm) while
  one was shown, and the shim guard saw no command-scope store use in any of
  33 checks on each host.
- **iPad: not done**, no iPad reachable from this host: six warm nodes
  against the budget and a jetsam-free run of N switches remain unmeasured.
- Not measured: transcripts (no provider turn), a packaged desktop build, a
  real LAN or tailnet, WebKit.

### Re-run after the realm code was deleted

Measured 2026-11-07 at `9d061d7aa` (6002 and 6003 landed: in-tree is the
only path), same host, flags and topology as above (profiles `uf-final-cmd`,
`uf-final-leaf`, six leaves), from a detached worktree with a frozen install.
Browser 7 passed, 1 skipped (desktop-only flow); desktop 8 passed. The
4006 fixes hold: the desktop leaf preview renders and the lapsed grant's
terminal takes input again.

| Measure | Browser (Chromium) | Desktop (Electron) |
|---|---|---|
| First open of a leaf (6 leaves, one after another) | 240–345 ms | 205–307 ms |
| First open of the command node's environment | 788 ms | 594 ms |
| Warm switch between leaves (rounds 2 and 3, 12 switches) | 178–289 ms | 185–297 ms |
| Reload: snapshot painted (since navigation) | 2.4 s | 0.7 s |
| Reload: live workspace (grant held 3 s on purpose) | 5.9 s | 4.2 s |
| JS heap after GC, six leaves warm (one shown) | 105.5 MB | 103.6 MB |
| JS heap after GC, one shown, five back to summary | 97.5 MB | 96.4 MB |
| Per warm scope (difference / 5) | 1.6 MB | 1.4 MB |
| Reopen of a leaf from summary | 304 ms | 234 ms |
| Grant lapse to new grant, no reload | 0.67 s | 0.68 s (terminal takes input after) |

- Budgets behaved as before on both hosts: estimate minus 2.5 scopes left
  `suspended ×3, warm ×2, live`; one scope left only the shown leaf.
- The shim guard saw no command-scope store use in 33 (browser) and 34
  (desktop) checks.
- **Invoke paths during the browser smoke run** (plan item
  [2010](../../plans/unified/2010-command-scope-wiring.md), same commit,
  profile `uf-final-smoke`; 53 passed, 1 failed, the base-failing vim case):
  across 87 browser contexts, 14,535 invokes (185 commands) and 12,540
  listens (39 events) were all called from the command scope's client; none
  from another module or a spec; all 14,160 invoke requests that left a page
  had passed through it.
