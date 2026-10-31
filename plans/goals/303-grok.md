---
id: 303
title: "Grok"
phase: 3
plan: "P3.3"
status: not-started
depends_on: [108]
blocked_by: ""
owner: ""
branch: ""
pr: ""
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

- [ ] Reserve Grok's own `/goal` row, including rows restored as `stale`.
- [ ] If 001 shows the native `update_goal` tool is offered over ACP, find a way to turn it off, or make sure the agent's instructions name `report_goal`. Record which.
- [ ] Grok's write enforcement is advisory (composable graphs D4). State in the panel what that means for an unattended goal.
- [ ] Turn on `actions.goal` after the live run passes.

## Tests

- [ ] Catalogue reservation with live and restored rows.
- [ ] The live suite passes on Grok.

## Done when

- [ ] Grok passes every scenario in 109, and the capability is on, or the blocking gap is written down and it stays off.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
