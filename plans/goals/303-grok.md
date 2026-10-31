---
id: 303
title: "Grok"
phase: 3
plan: "P3.3"
status: done
depends_on: [108]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "pending"
updated: 2026-10-31
---

# 303 · Grok

- **Plan:** [P3.3 Grok](../goals.md#p33-grok)
- **Decisions:** D14
- **Depends on:** [108](108-the-goal-slash-command.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Goals work on Grok over ACP, with Grok's own goal loop out of the way.

## Work

- [x] Reserve Grok's own `/goal` row, including rows restored as `stale`.
- [x] If 001 shows the native `update_goal` tool is offered over ACP, find a way to turn it off, or make sure the agent's instructions name `report_goal`. Record which.
- [x] Grok's write enforcement is advisory (composable graphs D4). State in the panel what that means for an unattended goal.
- [x] Turn on `actions.goal` after the live run passes.

## Tests

- [x] Catalogue reservation with live and restored rows.
- [x] The live suite passes on Grok.

## Done when

- [x] Grok passes every scenario in 109, and the capability is on, or the blocking gap is written down and it stays off.

## Notes

**2026-10-31.** Live: every loop scenario passes. The panel states that Grok's rules are advisory. Grok's model names no goal tool over ACP.

Grok's shell fails to spawn in Orkestrator sessions with or without a goal, so the suite gives Grok a slow step that needs no shell. That bug is not fixed here; it is outside this plan and limits what a Grok goal can do.

The host's Grok login had expired, and a normal `grok -p` call refreshed it.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
