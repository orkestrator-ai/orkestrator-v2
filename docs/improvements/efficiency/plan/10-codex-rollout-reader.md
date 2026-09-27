# 10 — Bound Codex rollout parsing, retention, and repeated reads

Status: Complete. Prerequisite: 01; coordinate interfaces with 08. Finding: E08.

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

## Execution record

```text
Status: Implemented, validation pending
Implementation commit / PR: branch implement-efficiency-improvements-7f0993836777-r1
  (worktree agent-a85be368877d3b2b6), commit "perf(codex-bridge): bound rollout
  parsing, retention and repeated reads"
Protocol or storage decisions: none on the wire; bridge-internal only (below)
Tests and isolated profiles: focused bun suites (below); no Electron/Docker profile run
Before/after measurements: below (local Linux dev box, 12 cores, 30 GiB, Bun 1.4.2)
Compatibility/migration result: no persisted format; rollouts stay read-only;
  hydration results gain an additive `transcriptStatus`
Remaining limitations: below
```

### What was implemented

- **Query shapes (step 1).** `bridges/codex-bridge/src/transcript-queries.ts`
  documents every consumer and its shape. Catalogue listing keeps the uncached
  64 KiB `readTranscriptHead` (a test asserts it performs no scan, index or cache
  fill). The live sub-agent parent path asks `readTurnRecords(path, turnStart)` —
  exactly the old `records.filter(ts >= turnStart)` plus the first `session_meta`
  for `parentAgentPath`. Child rollouts (live and persisted cards) ask
  `readChildSummary(path)`: the old `parseChildTranscript` became an incremental,
  base-independent fold (`foldChildTranscriptRecord` / `ChildTranscriptSummary`)
  with the spawn call's nickname/role/prompt layered on afterwards, so the
  whole-history semantics are unchanged. Thread hydration
  (`hydrateMessagesFromPersistedSession`) is a complete chronological replay over
  `acquireTranscriptSnapshot` + `forEachTranscriptBatch`. It now streams once
  (plus one pre-pass only when structured-output turns are present), keeps only the
  parent's collaboration records (`createCollaborationRecordFilter`) for sub-agent
  derivation, and swaps each `spawn_agent` tool part for its child card after the
  pass. The dead `readCachedTranscript` import in `index.ts` and the function
  itself are gone; no consumer receives "the whole rollout as an array".
- **Bounded reader (step 3).** `rollout-reader.ts` reads fixed chunks (256 KiB)
  from an open descriptor and splits on the newline *byte*. UTF-8 never encodes
  0x0A inside a multi-byte sequence, so a code point split across chunks or appends
  is carried as bytes and decoded once per complete line. Offsets are file bytes.
  Only the incomplete trailing line is carried, capped at `MAX_ROLLOUT_RECORD_BYTES`
  = 16 MiB (4x the largest line in 100 local rollouts, 4.2 MiB). An incomplete
  trailing line is not retained between reads: the cursor points at its start and
  it is re-read (at most 16 MiB) when the file grows, preserving the old "not
  parsed until completed by a later append" semantics. CRLF and blank lines behave
  as before (lines are trimmed). The scanner yields to the event loop between
  chunks, and full replays also yield every 2,048 records.
- **Overlong/corrupt policy (step 4).** A line above the cap is discarded as it
  streams (never allocated whole), including across appends. A line that is not
  JSON is no longer silently dropped. Both become positioned marker records
  (`orkestrator/unreadable-record`: reason, byte offset, length) that every other
  consumer ignores. Snapshot/result status is `complete` | `degraded` |
  `unavailable`. Hydration renders a warning `status` part at the marker's
  chronological position ("A rollout record could not be restored (…; rollout bytes
  A–B)"), coalescing consecutive markers, and returns `transcriptStatus`. A
  missing or unreadable rollout returns `transcriptStatus: "unavailable"` (plus a
  thread-id-only warning log) instead of an authoritative empty result. A degraded
  or unavailable child rollout appends `INCOMPLETE_CHILD_TRANSCRIPT_NOTICE` to its
  card.
