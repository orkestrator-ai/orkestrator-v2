---
id: 108
title: "The goal slash command"
phase: 1
plan: "P1.8"
status: not-started
depends_on: [002, 104, 105, 106, 107]
blocked_by: ""
owner: ""
branch: ""
pr: ""
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

- [ ] Add `goal` to `SessionActionCommandKind` and to the plan union in `native-agent-command-dispatch.ts`, and handle it in `performCommandSessionAction`.
- [ ] Parse arguments in protocol with exact, tested rules. `--check` takes the rest of the line, so a command can hold anything. The subcommand words are reserved as whole arguments only.
- [ ] `/goal <objective>` while idle sets the goal and starts the first turn with the objective. While a turn is running, it sets the goal and the first evaluation happens at that turn's end. Replacing an active goal needs `/goal clear` first.
- [ ] `/goal` with no arguments answers with a local status line and starts no model turn.
- [ ] Turn on `actions.goal` for Claude and Codex only, per `nativeCapabilities`.
- [ ] Check how the composer treats session actions (`native-command-submission.ts`, `useNativeCommandComposer.tsx`) so all forms work while busy, and adjust `inputPolicy.busy` if `queue`, `idle` and `running` cannot express it.

## Tests

- [ ] Argument parsing table, including hostile and multi-line text.
- [ ] Reserved collision: Claude's and Grok's own `/goal` rows disappear only when the capability is on.
- [ ] Every form through the dispatch path with a fake provider, idle and busy.

## Done when

- [ ] `/goal` drives the whole loop on fake Claude and Codex providers from a composer submission.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
