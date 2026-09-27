# 11 — Serve history pages without rebuilding interactive projections

Status: Not started. Prerequisites: 08, 09; 10 for Codex indexed pages.
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
