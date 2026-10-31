---
id: 305
title: "Browser scenario and qualification record"
phase: 3
plan: "P3.5"
status: not-started
depends_on: [202, 203, 204, 301, 302, 303, 304]
blocked_by: ""
owner: ""
branch: ""
pr: ""
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

- [ ] Browser scenario: set a goal in the UI, close the tab, watch it finish in the background, reopen it, and read the result.
- [ ] Run it on a host worktree and in a container, because checks run in different places.
- [ ] Add goals to the re-qualification list in `docs/development/upgrade-agents.md`, because any pin change can alter turn edges or add a native goal.
- [ ] Publish the provider table with pins, dates and what each run did not cover.

## Tests

- [ ] The scenario runs through `mise run test:logged`, with results linked from Notes.

## Done when

- [ ] Phase 3's exit criteria can be ticked from this item's evidence.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
