---
id: 201
title: "Goal state in snapshots and events"
phase: 2
plan: "P2.1"
status: done
depends_on: [102]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "pending"
updated: 2026-10-31
---

# 201 · Goal state in snapshots and events

- **Plan:** [P2.1 Goal state in snapshots and events](../goals.md#p21-goal-state-in-snapshots-and-events)
- **Decisions:** D5
- **Depends on:** [102](102-goal-storage.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Any client can read a goal's current state, and live updates are only an optimisation.

## Work

- [x] Public shape without the check output tail, which is read on demand.
- [x] Include the goal in the state read and its revision, so a change wakes subscribers.
- [x] A `get_native_agent_goal` command for the detail, including `lastCheck` and history.
- [x] Follow the transport invariants in root `AGENTS.md`: snapshot first, events as increments.

## Tests

- [x] A client attaching mid-goal sees the current state. A dropped event heals on the next read.
- [x] Compression and replay tests stay within budgets for sessions with goals.

## Done when

- [x] The web app can render a goal from the snapshot alone.

## Notes

**2026-10-31.** `goal` is on the projection and the state view, in the field lists, and read from the record. `announce` invalidates the projection and emits the existing content event. Reload and re-open are proven live in the browser scenario.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
