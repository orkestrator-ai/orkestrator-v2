---
id: 101
title: "Goal model and protocol"
phase: 1
plan: "P1.1"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 101 · Goal model and protocol

- **Plan:** [P1.1 Goal model and protocol](../goals.md#p11-goal-model-and-protocol)
- **Decisions:** D3, D7, D9, D15
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

One shared definition of a goal, its statuses, its bounds and its transitions.

## Work

- [ ] `NativeAgentGoal`: `goalId`, `objective`, optional `check`, `status`, `statusReason`, `providerSessionId`, `iterations`, `maxIterations`, optional `tokenBudget`, `tokensAtStart`, `tokensUsed`, `lastReport`, `lastCheck`, `setAt`, `updatedAt`.
- [ ] Statuses as in the plan's Status table, with terminal and non-terminal sets exported.
- [ ] Bounds: objective ≤ 4,000 characters, check ≤ 4 KiB, report message ≤ 2 KiB, retained check output ≤ 8 KiB, `maxIterations` default 20 and at most 100.
- [ ] Hand-written guards for persisted and wire shapes, following the other protocol guards.
- [ ] `nextGoalState(goal, event)`: a pure function from status and event (turn outcome, report, check result, user action, limit) to the next status and the action to take.

## Tests

- [ ] Table test over every status and event pair, including events that must be ignored.
- [ ] Guards reject each out-of-bound field and accept a record written by this version.

## Done when

- [ ] Later items can import the model and the transition function, and no later item needs a status rule of its own.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
