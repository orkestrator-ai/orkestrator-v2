---
id: 302
title: "Cursor"
phase: 3
plan: "P3.2"
status: not-started
depends_on: [108]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 302 · Cursor

- **Plan:** [P3.2 Cursor](../goals.md#p32-cursor)
- **Decisions:** D14
- **Depends on:** [108](108-the-goal-slash-command.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Goals work on Cursor through the SDK we use.

## Work

- [ ] Make sure the session-action row appears when the provider's catalogue is `unsupported`, and that a typed `/goal` reaches the backend.
- [ ] Confirm a typed `/goal` in a continuation or prompt does not reach any native goal in the SDK, using 001.
- [ ] Confirm stop-hook settings from a user's Cursor config do not fight with the loop. Record the behaviour.
- [ ] Turn on `actions.goal` after the live run passes.

## Tests

- [ ] Composer and dispatch with an `unsupported` catalogue.
- [ ] The live suite passes on Cursor.

## Done when

- [ ] Cursor passes every scenario in 109, and the capability is on.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
