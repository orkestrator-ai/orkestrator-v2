---
id: 107
title: "Limits and no-progress stop"
phase: 1
plan: "P1.7"
status: not-started
depends_on: [103]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 107 · Limits and no-progress stop

- **Plan:** [P1.7 Limits and no-progress stop](../goals.md#p17-limits-and-no-progress-stop)
- **Decisions:** D9
- **Depends on:** [103](103-goal-service-and-turn-edge-driver.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

No goal can run or spend without bound, and a stuck agent stops early.

## Work

- [ ] Iteration cap: reaching it sets `limited` with the reason.
- [ ] Token budget from the counters the backend already observes (`NativeAgentContextUsage`, see `agent-branch-observation.ts`). Crossing it between turns sets `limited`, and in-flight turns are not interrupted.
- [ ] No-progress stop: 3 consecutive continuations with no workspace change and no report pause the goal. Use `change-tracking/turn-boundaries.ts` as the workspace signal if 001 shows it is available on every provider, and otherwise record what replaces it.
- [ ] Compaction is left to each provider. Record in Notes what 109 shows happens on a goal that fills the context.

## Tests

- [ ] Cap, budget and no-progress stops through the service, including a resume that grants more iterations.
- [ ] A provider with no usage answer refuses a budget at set time with a clear message.

## Done when

- [ ] A fake agent that never finishes stops at each limit, with a reason a person can act on.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
