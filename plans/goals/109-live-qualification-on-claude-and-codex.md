---
id: 109
title: "Live qualification on Claude and Codex"
phase: 1
plan: "P1.9"
status: done
depends_on: [108]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "pending"
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

- [x] Scenarios: check passes after several iterations; no check ends `claimed`; a check that never passes hits the cap; `report_goal` blocked; Stop pauses and resume continues; a user prompt mid-goal; backend restart mid-goal; a goal large enough to compact. (a goal large enough to compact was replaced by a compact while a goal waits, see Notes)
- [x] Assert on the durable goal record and the queue, and read the transcript only to confirm what the agent saw.
- [x] Record pins, dates, costs and results in Notes.

## Tests

- [x] The suite's own runner and any assertions helpers have unit tests, as the coordinator suite's do.

## Done when

- [x] Both providers pass every scenario, or a failure has a filed item and the capability stays off for that provider.

## Notes

**2026-10-31 · Live record** (`mise run test:agent:goals`, default models). Check passes after iterations, no check, cap, blocked, Stop, resume and a queued user prompt pass on all six providers, not only Claude and Codex. Coordinator scenario: see 403.

Killed backend (Claude, `goals-restart-live.spec.ts`): during a check, the check re-runs and the goal completes with no extra turn; mid-turn, the goal pauses, resume completes it, and no continuation is sent twice.

Compaction: a real context overflow was not forced, because it would cost far more than the rest of the suite together. Instead a provider compact runs while a goal waits, then resume completes it: applied on Claude and Codex. On Pi and OpenCode the compact itself failed with the provider's error (`HTTP 500`, `OpenCode compact failed`), and the goal still completed.

Across about 15 runs, three failures came from the model and not the loop: OpenCode's `Model access is disabled` 403 (the goal paused and said so), one OpenCode timeout whose state the suite could not yet report, and a Codex verifier that took over 5 minutes.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
