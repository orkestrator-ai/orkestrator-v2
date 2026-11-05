# The whitespace-ignore diff view skips the page's batch budget

## Task analysis

Analysed 2026-11-04 against `main` at `a8bdce444`.

### Tasks

1. **Apply `maxBatchBytes` across a whitespace-ignore page**: decide whether that view shares the page budget as the normal view does. Status: done.

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

## Assumptions and decisions

Re-checked 2026-11-05 against `main` at `f6d4162e1`, after E3 (#1833) merged. The finding still held: `DiffBodyService.renderView` called `renderSnapshotBodies` once per file of a whitespace-ignore page, each with a fresh `maxBatchBytes`.

### Task 1: share the page budget

Took the recommended option: `renderView` makes one `renderSnapshotBodies` call for the whole page in both views, passing `ignoreWhitespace` for the whitespace view. Later files on a page past the budget show `changes.body.batch-limit`, as the normal view does. `diff-bodies-lookup.test.ts` kept its comparison with the old per-file double render, now named as holding only within the budget, and gained a test that the budget applies across a whitespace page (it fails on the per-file code). `docs/architecture/change-tracking.md` "Manifest cache" says so.

## Outcome

| Task | Outcome |
| --- | --- |
| 1. Apply `maxBatchBytes` across a whitespace-ignore page | Done. Code: `DiffBodyService.renderView` in `apps/backend/src/core/change-tracking/diff-bodies.ts` renders the page in one `renderSnapshotBodies` call. Test: `diff-bodies-lookup.test.ts`, "the whitespace-ignore view > shares the page's batch budget across files, as the normal view does". |
