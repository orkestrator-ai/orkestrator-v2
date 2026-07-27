# Frontend State Audit — What Should Move to the Backend

> **Status.** Items 1–4 of §5 have landed (see §7 for exactly what, and what is
> still outstanding within item 4). Items 5–8 are not started. The findings in
> §3 are left as originally written so the "before" state stays legible; §7 is
> the authoritative record of current state.


**Goal:** minimise renderer-owned state so that multiple frontend clients (Electron
window, browser via the gateway, a second machine over Tailscale) attached to the
same backend converge on a consistent view.

**Scope:** all 30 Zustand stores in `apps/web/src/stores/`, `TerminalContext`, and the
hooks that own long-running loops in `apps/web/src/hooks/`.

---

## 1. Current architecture

The backend already owns a lot. `StorageService` (`apps/backend/src/core/storage.ts`)
persists projects, environments, config, sessions + PTY buffers, pane layouts, looped
review workflows, kanban tasks and images, project notes, feature plans, Linear auth,
and completion-comment markers. Two of the frontend's biggest state machines — pane
layout and looped review — already have a revisioned, backend-authoritative mirror
(`apps/web/src/lib/pane-layout-persistence.ts`, `apps/web/src/lib/looped-review-persistence.ts`).

Multi-client is a real deployment mode, not hypothetical: `apps/backend/src/gateway.ts`
serves the web client to arbitrary browsers behind a bearer token, and
`apps/backend/src/tailscale-serve.ts` exposes it off-machine.

### The gap

Two things are missing, and every finding below is a symptom of one of them.

**(a) There is no general change-notification channel.** The gateway has an SSE
broadcast (`GatewayServer.emit`, `apps/backend/src/gateway.ts:866`) but only 9 event
names are ever emitted across the whole backend:

```
environment-renamed              environment-activity-recorded
environment-setup-started        environment-setup-complete
claude-model-catalog-updated     claude-tmux-*
terminal-output-<id>             claude-state-<containerId>
```

Nothing is emitted for environment create/delete/status, kanban mutations, pane layout
writes, looped review transitions, session changes, or config changes. Clients converge
only where someone bolted on a poller — `useEnvironmentListPolling` refreshes every
project's environment list every 5s (`apps/web/src/hooks/useEnvironmentListPolling.ts:2`),
`useEnvironmentDiffStats` polls git diff every 15s, `usePrMonitorService` polls PR state
per environment. Everything else silently diverges until the user reloads.

**(b) Long-running orchestration runs in the renderer.** `getBackgroundProcessingEnvironments`
(`apps/web/src/lib/background-pipelines.ts`) exists specifically to keep *unselected*
environments mounted in React so their pipelines, setup scripts, prompt queues and SSE
subscriptions keep running. That is a workaround for work that belongs in a process
that has no concept of "mounted". It also means the work is duplicated, not shared,
when a second client connects — and stops entirely when the last client closes.

---

## 2. Rubric

State legitimately belongs in the frontend only if it is one of:

- **Ephemeral view state** — hover, focus, scroll position, dialog open/closed.
- **Non-serialisable browser objects** — DOM nodes, `xterm.js` instances, `AbortController`s.
- **Genuinely per-client** — window zoom, sidebar width, viewport-dependent layout.

Everything else — anything another client would need to see, or that must survive a
reload or a client disconnecting — belongs in the backend.

---

## 3. Findings, highest priority first

### P0 — Build pipeline orchestration
`apps/web/src/stores/buildPipelineStore.ts` (951 lines), `apps/web/src/hooks/useBuildPipeline.ts`,
`components/build-pipeline/{BuildChatTab,CodexBuildChatTab,OpenCodeBuildChatTab}.tsx` (~5,500 lines)

This is the single largest correctness problem. A `BuildPipeline` is a durable,
multi-hour state machine — `creating-environment → building → reviewing → addressing →
verifying → fixing → creating-pr → complete` — with iteration counters, per-phase agent
sessions, structured review reports, dispatch/retry leases (`pendingPromptAttempt`,
`reconnectAttempt`, `failureContext`) and GitHub/Linear completion-comment status.

All of it lives in a Zustand store persisted to **`localStorage["orkestrator-build-pipelines"]`**
(`buildPipelineStore.ts:204`, `:916`), and phase transitions are driven by React effects
inside the mounted `*BuildChatTab` components.

Consequences:

