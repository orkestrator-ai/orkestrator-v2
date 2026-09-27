# 13 — Keep immutable history out of frontend live-update accounting

Status: Not started. Prerequisite: 12. Finding: E10.

## Outcome

A tail update does not stringify the entire retained conversation on the main
thread. Existing history eviction, message identity, virtualization, and
authoritative reconciliation remain correct across multiple mounted views.

## Owners

- [Session hook](../../../../apps/web/src/hooks/useNativeAgentSession.ts).
- [Projection store](../../../../apps/web/src/stores/nativeAgentProjectionStore.ts).
- [Native tab controller](../../../../apps/web/src/components/native-agent/AgentNativeTab.controller.tsx).
- [Normalization caches](../../../../apps/web/src/lib/chat/native-message-adapters.ts).
- [Virtualized list](../../../../apps/web/src/components/chat/VirtualizedMessageList.tsx).
- Existing hook progressive tests, store tests, and native tab browser tests.

## Implementation

1. Represent retained history as immutable page/message entries with cached
   encoded sizes, separate from the live window. A projection may still expose
   the existing joined array to callers, but compute its byte total from entries
   rather than encoding the joined array again.
2. Compute a received message's size once if the wire does not carry a trusted
   validated measurement. Treat server-supplied sizes as accounting hints unless
   validated against the received data; a malicious or malformed peer cannot
   bypass client memory admission with a false size field.
3. Maintain per-session and global history/live totals incrementally when
   installing/replacing/deleting a message or page. Count overlaps consistently
   within each policy budget. JSON bytes are a retention proxy, not exact heap.
4. Reuse discovery size while its revision/object is unchanged. Avoid resampling
   the discovery payload just because transcript availability or a refresh flag
   changed. Separate state-domain and content-domain subscriptions where that
   prevents unrelated rerenders without changing action authority.
5. Preserve stable message/part objects for unchanged revisions. Retain current
   WeakMap normalization caches and memoized row components. Do not replace
   them with global unbounded caches keyed by every message ID ever visited.
6. Centralize history ownership and eviction notifications. When global pressure
   evicts a session, invalidate both store entries and mounted hook refs via the
   existing eviction generation mechanism. Update associated byte maps in the
   same transaction so a later poll cannot reinstate stale totals or old pages.
7. Assemble display arrays only when membership/order or an entry value changes.
   Keep expensive full-prefix scans for actual page/epoch changes, not every
   streaming part. Derive search/annotation indexes by revision where useful;
   preserve search over retained content and source-message attribution.
8. Do not add workers initially. Profile after accounting changes; introduce an
   off-main-thread normalizer only if substantial unavoidable work remains and
   transfer/copy costs are measured. Virtualized DOM count is not a substitute
   for measuring main-thread processing.

## Tests

- Hold 8 MiB of historical messages and change one live message repeatedly;
  serialization hooks show only newly received/changed values are measured.
- Two views share a session, then one unmounts; shared cached content remains
  valid and the other view receives changes.
- Global eviction while an inactive mounted hook retains refs cannot restore
  evicted history on its next update. Compare exact totals with a slow full
  recomputation in tests after every operation sequence.
- Rewind/delete, duplicate page, overlapping window, partial live head, and
  provider identity replacement preserve ordering and completeness semantics.
- Expanded tool cards, selection, scroll restoration, copy, search, annotations,
  and load-earlier controls behave correctly after structural-sharing changes.

## Acceptance and rollout

Run focused hook/store tests and the required isolated browser cycle. Capture
input latency and long tasks on the same large-history workload used in step
01, including hidden/resumed documents. No timing-based unit assertions.
The store remains a derived cache; authoritative work stays in the backend.
No persistent local browser transcript migration should be necessary.
