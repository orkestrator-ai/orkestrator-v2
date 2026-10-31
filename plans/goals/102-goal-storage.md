---
id: 102
title: "Goal storage"
phase: 1
plan: "P1.2"
status: done
depends_on: [101]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1482"
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

- [x] Add `goal` and `goalHistory` to the session record, with their guards on load.
- [x] Storage operations: set, replace, patch by `goalId` (a stale `goalId` is a no-op), move to history.
- [x] A goal is bound to `providerSessionId`. If the session's provider id changes (clear, resume another conversation), the goal pauses with reason `session-replaced`.
- [x] A fork does not inherit the goal. Environment deletion removes it with the session.
- [x] Reads go through the existing session reads, so no new storage path or recurring-work unit is added.

## Tests

- [x] Round trip through restart. A record with no `goal` loads unchanged.
- [x] A stale `goalId` patch changes nothing. Concurrent patches serialize.
- [x] Fork, replace and delete behave as above.

## Done when

- [x] The service in 103 can rely on one atomic, fenced way to change a goal.

## Notes

**2026-10-31.** A record loads through `sessionGoal`, like `retiredDispatch`: a malformed value reads as absent. Adopting the same key with a new provider id keeps the goal, whose stale `providerSessionId` pauses it (`session-replaced`), and resume rebinds it. A new key, as a fork gets, starts with none.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