- Two clients on the same backend each restore a *different* pipeline set from their own
  `localStorage`, and each independently drives it. Two renderers can dispatch the same
  phase prompt to the same agent session. The `completionCommentStatus: "posting"` lease
  is explicitly acknowledged as unreliable in the merge function (`:921-931`) — it is
  cleared on rehydrate and the code falls back to "the backend's durable marker check",
  which is exactly the admission that the lease belongs in the backend.
- Closing the last window stops the pipeline mid-phase.
- A browser client that has never run this pipeline shows nothing at all, even though the
  agent sessions and the environment are visible to it.

**Recommendation.** Move the pipeline to the backend as a first-class supervised runtime,
the way the Codex bridge supervises `app-server`. Concretely:

1. Add `buildPipelines.json` to `StorageService` with the same revisioned
   compare-and-swap shape already used by `saveLoopedReviewWorkflow` (`storage.ts:1314`).
2. Add backend commands `create/get/list/advance/cancel_build_pipeline`, and move the
   phase-transition logic out of the `*BuildChatTab` effects into a backend pipeline
   runner that talks to the bridges directly.
3. Emit `build-pipeline-updated` over the gateway SSE; the store becomes a read-through
   cache hydrated from `list_build_pipelines` on mount.

This is a large change. If it must be staged, **stage 1 is persistence + CAS revisions
only** (mirroring exactly what `looped-review-persistence.ts` does today). That alone
removes the two-clients-diverge failure and the "close the window, lose the pipeline"
failure, without yet moving the driver loop. Stage 2 moves the driver.

Note the same pattern already exists correctly one layer over: looped review *is*
backend-persisted with CAS. Build pipeline is the one that was left behind.

---

### P1 — Agent prompt queues
`createNativeChatStore.ts:55` (`messageQueue`), `claudeTmuxStore.ts:497-559`,
drained in `ClaudeChatTab.tsx:1399,1511`, `ClaudeTmuxChatTab.tsx:988`

Queued prompts — text the user has explicitly committed to sending, plus their
attachments, effort level and plan-mode flags — sit in an in-memory `Map` and drain only
from a React effect in a mounted tab.

- A second client cannot see that three prompts are queued, and will happily send a
  fourth that interleaves.
- Reloading the page silently drops the queue. The user's typed intent is gone with no
  error.
- `background-pipelines.ts` has a dedicated `queuedAgentPromptEnvironmentIds` parameter
  purely to keep a tab mounted so its queue can drain — again, a workaround for state in
  the wrong place.

**Recommendation.** The bridges already own at-most-once dispatch
(`bridges/codex-bridge/src/sessions/dispatch-journal.ts`). Extend that surface with a
per-session prompt queue: `POST /session/:id/queue`, `GET /session/:id/queue`,
`DELETE /session/:id/queue/:messageId`, with the bridge draining the queue when the turn
goes idle. The renderer then renders a queue it does not own. This also makes
"queue a prompt, close the laptop, it runs" work, which is currently impossible.

---

### P2 — Compose drafts
`createNativeChatStore.ts:53-54` (`draftText`, `draftMentions`),
`terminalSessionStore.ts:67-70` (`composeDraftText`, `composeDraftImages`),
`featurePlanStore.ts` (`chatDrafts`)

Half-typed prompts, file mentions and pasted images. Not persisted anywhere; lost on
reload; invisible to other clients. Pane layout persistence deliberately strips
`initialPrompt` (`pane-layout-persistence.ts:33-38`), so there is no back door either.

**Recommendation.** Persist per `(environmentId, tabId)` under the existing pane-layout
or session records, debounced ~500ms, same write-chain pattern as
`startPaneLayoutPersistence`. Images should go to the backend as blobs (kanban images
already have this shape: `storage.addKanbanImage`) rather than base64 in a JSON blob.

Lower severity than P0/P1 because losing a draft is annoying rather than incorrect — but
it is cheap to fix and it is the state users notice losing most often.

---

### P2 — Editor dirty buffers
`apps/web/src/stores/fileDirtyStore.ts`

Unsaved file-editor content is held as `{content, originalContent}` in a renderer `Map`,
keyed by tab ID, with no persistence at all. Closing the window discards unsaved edits
with no prompt, and a second client editing the same file has no idea.

**Recommendation.** Either (a) persist dirty buffers backend-side per
`(environmentId, path)` so they survive reload and are visible to other clients, or
(b) if that is judged too invasive, at minimum surface a backend-held
"file X has unsaved changes in another client" marker so a second client does not
overwrite. Option (a) is the one consistent with the stated goal.

