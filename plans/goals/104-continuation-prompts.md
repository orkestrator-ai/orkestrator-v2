---
id: 104
title: "Continuation prompts"
phase: 1
plan: "P1.4"
status: done
depends_on: [103]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1482"
updated: 2026-10-31
---

# 104 · Continuation prompts

- **Plan:** [P1.4 Continuation prompts](../goals.md#p14-continuation-prompts)
- **Decisions:** D6, D12
- **Depends on:** [103](103-goal-service-and-turn-edge-driver.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

The next goal turn reaches the agent exactly once, behind anything the user already queued.

## Work

- [x] `renderGoalContinuation` in protocol: objective, iteration and limit, the last report, and the failing check's output in an evidence frame, in the style of `renderAgentMailCarrier`.
- [x] The carrier never starts with `/` or `!`, so Claude's and Grok's literal-prompt refusal (`literalCommandSuppression`) and `!` handling cannot touch it. A test pins this for hostile objectives.
- [x] Send with `literal` intent, and keep the model, effort and mode the session last used.
- [x] Queue order: FIFO, so a prompt the user queued goes first. Mail waiting for the session keeps its own ordering; check what `agent-mail-service.ts` does at the same idle edge and record the result in Notes.
- [x] A goal paused or cleared while its continuation is still queued removes that queue entry, or the drain drops it when `goalId` or status no longer match.

## Tests

- [x] Crash between enqueue and dispatch sends one continuation. A duplicate wake sends none.
- [x] Pause, clear and replacement with a queued continuation.
- [x] Objective text containing carrier structure cannot break out of its frame.

## Done when

- [x] Continuations are exactly-once under the existing dispatch journal, with no new delivery path.

## Notes

**2026-10-31.** Mail: `agent-mail-service.ts` dispatches on its own at the same idle edge. Either order is safe, because the loop evaluates whatever the session's latest request is, so a mail turn counts as a turn and not an iteration. Fakes and code reading only; not exercised live.

A queue conflict was found by test: passing a custom fingerprint made every re-send conflict. The id is the identity, so a conflict now reads as `present`.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
