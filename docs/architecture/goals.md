# Agent goals

Status: living. Owner modules:
[`native-agent-goal.ts`](../../packages/protocol/src/native-agent-goal.ts) (model,
transitions, carrier, command parsing) and
[`native-agent-goal-service.ts`](../../apps/backend/src/core/native-agent-goal-service.ts)
(the loop). The design and decisions are in
[`plans/goals.md`](../../plans/goals.md).

A goal is a durable objective on one native agent tab. The backend keeps sending
turns until a check proves the objective, the agent says it needs a person, or a
limit stops it. `/goal` behaves the same on every qualified provider, because the
backend runs the loop rather than each provider's own feature.

## The loop

1. A person sets a goal with an objective and, ideally, a check command. While the
   tab is idle, the objective goes out as a normal first turn. While a turn runs,
   the first evaluation waits for that turn's end.
2. A turn ends. `isAgentTurnEndTransition` wakes the service, or the activity sweep
   does when no edge fired, for example under a live background task.
3. `sessionRequestOutcome` says how the turn ended. The service never reads a
   transcript to decide this.
4. `nextGoalState`, a pure function, decides what happens:

| Turn ended | Agent reported | Result |
| --- | --- | --- |
| Stopped | any | `paused` (`user-stopped`) |
| Failed | any | `paused` (`turn-failed`, with the error) |
| Unknown | any | `paused` (`outcome-unknown`) |
| Completed | `blocked` | `blocked` |
| Completed | `done`, with a check | `checking`, then `complete` on exit 0, or another turn with the output |
| Completed | `done`, no check | `claimed`, shown as unverified |
| Completed | nothing or `progress` | another turn, unless a limit stops it |

A person's prompt during a goal is a turn like any other. It runs first, because
the queue is FIFO, and it does not count as an iteration. The goal continues after
it.

## Statuses

| Status | Meaning | What follows |
| --- | --- | --- |
| `active` | Turns continue | |
| `checking` | The backend is running the check | |
| `paused` | Stopped by a person, a failed turn, a stopped environment, no progress or a replaced conversation. `statusReason` says which | Resume |
| `blocked` | The agent needs a person | Resume |
| `limited` | The iteration cap or token budget was reached | Resume with a higher limit |
| `claimed` | The agent says it is done, and nothing checked it | A new goal |
| `complete` | The check passed | A new goal |

## Delivery

A continuation is a persisted prompt-queue message whose id is
`goal:<goalId>:<iteration>`. The new iteration number is written first and the id
derives from it, so a crash on either side of the enqueue re-sends the same id,
which the queue deduplicates. Text is rendered by `renderGoalCarrier`: it always
opens with `<orkestrator-goal`, so no provider can read a leading `/` or `!` as a
command, and objective, report and check output are JSON-escaped inside it so they
cannot form carrier structure. Taking a continuation out of the queue pauses the
goal.

## Limits

- **Iterations:** always on, default 20, at most 100. The first turn counts.
- **Tokens:** optional, on platforms in `GOAL_TOKEN_BUDGET_PLATFORMS`. Checked
  between turns from the provider's session counter; a running turn is never cut
  off.
- **No progress:** 3 consecutive continuations with no change to the workspace
  (commit, status and diff, hashed) and no report pause the goal. A workspace that
  is not a git checkout cannot say, so this stop does not apply there, and the cap
  still does.
- **Check:** 10 minutes. A check that times out or cannot start pauses the goal
  rather than telling the agent it failed. A check runs under `bash -lc` in the
  workspace, through the worker behind `environment.exec`, and runs again after a
  backend restart, so a check must be safe to repeat.

## The agent's tool

`report_goal` is on the agent MCP server, listed for every tab because a provider
may cache its tool list when a session starts. Its `goalId` comes from the goal's
own turn, so an environment-wide credential (OpenCode) cannot reach another tab's
goal by accident, and a tab-scoped credential must also match the goal's tab. It
never prompts for approval, because a parked report would stall the loop. It
records a claim; the service acts on it at the turn's end. An agent cannot set,
widen or complete a goal.

## Stops, restarts and side effects

- **Stop always wins.** No turn follows until a person resumes.
- **Backend restart:** `init` rebuilds the index and picks up running goals.
- **Replaced conversation:** a goal is bound to `providerSessionId`, and a different
  one pauses it. Resume rebinds it. A fork does not inherit it.
- **Stopped environment or runtime:** the goal pauses, through the sweep where no
  edge fires.
- **Attention:** a turn the goal will follow up rings nothing, and a coordinator is
  not woken by it. The loop rings once when it ends or needs a person. A person's
  own pause or Stop rings nothing, and a failed turn rings `agent_failed` on its
  own edge. The PR probe, change tracking and mail keep running on every turn end,
  because they only read state or deliver what is due.
- **Permissions:** a goal never changes the permission mode, so an approval parks
  the turn as usual. Unattended goals need a mode that does not ask.

## Writing a good goal

Name one end state and the command that proves it. Say what must not change. A
check proves only what it runs, so an agent could weaken a test to pass it; put
that constraint in the objective.

```text
/goal Make every test in test/auth pass without editing test files --check bun test test/auth
```

## Native goals stay off

Codex's `features.goals=false` stays, and `/goal` is reserved over a provider's own
row. Claude's `ProposeGoal` is in `disallowedTools`. See each bridge's `AGENTS.md`.
Any pin change can add a native goal or move a turn edge, so upgrades re-run
`mise run test:agent:goals`.