---

### P2 — Selection and unread state
`apps/web/src/stores/uiStore.ts:221-228`

`uiStore` persists to `localStorage["ui-storage"]`. Most of it is correctly per-client
(`sidebarWidth`, `zoomLevel`, `collapsedProjects`). Two fields are not:

- **`unreadEnvironmentIds`** — "an agent finished work here and nobody has looked yet".
  That is a fact about the *environment*, not about this browser tab. Today, finishing
  work in client A marks it unread only in A; opening it in B does not clear A's badge.
  It should be a field on the `Environment` record, cleared by a backend command.
- **`recentProjectIds`** — user-level, arguably should follow the user across clients.
  Lower priority; reasonable to leave local.

`selectedProjectId` / `selectedEnvironmentId` / `selectedEnvironmentIds` are correctly
per-client (each window navigates independently) and should stay.

---

### P3 — Environment runtime readiness
`apps/web/src/stores/environmentStore.ts:44-59`

Six renderer-only `Set`/`Map` fields: `workspaceReadyEnvironments`, `deletingEnvironments`,
`pendingSetupCommands`, `setupCommandsResolved`, `setupScriptsRunning`, `sessionActivated`.

These are facts about a *process*, not about a view. The awkwardness is visible in the
code: `hydrateReadinessFromPersisted` (`:13-37`) reverse-engineers the runtime sets from
the persisted `setupScriptsComplete` flag on restart, and `updateEnvironment` (`:204-244`)
carries a 10-line comment explaining how to avoid clobbering in-memory readiness with a
backend response that carries the same field as a passenger. Meanwhile
`useBuildPipeline.waitForSetupInitiation` (`useBuildPipeline.ts:32-56`) polls these sets
in a 50ms loop to synchronise with `TerminalContainer` — a cross-component handshake
through global mutable state.

Two clients will disagree about whether setup is running; `deletingEnvironments` means
client B can issue a second delete for an environment client A is already deleting.

**Recommendation.** The backend already emits `environment-setup-started` /
`environment-setup-complete` and already owns setup execution in newer Electron starts
(`StartEnvironmentResult.setupManagedByBackend`). Finish that migration: put
`setupPhase: "pending" | "running" | "complete"` and `deleting: boolean` on the
`Environment` record, drive them from the backend, and delete the renderer sets and the
`waitForSetupInitiation` polling loop with them.

---

### P3 — Agent activity state
`apps/web/src/stores/agentActivityStore.ts`, `apps/web/src/hooks/useGlobalActivityMonitor.ts` (849 lines)

Per-container `idle | working | waiting`, derived in the renderer by merging four
sources (Claude native, Claude tmux, OpenCode, Codex) plus terminal output parsing, with
a manual ref-count (`containerRefCounts`) to track how many tabs are watching. The
comment on `decrementContainerRef` — "preserve activity state so the sidebar icon keeps
showing the correct color even when the user navigates to a different project" — is a
tell that this is trying to be global state in a mount-scoped container.

The backend already emits `claude-state-<containerId>` (`tmux.ts:1896`), so half the
input is backend-owned; the aggregation is not.

**Recommendation.** Aggregate in the backend into a single `environmentActivity` field
and broadcast it. The 849-line monitor hook plus the ref-counting store collapse into a
subscription. Lower priority than the above because a wrong sidebar colour is cosmetic —
but it is a large chunk of renderer complexity that exists only because the aggregation
is in the wrong place.

---

### P3 — PR monitor scheduling
`apps/web/src/stores/prMonitorStore.ts`, `apps/web/src/hooks/usePrMonitorService.ts`

Poll cadence, backoff, `checkInProgress` and `lastCheckTime` are per-client. Two clients
each poll GitHub independently at 20s (1s during a merge), doubling API consumption
against a rate limit, with no shared "a check is already running" lease.

**Recommendation.** Move the poller into the backend, keyed by environment, and broadcast
`pr-state-changed`. `checkInProgress` becomes a real lease rather than a per-client hint.
The mode escalation (`create-pending`, `merge-pending`) becomes a backend command issued
by whichever client pressed the button — which is also the correct semantics, since the
merge that client A triggered should speed up client B's view too.

Same argument applies to `useEnvironmentDiffStats` (15s git-diff poll per client,
`environmentDiffStore`): computing diff stats once in the backend and broadcasting is
strictly better than N clients each shelling out to git.

