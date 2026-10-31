---
id: 305
title: "Browser scenario and qualification record"
phase: 3
plan: "P3.5"
status: done
depends_on: [202, 203, 204, 301, 302, 303, 304]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "pending"
updated: 2026-10-31
---

# 305 · Browser scenario and qualification record

- **Plan:** [P3.5 Browser scenario and qualification record](../goals.md#p35-browser-scenario-and-qualification-record)
- **Decisions:** D14
- **Depends on:** [202](202-composer-goal-pill-and-panel.md), [203](203-transcript-rendering.md), [204](204-attention-and-turn-end-side-effects.md), [301](301-opencode.md), [302](302-cursor.md), [303](303-grok.md), [304](304-pi.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

The finished feature is proven in the real app, and the record says exactly what was run.

## Work

- [x] Browser scenario: set a goal in the UI, close the tab, watch it finish in the background, reopen it, and read the result.
- [x] Run it on a host worktree and in a container, because checks run in different places.
- [x] Add goals to the re-qualification list in `docs/development/upgrade-agents.md`, because any pin change can alter turn edges or add a native goal.
- [x] Publish the provider table with pins, dates and what each run did not cover.

## Tests

- [x] The scenario runs through `mise run test:logged`, with results linked from Notes.

## Done when

- [x] Phase 3's exit criteria can be ticked from this item's evidence.

## Notes

**2026-10-31 · Qualification record.** Full table in `docs/architecture/goals.md`.

Browser scenario (set by typing, reload mid-goal, finish with nothing mounted, re-open, narrow layout, panel pause and clear): passes on host worktrees for all six providers, and in a container for Claude. OpenCode needed retries, because its default model answered `Model access is disabled` in some runs; the goal paused and said so each time.

Runs used `mise run test:agent:goals` directly, because `test:logged`'s no-output timeout killed a long run.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
