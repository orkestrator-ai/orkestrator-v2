# Frontend-to-Backend Migration Plan

Plan for addressing every finding in [`docs/frontend-state.md`](../frontend-state.md).
Each workstream is independently shippable; ordering within a phase matters,
ordering across phases mostly does not (dependencies are called out).

Target architecture for every workstream is the pattern already proven in this
codebase: **backend/bridge owns the record and the lifecycle, the renderer is a
revision-guarded projection** (`buildPipelineStore` / `loopedReviewStore` /
`prMonitorStore` shape), rehydrating on mount and treating events as
incremental updates over authoritative snapshots.

## Invariants that apply to every workstream

- Backend snapshots carry a `backendRevision`; the renderer store rejects stale
  writes and exposes a single `replaceX(snapshot)` write path, no phase
  mutators.
- Subscribe before snapshot; buffer events during the snapshot fetch; re-snapshot
  on stream reconnect (copy `usePrMonitorService.ts`).
- New backend commands go through `createCommandRegistry()` in
  `apps/backend/src/core/commands.ts`; shared contracts go in
  `packages/protocol` so guards cannot drift.
- Every migration keeps a one-release compatibility window where the renderer
  can talk to an older backend (feature-detect the new command; fall back to
  the legacy path) unless noted otherwise.
- Test the inactive-environment path for each: start work, switch environment,
  let it progress/finish, return, verify status/messages/prompts/controls.
  Also test the reload-mid-operation path, which is the actual failure mode
  behind most findings.
- Metrics/logs added by these services must not contain prompts, terminal
  contents, file contents, or credentials.

---

## Phase 1 — stop losing user work