---

### P3 — Terminal session buffers
`apps/web/src/stores/terminalSessionStore.ts`

`serializedBuffer` and `hasLaunchedCommand` are held per tab in the renderer.
`StorageService.saveSessionBuffer` exists and is wired through `sessionStore`, but
`PersistentTerminal.tsx` writes the serialized buffer into the renderer store
(`:559`, `:1029`) as the primary path. A second client attaching to the same PTY gets no
scrollback. `hasLaunchedCommand` in particular is a fact about the PTY — client B will
re-launch a command client A already launched.

**Recommendation.** Make the backend buffer authoritative on attach (it is already the
storage layer), and move `hasLaunchedCommand` onto the backend `Session` record.

---

### Correctly frontend — leave alone

| Store | Why it stays |
| --- | --- |
| `terminalPortalStore` | Live `xterm.js` `Terminal`, addons, DOM nodes. Not serialisable. |
| `TerminalContext` | React-tree plumbing. |
| `messagePartExpansionStore` | Per-view expand/collapse. |
| `errorDialogStore` | Transient dialog. |
| `uiStore` — `sidebarWidth`, `zoomLevel`, `collapsedProjects`, selection | Genuinely per-window. |
| `filesPanelStore` — `panelWidth`, `expandedFolders`, `isOpen` | Per-window layout. |
| `claudeStore.eventSubscriptions` | Holds `AbortController`s. Per-connection by nature. |
| `projectStore` / `kanbanStore` / `githubIssuesStore` / `featurePlanStore` / `sessionStore` | Already thin read-through caches over backend commands. They need *broadcast* (§4), not relocation. |

`paneLayoutStore` and `loopedReviewStore` are also already correct in structure — they
have backend-authoritative persistence with CAS revisions. They only lack live
invalidation, which §4 covers.

---

## 4. The cross-cutting fix: a real event bus

Several findings above become much cheaper if the gateway gets a general change-feed
first. Today `GatewayServer.emit` broadcasts to all SSE clients but almost nothing calls
it, so read-through caches never learn they are stale.

**Recommendation.** Emit a `resource-changed` event from every `StorageService` mutation:

```ts
{ resource: "environment" | "project" | "kanban" | "pane-layout"
          | "looped-review" | "session" | "config" | "build-pipeline",
  id: string,
  revision: number }
```

Clients subscribe and refetch the named resource. This:

- deletes `useEnvironmentListPolling`'s 5s full-refresh of every project;
- makes `kanbanStore` / `githubIssuesStore` / `featurePlanStore` / `projectStore` /
  `sessionStore` converge across clients with no structural change to those stores;
