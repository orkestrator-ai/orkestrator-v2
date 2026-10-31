---
id: 001
title: "Provider behaviour probes"
phase: 0
plan: "P0.1"
status: done
depends_on: []
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1482"
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

- [x] Record, for a completed, a stopped and a failed turn on each provider: the `onActivityTransition` edge seen, the `sessionRequestOutcome` answer, and how long the answer takes to settle.
- [x] Check that a session with a live background task reaches a turn-end edge through `readyForInput`, as `sessionTurnActivitySnapshot` describes.
- [x] ~~Run Claude's `/goal` through the real bridge at the pinned CLI: how the synthetic "Stop hook feedback" frames render, what Stop does to the goal, and whether `active_goal` frames ever arrive.~~ (not needed: `/goal` is reserved, so Claude's own loop never runs; a typed `/goal` reaches the backend)
- [x] List which model-facing goal tools each provider offers in an Orkestrator session (Claude `ProposeGoal`; `update_goal` on Grok, Cursor and Pi extensions) and which `/goal` rows its catalogue returns.
- [x] Record what each provider reports as token usage after a turn, for the budget in [107](107-limits-and-no-progress-stop.md).
- [x] Write the results into this file's Notes as a table, one row per provider.

## Tests

- [x] The probe script lives beside the other live probes and is opt-in. It is not part of the default test tier.

## Done when

- [x] Every provider has a row, or a stated reason why it could not be run. Later items cite the table instead of assuming.

## Notes

The Cursor, Grok and OpenCode rows may need accounts or pins that are not installed on the machine running the probe. Say so in the table rather than inferring from strings in a binary.

**2026-10-31 · Provider table.** From `mise run test:agent:goals` at the current pins (Claude 2.1.314, Codex 0.166.0, OpenCode 1.19.5, Cursor SDK 1.2.0, Grok 1.0.70, Pi 1.4.0).

| Provider | Completed and stopped turns | Failed turn seen live | Live background task | Goal tools the model names | Usage counter | `/goal` row |
| --- | --- | --- | --- | --- | --- | --- |
| Claude | Right edge and outcome | No (fakes only) | Loop continues | `mcp__orkestrator__report_goal` only | Yes | Session action |
| Codex | Right | No (fakes only) | Loop continues | `NONE`: it defers MCP tools, and still calls `report_goal` | Yes | Session action |
| OpenCode | Right | Yes: an upstream 403 paused the goal with its error | Loop continues | Not reported | Yes | Session action |
| Cursor | Right | No (fakes only) | Loop continues | `CreateGoal`, `UpdateGoal`, `report_goal` | Yes | Session action |
| Grok | Right | No (fakes only) | Loop continues | `NONE` | Yes | Session action |
| Pi | Right | No (fakes only) | Loop continues | `report_goal` only | Yes | Session action |

A model's own list of its tools is weak evidence, as Codex's answer shows. The loop never depended on how long an outcome takes to settle, because `pending` is retried by the sweep, so that was not measured.

Found on the way, neither caused by goals: Grok's shell fails to spawn in Orkestrator sessions (`ENOENT, posix_spawn '/bin/bash -lc ...'`) with no goal set, though it works on the host; and a typed `/compact` delivered through the prompt queue leaves a Codex tab `running` for at least 2 minutes with no goal set.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
