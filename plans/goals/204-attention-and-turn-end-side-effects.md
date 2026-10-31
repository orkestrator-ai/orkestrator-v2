---
id: 204
title: "Attention and turn-end side effects"
phase: 2
plan: "P2.4"
status: done
depends_on: [103]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "pending"
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

- [x] List every listener of `isAgentTurnEndTransition` in `apps/backend/src/core/index.ts` and decide for each one, recording the table in Notes.
- [x] Suppress `agent_finished` for an edge the goal will continue from, and ring once at any terminal or paused status. Reuse `agent_failed` for a failed turn.
- [x] A coordinator's worker gets one status wake when the goal ends or pauses, not one per iteration.
- [x] An approval or question that parks during a goal already rings; confirm the composer shows both the approval and the goal state.

## Tests

- [x] Per-platform table like `native-agent-failed-turn-attention.test.ts`.
- [x] A coordinator receives one wake for a many-iteration goal.

## Done when

- [x] A 20-iteration goal produces one notification.

## Notes

**2026-10-31 · Listeners of the turn-end edge.**

| Listener | During a goal |
| --- | --- |
| Change tracking `finalizeTurn` | Runs: it only reads |
| PR probe | Runs: it only reads |
| Web annotation `noteTurnEnded` | Runs: it reads its own requests |
| Prompt queue drain | Runs: it sends the continuation |
| Agent mail drain | Runs: mail is due |
| `settleWorkerDelegations` | Held until the goal stops, then runs once |
| `agent_finished` attention | Held until the goal stops, then rings once |
| `agent_failed` attention | Rings on the failed turn's own edge |

The delegation sweep closed delegations when a tab read idle, which a tab does between iterations, so `CoordinatorService` also asks about the worker's goal (found in 403).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
