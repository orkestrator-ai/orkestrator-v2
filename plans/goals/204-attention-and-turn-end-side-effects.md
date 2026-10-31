---
id: 204
title: "Attention and turn-end side effects"
phase: 2
plan: "P2.4"
status: not-started
depends_on: [103]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 204 · Attention and turn-end side effects

- **Plan:** [P2.4 Attention and turn-end side effects](../goals.md#p24-attention-and-turn-end-side-effects)
- **Decisions:** D12
- **Depends on:** [103](103-goal-service-and-turn-edge-driver.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

A goal interrupts the user once when it needs them, not on every iteration.

## Work

- [ ] List every listener of `isAgentTurnEndTransition` in `apps/backend/src/core/index.ts` and decide for each one, recording the table in Notes.
- [ ] Suppress `agent_finished` for an edge the goal will continue from, and ring once at any terminal or paused status. Reuse `agent_failed` for a failed turn.
- [ ] A coordinator's worker gets one status wake when the goal ends or pauses, not one per iteration.
- [ ] An approval or question that parks during a goal already rings; confirm the composer shows both the approval and the goal state.

## Tests

- [ ] Per-platform table like `native-agent-failed-turn-attention.test.ts`.
- [ ] A coordinator receives one wake for a many-iteration goal.

## Done when

- [ ] A 20-iteration goal produces one notification.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
