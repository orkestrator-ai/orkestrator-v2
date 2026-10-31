---
id: 301
title: "OpenCode"
phase: 3
plan: "P3.1"
status: not-started
depends_on: [108]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 301 · OpenCode

- **Plan:** [P3.1 OpenCode](../goals.md#p31-opencode)
- **Decisions:** D14
- **Depends on:** [108](108-the-goal-slash-command.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Goals work on OpenCode with the same behaviour.

## Work

- [ ] Finish `report_goal` caller resolution for an environment credential, so one tab's report can never land on another tab's goal.
- [ ] Confirm continuation dispatch and outcomes through `session.command` and the SDK provider, using the 001 table.
- [ ] If a later OpenCode pin ships a goal command, reserve it and record how to keep it off in `docs/architecture/agent-engines.md`.
- [ ] Turn on `actions.goal` after the live run passes.

## Tests

- [ ] Two OpenCode tabs in one environment with different goals.
- [ ] The live suite passes on OpenCode.

## Done when

- [ ] OpenCode passes every scenario in 109, and the capability is on.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