- **Blocks, sparse index, admission (steps 5–7).** Records are retained as
  immutable blocks of ~256 KiB source (`RECORD_BLOCK_SOURCE_BYTES`). Every block
  keeps an index entry (byte range, record ordinals, newest timestamp). Its parsed
  records are resident only within budget and are otherwise re-read from their
  exact byte range. Appends add a block, or merge into a small resident tail block
  (a bounded copy); `[...records, ...parsed]` is gone. `readTurnRecords` skips every
  block whose newest timestamp predates the turn, so a live render costs the turn,
  not the file. Budgets now measure **estimated retained heap**: soft 64 MiB /
  hard 256 MiB / 30 s active grace (unchanged constants, stricter meaning) plus a
  64-entry count bound. Estimate = resident source bytes x 3
  (`RETAINED_HEAP_BYTES_PER_SOURCE_BYTE`; measured 1.91–1.96 heap bytes per source
  byte on 12 local 8–35 MiB rollouts under Bun) + 160 B per index block + 1 KiB per
  entry + the first `session_meta` + fold-memo estimates. Source bytes are reported
  separately (`sourceBytes`, `residentSourceBytes`). LRU shedding drops the oldest
  blocks first, then memos. Idle entries are shed to the soft budget and may lose
  their index. Entries inside the grace window are protected up to the hard ceiling
  and keep their index, so an entry larger than the ceiling is never wholesale
  self-evicted: its tail stays resident and its folds stay memoised. A cold scan
  caps its own resident blocks, and all in-flight scans together, at the hard
  ceiling. Documented peak: <= 2 x hard budget of estimated resident records, plus
  per concurrent scan one 256 KiB chunk and one record <= 16 MiB (~2x while joined
  and decoded).
- **Folds.** `foldTranscript` memoises a reducer per file generation and extends it
  only with appended records; the child summary is the production reducer. Memos
  are accounted and shed like blocks; a reducer that throws drops its memo.
- **Sharing and ordering (step 2).** A per-path promise chain serialises refresh
  and fold installation. Concurrent cold readers queue behind the first scan and
  then find the entry current (one source read; tested), and an older append can
  never install after a newer one. The chain never rejects; one consumer's failure
  (tested with a throwing reducer) neither aborts the shared scan nor poisons later
  readers. These callers have no cancellation API today, so none was added. Keying
  is by path; every snapshot carries `fileId` (dev:ino of the descriptor it was
  read from) and a rotating `generation`.
- **Identity and races (step 8).** An unchanged file is detected with one path
  `stat` (dev, ino, size, mtime, ctime) and reads no bytes. Otherwise the
  descriptor is opened first, `fstat`ed, and only that descriptor is read, so bytes
  are labelled with the identity they came from. Replacement (inode change),
  shrink, same-size rewrite (mtime/ctime), and growth over rewritten bytes (the 64
  bytes before the consumed boundary are compared on every append) rotate the
  generation and rescan. A short read (truncated mid-scan) installs nothing and
  retries once. Re-reads of shed blocks verify inode, exact end offset and record
  count; a mismatch invalidates the entry and the query retries once from a fresh
  snapshot. A file unlinked mid-read finishes from the open descriptor under its
  old identity; the next request reports `unavailable`.
- **Diagnostics.** `getTranscriptCacheStats()` (surfaced through
  `getStorageStats().transcriptCache`) now reports entries, estimated bytes,
  source/resident source bytes, index/resident blocks, memo bytes and counters
  (cold scans, append scans, block re-reads, source bytes read). Counts only.

### Tests

