---
id: 107
title: "Limits and no-progress stop"
phase: 1
plan: "P1.7"
status: done
depends_on: [103]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "pending"
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

- [x] Iteration cap: reaching it sets `limited` with the reason.
- [x] Token budget from the counters the backend already observes (`NativeAgentContextUsage`, see `agent-branch-observation.ts`). Crossing it between turns sets `limited`, and in-flight turns are not interrupted.
- [x] No-progress stop: 3 consecutive continuations with no workspace change and no report pause the goal. Use `change-tracking/turn-boundaries.ts` as the workspace signal if 001 shows it is available on every provider, and otherwise record what replaces it.
- [x] ~~Compaction is left to each provider. Record in Notes what 109 shows happens on a goal that fills the context.~~ (see 109: a forced overflow was not run)

## Tests

- [x] Cap, budget and no-progress stops through the service, including a resume that grants more iterations.
- [x] A provider with no usage answer refuses a budget at set time with a clear message.

## Done when

- [x] A fake agent that never finishes stops at each limit, with a reason a person can act on.

## Notes

**2026-10-31.** `tokensUsed` comes from the provider's session counter, and on every provider it includes context re-read each turn: a one-word Claude turn counts about 68,000. A budget therefore needs to be far larger than the words suggest; `docs/architecture/goals.md` says so. The cap and check-driven stops are proven live. The no-progress stop and the budget are proven with fakes only. Compaction: see 109.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
