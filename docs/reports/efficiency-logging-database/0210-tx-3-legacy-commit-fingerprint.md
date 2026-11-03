# The legacy commit re-serialises the whole projection to fingerprint it

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Fingerprint through the message memo**: replace the `JSON.stringify` with `digestWithMessages`. Status: open.

### 1. Fingerprint through the message memo

**Problem.** Each legacy commit serialises the whole candidate projection, up to 4,096 rows, bypassing the per-object encodings, only to compare it with the previous one.

**Context.** The memo exists for this. `digestWithMessages` is already used for the sync token.

**Investigation.** The fingerprint is `JSON.stringify({ ...candidate, revision: 0, cursor: candidate.cursor })` (`apps/backend/src/core/native-agent-transcript-projection.ts:5465`), compared at `:5470` and stored in the cache entry at `:5503`, so the cache also keeps that whole string alive. `digestWithMessages` is at `native-agent-projection-encoding.ts:141-148`, and its sync use is at `native-agent-transcript-projection.ts:1491`. The fingerprint is compared only for equality, so a digest is a drop-in replacement.

**Decisions.** None: the report names the fix, and the fingerprint is used only for this comparison.

## Constraints and rationale

- `encodedValue` relies on projected values being immutable once `projectionMessages` returns them. The candidate's `messages` must come from there.

## Needs verification

- The saving was reasoned, not measured.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-3)
- [1202 task 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0150](0150-tx-2-tx-15-post-dispatch-raw-reads.md): fewer legacy refreshes would also lower this cost