The two findings where real user output (an agent's answer, queued prompts) is
destroyed rather than merely displayed stale.

### 1.1 Backend feature-planning workflow service

**Replaces:** the orchestration in `FeaturesView.tsx` and the state machine in
`featurePlanStore.ts` (audit §1).

**Design.** New `apps/backend/src/core/feature-planning.ts` service, modeled on
the build-pipeline service:

- Persistent record per conversation:
  `{ featureId, projectId, environmentId, codexSessionId, phase, backendRevision, dispatchId, result?, error? }`
  with `phase: dispatching | running | persisting | complete | failed`.
  Stored via `StorageService` so it survives backend restart.
- Commands: `startFeaturePlanning(featureId, kind, promptInputs)`,
  `getFeaturePlanningSnapshot(projectId)`, `retryFeaturePlanning(featureId)`,
  `cancelFeaturePlanning(featureId)`.
- The backend owns the whole chain FeaturesView currently runs: ensure
  environment → start Codex server → create session → persist `codexSessionId`
  → dispatch prompt (recording a `dispatchId` before sending, so a crash
  between dispatch and record cannot double-send — same at-most-once contract
  as the codex bridge's dispatch journal) → detect completion → parse the
  structured JSON → write the plan/story via the existing persistence path →
  advance `phase` and bump `backendRevision`.
- Completion detection: poll the bridge's `GET /session/:id/activity` (the
  route built for exactly this — no liveness touch), then fetch messages once
  on the idle transition. **Never** poll `/session/:id/status` from this
  service (AGENTS.md: that route refreshes `lastAccessed` and would keep the
  thread from detaching).
- JSON parse failures do not lose the reply: store the raw assistant text on
  the record with `phase: failed` + structured error so the UI can offer
  retry/inspect. The `persisting` phase writes the parsed result to the record
  *before* applying it to the plan, so a crash between the two is recoverable
  by replaying from the record — the renderer never holds the only copy again.
- Emit `feature-planning-updated` events (snapshot-carrying, or revision-bumped
  with the renderer re-fetching) over the existing backend event channel.

**Renderer.** `featurePlanStore` becomes a projection: delete
`startConversation`/`markConversationRunning`/`claimConversationPersistence`/
`settleConversation`; add `replaceConversations(snapshot)` with revision guard.
`FeaturesView` deletes `ensureCodexSession`, `waitForCodexReply`, `clientsRef`,
the poll loop, and the reconcile-on-mount machinery; it calls
`startFeaturePlanning` and renders the snapshot. The `unavailable` phase and
"Check again" button become a `retryFeaturePlanning` call.

**Migration.** On backend startup, sweep persisted features for the legacy
"unanswered message" markers FeaturesView used for rehydration and convert them
to records in `phase: running` so in-flight conversations from an old version
are adopted, not orphaned.

**Tests.** Unit: phase transitions, at-most-once dispatch (crash between
dispatch and record), parse-failure preserves raw reply. Integration: start
planning, kill/restart the backend mid-`running`, verify the plan still lands;
start planning, reload the renderer, verify no re-dispatch.

**Estimated size:** L (largest workstream; the service is new but every
primitive exists).

### 1.2 Backend prompt-queue drainer

**Replaces:** the dispatcher half of `useNativeMessageQueue.ts` and the hidden
force-mount hack in `App.tsx:244-269` (audit §2).

**Design.** New `apps/backend/src/core/prompt-queue-drainer.ts`:

- The backend already owns the queue and claim leases; add a supervisor that,
  per session with a non-empty queue, watches for the idle transition (via the
  same activity sweep / `GET /session/:id/activity` mechanism, per agent type)
  and then runs claim → dispatch to bridge → ack/reject with backoff — the
  exact ladder currently in `useNativeMessageQueue.ts:115-260`, moved
  server-side where a renderer reload cannot abandon a claim.
- Dispatch errors are recorded on the queue entry (structured, not a toast) so
  the renderer can render "dispatch failed: …" from the snapshot.
- The renderer keeps: optimistic enqueue, drafts, the queue projection
  (`setQueueProjection` contract unchanged), and rendering of dispatch errors.
  Delete the drain loop and the settlement-retry ladder from
  `useNativeMessageQueue.ts`; delete the queue-derived half of
  `getBackgroundProcessingEnvironments` in `App.tsx`.

**Ordering note.** Land the backend drainer behind a config flag first, with
the renderer drain disabled when the backend advertises the capability —
double-drain protection comes free from the existing claim lease, but only one
drainer should be *trying*.

**Tests.** Enqueue N prompts, close the app entirely, restart backend, verify
all N dispatch in order. Enqueue, reload renderer mid-dispatch, verify the
claim settles without the lease-expiry wait. Verify tmux, codex, opencode, and
claude-native queues all drain (the four maps `App.tsx` currently scans).

**Estimated size:** M.

---

## Phase 2 — backend-owned observation

### 2.1 tmux TUI capture and parsing in the backend

**Replaces:** the renderer `capturePane` poll and regex parsing (audit §3).

**Design.** Move the loop into `apps/backend/src/core/tmux.ts`:

- Per active tmux session, the backend runs the capture interval (keep the
  existing 500ms-busy / 3s-idle adaptive cadence from
  `claude-tmux-polling.ts`). Move `claude-tmux-usage.ts` parsing
  (ANSI-stripping, `AGENT_USAGE_RE`, selection-prompt detection) into a shared
  module the backend imports — put the pure parsers in `packages/protocol` or a
  backend module with the types exported, so the renderer types don't fork.
- Backend emits normalized events: `tmux-agent-usage`, `tmux-prompt-detected`,
  `tmux-prompt-cleared`, and stores the latest parsed state on the session
  record.
- New snapshot in the existing tmux status payload (or a
  `getTmuxAgentSnapshot(tabId)` command): current usage summaries + pending
  TUI prompt, read by `ClaudeTmuxChatTab` on mount.
- Bounded: capture output is parsed and discarded; only the small normalized
  struct is retained (invariant 11). Raw pane text never goes to logs
  (invariant 12).

**Renderer.** `ClaudeTmuxChatTab` deletes the `setInterval`/`tuiSnapshot`
state; renders prompt UI from store state fed by events + mount snapshot. This
fixes prompt detection for unmounted tabs and lets the prompt itself contribute
to `backgroundProcessingEnvironments`/busy signaling backend-side.

**Tests.** Fixture-driven parser tests move with the parser. Integration: raise
a TUI selection prompt while the environment is not selected, verify the
backend event fires and the prompt renders on return.

**Estimated size:** M.

### 2.2 Backend-owned agent activity

**Replaces:** clock arbitration and the polling-lifecycle decisions in
`agentActivityStore.ts` / `useGlobalActivityMonitor.ts` (audit §4).

**Design.**

- The backend polls every *running* environment for agent state
  unconditionally — the renderer no longer calls
  `startClaudeStatePolling`/`stopClaudeStatePolling`, and the 8-attempt
  client-side ladder is deleted. Backoff/give-up policy moves into the
  backend poller with its own retry-forever-with-cap behavior (a container
  that stops answering gets a `stale` marker, not a permanently frozen state).
- Timestamp arbitration (`nextObservationTime`, monotonicity dropping) moves
  into the backend merge: all observations get backend-issued timestamps, so
  the renderer never mints clocks. The multi-source merge
  (`mergeActivityState`) moves with it.
- Transition side effects (persistence, notifications) currently hung off
  `registerStateCallback` move to backend event emission on the working↔idle
  edge; renderer consumers subscribe to the event instead of the store
  callback bus. Because the backend observes the edge, transitions during a
  renderer reload are no longer lost.
- Keep the renderer's leased "a human is watching this environment"
  observation — that is genuinely renderer knowledge — but it becomes an input
  to the backend merge, not a peer authority.

**Renderer.** `agentActivityStore` shrinks to a projection keyed by
environment; `containerRefCounts` stays (it is mount-derived UI bookkeeping).
Add a bulk `replaceActivitySnapshot` applied on app start and stream reconnect.

**Dependency.** Do 2.1 first or in parallel — tmux activity is one of the
sources being merged, and it is cleaner to merge backend-side sources than to
keep one renderer-side.

**Tests.** Kill the renderer during a working→idle transition; restart; verify
the notification/persistence side effect fired exactly once (backend-side).
Out-of-order observation delivery no longer possible by construction — delete
the arbitration tests along with the code.

**Estimated size:** M–L.

### 2.3 Codex background sync moves bridge-side

**Replaces:** `useCodexBackgroundSync.ts` polling (audit §10).

**Design.** Two parts:

- Turn-generation token becomes bridge-issued: the codex bridge already knows
  turn boundaries; expose the turn id in the status/dispatch response and in
  SSE frames, and key renderer discard-late-responses logic on it instead of
  `loadingStartedAt`. This survives reload.
- Replace the renderer's 2s status/messages/approvals poll with the bridge's
  push machinery: the tab already has cursor-based SSE with gap recovery
  (`CodexChatTab.tsx:2445-2530`); background sessions should be covered by the
  backend's existing activity sweep plus `GET /session/:id/activity`, with a
  full reconcile (messages + approvals via `/session/:id/approvals`) triggered
  only on the idle transition or a detected revision gap — not on a timer.

**Note:** any polling added here must use `/session/:id/activity`, never
`/session/:id/status` (liveness-touch rule).

**Estimated size:** M.

### 2.4 Bridge-side stalled-turn recovery

**Replaces:** `useStalledTurnWatchdog.ts` as the primary mechanism (audit §14).

**Design.** The watchdog exists because SSE frames can be dropped. The
event-ring already assigns revisions; add a lightweight bridge heartbeat frame
(`id: <latest revision>` with no payload, every few seconds while a turn is
running) so a client that misses frames detects the gap through the existing
cursor machinery and triggers its existing reconcile — no renderer clocks.
Keep the watchdog hook for one release as a belt-and-braces fallback, then
delete it.

**Estimated size:** S.

---

## Phase 3 — lifecycle and teardown correctness

### 3.1 Retire the legacy setup-command path; single `setupPhase`

**Replaces:** `pendingSetupCommands` destructive read, the three-boolean
derivation, `forceResolveSetupRuntime` (audit §5).

**Steps.**

1. Make `setupManagedByBackend` the only path: delete the
   `result.setupCommands` branch in `useEnvironments.ts:871-875`,
   `pendingSetupCommands`/`consumePendingSetupCommands`/`sessionActivated` in
   `environmentStore.ts`, and the terminal-side consumer. Environments created
   by older versions mid-setup: on backend startup, any environment with
   `setupScriptsComplete: false` and no backend setup session gets a backend
   setup session started for it (the commands are derivable from repo config).
2. Backend exposes one authoritative
   `setupPhase: pending | running | ready | failed` on the environment record,
   computed server-side, plus a persisted `setupOverride` for the current
   `forceResolveSetupRuntime` use case. Delete `setupScriptsRunning` /
   `setupCommandsResolved` / `workspaceReady` derivation and the out-of-order
   guards in `useEnvironments.ts:346-436` — the renderer renders `setupPhase`.

**Tests.** Reload during setup: environment resumes `running` and completes.
Override survives reload.

**Estimated size:** M.

### 3.2 Atomic teardown commands

**Replaces:** `clearTaskBuildStatus` orchestration and fire-and-forget tab
cleanup (audit §6).

**Steps.**

1. New backend command `clearTaskBuildStatus(taskId)`: deletes/cancels the
   pipelines and unlinks the task in one backend-side sequence with
   idempotent retry; emits updated task + pipeline snapshots. `kanbanStore`
   calls it and applies the returned snapshots; the manual-cleanup toast goes
   away.
2. New backend command `teardownTab(tabId, kind)` covering the PTY / tmux /
   bridge-session cleanup now scattered across `paneLayoutStore.ts:267-380`.
   The backend records the teardown intent *before* executing, so a crash
   mid-teardown is finished by a startup sweep.
3. Backend orphan reaper: on startup and periodically, reconcile live PTYs,
   tmux sessions, and bridge sessions against pane-layout + session records;
   reap anything unreferenced past a grace period. This also cleans up
   pre-existing leaks. Reaping is destructive — log (id-only) and gate behind
   a generous grace window; never reap a session referenced by any persisted
   record.

**Estimated size:** M.

### 3.3 Backend creates the build tab

**Replaces:** `waitForPendingPaneHydration` race in `useBuildPipeline.ts`
(audit §15).

`startBuildPipeline` adds the `claude-build` tab to the backend-owned pane
layout as part of the same command, before returning. The renderer's
hydration machinery (which already applies authoritative layout) picks it up;
delete `waitForPendingPaneHydration`/`ensureBuildTab`.

**Estimated size:** S.

---

## Phase 4 — connection and retry policy

### 4.1 Structured retryability + backend "wait for bridge ready"

**Replaces:** ref-held retry budgets and error-string regexes (audit §7,
`new-environment-connection-retry.ts`).

**Design.**

- Backend/bridge errors gain a structured `retryable: boolean` (and optional
  `retryAfterMs`) in the protocol package; delete the message-regex
  classification.
- New backend command `awaitBridgeReady(environmentId, timeoutMs)` that owns
  the "new environment is still coming up" window server-side (anchored to the
  durable `environment.createdAt`), returning ready/failed/timed-out. The tab
  calls it once on mount instead of running its own laddered timer; remounts
  join the same in-flight wait instead of resetting the budget.
- Delete `automaticInitRetry*` refs in `CodexChatTab`/`OpenCodeChatTab`, the
  ladder in `new-environment-connection-retry.ts`, and the
  `TerminalContainer` bind-retry refs (the bind call goes through the same
  await-ready command).
- Codex initial-prompt retry (`CodexChatTab.tsx:2925-2949`): move
  retry-on-rejected-dispatch next to the bridge's dispatch journal — the
  bridge re-arms the dispatch once when the session becomes available; the
  renderer just renders the durable `initialPromptRequestId` state it already
  has.

**Estimated size:** M.

### 4.2 SSE reconnect state into the store

**Replaces:** component-ref reconnect budget in `OpenCodeChatTab` (audit §8).

Move `attempts`, backoff timer, and a `desynced` flag into the
`eventSubscriptions` entry in `createNativeChatStore.ts` (which already owns
the stream). Exhausting the budget sets `desynced: true`, which every tab in
the environment renders and which triggers a forced full rehydrate on the next
reconnect — satisfying "every missed event is detectable". Renderer-only
change; no protocol work. Apply the same shape to any other per-component
reconnect counters found in the codex tab.

**Estimated size:** S.

---

## Phase 5 — small durable-state fixes

Each is independent and small; batch as convenient.

| # | Fix | Change |
| --- | --- | --- |
| 5.1 | `hasLaunchedCommand` → backend PTY record (audit §9) | Add `bootstrapped: boolean` to the backend PTY session record, set when the auto-launch command is written; return it from attach/status; delete the renderer latch in `terminalSessionStore.ts:41` |
| 5.2 | tmux `busyStartedAt` backend-authoritative (audit §13) | Backend tmux status already tracks busy; add `busyStartedAt` (backend clock) to the status payload; `claudeTmuxStore` stores it verbatim (mirror `createNativeChatStore.ts:90`). Same for `session-timer.ts` fallback — prefer backend clock, render "—" over inventing one |
| 5.3 | `infoEvents` rehydration (audit §13) | Backend keeps the last 20 Notification/Stop hook events per session (it already receives them); include in the snapshot `replacePendingHooks` consumes |
| 5.4 | `unconfirmedDispatches` durable (audit §13) | Persist the unconfirmed-dispatch marker on the bridge/backend session record when created; clear on settle; include in session snapshot so the "may not have run — safe to resend" affordance survives reload |
| 5.5 | `pendingNativeLaunches` (minor) | Persist the launch intent with the provider session at creation (backend startup coordinator already creates the session); consume-on-mount from the snapshot; backend expires unconsumed intents and deletes the orphaned session |
| 5.6 | `updateSessionStatus` revert (minor) | Bring in line with the store's other mutations: capture prior status, revert on failure |
| 5.7 | Attachment writes → one command (audit §12) | New backend command `writeInitialPromptAttachments(envId, attachments[]) → resolvedPaths[]`; container layout knowledge moves to `apps/backend/src/core/`; all-or-nothing with cleanup on partial failure |
| 5.8 | Pane-layout intents (audit §11) | Send mutations as intents immediately (no 1s renderer debounce); backend coalesces and rebases. Shrink `pane-layout-merge.ts` renderer-side to optimistic application only. Do after 3.2/3.3 to avoid churn |
| 5.9 | Misplaced probe script | `git mv apps/web/src/lib/opencode-live-compatibility-probe.ts scripts/`; fix imports/references |
| 5.10 | UI nits (minor) | `BrowserTab` history into pane state; `ProjectNotesView` draft via the existing durable-compose-draft mechanism; `InitializationLogs` fed from a backend-buffered log snapshot |

---

## Sequencing summary

```
Phase 1 (user-work loss):        1.1 feature planning   1.2 queue drainer
Phase 2 (observation):           2.1 tmux capture → 2.2 activity   2.3 codex sync   2.4 heartbeat
Phase 3 (lifecycle):             3.1 setup phase   3.2 teardown   3.3 build tab
Phase 4 (retry policy):          4.1 retryable + awaitBridgeReady   4.2 SSE store state
Phase 5 (small fixes):           5.1–5.10, anytime
```

Phases 1–2 deliver almost all of the user-visible reliability win. 1.1 and 1.2
are independent of everything else and of each other — start both. 2.2 wants
2.1 first. 5.8 should wait for 3.2/3.3. Everything else is unordered.

## Definition of done (per workstream)

- No authoritative state exists only in renderer memory for the migrated area;
  the renderer store has a single snapshot write path with a revision guard.
- The inactive-environment test passes: work started, environment switched,
  work progresses/finishes, return shows correct status/messages/prompts.
- The reload test passes: renderer hard-reloaded at the worst mid-operation
  point; no lost output, no double dispatch, no stuck state.
- The backend-restart test passes where the workstream adds persisted backend
  state.
- Legacy renderer code paths are deleted (not flagged off indefinitely) one
  release after the backend capability ships.
- `bun run --cwd apps/web typecheck`, `--cwd apps/backend typecheck`, and the
  relevant suites (`bun test tests --parallel`, `bun test bridges --parallel`)
  pass.
