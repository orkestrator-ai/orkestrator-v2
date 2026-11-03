# Memoise row fingerprints and hash them for the view token

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Memoise `valueFingerprint` (TX-9)**: a `WeakMap` beside `encodings`. Status: open.
2. **Hash row fingerprints in the view token (TX-13)**: stop feeding every row's JSON through SHA-256 per changed read. Status: open (depends on 1).

These share a file because TX-13's fix is built on TX-9's memo.

### 1. Memoise `valueFingerprint` (TX-9)

**Problem.** The comment at the call site says "Memoized per projected message", but only the JSON is memoised. The SHA-256 is recomputed for every message on every history refresh.

**Context.** The cost is bounded by the history window, and it runs per refresh, not per poll.

**Investigation.** `valueFingerprint` (`apps/backend/src/core/native-agent-projection-encoding.ts:64-66`) hashes `encodedValue(value).json` on each call. The call is `messages.map(valueFingerprint)` (`native-agent-transcript-projection.ts:1383`), under the comment at `:1381`.

**Decisions.** None: the report names the fix. A `WeakMap` entry lives only as long as its row, as `encodings` does, so it adds no separate bound.

### 2. Hash row fingerprints in the view token (TX-13)

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

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): a token must still move on any change a client can see, including `revisedMessages` (see the comment at `native-agent-transcript-projection.ts:2628-2630`).

## Needs verification

- The saving was reasoned, not measured.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-9, TX-13)
- [1202 task 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
