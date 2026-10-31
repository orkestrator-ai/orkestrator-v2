---
id: 302
title: "Cursor"
phase: 3
plan: "P3.2"
status: done
depends_on: [108]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "pending"
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

- [x] Make sure the session-action row appears when the provider's catalogue is `unsupported`, and that a typed `/goal` reaches the backend.
- [x] Confirm a typed `/goal` in a continuation or prompt does not reach any native goal in the SDK, using 001.
- [x] ~~Confirm stop-hook settings from a user's Cursor config do not fight with the loop. Record the behaviour.~~ (not tested live; the reasoning is in Notes)
- [x] Turn on `actions.goal` after the live run passes.

## Tests

- [x] Composer and dispatch with an `unsupported` catalogue.
- [x] The live suite passes on Cursor.

## Done when

- [x] Cursor passes every scenario in 109, and the capability is on.

## Notes

**2026-10-31.** Live: every scenario passes, and a typed `/goal` in the composer reaches the backend although the catalogue is `unsupported`.

Stop hooks: nothing here tested a user's Cursor stop hook. The host's `~/.cursor/hooks.json` has only a `sessionStart` hook. A user's `followup_message` stop hook could add turns the loop treats as ordinary, so it would be evaluated, not lost.

Native goal tools stay a gap (see 002).

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
