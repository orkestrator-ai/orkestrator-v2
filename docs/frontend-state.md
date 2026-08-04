# Frontend State Audit

Audit of renderer-held state and logic that, per `AGENTS.md`, should be
authoritative in the backend, bridge, persistent store, or external process.
Date: 2026-08-04. Branch: `frontend-state-audit`.

The governing rule: environments keep working while inactive. The mounted React
tree may miss IPC/SSE/tmux events, unmount does not mean "cancel the background
task", and the UI must be able to rehydrate from authoritative snapshots.

## Overall verdict

Most authoritative state has already been migrated. `buildPipelineStore`,
`loopedReviewStore`, `prMonitorStore`, `environmentDiffStore`, pane-layout
hydration, and `lib/resource-sync.ts` are correct backend-owned,
revision-guarded projections. The remaining violations cluster in:

1. Feature/story planning (a full workflow in the renderer)
2. Prompt-queue draining (dispatcher only runs while a tab is mounted)
3. tmux TUI screen-scraping (capture + parse in the renderer)
4. Agent-activity derivation (clock arbitration + transition callbacks client-side)
5. Legacy setup-command execution
6. Client-orchestrated multi-resource teardown
7. Retry budgets held in component refs

## High impact

### 1. Feature/story planning pipeline runs entirely in the renderer

**Files:** `apps/web/src/components/kanban/FeaturesView.tsx` (`ensureCodexSession`
~`:782`, `waitForCodexReply` ~`:187`, `clientsRef` ~`:559`, unmount abort
~`:1699-1706`), `apps/web/src/stores/featurePlanStore.ts` (`:22-32`, `:239-350`)

The whole workflow — create environment → start Codex server → create session →
send prompt → poll `getSessionStatus`/`getSessionMessages` every 1.5s for up to
10 minutes → parse structured JSON from the assistant reply → persist the plan —
lives in a component that only renders when **no** environment is selected
(`App.tsx:713`). Clicking into any environment unmounts it, aborting the
reconciliation monitors and abandoning the in-flight reply wait.

`featurePlanStore` is a guarded client-side state machine
(`dispatching → running → persisting → settled`, plus `unavailable`). The
`persisting` phase holds the agent's **completed response only in renderer
memory** as a claim over a write that has not reached `appendMessage`
(`featurePlanStore.ts:325-350`). A reload in that window destroys the answer;
the dedupe latch also resets, so a reload can re-dispatch a conversation the
bridge is still running. Recovery (`runRestoredConversationMonitor`) is one pass
per project per mount, and several paths park at `phase: "unavailable"`
requiring a manual "Check again".

It also polls `/session/:id/status` from what is effectively a background
reconciler — a route `AGENTS.md` explicitly reserves for tab-facing liveness
touches.

**Suggested home:** a backend feature-planning workflow service in
`apps/backend/src/core/`, shaped like the build-pipeline / looped-review
services (backend-owned record with `backendRevision`, session creation,
dispatch journal, completion detection, persist step). The view becomes
snapshot + incremental events; `LoopedReviewTab.tsx` is the shape to copy.

### 2. Prompt-queue drain is renderer-driven

**Files:** `apps/web/src/hooks/useNativeMessageQueue.ts:115-260`,
`apps/web/src/components/claude/ClaudeTmuxChatTab.tsx:1258-1382`,
`apps/web/src/App.tsx:244-269`

Queue storage and claim leases are correctly backend-owned
(`lib/prompt-queue-persistence.ts`, `claimAgentPromptQueueHead`), but the
**dispatcher** — claim head → dispatch to agent → acknowledge/reject, with an
exponential backoff ladder to 30s — is a `useEffect` guarded by `mountedRef`.
Nothing sends the next queued prompt unless a React tree is mounted, connected,
and re-rendering.

`App.tsx:244-269` exists purely to compensate: it scans four renderer queue
maps and force-mounts hidden `TerminalContainer`s for any environment with a
non-empty queue. A reload, crash, or quit still leaves queued prompts
undispatched until a renderer remounts. A reload between "agent accepted the
dispatch" and "claim acknowledged" abandons an outstanding claim until the
lease expires.

**Suggested home:** a backend queue supervisor alongside the claim-lease code in
`apps/backend/src/core/` that dispatches to the bridge when a session reports
idle. The renderer keeps only the optimistic/draft interlock and "show me the
queue and the dispatch error". This also lets `App.tsx` drop the queue-derived
half of `backgroundProcessingEnvironments`.

### 3. tmux TUI screen-scraping and prompt detection

