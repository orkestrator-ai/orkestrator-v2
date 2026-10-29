---
id: 003
title: "Same routing after single and panel review"
phase: 0
plan: "P0.3"
status: in-progress
depends_on: []
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "implement-graph-tasks-17b1f79c6e44-r1"
pr: ""
updated: 2026-10-29
---

# 003 · Same routing after single and panel review

- **Plan:** [P0.3 Same routing after single and panel review](../composable-graphs.md#p03-same-routing-after-single-and-panel-review)
- **Decisions:** D21
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

When a reviewer panel's consolidated report has no issues and no coverage gaps, the Build Pipeline goes straight to Verify, as the single-review path already does.

## Work

- [x] In `advanceReviewFanout`, route to Verify when `structuredReview` has no issues and no coverage gaps, otherwise to Address. Keep the order "open the next stage, then drop `reviewFanout`".
- [x] Check that `pipeline-flow.ts` placeholders still read correctly (Address is never drawn ahead).
- [x] Update `docs/architecture/build-pipeline-view.md` if it describes the old behaviour.

## Tests

- [x] A fan-out pipeline with a clean consolidated report goes to Verify.
- [x] A fan-out pipeline with coverage gaps only goes to Address.
- [x] Existing restart and rewind tests still pass.

## Done when

- [x] Both review paths share one routing rule, and it is documented.

## Notes

- 2026-10-29: The rule is one function, `stageAfterReview(report)` in
  `apps/backend/src/core/build-pipeline-service-helpers.ts`. It takes
  `StructuredReviewFindings` and returns
  `{ sessionPhase: "address", phase: "addressing" }` when the report has issues
  or test coverage gaps, else `{ sessionPhase: "verify", phase: "verifying" }`.
  `finishReview` (single reviewer) and `advanceReviewFanout` (panel) both call
  it. The panel path routes on `pipeline.structuredReview`, falling back to
  `reviewFanout.report`, and fails the stage if neither exists. It still opens
  the next stage before dropping `reviewFanout`.
- 2026-10-29: `pipeline-flow.ts` needs no change. Its placeholder route never
  contains Address, and the projection reads sessions, so a clean panel pass
  draws Consolidation → Verify. A new test pins that, including the moment
  when a leftover `reviewFanout` still exists in `verifying`.
- 2026-10-29: `build-pipeline-view.md` did not describe the old routing. It
  now has an "After review" bullet stating the shared rule. The
  `review-preparation.md` line "the fan-out record is dropped once addressing
  starts" now names Address or Verify.
- 2026-10-29: Tests: `build-pipeline-review-fanout.test.ts` ("a clean
  consolidated report skips Address and goes straight to Verify", "a
  consolidated report with only coverage gaps goes to Address"), the fake's
  new `FanoutProvider.consolidationFindings` knob
  (`"issue" | "clean" | "coverage-gap"`, default `"issue"`, so the existing
  suites are unchanged), `stageAfterReview` cases in
  `build-pipeline-service-helpers.test.ts`, and the flow test in
  `apps/web/src/components/build-pipeline/pipeline-flow.test.ts`. The
  restart, rewind, skip, recovery and retry suites pass unchanged.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · Claude Opus 5.5 (implement-graph-tasks) · Shared `stageAfterReview` routes both review paths; tests for clean, gaps-only and flow projection; docs updated (evidence for the Phase 0 exit criterion: `build-pipeline-review-fanout.test.ts`). · complete; awaiting PR
