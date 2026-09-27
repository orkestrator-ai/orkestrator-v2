# 12 — Reuse backend normalization, hashes, sizes, and detail references

Status: Complete — unchanged projected rows are reused since a81a4a66; a changed read still compares each window row once (no per-message provider revision exists). Whole-message wire delta retained; part patches in step 14.

## Outcome

The backend projects changed source messages/parts once, reuses immutable
completed values, and does not repeatedly stringify identical content to
compute tokens, diffs, cache sizes, and response sizes in one refresh.

## Owners

- [Projection service](../../../../apps/backend/src/core/native-agent-service-projection.ts).
- [Provider snapshot types](../../../../apps/backend/src/core/agent-provider-contract.ts).
- [OpenCode snapshot normalizer](../../../../apps/backend/src/core/opencode-snapshots.ts).
- Shared transcript size helpers from step 02 and adapter revisions from step 09.
- Existing progressive/projection/sync/detail tests; split new internals into
  small modules rather than further expanding the projection service.

## Implementation

1. Introduce an internal projected-message entry containing immutable value,
   source identity/revision, display-transform version, encoded size, and a
   stable digest if needed. Include coordinator/prompt-presentation context in
   the cache identity because identical provider content can be presented
   differently for different logical sessions.
2. Reuse entries only when source revisions are trustworthy. For old providers,
   compute a digest once on arrival and reuse that result downstream. Never use
   object identity alone for bridge-owned mutable messages.
3. Cache detail references by source part/revision and transformation version.
   For a known unchanged detail, skip JSON serialization and hashing. The cache
   must still validate session ownership on lookup and expire stale entries
   after generation/epoch change. Pinned entries must have a finite admission
   policy so pinning cannot defeat the global budget.
4. Make windowing consume known encoded sizes. Build a token from scoped
   identity, revisions, ordered membership, metadata, and representation
   version; avoid hashing all text again. Tokens must change for title,
   freshness/completeness, truncation, and detail-reference changes as required
   by the contract.
5. Build message upserts by revision comparison and membership sets. Keep old
   immutable message references for unchanged rows. Compare metadata fields by
   revision/value rather than serializing the entire transcript view.
6. Choose delta versus snapshot using reusable size measurements. Where an exact
   serialized envelope is needed, serialize the selected response once and
   carry its measured bytes within that layer. Do not serialize both full
   candidates merely to discover one changed small message.
7. Keep source reads shared by connection/session/window and normalize shared
   immutable results once where safe. Coarse and fine windows may share source
   data only when completeness/position is proven; avoid a “smallest window
   wins” cache that silently starves larger callers.
8. Preserve existing dirty-while-in-flight follow-up behavior. A provider event
   during a read marks the relevant domain dirty and yields a bounded trailing
   refresh. A stale completion cannot overwrite a newer epoch or resurrect
   deleted detail entries.
9. Account cache object estimates and serialized bytes separately. Evict all
   associated normalization/detail/size indexes with the owning session or
   revision, while protecting active work through explicit ownership.

## Tests and acceptance

- Changing one tail part causes no re-normalization or serialization of a long
  immutable historical prefix on the revisioned path.
- Unchanged metadata and same source token return unchanged without content
  visits. Title-only and completeness-only changes still reach the client.
- Same raw content projected for two logical contexts produces correct distinct
  display fields and scoped details.
- Mutation of a reused source object with a changed revision cannot hit stale
  caches. Providers without versions take the measured compatibility path.
- Cache eviction, generation death, concurrent reads, and dirty trailing refresh
  retain exact current output compared with the baseline projection fixtures.

## Delivery

Land cache-entry representation and accounting first, then diff/token changes.
Keep the current whole-message wire delta in this step; it already permits
most CPU reductions without introducing a new client patch protocol. Collect
post-change bytes/CPU results for the step-14 decision.

## Execution record

```text
Status: Complete
Implementation commit / PR: branch implement-efficiency-improvements-7f0993836777-r1,
  "perf(native-agent): serialize each projected message once per read"
Protocol or storage decisions:
  - native-agent-projection-encoding.ts: projected messages are immutable once
    projectionMessages returns them, so their JSON and byte length are
    memoized per object (WeakMap). The view token, cache bytes, per-message
    delta comparison, delta-vs-snapshot sizing, history fingerprints and
    bytes, the sync-v1 token/budget and both byte bounds (boundTranscriptResponse
    now takes an injected `measure`) all use the memo.
  - reuseUnchangedMessages keeps the previously held object for every row
    whose encoding did not change, so later comparisons are reference checks
    and renderer caches keyed by object stay warm. Delta membership uses Sets
    (the old `includes` scan was quadratic).
  - Detail references for summary parts are registered without serializing or
    hashing bodies (step 09); inline bodies (v1 bridges, OpenCode) are still
    hashed once per changed read to mint content-addressed refs.
  - The whole-message wire delta is unchanged (part deltas: step 14).
  - native-agent-projection-entries.ts (commit a81a4a66, finding E05):
    projectionMessages reuses a projected row while its provider row is
    structurally equal (same keys in order, same values) to a private copy
    taken when the entry was built. No provider exposes a per-message
    revision and every bridge read parses fresh objects, so identity alone is
    never trusted; the check hashes and serializes nothing. A miss projects
    from the private copy, so a provider mutating its objects later cannot
    alter a kept value. Entries are keyed by session key, remote provider
    session (summary vs inline details) and coordinator display, and record
    prompt presentation. Detail references each row registered are replayed
    on reuse (recency refreshed; an evicted provider-held reference is
    re-registered from its locator; an evicted inline body forces a fresh
    projection). Bounds: 8,192 rows / 48 MiB global, 4,096 rows / 24 MiB per
    session, 2 MiB per row (source-copy estimate + projected encoding).
    Dropped on invalidateProjection (rewind, resume, steer, replacement), on
    an observed history-epoch change, and at shutdown.
Tests and isolated profiles: native-agent-projection-encoding.test.ts (exact
  array bytes incl. multibyte; one serialization per object; reuse of
  unchanged rows; digests change with messages and fields; a changed read of a
  100-message window with one changed tail serializes projected messages at
  most window+2 times — previously token + bytes + two per comparison + two
  sizings + two bounds); native-agent-projection-entries.test.ts (a tail
  change over 1,000 fresh-parsed rows normalizes 2 parts instead of 2,000
  and an unchanged re-read normalizes none, output byte-identical to an
  uncached twin; detail eviction; rewind/replacement; in-place mutation;
  five logical contexts; concurrent reads with invalidation under a tiny
  cache match the uncached output); full backend suite passes.
Before/after measurements: see baseline/ (projection serialization visits).
Compatibility/migration result: tokens are opaque; a restarted backend issues
  new ones anyway.
Remaining limitations: a changed read no longer normalizes or serializes an
  unchanged row, but it still walks each provider row once to compare it with
  the kept copy (read-only, no allocation or hashing). Removing that walk
  needs a per-message revision from providers, which bridges do not expose.
  The joined sync-v1 history epoch is not wired to eviction; its rows are
  still content-verified, so this costs memory until LRU, not correctness.
```
