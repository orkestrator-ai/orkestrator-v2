# 10 — Bound Codex rollout parsing, retention, and repeated reads

Status: Not started. Prerequisite: 01; coordinate interfaces with 08. Finding: E08.

## Outcome

A rollout larger than the cache budget does not require an unbounded cold
allocation or repeatedly evict itself and reparse on every render. Metadata
listing remains a bounded head read. Full recovery and subagent rendering retain
their existing semantic results or report an explicit incomplete/unavailable
result where a documented bound prevents them.

## Owners

- [Transcript cache](../../../../bridges/codex-bridge/src/transcript-cache.ts).
- [Rollout history](../../../../bridges/codex-bridge/src/history/rollout.ts).
- [Subagent records](../../../../bridges/codex-bridge/src/subagent-transcript.ts)
  and [part derivation](../../../../bridges/codex-bridge/src/subagent-transcript-parts.ts).
- [Render-turn consumers](../../../../bridges/codex-bridge/src/messages/render-turn.ts).
- Existing cache, rollout, subagent, and notification replay test owners.

## Implementation

1. Inventory consumers of `readCachedTranscript`: which need session metadata,
   a turn range, parent/child relationships, all usage records, or a complete
   chronological replay? Give each an explicit query shape. Do not replace a
   full-history consumer with an arbitrary tail and silently change its result.
2. Add per-file in-flight sharing keyed by stable source identity and observed
   generation. Serialize append installation for a file so concurrent readers
   cannot install older records after newer records. One cancelled caller must
   not abort work still needed by other readers.
3. Replace `readFile` plus whole-string splitting with a bounded chunk reader and
   incremental UTF-8 decoder. Carry only an incomplete record up to an explicit
   line-size cap. Handle CRLF, partial Unicode, a final line without newline,
   and a record completed by a later append. Offset accounting uses file bytes.
4. Define an explicit overlong-record policy: preserve a visible incomplete or
   unavailable result and source position; do not allocate until the whole line
   arrives or return an authoritative empty transcript. Distinguish parse errors
   from a session that actually has no messages.
5. Build a derived sparse index of turn/message boundaries and required context
   anchors. Bound index entries/bytes and parsing concurrency. An index may be
   rebuilt from the source and is not a second authority. Initial indexing can
   read many source bytes, but working memory stays bounded and the event loop
   yields between bounded batches.
6. Retain immutable record blocks rather than copying a growing flat array on
   every append. Adapt range/reduction consumers to block iterators. For
   semantics requiring a whole chronological pass, use a bounded reducer with
   explicit retained-state limits instead of materializing every raw record.
7. Admit cached blocks under both count and estimated-retained-byte budgets.
   Track source bytes separately. Oversized files remain usable through indexed
   windows/streaming reduction rather than inserting one self-evicting entry.
   Keep the active-working-set grace rule where it prevents thrash.
8. Detect inode replacement, shrink, same-size rewrite, and append races around
   open/stat/read. Rotate the derived generation and invalidate offsets/cursors
   on replacement. Do not label bytes read from one file identity with another
   identity sampled after the read.
9. Preserve `readTranscriptHead` for catalogue scans. No full-file index build
   may be triggered merely by listing sessions. Indexing is scheduled for a
   specifically requested transcript or active subagent consumer.

## Tests and measurements

- File above hard cache budget, repeatedly requested: bounded peak allocations
  and no repeated complete parse for an unchanged range after indexing.
- Parent/child working set above soft and hard caps; fair cache admission.
- Concurrent cold reads share source work; cancellation does not poison peers.
- Append at UTF-8 and JSONL boundaries; incomplete/oversized/corrupt records.
- Inode swap, truncate, same-size rewrite, read interrupted by file removal.
- Compare complete normalized outputs and usage/lifecycle derivations with
  existing small fixtures; run scrubbed notification replay regressions.

## Delivery and fallback

Land in-flight sharing and bounded decoding first, then block/index consumers.
Do not route unsupported large-file cases back to the old unbounded full read.
Use an explicit degraded display with recoverable source identity until the
consumer supports bounded reduction. No changes to provider-owned rollout files
or generated app-server protocol are required.
