---
id: 501
title: "Build Pipeline on the graph runtime (optional)"
phase: 5
plan: "Phase 5"
status: not-started
depends_on: [301]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 501 · Build Pipeline on the graph runtime (optional)

- **Plan:** [Phase 5 (optional): the Build Pipeline](../composable-graphs.md#phase-5-optional-the-build-pipeline)
- **Decisions:** D5
- **Depends on:** [301](301-multi-review-on-graph-runtime.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Decide whether to port the Build Pipeline and, if so, do it with full parity.

## Work

- [ ] Decide, from Phase 3's results, whether to port. Record the decision in the plan. If not, set this item to `dropped`.
- [ ] Parity: Kanban lifecycle and retries.
- [ ] Parity: the PR monitor.
- [ ] Parity: per-round semantics and skip rules.
- [ ] Parity: the "Prepare package again" variants.
- [ ] Parity: feature builds.

## Tests

- [ ] The existing Build Pipeline suites run against both engines until retirement.

## Done when

- [ ] Either the Build Pipeline runs on the graph runtime by default, or this item is `dropped` with the reason recorded.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
- 2026-10-29 · coordinator · Left not started until Multi Review has soaked on the graph runtime (D25). · Decide after the Phase 3 soak.
