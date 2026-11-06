# Raw preview window serialised on each changed read

## Task analysis

Analysed 2026-11-05 against `main` at `e6c3da899`, found while profiling a changed read for [6260](6260-projection-hashing-measurements.md) tasks 1 and 2.

### Tasks

1. **Measure the raw-window serialisation in `progressivePreviewFillsWindow`**: Status: open.
2. **Remove it if it matters**: Status: open (depends on 1).

### 1. Measure the raw-window serialisation in `progressivePreviewFillsWindow`

**Problem.** On a changed progressive read, `scheduleIncompleteProgressiveHydration` (`apps/backend/src/core/native-agent-transcript-projection.ts`) asks `progressivePreviewFillsWindow` whether the provider's preview already fills the live window. When the snapshot is incomplete (`complete: false`), has fewer rows than the window's 100, has no omitted parts, and is neither a summary nor a view with an adopted page cursor, the check runs `Buffer.byteLength(JSON.stringify(snapshot.messages))`. That serialises the provider's raw rows, inline tool output included, on every changed read. E11 did not touch it, and no to-do names it.

**Context.** A bridge cuts a long session's window by bytes before Orkestrator moves tool bodies behind detail references. A tool-heavy session can therefore arrive with fewer than 100 rows and `complete: false` on every read, which is the case this check serves. The raw rows are fresh objects from the provider's response, so the encoding memo does not help.

**Investigation.** Not measured. The changed-read benchmark's three progressive shapes are either complete or fill the window by count, so none of them reaches this line. The 6260 profile therefore says nothing about it.

**Decisions.**

- **How to measure it?**
  - **Add a scenario to `scripts/benchmark-transcript-changed-read.ts`: an incomplete window of about 60 rows whose raw tool outputs bring it near the bridge's byte bound, and compare CPU per read with the other shapes (recommended).**
    - Pros: same harness and method as 6260, no provider turn, and it shows the share directly.
    - Cons: the row shape is a guess at what a real bridge sends.
  - **Count how often real reads take this branch, in an isolated `dev:test` profile.**
    - Pros: real frequency.
    - Cons: needs real provider turns.

### 2. Remove it if it matters

**Problem.** If task 1 shows a meaningful share, the check serialises a large raw window only to compare its size with a target.

**Context.** The answer only gates whether an exact recovery read is scheduled, and the same token is checked again just after it (`existing.sourceToken === sourceToken`).

**Investigation.** Not started; depends on task 1.

**Decisions.**

- **How to avoid it?**
  - **Remember the answer per view and source token, so it is computed at most once per provider revision (recommended).**
    - Pros: smallest change; the answer cannot change while the token holds.
    - Cons: still one serialisation per streamed revision.
  - **Stop serialising as soon as the running size passes the target, measuring row by row.**
    - Pros: bounded work; the answer is exact.
    - Cons: each row is still serialised once per read until the target is reached.
  - **Use the bridge's own signal (`byteOmittedMessages`, or the snapshot's reported size) instead of measuring.**
    - Pros: no serialisation at all.
    - Cons: not every provider reports it, so a fallback is still needed.

## Related

- [6260](6260-projection-hashing-measurements.md): the profile that led here
- [Efficiency outcome, measurement of E11](../../reports/2026-11-06-efficiency-logging-database-outcome.md#measurement-of-e11-to-do-6260)
