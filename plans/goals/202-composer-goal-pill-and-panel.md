---
id: 202
title: "Composer goal pill and panel"
phase: 2
plan: "P2.2"
status: not-started
depends_on: [108, 201]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 202 · Composer goal pill and panel

- **Plan:** [P2.2 Composer goal pill and panel](../goals.md#p22-composer-goal-pill-and-panel)
- **Decisions:** D11, D14
- **Depends on:** [108](108-the-goal-slash-command.md), [201](201-goal-state-in-snapshots-and-events.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Users can see a goal's progress and control it without typing.

## Work

- [ ] Pill and panel, rendered from the snapshot, for every status including `checking` and the paused reasons.
- [ ] Set-goal form with objective, check, iteration cap and budget. The budget field is absent where the provider cannot support it.
- [ ] With no check, the form says the goal will end as unverified.
- [ ] Warn when the session's permission mode will stop for approvals, and link to the existing control. A goal never changes the mode (D11).
- [ ] Say that checks may run more than once and should be safe to repeat.
- [ ] Follow `docs/development/agent-testing.md` and the existing UI patterns, and check the narrow composer layout.

## Tests

- [ ] Component tests per status.
- [ ] Browser test: set, pause, resume and clear on a fake provider, including a reload mid-goal.

## Done when

- [ ] A user can run a goal end to end with the mouse, and a screenshot of each status is linked from Notes.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
