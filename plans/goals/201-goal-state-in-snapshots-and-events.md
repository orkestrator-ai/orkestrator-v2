---
id: 201
title: "Goal state in snapshots and events"
phase: 2
plan: "P2.1"
status: not-started
depends_on: [102]
blocked_by: ""
owner: ""
branch: ""
pr: ""
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

- [ ] Public shape without the check output tail, which is read on demand.
- [ ] Include the goal in the state read and its revision, so a change wakes subscribers.
- [ ] A `get_native_agent_goal` command for the detail, including `lastCheck` and history.
- [ ] Follow the transport invariants in root `AGENTS.md`: snapshot first, events as increments.

## Tests

- [ ] A client attaching mid-goal sees the current state. A dropped event heals on the next read.
- [ ] Compression and replay tests stay within budgets for sessions with goals.

## Done when

- [ ] The web app can render a goal from the snapshot alone.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
