# 13 — Keep immutable history out of frontend live-update accounting

Status: Implemented, validation pending. Prerequisite: 12. Finding: E10.

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

## Execution record

```text
Status: Implemented, validation pending
Implementation commit / PR: branch implement-efficiency-improvements-7f0993836777-r1,
  commit "perf(web): keep retained history out of live-update byte accounting".
  Frontend only; step 12 was not a code dependency because the wire format
  stays whole-message.
Protocol or storage decisions:
  - No wire or backend change. Server-supplied sizes are never used: every size
    is measured from the received value.
  - New apps/web/src/lib/native-history-accounting.ts: per-message encoded size
    cached in a WeakMap keyed by object identity (GC-bounded, no ID registry);
    array size derived as "[" + elements + commas + "]", byte-exact with
    UTF-8(JSON.stringify(array)); UTF-8 length computed without allocating the
    encoded buffer. Retained history counts 0 when empty (was 2 on the sync
    path, 0 on the progressive path); this also stops the global eviction pass
    from "evicting" empty histories and bumping their eviction generation.
  - Identity caching relies on received messages being immutable. Audited the
    hook, projection store, protocol delta appliers (applyNativeAgent*Delta),
    native-message-adapters, native-agent-pinning, chat components: every
    rewrite copies; the only in-place writes (pinning's settledRows, block
    splitting's segment.parts) target locally created accumulators, not
    received messages. No mutation fix was needed.
  - Hook (accounting paths only): historyRequestBudget, planSyncMaterialization,
    retireLoadEarlierControl, applyProgressiveTranscript, and paging use cached
    sizes; no call site serializes retained history any more. A streamed tail
    update serializes only the changed message (once, in setProjection).
  - Store: setProjection sizes the joined array from cached per-message sizes;
    projectionBytesTotal / historyBytesTotal / progressiveCacheBytesTotal are
    maintained incrementally in setProjection, setProgressiveCache, reset and
    evictNativeAgentHistoryCaches (no per-update map re-summing). The eviction
    now also resets the evicted session's projectionBytes to its live tail in
    the same setState (previously the materialized size stayed charged).
    Eviction-generation semantics are unchanged.
  - setProgressiveCache measures discovery once per discovery object and
    returns the unchanged state (no subscriber notification) when a patch
    leaves the newest entry field-for-field identical (idle polls).
  - No workers added. Message identity, WeakMap normalization caches and
    memoized rows untouched.
Tests and isolated profiles:
  - New lib/native-history-accounting.test.ts: UTF-8 length vs TextEncoder
    (incl. astral and lone surrogates); array totals vs JSON.stringify over
    random arrays and non-JSON values; per-identity measurement counts; 400-step
    random retention sequences (page, delete, upsert, overlap/duplicate page,
    rewind, eviction/identity replacement, age-out) vs slow recompute.
  - Store tests: ~7.6 MiB history + 20 streamed updates measure only the changed
    message; 300-step random setProjection/sync/null/evict/progressive sequence
    with exact running totals; eviction charges only the live tail; empty
    histories are not evicted; discovery measured once, idle patches do not
    notify.
  - New hooks/useNativeAgentSession.accounting.test.tsx (progressive hook):
    ~7.6 MiB retained history with 10 streamed deltas measures exactly the
    upserted message each time and nothing on an idle poll; two views share a
    session and the survivor receives changes after one unmounts; global
    eviction while the hook is mounted but inactive is honoured on reactivation
    (no evicted pages or stale totals return); delete, part-trimmed live head,
    rewind and provider/runtime replacement keep order; duplicate, live-overlap
    and overlapping pages keep order and measure only new page messages once.
    Every step compares running totals and per-session sizes with a slow full
    re-encode.
  - Sync tests now seed/evict through store actions instead of raw setState so
    the running totals stay consistent.
  - Ran: bun test --cwd apps/web ./src/hooks ./src/stores
    ./src/lib/native-history-accounting.test.ts (pass); native-agent, chat,
    AgentInfoButton, RequestCard, CoordinatorPanel component suites (pass);
    web typecheck (pass); mise run format/format:check/lint (pass, pre-existing
    warnings only); mise run test:browser: 98 passed, 2 failed (DesignCanvas,
    both viewports) under concurrent machine load; DesignCanvas passes when
    rerun alone and imports none of the touched modules.
Before/after measurements: not captured. Serialization-count tests are the
  deterministic evidence; input latency / long-task profiling on the step-01
  large-history workload (incl. hidden/resumed documents) is still pending.
Compatibility/migration result: none needed; the store is a derived cache.
Remaining limitations:
  - Totals are derived by O(n) WeakMap lookups per install (no serialization);
    retained history is not yet a separate page/entry structure through the
    display pipeline, and display arrays are still re-joined per install
    (implementation items 1 and 7 are only partly addressed).
  - State/content subscription split (item 4, second half) and revision-keyed
    search/annotation indexes (item 7) not done.
  - The running totals assume every syncCaches/projectionBytes write goes
    through store actions or evictNativeAgentHistoryCaches; direct setState of
    those maps would desynchronise them (recomputeNativeAgentProjectionTotals
    is exported for tests).
  - Observed, not changed (outside accounting scope): a transcript snapshot
    for a different providerSessionId with the same sourceGeneration is dropped
    by applyProjection's revision fence, because the progressive path restarts
    the revision at 1 when the provider changes; the state read then relabels
    the old messages with the new sessionId. The hook test uses a new
    sourceGeneration for provider replacement.
```
