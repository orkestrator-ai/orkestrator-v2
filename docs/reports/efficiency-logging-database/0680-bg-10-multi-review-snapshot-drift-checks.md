# Multi Review snapshot mode runs a drift check per reviewer

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **One drift check per admission pass**: check a snapshot-mode review once per pass, as package mode does. Status: open.

### 1. One drift check per admission pass

**Problem.** Each snapshot-mode reviewer prompt runs its own worktree probe, including `git status --untracked-files=all`.

**Context.** The report's fix is one check per admission pass in both modes. [1202](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md) says [0027](../../todo/coordinator-and-multi-review/0027-multi-review-scale-and-cost.md) owns this, but I found no task or mention of it in 0027: its evidence permits cover package mode only.

**Investigation.** `beforeAdmission` is still wired only when the workflow has a review package (`apps/backend/src/core/multi-review-service.ts:3631-3633`), and `advanceReviewers` calls it once per pass (`apps/backend/src/core/review-fanout.ts:613-615`). Snapshot mode builds its prompt through `branchPrompt` and `host.reviewSnapshot` (`review-fanout.ts:795-798`), which reach `reviewSnapshotForDispatch` and `assertReviewSnapshotCurrent` (`multi-review-service.ts:3648-3649`, `:5011-5033`). Once a drift is recorded, the check stops (`:5025`).

**Decisions.**

- **Where does the one check go?**
  - **Wire `beforeAdmission` in snapshot mode too, and have prompts reuse that pass's answer (recommended).**
    - Pros: the report's fix; one path for both modes.
    - Cons: a worktree change after the pass's check is seen one pass later, so a reviewer dispatched in between gets a prompt that does not mention it.
  - **Memoise the probe for a few seconds inside `reviewSnapshotForDispatch`.**
    - Pros: no change to the fan-out.
    - Cons: time-based, so a slow pass still probes several times.

## Constraints and rationale

Drift is a durable warning, not a failure, in snapshot mode: "could not look" must stay distinct from "has changed" (`review-fanout.ts:222-227`).

## Needs verification

- The report's count of 2N `git status` runs. I traced one probe per reviewer prompt built, and could not confirm a second without running a review.

## Related

- [Efficiency report, F](../2026-10-27-efficiency.md#f-background-loops-and-external-processes)
- [0027 multi-review scale and cost](../../todo/coordinator-and-multi-review/0027-multi-review-scale-and-cost.md), the named owner
- [1202 efficiency follow-ups](../../todo/cross-cutting/1202-efficiency-review-follow-ups.md)
