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

- [x] Pill and panel, rendered from the snapshot, for every status including `checking` and the paused reasons.
- [x] Set-goal form with objective, check, iteration cap and budget. The budget field is absent where the provider cannot support it.
- [x] With no check, the form says the goal will end as unverified.
- [x] Warn when the session's permission mode will stop for approvals, and link to the existing control. A goal never changes the mode (D11).
- [x] Say that checks may run more than once and should be safe to repeat.
- [x] Follow the existing UI patterns (shadcn dialog, `ComposerIconPicker`, tile tones), and lay out for a narrow composer in code: the pill's objective gives way first.
- [ ] Check the narrow composer layout in a browser, per `docs/development/agent-testing.md`.

## Tests

- [x] Component tests per status.
- [ ] Browser test: set, pause, resume and clear on a fake provider, including a reload mid-goal.

## Done when

- [ ] A user can run a goal end to end with the mouse, and a screenshot of each status is linked from Notes.

## Notes

- 2026-10-31: The pill is in a new `statusAccessory` slot on `NativeComposeDock` and `NativeChatShell`, shown in both the centered and docked layouts, and shares the row with `topAccessory`. With no goal, the way in is an icon button in the composer toolbar, `goal-open-button`, so most tabs gain no height.
- 2026-10-31: The panel is a dialog (`apps/web/src/components/chat/GoalPanel.tsx`), because the UI kit has no popover. "Link to the existing control" is met by showing the session's own approval picker beside the warning. Besides the kinds `ask` and `auto-edits`, plan mode also warns, because it stops for plan approval.
- 2026-10-31: The form builds `/goal` arguments and parses them back with `parseGoalCommandArguments`, so an objective such as `resume` or `fix --budget 5` is refused instead of silently becoming something else.
- 2026-10-31: `/goal` and `/goal status` open the panel. A set or resume is refused while an agent handoff is pending, because a goal's turns cannot carry the transferred history. Pause and clear still work then.
- 2026-10-31: `useNativeAgentSession` copied state fields one by one and dropped `goal`, so the progressive path needed it added at both sites.
- 2026-10-31: `verifying` and the verifier fields arrived in the protocol during this work. The pill, panel and rows show them, but the form has no verifier field; `/goal ... --verifier` is the only way to set one.
- 2026-10-31: Screenshots are not linked yet. They need the browser run below.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Code · Pill, panel, form and `/goal` submission built, with component tests. · Browser test and screenshots remain.
