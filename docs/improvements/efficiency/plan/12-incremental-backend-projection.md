# 12 — Reuse backend normalization, hashes, sizes, and detail references

Status: Not started. Prerequisites: 05, 09. Finding: E05.

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
