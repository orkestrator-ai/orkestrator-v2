# Busy driver: the review-preparation sample fails every round

## Task analysis

Analysed 2026-11-10 against `main` at `04639b12b`, from the 7202 task 2
reruns of the busy phase (`recurring-live-ab.ts --busy-rounds`; see
[7202](7202-busy-profile-follow-ups.md#2-one-multi-review-stalled-35-minutes-after-its-plan-was-accepted)).

### Tasks

1. **Make the review-preparation sample match the review flow**: the busy driver fails `workflow-sample` "missing or ambiguous submit_review_preparation -> reviewing" in every round, although every review reaches `ready`, so the driver exits 1 on a run that kept every obligation. Status: open.

### 1. Make the review-preparation sample match the review flow

**Problem.** On 2026-11-10 a keyed-arm busy run (6 rounds, no clients, fake
Pi model, Linux) kept every obligation (6 held turns, 6 queued prompts, 6
approvals, 6 mails, 6 reviews to `ready`, no duplicate dispatch), yet failed
all 6 rounds with `workflow-sample`: "missing or ambiguous
submit_review_preparation -> reviewing". The driver exits 1, so its exit
status no longer separates a broken review from a sampling mismatch, and the
`workflow-progress` row loses its preparation samples.

**Context.** After each review, `scripts/recurring-live-ab-busy.ts` pairs each
workflow tool's submission with the first transition into a target phase
(`expected` in step 6): `submit_validation_plan` and
`submit_review_preparation` both map to `reviewing`. It fails a round when a
tool has not exactly one new submission, or the transition precedes the
submission. The fake model (`scripts/recurring-live-ab-fake-model.ts`,
`FAKE_WORKFLOW_RESULTS`) answers whichever tool the review asks for. The
backend moves a review from `preparing` to `reviewing` once its validation run
is sealed (`multi-review-service.ts`, the `workflow.phase = "reviewing"` after
`parseReviewPackageReference`).

**Investigation.** Not yet known which half fails: either the review no
longer asks for `submit_review_preparation` when a validation plan ran (zero
submissions), or it asks after the first `reviewing` transition (wrong
order). The run's result JSON
(`output/benchmarks/busy-7202-2026-11-10-run2.json`, git-ignored, local to the
worktree that ran it) does not keep per-tool submission counts or the
transition list, so the record cannot tell. The validation-plan pairing
passed in every round (`workflow-validation` 2.2 to 6.1 s).

**Decisions.**

- **How to fix the sample?**
  - **Record per-tool submission counts and the phase transitions in the busy result, read which case it is, then make the expected pairs follow the review flow the backend implements (recommended).**
    - Pros: the fix rests on evidence; the extra fields also explain the next mismatch.
    - Cons: one more live run before the fix.
  - **Treat a missing `submit_review_preparation` as acceptable.**
    - Pros: no run needed.
    - Cons: guesses the cause; would also hide a real regression in which the review skips preparation it needs.

## Related

- [7202](7202-busy-profile-follow-ups.md) task 2: the reruns that found it.
- [0048](0048-recurring-work-qualification.md) task 1: the busy profile.
