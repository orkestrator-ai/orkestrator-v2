# Event and snapshot recovery for event-led views

Status: Living — sequence semantics, conditional snapshot contract, and bounded
client hydration. Introduced by recurring-processes
[step 11](../improvements/recurring-processes/plan/11-recovery-and-resource-bounds.md).

An event-led view is a live event stream folded over an authoritative snapshot:
the PR monitor mirror, environment diff statistics, the worktree snapshot
revisions behind the Files panel (step 03), and the coordinator
view. This note defines which ordering each consumer may rely on, the
additive wire contract for revisioned snapshots, and
the client helper every such view uses to stay bounded while it converges.
The invariants in `AGENTS.md` ("Efficiency and Transport Invariants") apply
unchanged; nothing here relaxes them.

## Sequences — which consumer observes which ordering

These are different orderings. Never compare values from two rows, and never
compare revisions from two generations of the same row.

| Sequence | Owner and scope | Carried on | Who may use it |
| --- | --- | --- | --- |
| Gateway replay generation + revision | One backend process's replay ring (`apps/backend/src/gateway-event-replay.ts`); global across every non-droppable event | SSE `id` / cursor frames, `gateway.connected`, `gateway.reconcile-required` | The transport only (`apps/web/src/lib/native/web-gateway.ts`). A scoped subscription skips events it filters out, so its gaps are intentional. Domain code never sees this number. |
| Connection epoch | One client; increments on every `native-event-stream-connected` | Client memory | Fences in-flight snapshot reads started before a fresh connection or replay miss. |
| Resource revision | One backend process; `ResourceChange.revision`, contiguous across all persistent resource kinds on the main stream | `resource-changed` | `resource-sync.ts`: a gap or reset means the transport lost resource events, so it runs the manifest check (and the view safety checks below). |
| Resource manifest generation / snapshot revisions | Persistent storage snapshots; opaque 128-bit hex digests | `get_resource_revision_manifest`, scoped manifests, conditional resource snapshots | Equality only. Covers persistent resources, not ephemeral views. |
| View owner generation | One lifetime of the service that owns a view (for PR/diff: one `PrMonitorService` / `DiffStatsService` instance, a random UUID) | `generation` on view events and snapshots | Equality only. A different value means the owner was replaced (backend restart, transport switch, retarget to a different lineage): reset the view. |
| View domain revision | Per owner generation; integer that increases by exactly one per announced event (`packages/protocol/src/view-sync.ts`) | `revision` on view events and snapshots | Order events against a snapshot, drop duplicates, detect a missed event as a gap. Revision `0` = nothing announced yet (snapshots only). |
| Native observation generation + revision (step 07) | One `NativeAgentObservationBroker` lifetime (`native-agent-observation.ts`); revision advances by exactly one per announced session activity transition | `generation`/`revision` on `native-agent-session-activity`, plus `agent`/`logical_session_key`; current position in `get_native_agent_sync_capabilities.observation` | `apps/web/src/lib/native-observation-events.ts` only: invalidation, never state. A gap or new generation re-reads every mounted native view. |
| Target generation (worktree snapshots, step 03) | One tracked environment's lineage inside a `DiffStatsService` generation (worktree path or container, comparison ref); a service-unique integer, new on retarget, resume from pause, or re-track | `targetGeneration` on worktree snapshot states and on file-list/tree read stamps | Equality only. A different value means the file list and tree describe a different target: re-read, never compare its revisions with the old lineage's. An untracked environment is announced as a removal. |
| File-list / tree revision (step 03) | Per target lineage; advances on every semantic change of the changed-file list (paths, original paths, statuses, line counts, truncation) or of the bounded tree | `fileListRevision` / `treeRevision` in worktree snapshot states; `view.revision` on read responses | Decide whether the list or tree the client shows is older than the announced one. Never a content revision. |

Terminal output (generation/revision snapshot protocol with explicit desync)
and native-agent transcript windows keep their own existing contracts and are
out of scope here.

A domain revision gap is evidence of a missed event only because the owner
emits every revision to every subscriber of that event name on the main
stream. If a future view is delivered on a filtered stream, its owner must emit
a per-subscriber contiguous sequence or the view must not use gap detection.

## Snapshot contract

- The snapshot command returns the stamped legacy shape when called without
  arguments, e.g. `get_pr_monitor_state` → `{ entries, generation, revision }`.
  Legacy clients ignore the extra fields.
