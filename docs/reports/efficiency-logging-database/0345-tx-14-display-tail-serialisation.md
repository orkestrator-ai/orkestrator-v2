# Restart-preview checkpoints are serialised three times and cloned

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Serialise a checkpoint once and stop cloning it**: reuse the encoded payload and hand out frozen tails. Status: open.

### 1. Serialise a checkpoint once and stop cloning it

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

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep) apply as usual. The stored format and checksum versions must not change without a compatibility entry.

## Needs verification

- Which callers mutate what `get` returns; they were not all traced.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-14)
- [1202 task 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
