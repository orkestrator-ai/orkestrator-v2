---
id: 109
title: "Live qualification on Claude and Codex"
phase: 1
plan: "P1.9"
status: not-started
depends_on: [108]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 109 · Live qualification on Claude and Codex

- **Plan:** [P1.9 Live qualification on Claude and Codex](../goals.md#p19-live-qualification-on-claude-and-codex)
- **Decisions:** D14
- **Depends on:** [108](108-the-goal-slash-command.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

The loop is proven against real models on the first two providers before anything is built on it.

## Work

- [ ] Scenarios: check passes after several iterations; no check ends `claimed`; a check that never passes hits the cap; `report_goal` blocked; Stop pauses and resume continues; a user prompt mid-goal; backend restart mid-goal; a goal large enough to compact.
- [ ] Assert on the durable goal record and the queue, and read the transcript only to confirm what the agent saw.
- [ ] Record pins, dates, costs and results in Notes.

## Tests

- [ ] The suite's own runner and any assertions helpers have unit tests, as the coordinator suite's do.

## Done when

- [ ] Both providers pass every scenario, or a failure has a filed item and the capability stays off for that provider.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