**Files:** `apps/web/src/lib/claude-tmux-polling.ts`,
`apps/web/src/lib/claude-tmux-usage.ts:145-273`,
`apps/web/src/components/claude/ClaudeTmuxChatTab.tsx:1036-1062`

The renderer runs `capturePane` on a 500ms–3s `setInterval`, strips ANSI, and
regex-parses Claude Code's terminal UI (box-drawing prefixes, usage regexes) to
synthesize authoritative state: `agentState: "active"`, token counts, and
in-TUI selection prompts. The result lives in `useState<string> tuiSnapshot`.

The code comment claims prompts are "still detected while the pane is hidden" —
true for *hidden*, false for *unmounted*. A TUI-level selection prompt that
appears while the tab is not busy has nothing keeping the environment mounted,
so it is never detected and never surfaces. On remount the snapshot restarts
from `""`.

**Suggested home:** `apps/backend/src/core/tmux.ts` — run the capture loop and
parser there, emit normalized `TmuxAgentUsage` / pending-prompt events, and
expose a snapshot route the tab reads on mount (mirroring
`/session/:id/approvals` on the codex bridge).

### 4. Agent-activity derivation, clock arbitration, and polling lifecycle

**Files:** `apps/web/src/stores/agentActivityStore.ts` (`:87-185`, `:254-273`),
`apps/web/src/hooks/useGlobalActivityMonitor.ts:892-1050`

Three problems:

- `nextObservationTime` and `setContainerState` implement last-writer-wins
  clock reconciliation between backend-supplied and **locally-minted**
  timestamps, dropping out-of-order observations — status arbitration done
  client-side.
- `registerStateCallback` + a `queueMicrotask` fan-out form a renderer-hosted
  event bus driving persistence and notification side effects on agent state
  transitions. Transitions occurring while the renderer is gone produce no
  callbacks; the edge is unobservable after the fact.
- Whether the backend polls a running container at all
  (`startClaudeStatePolling`) is decided by a mounted renderer hook with an
  8-attempt client-side backoff that gives up after ~16s, leaving sidebar
  activity permanently stale.

**Suggested home:** backend owns per-environment activity state, source merge,
and transition events (it already runs an activity sweep and exposes
`/session/:id/activity`); it should poll running environments unconditionally.
The renderer's leased-observation pattern for "is a human watching" can stay.

### 5. Legacy setup-command execution path

**Files:** `apps/web/src/stores/environmentStore.ts:359-369`,
`apps/web/src/hooks/useEnvironments.ts:346-436`, `:871-925`,
`apps/web/src/lib/setup-commands.ts`

On the non-`setupManagedByBackend` path, `startEnvironment` returns
`setupCommands` which the renderer parks in `pendingSetupCommands` so a
terminal component can later type them in. `consumePendingSetupCommands` is a
**destructive read** — a reload between store and consume loses the setup plan
and the environment sits with `setupScriptsComplete: false` and no pending
commands, i.e. stuck not-ready. `sessionActivated` is an "at least once this
app session" latch that a reload resets, re-triggering the one-shot it exists
to prevent.

Separately, setup readiness is derived from three renderer booleans
(`setupScriptsRunning`, `setupCommandsResolved`, `workspaceReady`) synthesized
from events plus two snapshot reads, with hand-written out-of-order guards, and
`forceResolveSetupRuntime` is a renderer-only override a reload silently
reverts.

**Suggested home:** the `setupManagedByBackend` branch
(`useEnvironments.ts:898-925`) is the correct model — retire the legacy branch
and expose one authoritative `setupPhase: pending | running | ready | failed`
plus a persisted user override.

### 6. Client-orchestrated multi-resource teardown

**Files:** `apps/web/src/stores/kanbanStore.ts:125-168`,
`apps/web/src/stores/paneLayoutStore.ts:267-380`

- `clearTaskBuildStatus` collects pipeline ids, fires `deleteBuildPipeline` for
  each (each cancels an agent), then `updateKanbanTask` to unlink, then mutates
  two stores. A reload mid-sequence leaves pipelines cancelled while the task
  still carries `buildPipelineId`, or the inverse. The failure handler is a
  `toast.warning` telling the user to clean up manually.
- `cleanupTerminalTab` / `cleanupClaudeTmuxTab` / native cleanups close PTYs,
  stop tmux sessions, and delete bridge sessions — all `.catch(console.debug)`
  fire-and-forget with no retry or reconciliation. A reload immediately after a
  tab close leaks a live tmux session or PTY that nothing will ever reap.

