---
id: 108
title: "The goal slash command"
phase: 1
plan: "P1.8"
status: done
depends_on: [002, 104, 105, 106, 107]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "pending"
updated: 2026-10-31
---

# 108 · The goal slash command

- **Plan:** [P1.8 The goal slash command](../goals.md#p18-the-goal-slash-command)
- **Decisions:** D2, D3, D14
- **Depends on:** [002](002-close-the-native-goal-paths.md), [104](104-continuation-prompts.md), [105](105-agent-signal-tool.md), [106](106-done-check.md), [107](107-limits-and-no-progress-stop.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

`/goal` sets, reads and controls a goal from the composer on qualified providers.

## Work

- [x] Add `goal` to `SessionActionCommandKind` and to the plan union in `native-agent-command-dispatch.ts`, and handle it in `performCommandSessionAction`.
- [x] Parse arguments in protocol with exact, tested rules. `--check` takes the rest of the line, so a command can hold anything. The subcommand words are reserved as whole arguments only.
- [x] `/goal <objective>` while idle sets the goal and starts the first turn with the objective. While a turn is running, it sets the goal and the first evaluation happens at that turn's end. Replacing an active goal needs `/goal clear` first.
- [x] `/goal` with no arguments answers with a local status line and starts no model turn.
- [x] Turn on `actions.goal` for Claude and Codex only, per `nativeCapabilities`.
- [x] Check how the composer treats session actions (`native-command-submission.ts`, `useNativeCommandComposer.tsx`) so all forms work while busy, and adjust `inputPolicy.busy` if `queue`, `idle` and `running` cannot express it.

## Tests

- [x] Argument parsing table, including hostile and multi-line text.
- [x] Reserved collision: Claude's and Grok's own `/goal` rows disappear only when the capability is on.
- [x] Every form through the dispatch path with a fake provider, idle and busy.

## Done when

- [x] `/goal` drives the whole loop on fake Claude and Codex providers from a composer submission.

## Notes

**2026-10-31.** `/goal` has no `busy` policy, so it neither queues nor interrupts. Handled before anything is journaled, so it cannot disturb turn tracking. A typed `/goal` from the queue also works, by test.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
