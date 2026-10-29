---
id: 216
title: "Documentation"
phase: 2
plan: "P2.16"
status: not-started
depends_on: [201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 216 · Documentation

- **Plan:** [P2.16 Documentation](../composable-graphs.md#p216-documentation)
- **Decisions:** none
- **Depends on:** [201](201-run-record-and-storage.md), [202](202-supervisor-domain.md), [203](203-scheduling.md), [204](204-agent-node-executor.md), [205](205-replication-and-collection.md), [206](206-gate-merge-loop-failure.md), [207](207-system-nodes.md), [208](208-human-nodes.md), [209](209-guards-and-enforcement.md), [210](210-restart-and-rewind.md), [211](211-run-view.md), [212](212-editable-designer.md), [213](213-mock-runs.md), [214](214-launch-surfaces.md), [215](215-describe-a-graph.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Shipped behaviour is described in living docs, not only in this folder.

## Work

- [ ] `docs/architecture/graphs.md`: model, compiler, runtime, artifacts, profiles and tiers, guards, storage, bounds, invariants.
- [ ] `docs/architecture/graphs-user-guide.md`: designing, testing with mock runs, launching, watching, restarting.
- [ ] Rows for both in `docs/README.md`.
- [ ] Update `coordinator.md` (graph tools and wakes), `public-cli.md` (graph commands) and `agent-engines.md` (new capabilities).

## Tests

- [ ] `bun test tests/unit/mise-tasks.test.ts` and the docs tests pass.

## Done when

- [ ] The living docs describe everything Phase 2 shipped.

## Notes

- Write sections as items land rather than all at the end; this item is done when the last one is covered.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
