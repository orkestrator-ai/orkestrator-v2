# Small linear scans in the transcript projection

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Decide whether these scans matter**: profile a changed read, then fix or close. Status: open.

### 1. Decide whether these scans matter

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

## Needs verification

- Their share of a read. Nothing was measured.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-17)
- [1202 task 5](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
