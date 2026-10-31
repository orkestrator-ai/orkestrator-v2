---
id: 103
title: "Goal service and turn-edge driver"
phase: 1
plan: "P1.3"
status: not-started
depends_on: [001, 102]
blocked_by: ""
owner: ""
branch: ""
pr: ""
updated: 2026-10-31
---

# 103 · Goal service and turn-edge driver

- **Plan:** [P1.3 Goal service and turn-edge driver](../goals.md#p13-goal-service-and-turn-edge-driver)
- **Decisions:** D1, D5, D10
- **Depends on:** [001](001-provider-behaviour-probes.md), [102](102-goal-storage.md)
- **How to keep this file current:** [AGENTS.md](AGENTS.md)

## Goal

The backend decides what happens after every turn of a session with an active goal, whether or not any client is connected.

## Work

- [ ] Wake on the turn-end edge for sessions with an active goal, with no cost for sessions without one.
- [ ] Map outcomes: `completed` evaluates, `interrupted` and `failed` pause with a reason, `unknown` pauses with `outcome-unknown`, and `superseded` or `pending` waits for the later turn.
- [ ] A user prompt during a goal is a turn like any other: the goal continues after it, and it does not count as an iteration.
- [ ] A runtime that stopped mid-turn (`sessionStoppedMidTurn`) or a stopped environment pauses the goal, because the quiet settle announces no edge.
- [ ] Recovery on `init()`: for each active goal, re-derive the next step from durable state. Prefer extending the `native-queues` reconcile pass; add a `KEYED_SCHEDULING_DOMAINS` domain only if that cannot express it, and say why in Notes.
- [ ] Work is fenced with `withSessionWorkFence`, and every step re-reads the goal before acting.
- [ ] A catalogue entry in `recurring-work.ts` if this adds a recurring job, and none if it stays edge-driven.

## Tests

- [ ] Each outcome through a fake provider, including the `pending` then `completed` path.
- [ ] Seeded restart interleavings at each step of evaluate, enqueue and dispatch.
- [ ] A session with no goal does no extra provider or storage reads on a turn edge.

## Done when

- [ ] With fake providers, a goal advances, pauses and recovers correctly with no renderer attached.

## Notes

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
