---
id: 104
title: "Continuation prompts"
phase: 1
plan: "P1.4"
status: not-started
depends_on: [103]
blocked_by: ""
owner: ""
branch: ""
pr: ""
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

- [ ] `renderGoalContinuation` in protocol: objective, iteration and limit, the last report, and the failing check's output in an evidence frame, in the style of `renderAgentMailCarrier`.
- [ ] The carrier never starts with `/` or `!`, so Claude's and Grok's literal-prompt refusal (`literalCommandSuppression`) and `!` handling cannot touch it. A test pins this for hostile objectives.
- [ ] Send with `literal` intent, and keep the model, effort and mode the session last used.
- [ ] Queue order: FIFO, so a prompt the user queued goes first. Mail waiting for the session keeps its own ordering; check what `agent-mail-service.ts` does at the same idle edge and record the result in Notes.
- [ ] A goal paused or cleared while its continuation is still queued removes that queue entry, or the drain drops it when `goalId` or status no longer match.

## Tests

- [ ] Crash between enqueue and dispatch sends one continuation. A duplicate wake sends none.
- [ ] Pause, clear and replacement with a queued continuation.
- [ ] Objective text containing carrier structure cannot break out of its frame.

## Done when

- [ ] Continuations are exactly-once under the existing dispatch journal, with no new delivery path.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
