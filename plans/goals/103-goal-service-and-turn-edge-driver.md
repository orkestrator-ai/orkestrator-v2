---
id: 103
title: "Goal service and turn-edge driver"
phase: 1
plan: "P1.3"
status: done
depends_on: [001, 102]
blocked_by: ""
owner: "Claude Opus 5.5 (investigate-goal-command)"
branch: "investigate-goal-command-c4666baa82d9-r1"
pr: "https://github.com/orkestrator-ai/orkestrator-v2/pull/1482"
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

- [x] Wake on the turn-end edge for sessions with an active goal, with no cost for sessions without one.
- [x] Map outcomes: `completed` evaluates, `interrupted` and `failed` pause with a reason, `unknown` pauses with `outcome-unknown`, and `superseded` or `pending` waits for the later turn.
- [x] A user prompt during a goal is a turn like any other: the goal continues after it, and it does not count as an iteration.
- [x] A runtime that stopped mid-turn (`sessionStoppedMidTurn`) or a stopped environment pauses the goal, because the quiet settle announces no edge.
- [x] Recovery on `init()`: for each active goal, re-derive the next step from durable state. Prefer extending the `native-queues` reconcile pass; add a `KEYED_SCHEDULING_DOMAINS` domain only if that cannot express it, and say why in Notes.
- [x] Work is fenced with `withSessionWorkFence`, and every step re-reads the goal before acting.
- [x] A catalogue entry in `recurring-work.ts` if this adds a recurring job, and none if it stays edge-driven.

## Tests

- [x] Each outcome through a fake provider, including the `pending` then `completed` path.
- [x] ~~Seeded restart interleavings at each step of evaluate, enqueue and dispatch.~~ (replaced: crash-point tests and a live killed backend, see Notes)
- [x] A session with no goal does no extra provider or storage reads on a turn edge.

## Done when

- [x] With fake providers, a goal advances, pauses and recovers correctly with no renderer attached.

## Notes

**2026-10-31.** No new scheduling domain or recurring job: the service wakes on the turn-end edge and from the activity sweep, rate limited to 5 s and free with no running goal. The sweep is what catches a stopped environment and a turn end under a live background task. Restart coverage is crash-point tests plus `goals-restart-live.spec.ts` against a killed backend, rather than seeded interleavings.

**2026-10-31 · Bug the live restart case found.** After a turn died mid-way, a resumed goal's continuation waited forever, because the queue parks on a terminal error. A goal turn now passes that error: only a person's resume can lead there, and another failure pauses the goal, so it cannot burn a queue.

## Progress log

Newest last: `YYYY-MM-DD · who · what changed · next step`.

- 2026-10-31 · plan · Created from the plan. · Not started.
- 2026-10-31 · Claude Opus 5.5 (investigate-goal-command) · Delivered with the goals branch; see Notes for what was proven live and what was not. · Awaiting review.
