---
id: 301
title: "OpenCode"
phase: 3
plan: "P3.1"
status: done
depends_on: [108]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1482"
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

- [x] Finish `report_goal` caller resolution for an environment credential, so one tab's report can never land on another tab's goal.
- [x] Confirm continuation dispatch and outcomes through `session.command` and the SDK provider, using the 001 table.
- [x] If a later OpenCode pin ships a goal command, reserve it and record how to keep it off in `docs/architecture/agent-engines.md`.
- [x] Turn on `actions.goal` after the live run passes.

## Tests

- [x] Two OpenCode tabs in one environment with different goals.
- [x] The live suite passes on OpenCode.

## Done when

- [x] OpenCode passes every scenario in 109, and the capability is on.

## Notes

**2026-10-31.** Live: every loop scenario passes, and `report_goal` reaches the right goal by id. Tool approval uses the same allow list as mail. Upstream's goal plugin is unreleased, so `docs/architecture/agent-engines.md` says to reserve it on a pin that ships it. Availability of its default models varied during the runs (see 109).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
