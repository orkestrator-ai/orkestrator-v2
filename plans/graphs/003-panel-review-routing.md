---
id: 003
title: "Same routing after single and panel review"
phase: 0
plan: "P0.3"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
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

- [ ] In `advanceReviewFanout`, route to Verify when `structuredReview` has no issues and no coverage gaps, otherwise to Address. Keep the order "open the next stage, then drop `reviewFanout`".
- [ ] Check that `pipeline-flow.ts` placeholders still read correctly (Address is never drawn ahead).
- [ ] Update `docs/architecture/build-pipeline-view.md` if it describes the old behaviour.

## Tests

- [ ] A fan-out pipeline with a clean consolidated report goes to Verify.
- [ ] A fan-out pipeline with coverage gaps only goes to Address.
- [ ] Existing restart and rewind tests still pass.

## Done when

- [ ] Both review paths share one routing rule, and it is documented.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
