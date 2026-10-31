---
id: 102
title: "Goal storage"
phase: 1
plan: "P1.2"
status: not-started
depends_on: [101]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 102 · Goal storage

- **Plan:** [P1.2 Goal storage](../goals.md#p12-goal-storage)
- **Decisions:** D3, D15
- **Depends on:** [101](101-goal-model-and-protocol.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A goal is durable, changes atomically with its session, and follows the session's lifecycle correctly.

## Work

- [ ] Add `goal` and `goalHistory` to the session record, with their guards on load.
- [ ] Storage operations: set, replace, patch by `goalId` (a stale `goalId` is a no-op), move to history.
- [ ] A goal is bound to `providerSessionId`. If the session's provider id changes (clear, resume another conversation), the goal pauses with reason `session-replaced`.
- [ ] A fork does not inherit the goal. Environment deletion removes it with the session.
- [ ] Reads go through the existing session reads, so no new storage path or recurring-work unit is added.

## Tests

- [ ] Round trip through restart. A record with no `goal` loads unchanged.
- [ ] A stale `goalId` patch changes nothing. Concurrent patches serialize.
- [ ] Fork, replace and delete behave as above.

## Done when

- [ ] The service in 103 can rely on one atomic, fenced way to change a goal.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
