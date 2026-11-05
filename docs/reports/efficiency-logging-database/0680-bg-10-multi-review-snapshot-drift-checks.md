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

## Outcome

Checked back on 2026-11-05 against `main` at `69a3b4ca5`, implemented in `535156bc1`. The findings still held at that base: `beforeAdmission` was wired only for a review package (`multi-review-service.ts:3688-3690`), and each snapshot-mode reviewer prompt called `reviewSnapshotForDispatch` through `host.reviewSnapshot` (`:3705-3706`, `review-fanout.ts:795-798`). No to-do was needed.

| Item in the original file | Outcome | Evidence |
| --- | --- | --- |
| Task 1, one drift check per admission pass (recommended option: wire `beforeAdmission` in snapshot mode and have prompts reuse that pass's answer) | Done | `reviewFanoutHost` in `apps/backend/src/core/multi-review-service.ts` now wires `beforeAdmission` in snapshot mode too; it runs `reviewSnapshotForDispatch` once and every reviewer prompt built in the pass reuses that promise (`reviewSnapshotForPass`). Host comments updated in `review-fanout.ts`. Tests in `multi-review-service-efficiency.test.ts`: "snapshot mode checks the worktree once per admission pass, not once per reviewer" (3 reviewers, 1 probe; a retrying reviewer's later pass probes again and sees the change; a pass that admits nobody does not probe), "a drift found by the pass's check reaches every prompt that pass builds", and "an unreadable worktree fails snapshot admission before any reviewer starts". The first and third fail on the old code (3 probes, 3 sessions opened). Three tests in `multi-review-service.test.ts` that relied on a probe per reviewer now see drift from a later pass instead. |
| Rejected option, memoise the probe for a few seconds | Not taken | The report recommended the per-pass check; a time-based memo still probes several times in a slow pass. |
| Constraint, drift is a durable warning and "could not look" stays distinct from "has changed" | Kept | Drift still sets `reviewSnapshotStale` and the workflow continues; an unusable probe still raises `ReviewSnapshotUnverifiableError` and fails the pass with no reviewer started, without marking drift (tests above). |
| Needs verification, the count of 2N `git status` runs | Confirmed, now 2 per pass | Measured by running `REVIEW_WORKTREE_FINGERPRINT_SCRIPT` against a throwaway Git repository with a counting `git` wrapper: one drift probe runs 5 Git processes, 2 of them `git status --porcelain=v1 -z --untracked-files=all`, because the script captures twice and compares. N reviewers therefore cost 2N status runs per pass before this change, and 2 after it. |
| Cons of the chosen option, a change after the pass's check is seen one pass later | Accepted | The next pass that admits a reviewer checks again, and its prompts say the snapshot is stale (first test above). Consolidation keeps its own check. |
| Related, ownership claimed by 1202 for 0027 | Corrected | 1202's introduction now records BG-10 as done here instead of owned by 0027, which never had a task for it. |

No stored format, wire contract or command changed, so nothing in `docs/architecture/version-compatibility.md` applies.
