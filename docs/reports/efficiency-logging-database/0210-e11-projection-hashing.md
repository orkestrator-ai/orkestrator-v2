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
