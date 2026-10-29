---
id: 403
title: "Isolated branch worktrees"
phase: 4
plan: "Phase 4"
status: not-started
depends_on: [205, 210]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 403 · Isolated branch worktrees

- **Plan:** [Phase 4: extensions](../composable-graphs.md#phase-4-extensions)
- **Decisions:** D3
- **Depends on:** [205](205-replication-and-collection.md), [210](210-restart-and-rewind.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Several branches can write code in parallel, for example competing implementations.

## Work

- [ ] Write the design note in this file's Notes and get it agreed before building.
- [ ] One worktree per replicated writer branch, created from the input snapshot.
- [ ] `select` and agent `merge` nodes.
- [ ] Worktree lifecycle and cleanup, disk accounting (`docs/development/disk-usage.md`), container environments.
- [ ] Update D3 in the plan.

## Tests

- [ ] Competing implementations run, one is selected, and the others are cleaned up.

## Done when

- [ ] Parallel writers ship, and D3 is updated.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