**Suggested home:** single atomic backend commands (`clearTaskBuildStatus`,
`closeTab`-style teardown) with the backend reaping orphans.

## Medium impact

### 7. Retry budgets held in component refs

- `apps/web/src/components/codex/CodexChatTab.tsx:231-233`, `:1811-1842` and
  `apps/web/src/components/opencode/OpenCodeChatTab.tsx:306-308`, `:1660-1692` —
  `automaticInitRetryCountRef` and friends implement a bounded "environment
  still coming up" retry window in refs. Remount resets the counter (unbounded
  retries against a genuinely broken bridge); tab-switching mid-retry cancels a
  legitimate retry.
- `apps/web/src/lib/new-environment-connection-retry.ts:9-20`, `:113-165` — the
  delay ladder, attempt counter, and window start are renderer state (its own
  comment notes a backgrounded renderer can throttle timers past the window).
  Transient/permanent classification is a regex over backend error **strings**.
- `apps/web/src/components/terminal/TerminalContainer.tsx:637-649`, `:712-741` —
  setup-session bind retry timer is cleared unconditionally on unmount and the
  attempt counter resets on remount.
- `apps/web/src/components/codex/CodexChatTab.tsx:2925-2949` — initial-prompt
  retry timer is neither cleared on unmount nor re-driven on remount; a
  rejection followed by a tab switch loses the retry. Belongs with the bridge's
  dispatch journal.

**Suggested home:** backend reports a structured `retryable` flag and owns
"wait until the bridge is ready" as a command; attempt state sits beside the
durable `environment.createdAt` it derives from.

### 8. OpenCode SSE reconnect budget scoped to the wrong lifetime

**File:** `apps/web/src/components/opencode/OpenCodeChatTab.tsx:742`, `:2503-2529`

The shared per-environment subscription correctly lives in the store, but the
reconnect attempt counter and backoff timer are component refs: two tabs keep
two counters for one stream, remount resets the budget, and exhausting
`MAX_SSE_RECONNECT_ATTEMPTS` leaves the environment's stream dead with only a
`console.warn` — no desync signal, no forced resync. Move attempt/backoff/
give-up state into the `eventSubscriptions` entry in
`createNativeChatStore.ts`.

### 9. `terminalSessionStore.hasLaunchedCommand`

**File:** `apps/web/src/stores/terminalSessionStore.ts:41`, `:169`

A one-shot idempotency latch for auto-launching a command (e.g. `claude`) into
a PTY, held only in renderer memory. The PTY survives a reload by design; the
latch does not, so the renderer can re-fire the auto-launch into a PTY already
running the command. Belongs on the backend PTY session record, returned by the
attach/status call.

### 10. Codex background sync polls from the renderer

**File:** `apps/web/src/hooks/useCodexBackgroundSync.ts:17`, `:62-81`, `:384`

Every loading Codex session is polled for status/messages/approvals every 2s
from the browser, and the per-turn generation token is a renderer-generated
`loadingStartedAt` — a reload loses it, so a late response can no longer be
discarded. The bridge already has the primitives (`/session/:id/activity`,
event-ring cursors); the turn generation should be a bridge-issued id.

### 11. Pane-layout write debounce and client-side conflict rebase

**File:** `apps/web/src/lib/pane-layout-persistence.ts:282-296`, `:660-682`,
`:838-856`; `pane-layout-merge.ts`

Up to 1s of layout mutations plus in-flight conflict-retry state live only in
renderer memory; the `pagehide`/`visibilitychange` flush covers clean
navigation but not a crash or hard reload. The 517-line three-way merge
duplicates conflict resolution the backend must already reason about.
Least-invasive fix: send mutations as intents immediately; backend coalesces
and rebases; renderer stays optimistic-only.

### 12. Attachment writes with container-layout knowledge in the renderer

**File:** `apps/web/src/lib/initial-prompt-attachments.ts:53-97`

Per-attachment `writeContainerFile`/`writeLocalFile` loop encoding
`/workspace/${relativePath}` and `.orkestrator/initial-prompt/` layout, with
partial-failure semantics mid-loop. A reload mid-loop leaves orphaned files and
a prompt referencing paths never written. Should be one backend command taking
the attachment set and returning resolved paths.

### 13. Client-invented clocks and unrehydrated event lists

- `apps/web/src/stores/claudeTmuxStore.ts:530` — `busyStartedAt: Date.now()` is
  a local wall clock, so the "thinking for Ns" counter restarts on every tab
  switch/reload even though the turn never stopped. Native chat mode already
  does this correctly (`createNativeChatStore.ts:90`, backend-authoritative
  `startedAt`); tmux mode should match. `apps/web/src/lib/session-timer.ts`
  has the same `Date.now()` fallback.
