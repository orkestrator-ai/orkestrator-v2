---
id: 001
title: "Provider behaviour probes"
phase: 0
plan: "P0.1"
status: not-started
depends_on: []
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 001 · Provider behaviour probes

- **Plan:** [P0.1 Provider behaviour probes](../goals.md#p01-provider-behaviour-probes)
- **Decisions:** D1, D5, D10
- **Depends on:** none
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

Replace assumptions about turn edges and native goals with recorded facts for all six providers.

## Work

- [ ] Record, for a completed, a stopped and a failed turn on each provider: the `onActivityTransition` edge seen, the `sessionRequestOutcome` answer, and how long the answer takes to settle.
- [ ] Check that a session with a live background task reaches a turn-end edge through `readyForInput`, as `sessionTurnActivitySnapshot` describes.
- [ ] Run Claude's `/goal` through the real bridge at the pinned CLI: how the synthetic "Stop hook feedback" frames render, what Stop does to the goal, and whether `active_goal` frames ever arrive.
- [ ] List which model-facing goal tools each provider offers in an Orkestrator session (Claude `ProposeGoal`; `update_goal` on Grok, Cursor and Pi extensions) and which `/goal` rows its catalogue returns.
- [ ] Record what each provider reports as token usage after a turn, for the budget in [107](107-limits-and-no-progress-stop.md).
- [ ] Write the results into this file's Notes as a table, one row per provider.

## Tests

- [ ] The probe script lives beside the other live probes and is opt-in. It is not part of the default test tier.

## Done when

- [ ] Every provider has a row, or a stated reason why it could not be run. Later items cite the table instead of assuming.

## Notes

The Cursor, Grok and OpenCode rows may need accounts or pins that are not installed on the machine running the probe. Say so in the table rather than inferring from strings in a binary.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
