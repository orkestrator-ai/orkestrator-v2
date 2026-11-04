# The whitespace-ignore diff view skips the page's batch budget

## Task analysis

Analysed 2026-11-04 against `main` at `a8bdce444`.

### Tasks

1. **Apply `maxBatchBytes` across a whitespace-ignore page**: decide whether that view shares the page budget as the normal view does. Status: open.

### 1. Apply `maxBatchBytes` across a whitespace-ignore page

**Problem.** A whitespace-ignore page renders each of its 20 files with a fresh budget, so `maxBatchBytes` never applies. The normal view of the same page stops diffing at the budget and marks later files `changes.body.batch-limit`.

**Context.** `DiffBodyService.renderView` (`apps/backend/src/core/change-tracking/diff-bodies.ts`) calls `renderSnapshotBodies` once per file for this view. `diffRawLines` runs on the event loop. Found during [1202](1202-efficiency-review-follow-ups.md) task 7 (ST-5), which kept the behaviour so that rendering once changed nothing a client sees.

**Investigation.** Read from the code only; no page large enough to reach the budget was measured. The per-file call dates from when this view rendered every file twice. `diff-bodies-lookup.test.ts` pins the view's output against that old double render within the budget.

**Decisions.**

- **Should the whitespace view share the page budget?**
  - **One `renderSnapshotBodies` call for the page, as the normal view makes (recommended).**
    - Pros: the same bound on event-loop time in both views; removes the loop in `renderView`.
    - Cons: a large page that shows every file today would show `batch-limit` on its later files, as the normal view already does.
  - **Leave it.**
    - Pros: nothing a client sees changes.
    - Cons: a page can diff far more than `maxBatchBytes` on the event loop.