- `claudeTmuxStore.ts:507-513` — `infoEvents` (Notification/Stop hook events)
  accumulate with no rehydration path; `replacePendingHooks` restores
  approvals/questions/plans but not these, so events emitted while unmounted
  are permanently lost.
- `apps/web/src/stores/codexStore.ts:119-120`, `:555-605` —
  `unconfirmedDispatches` (the "your prompt may not have run, safe to resend"
  marker) vanishes on reload along with the optimistic bubble, leaving the user
  no evidence the prompt may not have run. The bridge owns at-most-once
  dispatch; the user-facing resolution should survive a reload too.

### 14. Stalled-turn watchdog is mount-scoped

**File:** `apps/web/src/hooks/useStalledTurnWatchdog.ts:104-156`

A 1s tick recovering dropped SSE frames. Correctly not gated on `isActive`, but
it dies with the component and restarts its clocks on remount — a mitigation
for a bridge-side gap implemented on the wrong side. The bridge's revision-gap
machinery (`event-ring.ts` cursors) is the natural home.

### 15. Build-tab creation races renderer hydration

**File:** `apps/web/src/hooks/useBuildPipeline.ts:158-219`

After the backend creates a pipeline, the renderer must race pane-layout
hydration to attach the build tab, with a 5s timeout that silently proceeds. A
reload between "pipeline started" and "tab added" leaves a running pipeline
with no tab. The backend owns pane layout; it should create the `claude-build`
tab as part of `startBuildPipeline`.

## Minor

- `apps/web/src/stores/sessionStore.ts:185-201` — `updateSessionStatus` writes
  optimistically and swallows failure ("Revert on error would be complex");
  every other mutation in the store reverts correctly.
- `apps/web/src/stores/claudeOptionsStore.ts:33`, `:61-76` —
  `pendingNativeLaunches` parks a launch intent in renderer memory after the
  backend has already created the provider session; a reload orphans the
  session.
- `apps/web/src/components/browser/BrowserTab.tsx:115-116` — back/forward
  history in component state; only the current URL is persisted.
- `apps/web/src/components/kanban/ProjectNotesView.tsx:47-73` — 1s autosave
  with the draft in `useState`; unmount flush covers navigation, not
  reload/crash.
- `apps/web/src/components/terminal/InitializationLogs.tsx:25` — logs
  accumulate in `useState` from mount; no snapshot of what was emitted while
  unmounted.
- `apps/web/src/lib/opencode-live-compatibility-probe.ts` — misplaced, not
  misarchitected: a Bun/Node-only script in the renderer's `lib/`. Move to
  `scripts/` so a stray import cannot pull Node builtins into the bundle.

## Verified fine — do not regress

| Area | Why it is correct |
| --- | --- |
| `buildPipelineStore.ts` | `replacePipeline` is the only write path, rejects stale `backendRevision`, exposes no phase mutators |
| `loopedReviewStore.ts` | Same shape; contracts re-exported from `@orkestrator/protocol` |
| `prMonitorStore.ts` / `usePrMonitorService.ts` | Backend owns polling (`apps/backend/src/core/pr-monitor.ts`); subscribe-then-snapshot with buffered events; re-snapshot on reconnect |
| `environmentDiffStore.ts`, `projectStore.ts` | Snapshot + incremental with mutation-version guards |
| `createNativeChatStore.ts` | Pure projection; queue mutators deliberately removed; `startedAt` backend-authoritative |
| `lib/resource-sync.ts`, `lib/store-resource-sync.ts` | Manifest generations, revision-gap detection, layered resync ordering |
| `lib/build-pipeline-persistence.ts`, `lib/looped-review-persistence.ts`, `lib/prompt-queue-persistence.ts` | Revision-guarded read-through caches; deprecation stubs prevent the renderer regaining write authority |
| `promptDraftStore.ts`, `messagePartExpansionStore.ts`, `uiStore.ts`, `filesPanelStore.ts` | Renderer-only by design (drafts, UI prefs), bounded, correctly partialized |
| `terminalPortalStore.ts` | Live xterm instances are legitimately renderer-owned rendering surface; survives pane moves/unmounts as required |
| `hooks/useTerminal.ts`, `useStalledTurnWatchdog.ts` (gating), `LoopedReviewTab.tsx`, `BuildChatTab.tsx`, `CodexChatTab` SSE hydration, `OpenCodeChatTab` reconnect re-read | Documented, correct rehydration patterns — use as references |
