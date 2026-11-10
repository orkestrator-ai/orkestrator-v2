# BG-11 live: project-notes reads per build pipeline review dispatch

## Task analysis

Analysed 2026-11-10 against `main` at `4dc220f7b`. Moved out of
[1202](1202-efficiency-review-follow-ups.md) task 1, whose other agent-doable
baselines were measured on 2026-11-10; this is the one that needs new
tooling rather than a run of an existing driver.

### Tasks

1. **Count BG-11's reads on a fake-model build pipeline**: open.

### 1. Count BG-11's reads on a fake-model build pipeline

**Problem.** BG-11 (1202 task 10, done 2026-11-02) builds the build
pipeline review fan-out's shared package prompt once per supervisor pass
instead of once per reviewer, so the review instruction and the project
notes are read once per pass. Its only evidence is a unit count: a
four-reviewer dispatch pass read the project notes 5 times on `0bd214ee` and
2 times after. 1202 task 1 asked for the live count as well, and no live run
has dispatched a build pipeline review.

**Context.** The code is `BuildPipelineReviewFanout.reviewHost`
(`apps/backend/src/core/build-pipeline-review-fanout.ts`), called from
`advance` on every supervisor pass; its reads run inside the
`build-supervisor-tick` recurring kind, so they show as that kind's
`storage-read` units in `recurringWork`. The saving happens only on a pass
that dispatches reviewers, so it is a few cached reads per review, not a
steady rate. The 0048 busy driver's Pi fake model
(`scripts/recurring-live-ab-fake-model.ts`) scripts Multi Review's result
tools only, so the busy profile never runs a build pipeline. The
Auto-pipeline fake model (`e2e/agent-testing/auto-pipeline-fake-model-script.ts`,
to-do 7547 task 4, `mise run test:agent:auto-pipeline`) does drive a build
pipeline through package preparation, review and Verify on Pi, but it is a
Playwright spec rather than a measurement driver, and `0bd214ee` predates it
(and the Auto-pipeline flow), so it cannot give the before side as it is.

**Investigation.** None beyond the above. Not checked: how many reviewers
the Auto-pipeline run's review fan-out dispatches, and whether
`0bd214ee`'s build pipeline can be driven to review by the 0048 fake model
with the build pipeline's own result tools added.

**Decisions.**

- **How to get the live count?**
  - **Run the Auto-pipeline fake model's pipeline on `main` with two or more reviewers and read `build-supervisor-tick`'s storage reads either side of the review dispatch; keep the unit count as the before side (recommended).**
    - Pros: reuses a driver that already reaches review on a fake model;
      shows the after count live.
    - Cons: no live before side; the count is a handful of cached reads,
      so the run proves the code path more than a saving.
  - **Extend the 0048 fake model with the build pipeline's result tools and run a ticket-driven pipeline on both commits.**
    - Pros: a true before and after.
    - Cons: a new scripted pipeline driver that has to fit `0bd214ee`'s
      prompts as well as today's; a large job for a few reads per review.
  - **Close BG-11's live count on the unit count.**
    - Pros: no work.
    - Cons: leaves 1202's report table with one item never seen live.

## Related

- [1202](1202-efficiency-review-follow-ups.md) task 1 (the baselines) and
  task 10 (BG-11).
- [0048](../transcripts-and-observation/0048-recurring-work-qualification.md)
  (the busy driver and its fake model).
