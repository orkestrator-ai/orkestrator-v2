# 11 — Qualify bounded event and snapshot recovery

Status: Not started. Dependencies: 01; coordinate contracts with 03, 06 and 07.
Finding: F07. This is a prerequisite for dependent polling reductions.

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
