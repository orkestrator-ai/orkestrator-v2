---
id: 208
title: "Human nodes"
phase: 2
plan: "P2.8"
status: not-started
depends_on: [203, 204]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-29
---

# 208 · Human nodes

- **Plan:** [P2.8 Human nodes](../composable-graphs.md#p28-human-nodes)
- **Decisions:** D15
- **Depends on:** [203](203-scheduling.md), [204](204-agent-node-executor.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

People take part in a run at explicit points, and a waiting run is visible wherever the user looks.

## Work

- [ ] `approve`, `edit` (through the type's form, or as JSON) and `choose` (pick a gate branch).
- [ ] A waiting human node shows in the sidebar activity, in the run view and as a coordinator notice, through the existing attention and status-wake paths.
- [ ] Optional timeout routes to the `error` port; without one, the run waits, paused rather than failed.
- [ ] The answer UI is shared with `ask_human` from [204](204-agent-node-executor.md).

## Tests

- [ ] Inactive-environment path: start, switch away, answer later, return.
- [ ] Restart while a human node is waiting.
- [ ] The coordinator gets one notice per wait.

## Done when

- [ ] Human nodes work across tab switches and backend restarts.

## Notes

None yet.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-29 · plan · Created from the plan. · Not started.
