# 11 — Serve history pages without rebuilding interactive projections

Status: Complete for providers serving v2 pages; joined fallback retained for others (isolated real-stack QA unrun).
Finding: E07.

## Outcome

A page request validates its identity/epoch and reads a page. It does not
refresh composer catalogues, approvals, runtime state, or every previously
loaded message to rediscover an unchanged historical prefix.

## Owners

- `getMessagePage`, `updateProjectionHistory`, cursor helpers in
  [backend projections](../../../../apps/backend/src/core/native-agent-service-projection.ts).
- [Provider contracts](../../../../apps/backend/src/core/agent-provider-contract.ts)
  and the step-09 adapters.
- [Native command registry](../../../../apps/backend/src/core/commands-registry-native.ts),
  [frontend wrappers](../../../../apps/web/src/lib/backend/workflows.ts), and
  [session hook](../../../../apps/web/src/hooks/useNativeAgentSession.ts).
- Proposed small `native-agent-history.ts` service for page/cache ownership.

## Implementation

1. Extract history cursor/cache logic behind a narrow service with explicit
   identity, epoch, ordering, and retention. Keep the existing service facade
   forwarding methods so callers do not need a broad simultaneous refactor.
2. For a known current epoch and cached immutable page, return it directly after
   validating session ownership. Do not use `refreshProjection(..., true)` as
   the prerequisite. A cheap provider epoch/revision observation may reconcile
   uncertain cache validity without reading content.
3. Request provider-native/indexed ranges where supported. For legacy providers,
   share one bounded history hydration, cache its immutable pages, and expose
   the fallback cost in metrics. A page click must not launch duplicate full
   hydrations from two views of the same session.
4. Generate the initial history cursor from the live summary boundary. Avoid
   today's joined-snapshot bootstrap when the provider gives enough sequence
   information. Unpositioned legacy windows must retain the safe old bootstrap
   instead of inventing an offset from array length or message IDs.
5. Treat history as immutable pages plus a mutable frontier. When a completed
   message ages out of the live tail, finalize its current revision exactly
   once. If historical content is edited, rotate or invalidate the affected
   epoch/range before returning another page.
6. Keep page caches bounded by global/per-session bytes and entry counts. Store
   per-message/page measurements, not a full-history fingerprint recomputed on
   every page. Eviction expires a cursor or transparently refetches from the
   same authoritative epoch; it never reuses a cursor for a different history.
7. Define overlapping-page merge behavior by stable IDs and revisions. The
   frontend must not deduplicate solely by equal text. Preserve user-selected
   scroll anchors and avoid re-adding explicitly deleted rows.
8. Surface permanently omitted history and oversized unpageable content
   distinctly from “more pages available”. Each cursor must advance, including
   byte-truncated pages, or terminate with an actionable explicit result.
9. Continue to refresh action-critical state on its own path. A failed history
   page must leave approvals/cancel controls usable and the existing live tail
   visible.

## Compatibility

Keep existing `sync-v1` cursors valid for their existing endpoint until normal
expiry. New direct-page tokens carry their own representation namespace; old
tokens route through a bounded compatibility adapter or receive a deliberate
reset. Never silently translate an old cursor by assuming the same array index.

For Claude, verify pinned provider history APIs before implementing range reads.
If true range access is unavailable, explicitly retain a shared bounded
hydration fallback and measure it. Do not claim O(page) disk work for a provider
whose first access still requires a chronological normalization pass.

## Tests and acceptance

- Repeated page reads perform no composer/discovery/interaction fetch and no
  full-history fingerprint pass.
- The first page, adjacent pages, overlaps, byte-limited pages, and final page
  produce contiguous correct ordering and advancing cursors.
- Rewind, provider restart, fork/rebind, or replacement invalidates stale bases.
- Cache eviction, inactive-environment return, and two simultaneous readers
  recover without gaps or duplicate rows.
- A part-truncated live head cannot falsely advertise recovery of discarded
  leading parts via a message-only page cursor.
- Measure cold and warm page cost separately for every provider/fallback.

Ship backend support before client cursor bootstrap changes. Retain the
existing full-sync fallback only for consumers that have not negotiated direct
pages; do not keep invoking it behind the new fast path.

## Execution record

```text
Status: Complete for v2 providers; bounded joined fallback for older bridges
Implementation commit / PR: branch implement-efficiency-improvements-7f0993836777-r1,
  "feat(native-agent): consume bridge summaries, remote details and direct history pages"
Protocol or storage decisions:
  - native-agent-direct-history.ts: backend cursor `v: 2` wraps the provider
    cursor with digests of the logical session key and provider session id
    plus the provider history epoch; `v: 1` joined cursors keep their own
    endpoint behaviour. A cursor for another session is refused; a rotated
    provider epoch answers "cursor expired" (the renderer resets and re-reads).
  - projectProgressiveTranscript mints a direct cursor only when the view
    starts at or before the provider snapshot's first position (a joined
    prefix may overlap the first page; a bound that dropped leading rows would
    leave a gap, so no cursor is issued then). The view carries
    `historyPaging: "direct"`; deltas mirror it.
  - getMessagePage serves v2 cursors before anything else: resolve the owning
    session, ask `provider.transcriptPage` for exactly the range, project only
    that page (remote details as above). No refreshProjection, composer,
    interaction or interactive-snapshot read, no history fingerprint pass.
  - Web hook: adopts a direct cursor as the paging boundary whenever it holds
    no cursor of its own for the epoch (or retention collapsed), so "load
    earlier" no longer bootstraps through a forced joined snapshot; a page of
    rows already on screen (a cursor adopted after rows aged out of the tail)
    is stepped past, bounded, only when the cursor advances.
  - Epoch correctness for positional pages: Codex local ring and Pi branch
    navigation now rotate their content epoch (bridge half, step 09).
Tests and isolated profiles: native-agent-service-summary-transcripts.test.ts
  (250-message history paged to the start in contiguous order with no legacy
  or interactive read; cross-session and post-rotation cursors refused);
  useNativeAgentSession.progressive.test.tsx (direct cursor paging without
  the joined snapshot; stepping past a duplicate page).
Before/after measurements: see baseline/ (provider calls per page: joined
  refresh vs direct).
Compatibility/migration result: additive cursor namespace; old sync-v1 cursors
  keep working until normal expiry.
Remaining limitations: providers without page routes (older bridges, OpenCode
  in-process) keep the shared joined-history fallback. Pages reach only what
  each bridge retains (Cursor/Pi/ACP front trim; Codex detached preview
  before hydration; Claude preview before hydration, whose cursor then
  expires). Claude has no provider-native range read, so its cold first
  access still performs a full chronological hydration.
```
