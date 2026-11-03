# Inline tool bodies are re-hashed whenever their row misses the cache

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Memoise per part**: avoid serialising and hashing an unchanged tool body when its row is re-projected. Status: open.

### 1. Memoise per part

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

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): the memo needs byte and count bounds.
- A memo hit must still register the reference (see `restoreDetailRegistrations`, `:890`), or an evicted detail stays lost.

## Needs verification

- The real cost on a streaming row with many tool parts. Reasoned, not measured.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-16)
- [1202 task 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
- [0150](0150-tx-2-tx-15-post-dispatch-raw-reads.md)