- `revision` identifies exactly the captured state: the owner reads entries
  and revision synchronously, in the same turn, and never reads a revision
  after building the body. Every announced change at or below `revision` is
  reflected; none above it is.
- The snapshot contains announced state only. An entry that can disappear
  without an event (the PR monitor's provisional probe) must not appear in a
  snapshot, because no later event or `unchanged` answer would correct it.
- Any change to snapshot content that is not announced as an event (for
  example `shutdown()` dropping entries) still advances the revision, so a
  conditional read cannot answer `unchanged` wrongly. Live clients observe
  that as a gap and reconcile.
- A failed event sink still consumes its revision, so a client that missed it
  sees a gap rather than an apparently contiguous stream.

## Conditional reads and outcomes

A client that has a revisioned position calls the same command with
`{ knownGeneration, knownRevision }`, where `knownRevision` is the revision it
is **contiguously** caught up to (not the highest seen — after a gap the
highest seen would let the owner answer `unchanged` while a change is
missing). The owner answers a `ViewSnapshotOutcome<T>`
(`packages/protocol/src/view-sync.ts`, decided by `resolveViewSnapshotOutcome`):

| Outcome | When | Client action |
| --- | --- | --- |
| `unchanged` | Same generation and revision | Keep state; no body is sent. Reject it if it names a position the client did not ask about. |
| `snapshot` | Same generation, newer revision | Replace the view, then apply buffered updates above `revision`. |
| `reset` + `reason` | Different generation (`generation`), client ahead of the owner (`ahead`), malformed request (`invalid-request`) | Replace the view and discard every per-key revision and tombstone. |
| `deleted` | Per-target views: the target no longer exists | Drop the view; buffered updates at or below `revision` must not resurrect it. |

Clients validate every response with `classifyViewSnapshotResponse` (or
`toHydrationFetchResult` on the web) before applying anything. A malformed
body is a failed read, never an empty view.

### Capability fallback

| Peer response | Capability | Client behaviour |
| --- | --- | --- |
| Stamped snapshot or outcome | `revisioned` | Revision-aware hydration, gap detection, compact safety checks. |
| Snapshot without stamp (older backend ignores the arguments) | `legacy` | Conservative reconnect hydration; buffered updates replay over the snapshot as before; no periodic safety reads (they would be full reads). |
| `Unknown backend command: <command>` | `unsupported` | No timed retries; the next reconnect tries again. |
| Any other error (network, auth, timeout) | unchanged | Ordinary failure: bounded retry, never a capability downgrade. |

A partial or malformed stamp on an event or snapshot fails validation; it is
never treated as legacy.

## Client hydration (`apps/web/src/lib/bounded-hydration.ts`)

`createBoundedHydration(options)` implements subscribe-before-snapshot for a
keyed view. The caller validates payloads, subscribes to the event, subscribes
to `native-event-stream-connected` (→ `onReconnect()`), registers with
`onViewSafetyCheck` (→ `safetyCheck()`), and then calls `request("initial")`.

1. While a read is in flight, updates go into a buffer window keyed by view
   key. Updates coalesce per key, keeping the highest revision, deletions
   included. The window records received revisions as bounded intervals so
   coalescing does not look like a gap.
2. The window is bounded by `maxBufferedKeys` (512) and `maxBufferedBytes`
   (1 MiB, estimated with a work-bounded walk). On overflow the controller
   discards all buffered bodies, stops buffering bodies, and keeps only the
   high-water stamp of what it dropped.
3. A result is applied only if its attempt is still the live one (late answers
   are ignored), its connection epoch is current, and no other owner
   generation was observed while it was outstanding. Otherwise the single
   queued rerun runs.
4. After applying a snapshot at revision R, buffered updates above R are
   applied in revision order; anything at or below R is covered. For a legacy
   peer, buffered updates replay in latest-arrival order.
5. If the window overflowed and R does not cover the high-water mark, the
   snapshot is still applied (it is newer than the store) and a bounded retry
   fetches a sufficient one.
6. One read in flight, at most one queued rerun. Each attempt has an owned
   timeout (15 s). Failures apply the buffered updates (the view stays live),
   then retry with capped jittered backoff (1 s, 2 s, 4 s … ≤ 30 s). After
   `maxAttempts` (4) the status is `degraded` and no timer remains; the next
   reconnect or safety check starts a fresh recovery.
7. Outside hydration, a stamped update at or below the contiguous position,
   or at or below the key's last applied revision, is ignored. A revision
   above `contiguous + 1` is applied and opens a gap, which requests one
   conditional read from the contiguous position. A different generation
   requests a reset read. Per-key bookkeeping exists only above the contiguous
   position and is bounded (`maxTrackedKeyRevisions`, `maxRevisionRanges`);
   exceeding it requests reconciliation.

Status (`HydrationStatus`) is mirrored into the owning store (`syncStatus` in
`prMonitorStore` and `environmentDiffStore`): `idle`, `hydrating`, `current`,
`stale`, `degraded`, `unsupported`. `getDiagnostics()` reports read counts per
trigger, overflows, dropped notifications and peak buffer sizes.

## Safety cadence

Ephemeral views do not add their own polling. `resource-sync.ts` exposes
`onViewSafetyCheck`; each registered view runs one compact conditional read on
the existing five-minute manifest interval and whenever the resource stream
shows a revision gap. For a current, revisioned view that read is normally an
`unchanged` answer with no body. Reconnects are handled by each view's own
connection listener. Legacy and unsupported peers skip safety reads.

The resource manifest itself is not extended: PR/diff revisions are owned by
in-memory services with process-lifetime generations, which do not match the
manifest's persistent-resource digests.

## Notifications versus state

State convergence and notifications are separate contracts.

- **State** is guaranteed: every missed event is recovered by the reconnect,
  gap, overflow or safety read above.
- **Transition notifications** (the "Branch merged" toast and sound) are
  **best-effort**. They are raised for transitions this client observes, after
  the transition's state has been applied, deduplicated per
  `(environmentId, url, state)` in a bounded set (`BoundedKeySet`, 256 keys).
  A re-delivered event, a backend retry after a failed persist, and a
  rehydrate never notify twice; a replacement PR (new URL) notifies again.
  Transitions announced while the client was disconnected are not replayed,
  and deferred notifications beyond `maxDeferredNotifications` (32) are dropped
  oldest-first and counted.
- Terminal side effects (task status, comments, metadata, merge cleanup)
  remain backend-owned in `pr-monitor.ts`; client notification delivery never
  gates them. A durable acknowledged transition journal was not needed for
  this policy and is not implemented.
- PR monitor freshness fields `lastCheckAt` (attempted) and the additive
  `lastSuccessfulCheckAt` (GitHub answered) ride on the next announced state
  event; neither is announced on its own, so a snapshot may carry a value
  older than the latest attempt. Lifecycle scheduling (terminal repair,
  five-minute terminal discovery, admission) is internal and never appears on
  the wire; see `pr-monitor-policy.ts`.

## Supported peers

| Client | Backend | Result |
| --- | --- | --- |
| Current | Current | Revisioned hydration, gap detection, compact safety checks. |
| Current | Before step 11 | `legacy`: reconnect hydration with bounded buffering; no periodic reads. |
| Current | Without the snapshot command | `unsupported`: live events only until a reconnect. |
| Before step 11 | Current | Extra optional fields are ignored; the unconditional snapshot shape is unchanged. |

## Native observation invalidations (step 07)

The native session view is not an event-folded view: its state comes from its
own progressive reads (transcript/state/discovery tokens). The stamped
activity announcement is therefore an **invalidation only** — a matching view
schedules one read through the read coordinator; nothing is applied from the
event itself. The stamp exists so a client can tell that it missed one: a
revision gap or a new generation invalidates every mounted native view, a
duplicate is ignored, and a malformed or partial stamp drops the announcement.
Reconnects are still covered by the coordinator's reconnect reconcile and
`onResourceResync`.

Quiet idle-view backoff relies on this, so it is enabled only for providers
whose idle view cannot change without an announced transition
(`NATIVE_QUIET_BACKOFF_QUALIFIED_PLATFORMS`) and only against a backend that
advertises `observationEventVersions`. Coverage:
`apps/web/src/lib/native-observation-events.test.ts` (gap, reset, duplicate,
legacy, malformed), `apps/web/src/hooks/useNativeAgentSession.observation.test.tsx`
(quiet schedule, immediate read on an announcement, gap re-read, older backend
and unqualified provider keep the baseline), `packages/protocol/src/native-agent-observation.test.ts`.

## Worktree snapshot revisions (step 03)

`DiffStatsService` owns, per tracked environment, the diff counts, the
changed-file list and (through `WorktreeTreeSnapshots`) the bounded file tree.
It announces a keyed view of their revisions:
`worktree-snapshot-changed` events (one environment's
`{ targetGeneration, comparisonRef, fileListRevision, treeRevision,
freshness, watched }`, stamped with the service generation and a contiguous
revision separate from the diff-stats stream) over the
`get_worktree_snapshot_revisions` snapshot, which answers conditional reads
like every view here (`packages/protocol/src/worktree-snapshots.ts`). Events
are invalidations only; the file list and tree are re-read with
`get_local_git_status` / `get_git_status` / `get_local_file_tree` /
`get_file_tree`, whose conditional answers now carry an optional `view` stamp
(generation, target lineage, the body's revision, freshness, watched).

- The snapshot contains announced state only: a live value (for example a
  watcher becoming qualified) is announced before a snapshot can show it.
- Revisions advance on semantic changes. A same-count, different-path list is
  a new file-list revision; a new empty folder is a new tree revision; an edit
  that leaves path, status and line counts unchanged is neither. Open editors
  keep their own load-on-open behaviour — no content invalidation is implied.
- `freshness` is `current`, `stale` (last scan failed; the retained list is
  the last good one) or `failed` (no good result). `watched` says whether a
  qualified watcher covers the worktree *and* its Git metadata; clients keep
  polling when it is false (containers, watcher failure) or the peer is
  legacy/unsupported.
- The Files panel (`useFilesPanel` + `useWorktreeSnapshotRevisions`) hydrates
  this view with `createBoundedHydration` while open and re-reads a view when
  the announced revision is newer than the stamp of what it shows, or the
  owner generation or target lineage differs. A hidden document defers to the
  read coordinator's return reconcile. The 5 s coordinated poll remains; for a
  quiet watched worktree the backend answers it from valid watched state.
- Container states carry an optional `remote` (step 04):
  `{ state: not-required | current | stale | unknown, lastSuccessAt?,
  failure? }` from the container fetch policy (`container-git-fetch.ts`).
  Container status scans read local refs only; a background fetch that moves
  `origin/<ref>` calls `invalidateBaseline`, so the rescan's file-list
  revision (if the list changed) is what tells clients to re-read. A fetch
  that changes only remote freshness republishes the state without advancing
  either revision. `stale` means the list is exact against the clone's refs,
  which may be behind the remote — never that the list is unusable.

## Coordinator view (step 09)

The coordinator panel is invalidation-led, not event-folded: it subscribes to
scoped `coordinator` (and `config`) `resource-changed` events before
hydrating and re-reads through `get_project_coordinator_view`
(`apps/backend/src/core/coordinator-view-revisions.ts`), which answers the
`ViewSnapshotOutcome` contract above. `generation` is one backend lifetime;
`revision` changes whenever the digest of the captured snapshot changes and
comes from one process-wide counter, so it is never reused for another body.
It is an equality/ordering token, not an event sequence — clients do not
gap-detect it. Recovery rides `onViewSafetyCheck`, reconnect reconciliation
and a guarded focus probe; an older backend keeps a 60 s full poll. The
project's Git status is a separate probe and is not part of this view's
freshness (see step 09's completion notes).

## Adopting the contract

For a new event-led view (step 07 activity observations, step 09 coordinator;
step 03's worktree snapshots above are a worked example):

1. Give the owner a `generation` and a contiguous `revision`, stamp every
   event, and return snapshots via a synchronous `{ entries, generation,
   revision }` capture. Advance the revision for any unannounced snapshot
   change. Keep announced state and snapshot content identical.
2. Parse conditional arguments with `parseViewSnapshotRequest` and answer with
   `resolveViewSnapshotOutcome`; per-target views answer `deleted` for a
   removed target and `reset` for a retarget.
3. Validate events and snapshots with `hasValidOptionalViewStamp` in the
   domain validators.
4. On the client, adapt reads with `readViewSnapshot(command, read, isSnapshot,
   toEntries)` and drive them with `createBoundedHydration`. Pass any user
   notification as the `notify` argument of `receive` and deduplicate it with
   its own bounded key.
5. Keep the existing polling for `legacy`/`unsupported` peers. A polling
   reduction may rely on this contract only after its own fault tests (see the
   plan's recovery coverage list) pass for that view.
