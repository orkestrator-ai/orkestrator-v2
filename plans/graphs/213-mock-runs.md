---
id: 213
title: "Mock runs"
phase: 2
plan: "P2.13"
status: not-started
depends_on: [204, 206, 207]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 213 · Mock runs

- **Plan:** [P2.13 Mock runs](../composable-graphs.md#p213-mock-runs)
- **Decisions:** none
- **Depends on:** [204](204-agent-node-executor.md), [206](206-gate-merge-loop-failure.md), [207](207-system-nodes.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Users test control flow without spending tokens or touching GitHub.

## Work

- [ ] `graph-mock-provider.ts`: answers from the type's `example`, a schema-generated value, or a per-node pinned sequence (for example "Verify: fail, fail, pass").
- [ ] Runs in the same runtime, so gates, loops, merges and the run view are exercised.
- [ ] Mock runs are labelled everywhere. Side-effecting system nodes record "would have run" and never open a PR or move a ticket.

## Tests

- [ ] A mock run of each report §9 example passes with zero provider sessions.
- [ ] No PR, push or ticket write happens in a mock run.

## Done when

- [ ] Mock runs are available from the designer.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