- gives pane layout and looped review the live invalidation they currently lack (both
  hydrate on mount, then never learn about another client's writes);
- is the delivery mechanism P0/P1 need anyway.

Do this before, or alongside, the P0 build-pipeline migration — the pipeline work needs
it, and it independently fixes convergence for six stores.

---

## 5. Suggested ordering

| # | Work | Unblocks |
| --- | --- | --- |
| 1 | Gateway `resource-changed` event bus (§4) | Convergence for 6 existing stores; prerequisite for the rest |
| 2 | Build pipeline → backend, stage 1: `buildPipelines.json` + CAS revisions | Removes the two-clients-diverge and window-close-loses-pipeline failures |
| 3 | Prompt queues → bridge session API | Queued prompts survive reload; queue visible to all clients |
| 4 | `unreadEnvironmentIds` → `Environment` record; setup/deleting flags → backend | Deletes `hydrateReadinessFromPersisted` and `waitForSetupInitiation` |
| 5 | Drafts + dirty buffers → backend, debounced | Stops silent data loss |
| 6 | PR monitor + diff stats pollers → backend | Halves external API load per extra client |
| 7 | Build pipeline stage 2: driver loop → backend runner | Pipelines run headless; `getBackgroundProcessingEnvironments` can shrink |
| 8 | Activity aggregation → backend | Retires most of the 849-line `useGlobalActivityMonitor` |

Steps 1–4 remove the correctness bugs. 5–8 are simplification and efficiency, and are
individually independent.

---

## 6. Implementation status

### Landed

**1. Gateway change feed.** `packages/protocol/src/resource-events.ts` defines
`resource-changed` and its payload. `StorageService` gained
`setResourceChangeListener` and announces every committed mutation — projects,
environments, sessions, config, kanban, notes, feature plans, pane layouts,
looped reviews, build pipelines, prompt queues — with a strictly increasing
revision. `OrkestratorBackend` wires it to `gateway.emit`; the Electron main
process already forwards backend events to renderers generically, so both
transports work with no extra plumbing.

On the client, `lib/resource-sync.ts` is the transport (validate, coalesce over
50ms, dispatch) and `lib/store-resource-sync.ts` binds the read-through stores.
`useEnvironmentListPolling`'s 5s full refresh is gone, replaced by
`useEnvironmentListSync`: event-driven, with a 60s resync purely as a
catch-up for a client that was disconnected.

*Announcements are deliberately not origin-filtered.* A client hears its own
writes back and refetches. That cannot loop, because every subscriber only
reads, and the two write-back stores compare against what they last persisted
before enqueuing. Pane layout is deliberately **excluded** from the subscriber
set — which panes a window has open is per-window state that merely happens to
be persisted, and mirroring it live between windows would fight the user.

**2. Build pipelines are backend-persisted.** `build-pipelines.json` with
compare-and-swap revisions, a cross-process mutation lock, and 32 MB snapshot
ceiling (task snapshots embed base64 attachments). `localStorage` is gone;
`BuildPipeline` carries `backendRevision`. `lib/build-pipeline-persistence.ts`
mirrors the store, adopts the backend winner on conflict rather than retrying,
and restores per project on load — per *project*, not per environment, because a
pipeline in `creating-environment` has no environment yet and that is precisely
the state a crash used to strand. `CodexBuildChatTab` flushes the dispatch lease
synchronously before a prompt leaves the process. Deleting an environment now
deletes its pipelines backend-side.

This is stage 1 only. The driver loop still runs in the mounted `*BuildChatTab`
components — see item 7, still outstanding.

**3. Prompt queues are backend-owned.** `prompt-queues.json`, whole-list writes
under CAS. Whole-list rather than per-item because the contended operation is
"take the head and send it", and a revision check is the cheapest guarantee that
exactly one client wins.

Implemented in the **backend** rather than in the bridges as originally
proposed: OpenCode has no bridge (the SDK is driven directly), so the bridges
could not have covered all four agent paths. `lib/prompt-queue-persistence.ts`
mirrors any number of agent stores through a `PromptQueueSource` adapter;
`lib/prompt-queue-sources.ts` adapts Claude native, Claude tmux, Codex and
OpenCode. Queue keys are namespaced per agent so two agents sharing a tab id
cannot collide.

Queues now survive reload, are visible to every client, and cannot be
double-dispatched. **The drain is still client-side** — a queue only advances
while some client has the tab mounted. Headless draining depends on item 7.

**4a. Unread is on the Environment record.** `unreadEnvironmentIds` is gone from
`uiStore` (and from its `localStorage` partialize). `Environment.hasUnreadWork`
is backend-owned: set when an agent completes in an environment this client does
not have open, cleared by `useUnreadEnvironmentSync` when any client opens it.
Whichever client opens the environment clears the badge everywhere, which is the
correct semantics — the work has been seen.

### Outstanding

| # | Work | Note |
| --- | --- | --- |
| 4b | Environment setup/deleting runtime flags | `environmentStore`'s six runtime Sets and `waitForSetupInitiation`'s 50ms polling handshake are untouched. |
| 5 | Compose drafts + editor dirty buffers | Not started. |
| 6 | PR monitor + diff stats pollers | Not started. |
| 7 | Build pipeline driver loop → backend runner | Not started. The largest remaining item, and what items 2 and 3 are waiting on to become fully headless. |
| 8 | Activity aggregation → backend | Not started. |

### Verification

All four workspace typechecks pass. Suites: backend 187, bridges 1117, protocol
40, web 2330, root ~2594 — all passing. The root suite has pre-existing
flakiness under `--parallel` (0–4 failures per run, different test names each
time: `FeaturesView` timing, `download-*.sh` process spawning). This was
measured on a clean tree before any of these changes and behaves identically
after them.

## 7. One caveat

`AGENTS.md` already states the correct rule ("Keep the authoritative long-running state
in the backend, bridge, persistent store, or external process — not only in mounted React
component state"). Pane layout and looped review follow it; build pipeline, prompt queues
and setup readiness predate it. Nothing in this report proposes a new architecture — it
proposes finishing the one that is already written down.
