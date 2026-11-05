# E11: Projection hashing

This file combines 8 reports into one batch to build together. Serialising and hashing in the projection path. All Low.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0210](#0210-the-legacy-commit-re-serialises-the-whole-projection-to-fingerprint-it) | Low | TX-3: The legacy commit re-serialises the whole projection to fingerprint it |
| [0220](#0220-memoise-row-fingerprints-and-hash-them-for-the-view-token) | Low | TX-9, TX-13: Memoise row fingerprints and hash them for the view token |
| [0320](#0320-head-row-recovery-re-reads-the-raw-transcript-on-each-streaming-revision) | Low | TX-7: Head-row recovery re-reads the raw transcript on each streaming revision |
| [0330](#0330-patch-building-re-serialises-and-hashes-whole-rows-in-a-javascript-loop) | Low | TX-11: Patch building re-serialises and hashes whole rows in a JavaScript loop |
| [0340](#0340-already-encoded-rows-are-stringified-again-on-the-way-out) | Low | TX-12: Already-encoded rows are stringified again on the way out |
| [0345](#0345-restart-preview-checkpoints-are-serialised-three-times-and-cloned) | Low | TX-14: Restart-preview checkpoints are serialised three times and cloned |
| [0350](#0350-inline-tool-bodies-are-re-hashed-whenever-their-row-misses-the-cache) | Low | TX-16: Inline tool bodies are re-hashed whenever their row misses the cache |
| [0380](#0380-small-linear-scans-in-the-transcript-projection) | Low | TX-17: Small linear scans in the transcript projection |

## 0210: The legacy commit re-serialises the whole projection to fingerprint it

### Task analysis

#### Tasks

1. **Fingerprint through the message memo**: replace the `JSON.stringify` with `digestWithMessages`. Status: open.

#### 1. Fingerprint through the message memo

**Problem.** Each legacy commit serialises the whole candidate projection, up to 4,096 rows, bypassing the per-object encodings, only to compare it with the previous one.

**Context.** The memo exists for this. `digestWithMessages` is already used for the sync token.

**Investigation.** The fingerprint is `JSON.stringify({ ...candidate, revision: 0, cursor: candidate.cursor })` (`apps/backend/src/core/native-agent-transcript-projection.ts:5465`), compared at `:5470` and stored in the cache entry at `:5503`, so the cache also keeps that whole string alive. `digestWithMessages` is at `native-agent-projection-encoding.ts:141-148`, and its sync use is at `native-agent-transcript-projection.ts:1491`. The fingerprint is compared only for equality, so a digest is a drop-in replacement.

**Decisions.** None: the report names the fix, and the fingerprint is used only for this comparison.

### Constraints and rationale

- `encodedValue` relies on projected values being immutable once `projectionMessages` returns them. The candidate's `messages` must come from there.

### Needs verification

- The saving was reasoned, not measured.

## 0220: Memoise row fingerprints and hash them for the view token

### Task analysis

#### Tasks

1. **Memoise `valueFingerprint` (TX-9)**: a `WeakMap` beside `encodings`. Status: open.
2. **Hash row fingerprints in the view token (TX-13)**: stop feeding every row's JSON through SHA-256 per changed read. Status: open (depends on 1).

These share a file because TX-13's fix is built on TX-9's memo.

#### 1. Memoise `valueFingerprint` (TX-9)

**Problem.** The comment at the call site says "Memoized per projected message", but only the JSON is memoised. The SHA-256 is recomputed for every message on every history refresh.

**Context.** The cost is bounded by the history window, and it runs per refresh, not per poll.

**Investigation.** `valueFingerprint` (`apps/backend/src/core/native-agent-projection-encoding.ts:64-66`) hashes `encodedValue(value).json` on each call. The call is `messages.map(valueFingerprint)` (`native-agent-transcript-projection.ts:1383`), under the comment at `:1381`.

**Decisions.** None: the report names the fix. A `WeakMap` entry lives only as long as its row, as `encodings` does, so it adds no separate bound.

#### 2. Hash row fingerprints in the view token (TX-13)

**Problem.** The view token hashes the JSON of every row in the window whenever a read commits a changed view, though usually one row moved.

**Context.** Rows keep their object identity across reads through `reuseUnchangedMessages`, so an unchanged row would hit the memo.

**Investigation.** `commitProgressiveTranscript` builds the token with `updateHashWithValues` over `value.messages` and `value.revisedMessages` (`native-agent-transcript-projection.ts:2611-2631`). The helper (`native-agent-projection-encoding.ts:48-56`) avoids re-serialising but still hashes each row's bytes.

**Decisions.**

- **What goes into the token?**
  - **Each row's memoised fingerprint (recommended).**
    - Pros: the report's fix; a read that moved one row hashes one row's bytes plus a short string per row.
    - Cons: tokens change once at upgrade, costing each client one snapshot; `valueFingerprint` keeps 96 bits, enough for an equality check but less than the full digest.
  - **Leave the token as it is and do task 1 only.**
    - Pros: no token change.
    - Cons: the window's bytes are still hashed per changed read.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): a token must still move on any change a client can see, including `revisedMessages` (see the comment at `native-agent-transcript-projection.ts:2628-2630`).

### Needs verification

- The saving was reasoned, not measured.

## 0320: Head-row recovery re-reads the raw transcript on each streaming revision

### Task analysis

#### Tasks

1. **Stop recovering on every revision**: wait for the source token to settle, or read only the head row. Status: open.

#### 1. Stop recovering on every revision

**Problem.** While a part-trimmed head row is in the window, each new source token cancels the pending recovery and starts another, each one reading raw messages from the provider and discarding what it read if the token has moved on.

**Context.** The trigger is narrower than the report implies. A summary window with no omitted parts returns early, so this needs a part-trimmed head (one row larger than the whole window) or a cached summary.

**Investigation.** `scheduleIncompleteProgressiveHydration` (`apps/backend/src/core/native-agent-transcript-projection.ts:1888`) first fences stale work with `invalidateStaleProgressiveHydration` (`:1901`, `:2009`). The early return is at `:1924-1929`. The first attempt has no delay (`scheduleAttempt(0)`, `:2006`). The read is `provider.messages(sessionId, { limit })` (`:2026`), bounded in rows but not to the byte window. A result is dropped when the source token has moved (`:1963`). Retries back off (`:1972`), but only for a read that recovered nothing.

**Decisions.**

- **How to reduce the reads?**
  - **Debounce: start the read only once the source token has stayed the same for a short interval (recommended).**
    - Pros: the report's first fix; no new provider call; the existing `holdPreview` keeps the view stable meanwhile.
    - Cons: the head stays trimmed until the turn pauses, so a long streaming turn may show it trimmed for longer. The interval needs a choice.
  - **Read just the head row through a page or detail read.**
    - Pros: the report's preferred read; bounded bytes; works during streaming.
    - Cons: needs the provider's page capability, so this path remains for providers without it; a larger change.

### Constraints and rationale

- A cached summary must still recover, because this read is the only thing that attaches a detached Codex thread (see the comment at `native-agent-transcript-projection.ts:1910-1914`). A debounce must not starve that case.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): unmount is not cancel.

### Needs verification

- How often sessions have a part-trimmed head during streaming. Reasoned, not measured.

## 0330: Patch building re-serialises and hashes whole rows in a JavaScript loop

### Task analysis

#### Tasks

1. **Reuse encodings in patch building**: compare content-less parts field by field and avoid re-serialising the part list for the digest. Status: open.

#### 1. Reuse encodings in patch building

**Problem.** For each patched message, the builder serialises its parts and walks every character in JavaScript to compute a digest. It also serialises patches to compare sizes.

**Context.** The same digest is checked on the client when it applies a patch, so both sides must compute the same value. This limits the report's "use a native hash": the renderer has no synchronous native hash.

**Investigation.** In `packages/protocol/src/native-agent-transcript-patch.ts`, `partsDigest` (`:71`) does `JSON.stringify(parts)` and a per-character loop. It is called to build (`:251`) and to apply (`:270`). The size comparison is `JSON.stringify(patch)` at `:151`. An injectable `encode` exists (`:67-69`), and the backend passes the memoised one (`apps/backend/src/core/native-agent-transcript-patches.ts:16`), but `partsDigest` does not use it.

**Decisions.**

- **How to make the digest cheaper?**
  - **Keep the algorithm, and feed it from the memoised encodings on the backend (recommended).**
    - Pros: the digest's value is unchanged, so no protocol change; removes the repeat serialisation, the larger part of the cost.
    - Cons: the per-character loop remains; encodings must join to byte-identical text as `JSON.stringify(parts)`.
  - **Change to a native hash.**
    - Pros: the report's suggestion; much faster on the backend.
    - Cons: the browser would need `crypto.subtle`, which is asynchronous, or a JavaScript copy of the hash, and a changed digest needs a new patch version and a version-compatibility entry.

### Constraints and rationale

- Patch semantics are negotiated by `NATIVE_AGENT_TRANSCRIPT_PATCH_VERSION`; a client must still reject a patch that does not line up with its base.
- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) apply as usual.

### Needs verification

- The share of a transcript read this takes. Reasoned, not measured.

## 0340: Already-encoded rows are stringified again on the way out

### Task analysis

#### Tasks

1. **Splice memoised rows into the response**: an update serialiser that reuses per-message JSON. Status: open.
2. **Count `revisedMessages` through the memo**: stop serialising them to measure a view. Status: open.

#### 1. Splice memoised rows into the response

**Problem.** A transcript answer's rows were each encoded and memoised to size and hash them, but the gateway serialises the whole result again to send it.

**Context.** `/invoke` is generic: it knows nothing about the shape of what a command returns.

**Investigation.** `apps/backend/src/gateway-handlers.ts:133` runs `JSON.stringify({ result })` for every command, then sends the string through `serializedJsonResponse` (`:141`). The memo is `encodedValue` in `apps/backend/src/core/native-agent-projection-encoding.ts:26`.

**Decisions.**

- **How does the handler reach the memo?**
  - **Let a command return a pre-serialised result the handler splices in (recommended).**
    - Pros: other commands are untouched; the update serialiser lives next to the memo.
    - Cons: a new marker type crossing the backend boundary, and every non-gateway caller of those commands must still get a plain object.
  - **Leave it.**
    - Pros: a plain and safe path. A window is at most 512 KiB, so the gain per poll is bounded.
    - Cons: the cost stays per changed read.

#### 2. Count `revisedMessages` through the memo

**Problem.** `encodedBytesWithMessages` memoises `messages`, but `revisedMessages` sits in `rest`, which is serialised on each measure.

**Context.** Revised rows are full messages outside the live tail, so they can be large.

**Investigation.** `native-agent-projection-encoding.ts:131-138` does `JSON.stringify(rest)`. It runs at `native-agent-transcript-projection.ts:2637` and on each delta (`:3029`).

**Decisions.** None: count the field with `encodedArrayBytes`, as `messages` is. It is the report's fix and does not alter any output.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): the byte budgets rely on this measure, so it must not undercount.
- The spliced JSON must be byte-identical in meaning to `JSON.stringify`, including `undefined` fields dropped.

## 0345: Restart-preview checkpoints are serialised three times and cloned

### Task analysis

#### Tasks

1. **Serialise a checkpoint once and stop cloning it**: reuse the encoded payload and hand out frozen tails. Status: open.

#### 1. Serialise a checkpoint once and stop cloning it

**Problem.** Writing one restart-preview checkpoint serialises the same messages for the checksum, for the size check and for the row, then clones the tail for the decoded cache. Each read hit clones it again.

**Context.** Checkpoints are scheduled when a transcript view changes (`scheduleDisplayTailPersist`, `apps/backend/src/core/native-agent-transcript-projection.ts:2658`), so the cost follows live traffic, within the tail's byte limit.

**Investigation.** In `apps/backend/src/core/native-agent-display-tails.ts`, the checksum serialises an array of fields (`:97-112`, `:116-132`), and `createNativeAgentDisplayTail` measures with another `JSON.stringify` at `:160`. In `native-agent-display-tail-store.ts`, `put` serialises again (`:231`) and clones for the cache (`:258`), and `get` clones on a hit (`:205`) and after a decode (`:221`), under the comment "callers own what they receive".

The checksum covers a positional array rather than the record's JSON, and old rows must keep verifying. So its text cannot simply be the row's payload; the message text can be shared, but not the whole string.

**Decisions.**

- **Serialise how many times?**
  - **Measure and store from one payload, and pass it from `createNativeAgentDisplayTail` to `put`; the checksum stays separate (recommended).**
    - Pros: one pass fewer with no format change.
    - Cons: the report's "once" is not fully reached, unless the checksum splices memoised message JSON.
  - **Also splice memoised messages into the checksum input.**
    - Pros: reaches the report's "once".
    - Cons: the spliced text must be byte-identical to today's, or every stored tail fails its check.
- **Freeze or clone?**
  - **Deep-freeze cached tails and hand those out, after checking each caller (recommended).**
    - Pros: the report's fix; the same technique as `FrozenStoreSnapshot`.
    - Cons: a caller that writes to its result throws, so each must be checked first.
  - **Keep cloning.**
    - Pros: no caller risk.
    - Cons: a clone per read and write remains.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) apply as usual. The stored format and checksum versions must not change without a compatibility entry.

### Needs verification

- Which callers mutate what `get` returns; they were not all traced.

## 0350: Inline tool bodies are re-hashed whenever their row misses the cache

### Task analysis

#### Tasks

1. **Memoise per part**: avoid serialising and hashing an unchanged tool body when its row is re-projected. Status: open.

#### 1. Memoise per part

**Problem.** A streaming row misses the row cache on each read. Every tool part on it is then re-projected, and each inline body is serialised and hashed to mint its reference, though only the newest part changed.

**Context.** The row cache exists to avoid this for unchanged rows (`apps/backend/src/core/native-agent-projection-entries.ts`). Summary-backed rows take the locator branch (`native-agent-transcript-projection.ts:990-992`), so this affects raw reads and inline-body providers. Fixing TX-2 shrinks it further.

**Investigation.** `cacheToolDetails` (`native-agent-transcript-projection.ts:807-808`) does `JSON.stringify(details)` and SHA-256 per call. `projectedMessage` (`:1131`) tries the row cache and, on a miss, maps every part through `projectionPart` (`:1142-1151`). Bridges parse fresh objects per read, so object identity cannot key a memo; the row cache uses a structural compare against a private copy for this reason.

**Decisions.**

- **What keys the memo?**
  - **A structural compare against a private copy per part, as the row cache does (recommended).**
    - Pros: the report's "per-part memo", exact, and uses a tested technique.
    - Cons: memory for one more copy per part, which needs its own bound.
  - **Wait for TX-2, and re-measure.**
    - Pros: possibly no new cache.
    - Cons: inline-body providers such as OpenCode are not helped by TX-2.

### Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): the memo needs byte and count bounds.
- A memo hit must still register the reference (see `restoreDetailRegistrations`, `:890`), or an evicted detail stays lost.

### Needs verification

- The real cost on a streaming row with many tool parts. Reasoned, not measured.

## 0380: Small linear scans in the transcript projection

### Task analysis

#### Tasks

1. **Decide whether these scans matter**: profile a changed read, then fix or close. Status: open.

#### 1. Decide whether these scans matter

**Problem.** A few one-off scans run per projection.

**Context.** The report names the sites but no fix. Each is one pass over a bounded window, and is small beside the serialising and hashing in the same read.

**Investigation.** In `apps/backend/src/core/native-agent-transcript-projection.ts`: `firstUserMessageIndex` (`:1203`), which usually stops early, and the head-row lookups in `fillIncompleteProgressiveSnapshot` (`:2035`) and the projection (`:2078`). The report's other lines have moved with these.

**Decisions.**

- **Change them?**
  - **Leave them unless a profile of a changed read shows them (recommended).**
    - Pros: no code for a cost nobody has seen; a map per read may cost more than the scan it replaces.
    - Cons: the item stays open until someone profiles a read.
  - **Replace the two head lookups with the first row's id compared directly, or a map.**
    - Pros: removes the scans.
    - Cons: more code in a delicate function.

### Needs verification

- Their share of a read. Nothing was measured.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-3, TX-9, TX-13, TX-7, TX-11, TX-12, TX-14, TX-16, TX-17)
- [1202 task 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [E9's closing check](0000-index.md#closing-check-of-e9-transcript-reads) (part 0150, built 2026-11-05): fewer legacy refreshes also lower this cost

## Outcome

Built on 2026-11-05 on branch `projection-hashing-fa7e6cc85e60-r1`, based on `main` at `39c26627f`, and checked item by item against this file before it was deleted. Every finding was re-checked against the base first and still held, at moved lines: TX-3 `native-agent-transcript-projection.ts:5696`, TX-9 `native-agent-projection-encoding.ts:64`, TX-13 `native-agent-transcript-projection.ts:2683`, TX-7 `:1960` with `scheduleAttempt(0)` at `:2078`, TX-11 `native-agent-transcript-patch.ts:71` and `:151`, TX-12 `gateway-handlers.ts:150` and `native-agent-projection-encoding.ts:136`, TX-14 `native-agent-display-tails.ts:160` with `native-agent-display-tail-store.ts:205`, `:221`, `:231` and `:258`, TX-16 `native-agent-transcript-projection.ts:829`, TX-17 `:1229`, `:2107` and `:2150`. Code is in commit `c9595377b`. Test files below are under `apps/backend/src/core/` unless they name another directory. No to-do was needed for code; what needs a profile or live evidence is to-do [6260](../../todo/transcripts-and-observation/6260-projection-hashing-measurements.md).

| Part | Item | Outcome | Code and test, evidence, or to-do |
| --- | --- | --- | --- |
| 0210 | Task 1: fingerprint through the message memo | Done | `commitProjection` compares `digestWithMessages("legacy-commit", { ...candidate, revision: 0 })` (`native-agent-transcript-projection.ts`); the cache entry keeps 43 characters, not the window's JSON. Test: "legacy commit fingerprint" in `native-agent-service-projection-hashing.test.ts`, which also asserts nothing serialises the whole candidate. |
| 0210 | Constraint: the candidate's `messages` come from `projectionMessages` | Holds | Every caller passes rows from `projectionMessages` or from a committed projection (the title, withdrawn-interaction and unreachable recommits). |
| 0210 | Needs verification: the saving | Moved to a to-do | 6260 task 2. |
| 0220 | Task 1: memoise `valueFingerprint` (TX-9) | Done | A `fingerprints` `WeakMap` beside `encodings` (`native-agent-projection-encoding.ts`). Test: "a row's fingerprint is hashed once and keeps its value" in `native-agent-projection-encoding.test.ts`, which counts the characters fed to SHA-256. |
| 0220 | Task 2: hash row fingerprints in the view token (TX-13) | Done, recommended option | `updateHashWithFingerprints` over `messages` and `revisedMessages` in `commitProgressiveTranscript`. Tests: "a token over fingerprints hashes a changed row once, not the window" (encoding test) and "moves when only a revised row changes, and holds when nothing does" (`native-agent-service-projection-hashing.test.ts`). |
| 0220 | Decision's cost: tokens change once at upgrade | Accepted; no version-compatibility entry | A client holding a token from before the upgrade gets one snapshot (`unknown-token`), as after any backend restart. Nothing keeps an older behaviour for an older peer, so there is no compatibility path to register, count or retire. |
| 0220 | Constraint: a token moves on any visible change, `revisedMessages` included | Holds | The same view-token test. |
| 0220 | Needs verification: the saving | Moved to a to-do | 6260 task 2. |
| 0320 | Task 1: stop recovering on every revision | Done | A recovery read starts at most once per `PROGRESSIVE_HYDRATION_SETTLE_MS` (1 s) per view (`scheduleIncompleteProgressiveHydration`, `progressiveHydrationReadStarts`, bounded at 1,024 views and cleared on invalidate and shutdown). Test: "starts at most one provider read per interval while the head streams" (`native-agent-service-projection-hashing.test.ts`). |
| 0320 | Decision: debounce, or read only the head row | Debounce, with a fixed deadline rather than a pure trailing one | The first read of a quiet view starts at once; a newer token during the wait replaces the pending one without moving its deadline. A pure trailing debounce was not taken: with `holdPreview` holding the view during the wait it would freeze a streaming turn until it paused, and a token that never settled would starve the read. One second because a streaming bridge publishes several revisions a second and the view should stay at most about a second behind. The head-row read was not taken (the report's second option; it needs page capability and leaves this path for other providers). |
| 0320 | Constraint: a cached summary still recovers | Holds | It starts at once on a quiet view, and the fixed deadline means a moving token cannot starve it. Test: "a cached summary still recovers while its token keeps moving". |
| 0320 | Constraint: unmount is not cancel | Holds | The timer lives in the backend projection, not in a mounted component; unchanged. |
| 0320 | Needs verification: how often a part-trimmed head streams | Moved to a to-do | 6260 task 3, with whether the interval suits a real turn. |
| 0330 | Task 1: reuse encodings in patch building | Done | `nativeAgentPartsDigest` feeds `[`, each part's encoding and `]` to the same hash (`packages/protocol/src/native-agent-transcript-patch.ts`); content-less parts compare field by field (`sameWithoutContent`); a patch's size comes from `encode`; the backend sizes patches through the memo (`native-agent-transcript-patches.ts`). |
| 0330 | Decision: keep the digest algorithm | Done, recommended option; patch version unchanged (2) | Tests in `packages/protocol/src/native-agent-transcript-patch.test.ts`: "is byte-identical to the shipped digest, with or without a memoizing encode" (a copy of the shipped function over random part lists), "a memoizing builder serializes each part once and never the whole list", "an append is recognised exactly when the rest of the part encodes the same", and the random suite builds the same patch with a memoising encode. |
| 0330 | Constraint: a client still rejects a misaligned patch | Holds | Unchanged on the client; the existing "a patch against a different base is refused" test passes. |
| 0330 | Needs verification: share of a read | Moved to a to-do | 6260 task 2. |
| 0340 | Task 1: splice memoised rows into the response | Done, recommended option, as a mark rather than a marker type | `markSpliceableResult` on the four transcript commands (`commands-registry-native.ts`); the gateway writes a marked result with `spliceEncodedJson` (`gateway-handlers.ts`), copying each memoised array element. The mark is a `WeakSet`, so every other caller gets the same plain object and no new type crosses the boundary. Tests: "splices already-encoded rows into a marked result and serializes others whole" (`apps/backend/tests/gateway-handlers.test.ts`) and the "spliced responses" tests in `native-agent-projection-encoding.test.ts`. |
| 0340 | Task 2: count `revisedMessages` through the memo | Done | `encodedBytesWithMessages` (`native-agent-projection-encoding.ts`). Test: "revised rows are measured through the memo and never undercounted". |
| 0340 | Constraint: the measure never undercounts | Holds | The same test: at least the `JSON.stringify` bytes, at most 2 over. |
| 0340 | Constraint: spliced JSON identical to `JSON.stringify`, `undefined` fields dropped | Holds | "match JSON.stringify for every shape a result can hold", and the gateway test compares the response body to `JSON.stringify({ result })`. |
| 0345 | Task 1: serialise a checkpoint once and stop cloning it | Done | `createNativeAgentDisplayTail` measures with the row's payload, deep-freezes the tail and registers the payload (`preparedDisplayTailPayload`, `native-agent-display-tails.ts`); `put` writes it, the storage check skips recomputing a prepared tail's checksum, and decoded tails are deep-frozen and shared (`native-agent-display-tail-store.ts`). Tests: "serializes a checkpoint once for size and row, with the checksum unchanged" (`native-agent-display-tails.test.ts`), "writes a prepared tail's own payload and freezes a copy of any other tail" and the updated round-trip test (`native-agent-display-tail-store.test.ts`). |
| 0345 | Decision: how many serialisations | One payload for size and row, checksum separate (recommended) | Two serialisations remain: the checksum's positional array and the row. Splicing message JSON into the checksum was not taken. |
| 0345 | Decision: freeze or clone | Freeze (recommended) | A tail passed to `put` that `createNativeAgentDisplayTail` did not build is cloned once and frozen, so a caller's own object is never frozen. |
| 0345 | Constraint: stored format and checksum versions unchanged | Holds | Same v2 record and checksum; the test computes the checksum independently. |
| 0345 | Needs verification: which callers mutate what `get` returns | Done, checked | Both production callers only read: the saved-transcript view (`boundedProjectedMessages`, which slices) and the persisted first answer in `getTranscriptUpdate`, whose rows then go through the read-only projection path. The store test that wrote to a result was changed to assert the result is frozen. |
| 0350 | Task 1: memoise per part | Done | `ToolDetailEncodingMemo` (`native-agent-tool-detail-memo.ts`): a structural compare against a private copy per session, message and part path, bounded at 4,096 entries, 32 MiB and 17 MiB per entry; used by `cacheToolDetails` and the args and thinking size checks; forgotten on invalidate. Tests: `native-agent-tool-detail-memo.test.ts`, and "an unchanged body on a re-projected row is not hashed again, and stays registered" and "the memo keeps to its count and byte bounds" in `native-agent-service-projection-hashing.test.ts`. |
| 0350 | Decision: what keys the memo | Structural compare (recommended) | Waiting for TX-2 was not taken: it does not help inline-body providers. |
| 0350 | Constraint: byte and count bounds | Holds | Same tests. |
| 0350 | Constraint: a hit still registers the reference | Holds | The service test evicts every detail, re-reads, and fetches each body. |
| 0350 | Needs verification: cost on a streaming row | Moved to a to-do | 6260 task 2. |
| 0380 | Task 1: decide whether the scans matter | Moved to a to-do | No profile was taken, so the scans were left as the report recommends. 6260 task 1. |
| 0380 | Needs verification: their share of a read | Moved to a to-do | 6260 task 1. |
