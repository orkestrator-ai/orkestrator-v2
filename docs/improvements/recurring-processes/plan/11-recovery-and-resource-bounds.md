# 11 — Qualify bounded event and snapshot recovery

Status: Implemented. Contracts and the PR/diff migration landed here (see
[completion notes](#completion-notes)). Adopters followed: file-list/tree
revisions (step 03), native observation invalidations (step 07) and the
coordinator view (step 09). Native-session transcript views keep their own
progressive-token contract and use stamped invalidations only. Real-stack
results are recorded in step 12. Dependencies: 01;
coordinate contracts with 03, 06 and 07. Finding: F07. This is a prerequisite
for dependent polling reductions.

## Outcome

Every newly event-led view can detect missed work, bound retained state while
hydrating, and converge after overflow/reconnect/restart without replaying a
mutation. A stalled snapshot cannot accumulate an unbounded event array.

## Existing targets

`packages/protocol/src/resource-events.ts`, `pr-monitor.ts`, `diff-stats.ts`,
`apps/web/src/lib/resource-sync.ts`, `usePrMonitorService.ts`,
`useEnvironmentDiffStats.ts`, native projection contracts, new file/coordinator
snapshot contracts, and gateway replay/scoping tests.

## Implementation tasks

1. Document which sequence each consumer observes: global gateway revision,
   resource revision, domain revision and owner generation. They are different
   orderings. Do not compare unrelated counters or treat a filtered global
   sequence's intentional gaps as automatically missing domain changes.
2. Add additive generation/revision metadata to PR/diff snapshots and changes, or
   a compatible compact manifest that provides equivalent convergence. Choose
   the smallest contract covering state and removals. Snapshot revision must
   identify the state actually captured, not a newer revision read afterward.
3. For new file/tree/coordinator views, define authoritative unchanged/snapshot/
   reset outcomes, deleted targets, and capability fallback. Validate schemas
   before applying data. A legacy peer without revisions remains on conservative
   polling/reconnect hydration until explicitly supported.
4. Replace unbounded snapshot-time PR/diff arrays with bounded keyed state maps
   plus any separately bounded transition bookkeeping. Preserve the highest
   applicable revision, including deletions. State updates can coalesce; a user
   notification transition requires its own explicit deduplication/delivery rule.
5. On buffer saturation, set reconcile-required and retain enough generation/
   high-water evidence to know the snapshot is insufficient. Stop buffering
   arbitrary additional bodies; obtain a fresh authoritative snapshot through
   bounded backoff. Do not silently drop authoritative state and claim current.
6. Subscribe before snapshot. Apply it only if still current for connection and
   target generation, then apply buffered updates newer than its revision.
   A newer snapshot must not be overwritten by an older buffered event. A removal
   during hydration must not resurrect the target.
7. Handle failed/slow/hung snapshots with an owned timeout, bounded retries and
   visible stale state. Maintain one in-flight hydration and at most one queued
   rerun. Continuous events cannot keep memory growing or keep every snapshot
   permanently stale without an explicit degraded state and recovery path.
8. Integrate compact safety checks with existing resource synchronization rather
   than installing a high-frequency full snapshot interval per feature. The
   current manifest covers persistent resources, not all ephemeral PR/diff views;
   extend its contract only where ownership/revision semantics genuinely match.
9. Preserve transport rules: subscribe before replay range; connected SSE echoes
   client's cursor; authoritative events are never silently dropped; terminal
   backpressure emits desync and restores exact snapshots; byte/count bounds
   apply before expensive decode/serialization. Do not expand replay content to
   full file or transcript bodies merely to simplify clients.
10. Keep snapshot state convergence distinct from toast history. Decide whether
    transition notifications after long disconnection are best-effort or durable.
    If best-effort, document it and still guarantee current PR state. If durable,
    implement a bounded acknowledged transition journal rather than unbounded
    client memory. This choice must not block task/merge side effects in backend.

## Fault-injection matrix

Test event before subscription, event during snapshot, multiple reconnects during
snapshot, older snapshot resolving late, same revision duplicate, out-of-order
update, generation reset, lost final event, replay expiry, filtered stream cursor,
deletion and recreation, buffer overflow, invalid payload, snapshot timeout,
unsupported capability and transport switch. Assert exact final state, bounded
memory and number of reconciliation attempts.

Test PR transitions separately from state: no duplicate toast on retried
persist/rehydrate, replacement PR identity handled correctly, terminal side
effects remain backend-owned, and missed notification never prevents current
state recovery. For files, preserve same-count path changes and tree-only edits.
For native sessions, restore approvals, parked dispatch controls and partial
history without inferring empty from unavailable.

## Acceptance and rollout gate

All buffers/caches/queues have explicit count and byte bounds or demonstrably
bounded scalar entries. Overflow leads to explicit reconciliation. Every
polling-reduction migration lists its recovery test coverage and supported peers.
No event loss requires user mutation/resubmission to recover read state.

Land additive contracts and client fallback before enabling new policy. If a
peer lacks the contract or convergence fails, select the conservative read
schedule automatically. Keep the protocol additive during rollback; remove
obsolete compatibility only through a separately reviewed support-window change.

## Completion notes

Recorded 2026-09-25. Living reference:
[event-snapshot-recovery.md](../../../architecture/event-snapshot-recovery.md).

### What landed

| Commit | Change |
| --- | --- |
| `0ac34533` | `packages/protocol/src/view-sync.ts`: `ViewRevisionStamp`, `readViewRevisionStamp`, `hasValidOptionalViewStamp`, `parseViewSnapshotRequest`, `resolveViewSnapshotOutcome`, `ViewSnapshotOutcome` (`unchanged`/`snapshot`/`reset`/`deleted`), `classifyViewSnapshotResponse`, `ViewSyncCapability`, `isUnknownViewCommandError`. Optional `generation`/`revision` on PR monitor and diff-stats events and snapshots (`PrMonitorSnapshotOutcome`, `EnvironmentDiffStatsSnapshotOutcome`). |
| `a4afdf60` | `PrMonitorService` / `DiffStatsService` stamp every announced event with a per-instance generation and contiguous revision; `revisionedSnapshot()` captures entries and revision synchronously. Commands answer conditional reads. PR snapshots now contain announced state only; a mid-check "detecting" state is always lowered; diff untrack announces a removal; shutdown advances the revision. |
| `13b9132a` | `apps/web/src/lib/bounded-hydration.ts` (+ `-primitives.ts`): bounded subscribe-before-snapshot controller. `usePrMonitorService` and `useEnvironmentDiffStats` migrated (unbounded `bufferedEvents` removed), `syncStatus` mirrored into both stores, `onViewSafetyCheck` in `resource-sync.ts`. |
| `42780df0`, `7dba0d65` | Test typing fixes found by `mise run check`. |
| docs commit | This note, the architecture note, and the catalog entry. |

Tasks 1–10 are addressed as follows. (1) Sequence table in the architecture
note. (2) Stamps plus conditional reads; snapshot revision is captured with
the body. (3) Generic outcome/deleted/capability contract with tests; the
file/tree/coordinator producers are deferred to steps 03 and 09. (4)–(7)
`createBoundedHydration`. (8) Safety reads ride the existing five-minute
manifest interval and resource revision gaps; the manifest itself was not
extended because PR/diff ownership (in-memory, process-lifetime generations)
does not match its persistent-resource digests. (9) No transport code
changed; replay content was not expanded. (10) Notifications are
**best-effort**: deduplicated per (environment, URL, state) in a 256-key
bounded set, delivered after their state, never replayed after disconnection;
current PR state is always recovered. No durable transition journal.

### Supported peers

Current client + current backend: revisioned. Current client + backend before
this step: `legacy` — reconnect hydration with bounded buffering and the old
replay-over-snapshot semantics, no periodic reads. Backend without the
snapshot command: `unsupported` — live events only until a reconnect. Client
before this step + current backend: unaffected (additive fields only).

### Recovery coverage list

Later polling-reduction steps must cite the rows they rely on and add their own
rows for their view.

| Case | Test (file › name) |
| --- | --- |
| Event before subscription | `apps/web/src/lib/bounded-hydration.test.ts` › event before subscription…; `apps/web/src/hooks/usePrMonitorService.test.tsx` › subscribes to changes before reading the snapshot |
| Event during snapshot | bounded-hydration › event during a snapshot is applied over it only when newer; `useEnvironmentDiffStats.test.tsx` › an older buffered change never overwrites the newer snapshot |
| Multiple reconnects during snapshot | bounded-hydration › multiple reconnects during a snapshot fence it and queue exactly one rerun |
| Older snapshot resolving late | bounded-hydration › an older snapshot resolving late never overwrites the newer one |
| Same-revision duplicate | bounded-hydration › a duplicate revision applies and notifies once |
| Out-of-order update | bounded-hydration › an out-of-order update is detected as a gap…; › a late-filled gap outside recovery… |
| Generation reset | bounded-hydration › a generation reset replaces the view…; › a snapshot from a replaced owner is not applied |
| Lost final event | bounded-hydration › a lost final event is recovered by the compact safety check; `usePrMonitorService.test.tsx` › a missed transition never prevents current state recovery |
| Replay expiry | bounded-hydration › replay expiry reconnect restores the exact snapshot, removals included |
| Filtered stream cursor | bounded-hydration › filtered global cursors do not create domain gaps |
| Deletion and recreation | bounded-hydration › deletion then recreation…; › a removal during hydration does not resurrect the key; › a stale update after a removal is ignored; `useEnvironmentDiffStats.test.tsx` › an untracked environment's removal does not resurrect… |
| Buffer overflow | bounded-hydration › buffer overflow keeps only high-water evidence…; › …insufficient snapshot…converges by bounded retry; › continuous events cannot grow memory while snapshots keep failing |
| Invalid payload | bounded-hydration › an invalid snapshot is never applied…; existing malformed-event/snapshot tests in `tests/unit/hooks/use{PrMonitorService,EnvironmentDiffStats}.test.tsx`; protocol stamp validation tests |
| Snapshot timeout | bounded-hydration › snapshot timeouts retry with capped backoff, then degrade until a safety check |
| Unsupported capability | bounded-hydration › unsupported capability stops timed reads until a reconnect; › a legacy peer replays buffered updates…; `usePrMonitorService.test.tsx` › an unknown snapshot command selects the unsupported capability |
| Transport switch | bounded-hydration › transport switch to a new owner…; › …to a legacy peer… |
| Gap → conditional read | `useEnvironmentDiffStats.test.tsx` › a revision gap triggers one conditional read from the contiguous position |
| Safety cadence | `resource-sync.test.ts` › ephemeral view safety checks (3 tests); `usePrMonitorService.test.tsx` › the resource-sync safety cadence runs a compact check… |
| PR transitions | `usePrMonitorService.test.tsx` › a retried or re-delivered transition toasts once and a rehydrate never re-toasts (also asserts no client-side terminal mutation); › a replacement PR's merge is announced…; › a missed transition never prevents current state recovery |
| Backend stamping | `tests/unit/backend/view-revisions.test.ts` (10 tests); `commands-state-sync.test.ts` › snapshot reads are stamped and answer compact conditional reads; `commands-integration.test.ts` › computes counts for a tracked local environment and announces them |

### Checks

Focused suites passed: protocol (`view-sync`, `pr-monitor`, `diff-stats`),
backend services (`pr-monitor-service`, `diff-stats-service`,
`view-revisions`), `commands-state-sync` (new test), the diff-statistics
block of `commands-integration` (with `--timeout 60000`), web
`bounded-hydration`, both hooks (web and root suites), `resource-sync`, and
`backend.test` wrappers, plus the related sidebar, `usePullRequest`, store,
`ActionBar` and `App` suites. `mise run check` passed.

`mise run test:changed` (host shared with several concurrent agents) failed
only on timeouts in unrelated code: six `commands-registry-environments`
lifecycle tests (five passed alone; "retains the environment and process
ownership when deletion cannot reap a server" took ~8 s against a 5 s budget
and passed with `--timeout 60000`) and `DesignCanvasTab history › only the
focused pane handles a shared shortcut` (passed alone). The two
`commands-state-sync` "initial prompt attachment command" tests time out in
confined file-write helpers under this load and pass with `--timeout 60000`.
None of these exercise the changed code paths.

### Not done / deferred

- Real-browser and real-stack qualification (two clients, one disconnected,
  backend restart while a snapshot is in flight). Unit coverage only.
- Step 03 file/tree producers, step 09 coordinator view, and native-session
  projections (approvals, parked dispatch, partial history) have not adopted
  the contract; their "same-count path change", "tree-only edit" and
  "unavailable is not empty" tests belong to those steps.
- No UI surfaces `syncStatus` yet; it is available in both stores.
- No measured before/after call counts: step 01's baseline was not available
  in this worktree. Expected steady-state cost is one bodiless conditional
  read per view per five minutes for revisioned peers.
- Durable transition delivery was deliberately not implemented (best-effort
  policy above). Reconsider only if a product requirement appears.
- No polling was reduced by this step; dependent steps must still pass their
  own qualification before relying on it.
