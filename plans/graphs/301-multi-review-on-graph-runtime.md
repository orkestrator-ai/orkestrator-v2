---
id: 301
title: "Multi Review on the graph runtime"
phase: 3
plan: "Phase 3"
status: in-progress
depends_on: [204, 205, 206, 207, 209, 210, 211, 214]
blocked_by: ""
owner: "Claude Opus 5.5 (implement-graph-tasks)"
branch: "graphs-301-multireview"
pr: ""
updated: 2026-10-29
---

# 301 · Multi Review on the graph runtime

- **Plan:** [Phase 3: Multi Review on the graph runtime](../composable-graphs.md#phase-3-multi-review-on-the-graph-runtime)
- **Decisions:** D5
- **Depends on:** [204](204-agent-node-executor.md), [205](205-replication-and-collection.md), [206](206-gate-merge-loop-failure.md), [207](207-system-nodes.md), [209](209-guards-and-enforcement.md), [210](210-restart-and-rewind.md), [211](211-run-view.md), [214](214-launch-surfaces.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Multi Review runs on the graph runtime with no loss of quality, robustness or efficiency.

## Work

- [ ] A setting (plus an environment override for testing) selects the graph runtime for Multi Review.
- [ ] Parity: evaluation corpus scores (`multi-review-evaluation.test.ts`).
- [ ] Parity: efficiency budgets (two verifications per generation, at most one save per running pass, no whole-store reads).
- [ ] Parity: interleaving and dispatch-recovery suites.
- [ ] Parity: auto-fix and auto-PR ordering (`review-preparation.md`).
- [ ] Parity: coordinator launch, status wakes and `get_multi_review`.
- [ ] Parity: review-pass tab, CLI `review` commands, provisional findings, overlap metrics.
- [ ] Parity: stored Multi Review records stay readable.
- [ ] Soak period on the graph runtime, then flip the default.
- [ ] Retire the bespoke service once no supported version needs it (`docs/architecture/version-compatibility.md`).

## Tests

- [ ] The existing Multi Review suites run against both engines until retirement.

## Done when

- [ ] Multi Review runs on the graph runtime by default and the bespoke service is retired.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
