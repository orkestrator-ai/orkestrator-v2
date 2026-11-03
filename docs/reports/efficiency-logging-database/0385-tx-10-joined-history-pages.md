# Joined history pages read the whole transcript per page

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Retire joined paging, or add the interim map**: owned by 0232's last task, which waits on the support window. Status: open.

### 1. Retire joined paging, or add the interim map

**Problem.** A joined (v1) history page runs a whole `sync-v1` projection, then hashes message ids in turn to find the cursor.

**Context.** Todo 0232 owns this. Its first three items landed, so current renderers page directly and joined paging remains for older renderers. Its task 4 removes the path and is blocked on the support window.

**Investigation.** Each page calls `refreshProjection` (`apps/backend/src/core/native-agent-transcript-projection.ts:3878`) and runs a `findIndex` with SHA-256 per row (`:3903-3909`). Use is counted by `history.joined-v1-page` (`:247`, `:3877`).

**Decisions.**

- **Add the report's interim fix?**
  - **No: leave the path until 0232 removes it, unless the counter shows real use (recommended).**
    - Pros: no new state for a path that is going away.
    - Cons: an older renderer keeps the cost for the support window.
  - **An id-to-index map per history epoch.**
    - Pros: the report's interim fix; removes the hashing scan.
    - Cons: a new bounded structure on a retiring path; it does not touch the whole-transcript read.

## Constraints and rationale

- [Report invariants](../2026-10-27-efficiency.md#invariants-every-fix-must-keep): a new map needs byte and count bounds.

## Related

- [Efficiency report, B](../2026-10-27-efficiency.md#b-native-agent-transcript-pipeline) (TX-10)
- [0232 direct history cursor minting](../../todo/transcripts-and-observation/0232-direct-history-cursor-minting.md), task 4
- [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md), which leaves this with 0232
