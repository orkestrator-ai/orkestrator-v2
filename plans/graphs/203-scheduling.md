---
id: 203
title: "Scheduling"
phase: 2
plan: "P2.3"
status: not-started
depends_on: [202]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 203 · Scheduling

- **Plan:** [P2.3 Scheduling](../composable-graphs.md#p23-scheduling)
- **Decisions:** D3
- **Depends on:** [202](202-supervisor-domain.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Each pass decides which activations may start, without breaking workspace safety or admission budgets.

## Work

- [ ] Ready set: activations whose required inputs are live and whose `when` holds, computed under the run lock.
- [ ] Workspace locks: one writer at a time; no reader alongside a writer (D3).
- [ ] Admission through the work-admission pool and the per-provider caps (4/8/4/16).
- [ ] Enforce `limits.maxConcurrentAgents` and `limits.maxAgentSessions` at admission.
- [ ] Observe running activations every 3 s plus jitter.
- [ ] Skeleton for `graph-run-efficiency.bench.test.ts`.

## Tests

- [ ] Ready-set unit tests over small plans.
- [ ] Locks keep a writer and a reader apart.
- [ ] Admission caps hold under a wide fan-out.

## Done when

- [ ] Activations start in a safe, bounded order, and the benchmark skeleton runs.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
