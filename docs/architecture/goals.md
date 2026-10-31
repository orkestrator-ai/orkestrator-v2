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
goal. Publication and provider handoff both check the current goal identity,
active status and iteration. Carriers preserve the session mode. A parked
dispatch pauses the goal with its error. Queue retries keep the iteration
identity; resuming the goal creates a new one after a retired delivery.

## Limits

- **Iterations:** always on, default 20, at most 100. The first turn counts.
- **Tokens:** optional, on platforms in `GOAL_TOKEN_BUDGET_PLATFORMS`. Checked
  between turns from the provider's session counter; a running turn is never cut
  off. If OpenCode's lightweight snapshot omits usage, a bounded authoritative
  transcript read meters the background tab. That counter includes context re-read on each turn, so a one-word Claude turn
  counts about 68,000. Set a budget in hundreds of thousands.
- **No progress:** 3 consecutive continuations with no change to the workspace
  (commit, status, tracked diff and untracked contents, hashed) and no report
  pause the goal. A workspace that is not a git checkout cannot say, so this stop does not apply there, and the cap
  still does.
- **Check:** 10 minutes. A check that times out or cannot start pauses the goal
  rather than telling the agent it failed. A check runs under `bash -lc` in the
  workspace, through the worker behind `environment.exec`, and may run again after a
  backend restart, so a check must be safe to repeat. Worker identities are
  durable: recovery adopts a worker still running. Stop, delete and move drain
  checks and their descendants before changing the environment. Backend shutdown
  cancels checks and keeps the goal in recoverable `checking` state. Exited
  worker directories are removed after reading the output tail.

## The agent's tool

`report_goal` is on the agent MCP server, listed for every tab because a provider
may cache its tool list when a session starts. Its `goalId` comes from the goal's
own turn, so an environment-wide credential (OpenCode) cannot reach another tab's
goal by accident, and a tab-scoped credential must also match the goal's tab. It
never prompts for approval, because a parked report would stall the loop. It
records a claim; the service acts on it at the turn's end. An agent cannot set,
widen or complete a goal.

## Stops, restarts and side effects

- **Stop always wins.** It pauses the goal directly, including queued carriers
  and provider startup while activity still says idle. Provider interruption
  runs concurrently so a pending dispatch's storage lease cannot delay the abort.
  No turn follows until a person resumes.
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

## Verifier and other surfaces

`/goal <objective> --verifier <agent>[:model]` adds a fresh read-only session that
judges a `done` report and returns a verdict, in `native-agent-goal-verifier.ts`. With
both a check and a verifier, the check runs first and both must pass. Its spend
counts toward the budget, and it can take several minutes. Read-only enforcement
follows the provider's tier, so it is advisory on Grok.

Scripts use `orkestrator session goal`
([public-cli.md](public-cli.md)), and a coordinator uses `set_worker_goal` and its
neighbours ([coordinator.md](coordinator.md)). Coordinator tools cannot supply
shell checks; only a person may configure one through the composer or public API.
Coordinator goals finish as unverified claims.

## Native goals stay off

Codex's `features.goals=false` stays, and `/goal` is reserved over a provider's own
row. Claude's `ProposeGoal` is in `disallowedTools`. See each bridge's `AGENTS.md`.
Any pin change can add a native goal or move a turn edge, so upgrades re-run
`mise run test:agent:goals`.

Cursor is the exception: its model is offered `CreateGoal` and `UpdateGoal`, and
`@cursor/sdk` 1.2.0 has no way to turn them off. The carrier tells the agent to use
no other goal tool, which reduces the chance without closing the path.

## Qualification

Live on 2026-10-31 at Claude 2.1.314, Codex 0.166.0, OpenCode 1.19.5, Cursor SDK
1.2.0, Grok 1.0.70 and Pi 1.4.0, with each provider's default model.

| Provider | Loop scenarios | Background task | Compact then resume | Verifier | Browser, host |
| --- | --- | --- | --- | --- | --- |
| Claude | Pass | Pass | Pass | Pass | Pass, and in a container |
| Codex | Pass | Pass | Pass | Pass, slowly | Pass |
| OpenCode | Pass | Pass | Goal passes; the compact itself failed | Pass | Pass |
| Cursor | Pass | Pass | Pass, with no compact to run | Pass | Pass |
| Grok | Pass, with no shell step | Pass | Pass | Pass | Pass |
| Pi | Pass | Pass | Goal passes; the compact itself failed | Pass | Pass |

Loop scenarios are a check passing after several iterations, no check, a check that
never passes, `blocked`, Stop and resume, and a queued user prompt. On Claude,
`goals-restart-live.spec.ts` also kills the backend during a check and mid-turn. On
Claude and Codex, the coordinator scenario delegates a goal and gets one wake.

The no-progress stop (four unchanged turns) and token budget exhaustion (one turn)
passed live on all six providers. First and later continuations preserved Plan on
Claude, Codex, OpenCode, Cursor and Grok; OpenCode uses its primary Plan profile.
Pi exposes no Plan mode or Plan profile, so its inherited-mode handoff is covered
by deterministic provider dispatch tests instead.

The review repair reran the full deterministic suite, typecheck, lint and format
checks successfully, plus the CLI scenario and Docker fixture suites. The live
repair sweep repeats the loop and limits cases; compact, verifier, background and
browser cases had already passed in the six-provider sweep. Rejected dispatch,
publication/cancellation races, untracked-file progress, check shutdown and local
environment stop/delete/move have deterministic regression coverage. A 17 MiB
trace regression confirms sanitization retains oversized failure evidence; live
failure traces also survived without an artifact bound error.

The component browser rerun had 988 passes, 106 skips and two failures in the
unchanged `AgentLaunchDialog` branch picker (desktop and mobile). Its owning file
also failed alone; the observations are recorded in the existing
[validation case](../tests/flaky-tests/aggregate-validation-runs/0958-transcript-scroll-review-validation.md).
The separate public-site browser suite passed.

Later OpenCode reruns exhausted the default Big Pickle model's free allowance.
A retained fixture confirmed `turn.phase: error` with `Free limit reached`, no
usage and no goal reports. Its final limit probe therefore did not qualify the
transcript-usage fallback live; that fallback has a deterministic background-tab
regression. The earlier OpenCode loop, Plan, no-progress and budget run passed.
The later Claude, Codex and Cursor repair runs passed, including Cursor Stop
during startup. Claude restart recovery and the Codex coordinator goal flow also
passed. Disposable profiles were stopped and reset after qualification.

Not proven live:

- A failed turn, except on OpenCode, where a real upstream 403 paused the goal. The
  others rely on fakes.
- A context overflow during a goal. A compact while a goal waits stands in for it.
- A goal extension on Pi, or a stop hook in a user's Cursor config.
- A worker on another node: its delegation can wake a coordinator between iterations.

Known problems found on the way, not caused by goals and not fixed here: Grok's shell
fails to spawn in Orkestrator sessions, and a typed `/compact` delivered through the
prompt queue leaves a Codex tab `running`.