New: `rollout-reader.test.ts` (UTF-8 split across chunks, CRLF, byte offsets,
incomplete final line, overlong within and across chunks and scans, short read);
`transcript-cache.test.ts`, rewritten (JSONL and UTF-8 append boundaries, CRLF,
corrupt and overlong markers, same-size rewrite, inode swap, shrink, growth over
rewritten bytes, removal and truncation mid-read, removal after indexing, shared
concurrent cold reads, failing-consumer isolation, a rollout ~8x the hard budget
requested 20x with no further source reads plus a memoised fold, a parent/child
working set above the hard budget with LRU-fair re-admission, idle and count
bounds, equivalence with a whole-file parse after appends and evictions);
`transcript-queries.test.ts` (sub-agent cards identical to the whole-file reference
under default and tiny budgets, before and after a child follow-up append; no
re-reads across 10 renders; the turn query re-reads <= 2 blocks with nothing
resident; degraded and unavailable child cards); and
`history/rollout-bounded-hydration.test.ts` (hydration identical to the unbounded
read under an 8 KiB hard budget, including a sub-agent card and a
structured-output turn; overlong record shown in place; missing rollout is
`unavailable`). Updated: `history/rollout.test.ts` (a malformed line is now a
positioned warning with `degraded`; catalogue stats), `history/subagent-index.test.ts`
(child-summary dependency), `index-coverage.test.ts` (additive
`transcriptStatus`). Test budgets are injected through
`setTranscriptCacheLimitsForTesting`; fixtures are generated in temp directories.

Commands run (all passing at the end):

- `mise run test:logged -- --name br-a85-codex -- mise exec -- bun test ./bridges/codex-bridge/src --parallel=2 --only-failures`
  — the whole codex-bridge suite, including the scrubbed notification replay
  regressions. The first run found one failure (`index-coverage.test.ts`, the new
  additive field); it was fixed and the suite re-run green.
- `mise exec -- bun run --cwd bridges/codex-bridge typecheck`
- `mise run format`, `mise run format:check`, `mise run lint` (repository root)

Unrun: full `mise run test`; isolated browser/Electron/Docker QA.

### Measurements

Local harness (not committed). A real 34.4 MiB rollout concatenated 10x (344 MiB,
51,980 records), default limits:

| Path | Per request | Peak RSS delta | Retained heap after GC |
| --- | --- | --- | --- |
| Old: entry above the hard budget self-evicts; full `readFile`+split+parse per request | 1,616–1,897 ms, every request | +3,627 MiB | 656 MiB |
| New: first turn-range query (cold scan) | 1,152 ms | +687 MiB | 122 MiB |
| New: repeated turn-range query | ~0 ms, no source read | — | — |
| New: first / repeated whole-history fold | 1,130 ms / 1.3 ms | — | — |
| New: full replay (hydration pass) | 770 ms, max event-loop gap 7 ms | — | — |

Cache state afterwards: 255 MiB estimated (hard budget 256 MiB), 52.5 of 344 MiB
source resident, 881 index blocks. For one 34.4 MiB rollout within budget the
first read costs about the same (216 ms vs 193–218 ms) with a lower peak
(+135 MiB vs +430 MiB), and a repeated child fold drops from a full re-parse to
~1 ms. The sparse index was implemented, so step 7's "justify skipping the index"
does not apply.

### Remaining limitations

- A single *turn* whose records exceed the hard budget is re-read on each render.
  The cost is bounded by the turn's size, not the file's: a turn-range query cannot
  be smaller than the turn it asks for.
- A child fold memo is as large as the rendered card. If memos alone exceed the
  hard budget they are shed and recomputed; the card was already that large.
- Same-size rewrites within filesystem timestamp granularity, and rewrites that
  preserve the 64 bytes before the consumed boundary, are undetectable without
  hashing the file.
- The hydration callers in `app-server-runtime-sessions.ts` and
  `app-server-runtime-lifecycle.ts` (outside this step's ownership) do not yet
  surface `transcriptStatus: "unavailable"`; they keep their previous
  empty-transcript handling. The live render path has no channel for an
  unavailable *parent* rollout and, as before, renders no transcript-derived cards.
- In-flight sharing is keyed by path, not dev+ino, so two hard-linked paths to one
  rollout are scanned separately.
- AGENTS.md's Codex bridge section was not edited (outside this step's ownership).
  Its invariants still hold: metadata scans never read whole rollouts.
