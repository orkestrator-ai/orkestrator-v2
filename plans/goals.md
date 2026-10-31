# Agent goals plan

Status: proposed 2026-10-31. The decisions below are recommendations from the
2026-10-30 investigation and are not yet confirmed by the maintainer. Nothing
is built.

Work items and their status: [`plans/goals/000-index.md`](goals/000-index.md).
Each Pn.m section below is one numbered file there (P1.3 is `103`).

## Objective

Let a user give any native agent tab a durable objective and a way to prove it
is finished. The agent then keeps working across turns without being prompted,
until the proof passes, it needs a person, or a limit stops it. `/goal` behaves
the same on Claude, Codex, OpenCode, Cursor, Grok and Pi.

## Background

What providers offered when this was investigated on 2026-10-30:

| Agent | Native goal | Who decides it is done | Through our integration |
| --- | --- | --- | --- |
| Claude | `/goal`, session-scoped, restored on resume | A separate small model reads the transcript; it cannot run tools | Not blocked, so it probably works today. Not tested in the app |
| Codex | `/goal` and `thread/goal/*`, with pause and token budget | The model marks it complete with `update_goal` | Reachable, but turned off with `features.goals=false` |
| Cursor | `/goal` in the CLI, "rolling out and gated" | Not documented | No: `@cursor/sdk` 1.2.0 has no goal strings, and its catalogue is `unsupported` |
| Grok | `/goal` with a checklist, pause and resume | Binary strings show `update_goal` and a classifier | Unknown: not documented or tested over ACP |
| OpenCode | Not in the 1.19.4 binary; a core plugin on an unreleased branch; community plugins | Varies by plugin | No |
| Pi | Not in 1.4.0; the third-party `pi-xai` extension adds it | `update_goal` | No |

Two live probes shaped the design:

- **Codex (installed 0.159.3, pin 0.166.0).** `thread/goal/set` started a turn
  with no `turn/start`, and Codex then continued on its own. The bridge handles
  only events for the turn it dispatched
  (`bridges/codex-bridge/src/app-server-runtime-lifecycle.ts`), so those turns
  would be dropped.
- **Claude (Agent SDK 0.3.314).** The whole loop arrived as one `result`, with
  evaluator feedback as synthetic "Stop hook feedback" user frames. The declared
  `active_goal` frame never appeared.

Codex goals were turned off on purpose in the 2026-10-30 provider upgrade. The
recorded condition for revisiting is "a goal surface and a design for turns
Codex continues on its own"
([0007](../docs/todo/agent-engines/0007-provider-sdk-adoption-backlog.md),
[1020](../docs/todo/agent-engines/1020-provider-upgrade-2026-10-30.md)). This
plan meets that condition by having no such turns.

Sources:
[Claude Code `/goal`](https://code.claude.com/docs/en/goal.md),
[OpenAI: follow goals](https://learn.chatgpt.com/use-cases/follow-goals),
[Cursor changelog](https://cursor.com/changelog/08-19-26),
[Cursor CLI changelog](https://cursor.com/docs/cli/changelog),
[xAI: introducing `/goal`](https://x.ai/news/introducing-goal),
[OpenCode PR #59850](https://github.com/anomalyco/opencode/pull/59850),
[`pi-xai`](https://pi.dev/packages/pi-xai?name=Plan).

## How a goal runs

1. The user sets a goal with an objective and, ideally, a check command. The
   objective goes to the agent as a normal first turn.
2. A turn ends. The backend reads how it ended from durable state.
3. If the turn was stopped or failed, the goal pauses, with the reason.
4. If the agent called `report_goal` with `blocked`, the goal ends as `blocked`.
5. If it reported `done`, the backend runs the check. A pass ends the goal as
   `complete`. A failure sends the output back to the agent. With no check, the
   goal ends as `claimed`, which the UI shows as unverified.
6. Otherwise, if no limit is reached, the backend queues the next continuation.

### Status table

| Status | Meaning | Ends the loop? |
| --- | --- | --- |
| `active` | Turns continue | No |
| `checking` | The backend is running the check | No |
| `paused` | Stopped by the user, a failed turn, a stopped environment, no progress or a replaced session. `statusReason` says which. Resume continues it | Until resumed |
| `blocked` | The agent says it needs a person | Yes, until resumed |
| `limited` | An iteration cap or token budget was reached. Resume with a higher limit | Until resumed |
| `claimed` | The agent says it is done and nothing checked it | Yes |
| `complete` | A check passed | Yes |

`/goal clear` removes the goal, in any status.

## Decisions

Proposed, pending the maintainer's confirmation. The last column records what
was considered and turned down. Changing a decision means editing its row and
saying why.

| # | Question | Decision | Rejected alternatives |
| --- | --- | --- | --- |
| D1 | Who runs the loop? | The Orkestrator backend, on every provider. | Wrap each provider's `/goal`: semantics differ, and only two of six are confirmed reachable. A mix of both: two behaviours to explain and test. |
| D2 | What about native goals? | They stay off. `features.goals=false` stays. Our `/goal` reserves the name, so a provider's own row is hidden when the capability is on. Model-facing goal tools are disabled where the provider allows it (002). | Offer both, as `/goal` and `/native-goal`: two loops could stack in one session. |
| D3 | Scope | Native agent tabs, one goal per session. Not terminal agents, coordinator conversations, or graph and pipeline sessions, which have their own loops. | Multiple goals per session. Goals across several sessions: that is what graphs are for. |
| D4 | Who can set a goal? | A person, through the composer, and later the CLI and a coordinator. An agent can only report on one. | Model-facing `create_goal` or `ProposeGoal`: an agent could give itself hours of unattended turns. |
| D5 | What triggers evaluation? | The existing turn-end edge and durable turn outcomes. | Provider stop hooks: not available everywhere. A new poll per session. Reading the transcript to infer an end. |
| D6 | How is the next turn sent? | Through the persisted prompt queue with a deterministic request id, behind anything the user queued. | A new delivery path. Steering into a running turn: it does not start a turn. |
| D7 | What makes a goal complete? | A passing check. An agent's `done` with no check ends as `claimed`, shown as unverified. A verifier session may be added later (401). | Trusting the agent's report, as Codex does: the same model marks its own work. A transcript-only evaluator, as Claude does: it cannot run anything, and it needs a small-model path per provider. Requiring a check on every goal: it rules out exploratory goals. |
| D8 | How does the check run? | The user's command, once per `done` report, through the `environment.exec` worker, in the workspace. Failure output returns to the agent as framed evidence. The agent cannot edit it. | Running it after every turn: slow and costly for long test suites. Letting the agent run it and trusting the transcript. |
| D9 | What limits a goal? | An iteration cap, always on: default 20, at most 100. An optional token budget. A no-progress stop after 3 idle continuations. | Unbounded by default, as Claude and Codex are unless the user adds a clause or a budget. Wall-clock limits in version 1: iterations and tokens bound cost more directly. |
| D10 | Stops, failures and restarts | Stop always wins and pauses. A failed turn pauses with no automatic retry in version 1. A stopped environment pauses. A backend restart resumes active goals, because exact-once delivery makes that safe. | Retrying automatically, as Claude does: rate limits and credit errors need their own policy. Pausing on restart, as OpenCode's plugin does: it breaks the rule that background work survives. |
| D11 | Permissions | A goal never changes the permission mode. An approval parks the turn as usual, and the UI warns when a mode will need approvals. | Auto-approving during a goal: unattended writes need an explicit choice. |
| D12 | How visible is a continuation? | A collapsed tile, never a user bubble. Attention rings once, when the goal ends or pauses. | Plain user messages. Ringing on every turn end: a 20-iteration goal would ring 20 times. |
| D13 | What is the agent's tool called? | `report_goal`, on the agent MCP server. It never prompts for approval. | `update_goal`: it collides with the native tool on Codex, Grok, Cursor and Pi extensions, and the model could call the wrong one. |
| D14 | Rollout | Per provider through an `actions.goal` capability. Claude and Codex first. Each provider's capability turns on only after its live run passes. | All six at once: the provider differences are exactly what is unproven. A global setting: capabilities are how every other session action is gated. |
| D15 | Where does a goal live? | A field on the session record, so it changes atomically with the session and dies with it. | A separate store, as graph runs have: it adds fencing and cleanup for one record per session. |

## Non-goals

- Planning or checklists, as Grok's goal panel has. The agent can keep its own.
- Scheduling and intervals. Scheduled jobs and `/loop` already cover those.
- Fresh sessions per iteration. Graph loops already do that.
- Changing permission modes or sandboxing.
- Automatic retry of failed turns (D10).

## Invariants

- State lives in the backend. Closing a tab, reloading or disconnecting never
  stops or changes a goal.
- Stop always wins. No turn starts after a Stop until the user resumes.
- One continuation per iteration, across any crash or replay.
- Sessions with no goal pay nothing on a turn edge.
- An agent cannot set, widen or complete a goal by itself. It can only report.
- Agent reports and check output are untrusted text. They reach a model only in
  an evidence frame, and they are bounded in storage and on the wire.
- Every goal has an iteration cap, so there is no unbounded form.

## Module map

| Concern | Where |
| --- | --- |
| Model, bounds, transitions, carrier | `packages/protocol/src/native-agent-goal.ts` (new) |
| Record | `apps/backend/src/core/models.ts`, storage mutations |
| Driver | `apps/backend/src/core/native-agent-goal-service.ts` (new), wired in `native-agent-service.ts` and `index.ts` |
| Delivery | The prompt queue, `native-agent-prompt-queue-dispatcher.ts` |
| Agent tool | `apps/backend/src/core/agent-tools.ts` |
| Check | The worker behind `public-api/actions-exec.ts` |
| Command | `packages/protocol/src/agent-slash-commands.ts`, `native-agent-command-dispatch.ts` |
| UI | `apps/web/src/components/chat/NativeComposeDock.tsx`, new goal components, `MailTile.tsx` as the pattern |

## Phase 0: Qualify the assumptions

Prove on real providers what the design relies on, and close the native goal paths that would compete with ours. No user-visible feature ships here.

### P0.1 Provider behaviour probes

Run a logged, opt-in probe per provider at the current pins. The 2026-10-30 probes in Background used the installed Codex 0.159.3 and the bare SDK, not our bridges, so they don't count as qualification.

### P0.2 Close the native goal paths

Codex is already closed by `features.goals=false` (`bridges/codex-bridge/src/codex-config.ts`). This item closes the rest, using what 001 finds. Until 108 reserves the `/goal` name, the provider's own command stays listed as it is today.

### Phase 0 exit criteria

- Each provider's turn-end edge and `sessionRequestOutcome` answer are recorded for a completed, a stopped and a failed turn, at the current pins.
- We know, per provider, which native goal commands and tools reach an Orkestrator session.
- No native goal loop can start in an Orkestrator session without the user asking for that provider's own command.

## Phase 1: The core loop on Claude and Codex

A goal set with `/goal` runs to a checked end state on Claude and Codex. The surface is the slash command and a transcript line; the pill and panel come in Phase 2.

### P1.1 Goal model and protocol

A new `packages/protocol/src/native-agent-goal.ts` holds `NativeAgentGoal`, the status list, the bounds and a pure `nextGoalState` transition function. Everything else calls that function, so the rules are tested in one place.

### P1.2 Goal storage

`goal` is an optional field on `PersistedNativeAgentSession` (`apps/backend/src/core/models.ts`), changed only through `storage.enqueueNativeAgentSessionMutation`. A bounded `goalHistory` keeps the last 5 ended goals without their check output.

### P1.3 Goal service and turn-edge driver

`NativeAgentGoalService` (`apps/backend/src/core/native-agent-goal-service.ts`) is a new collaborator of `NativeAgentService`, wired through a host object like the others (see `docs/architecture/native-agent-service.md`). It wakes on the `isAgentTurnEndTransition` edge from `onActivityTransition` (`apps/backend/src/core/index.ts`), reads `sessionRequestOutcome`, and applies `nextGoalState`.

### P1.4 Continuation prompts

A continuation is a persisted prompt-queue message whose `requestId` is `goal:<goalId>:<iteration>`, enqueued with `enqueuePromptQueueMessageIfAbsent` (see `apps/backend/src/core/public-api/prompt-delivery.ts`). A replay after a crash finds the same item, and the drainer sends it when the session is free.

### P1.5 Agent signal tool

A `report_goal` tool on the agent MCP server (`apps/backend/src/core/agent-tools.ts`), with `{ status: "done" | "blocked" | "progress", message }`. It records a claim for the service to act on at the turn's end. It cannot set, change or clear a goal.

### P1.6 Done check

When the agent reports `done`, the service runs the goal's check once, through the same worker as `environment.exec` (`apps/backend/src/core/public-api/actions-exec.ts`), in the environment's workspace. Exit 0 is `complete`. Anything else continues the loop with the output in an evidence frame. With no check, the goal ends `claimed`.

### P1.7 Limits and no-progress stop

Every goal has an iteration cap. A token budget is optional, and refused where 001 shows the provider reports no usable count. The no-progress stop catches an agent that keeps answering without working.

### P1.8 The goal slash command

A `/goal` entry in `SESSION_ACTION_SLASH_COMMANDS` (`packages/protocol/src/agent-slash-commands.ts`) with `collision: "reserve"` and a new `actions.goal` capability. Forms: `/goal`, `/goal <objective> [--check <command>] [--max-iterations N] [--budget N]`, `/goal pause`, `/goal resume [--max-iterations N]`, `/goal clear`.

### P1.9 Live qualification on Claude and Codex

A new opt-in suite, `mise run test:agent:goals`, modelled on `test:agent:coordinator`, using the smallest model that can do the job. It never runs in the default tier. Mocks do not confer support (`docs/architecture/native-agent-commands.md`).

### Phase 1 exit criteria

- A goal with a passing check ends `complete`, and one with no check ends `claimed`, on Claude and Codex in live runs.
- Stop pauses a goal, and no further turn starts until the user resumes it.
- A backend restart at each step of the loop sends no duplicate continuation and loses no goal.
- Every goal stops at its iteration cap, and an agent that makes no progress is stopped before that.

## Phase 2: The goal surface

Users can see and control a goal without typing a command, from any client, with the tab closed or open.

### P2.1 Goal state in snapshots and events

The goal joins the session state the renderer already reads through `NativeAgentTranscriptProjection`, with a content-bounded public shape. Live events invalidate it. A client that missed them re-reads the snapshot.

### P2.2 Composer goal pill and panel

A pill in `NativeComposeDock.tsx` shows status, iteration and limit, and elapsed time. It opens a panel with the objective, check, tokens, the last report and check result, and Pause, Resume and Clear. A form sets a goal, with the check field shown prominently.

### P2.3 Transcript rendering

Continuations render as a collapsed tile, as `MailTile.tsx` does for mail, identified from the durable request id and carrier rather than guessed from prose. Status changes and check results render as short rows.

### P2.4 Attention and turn-end side effects

Every continuation ends in a turn-end edge, and several things listen to that edge: the `agent_finished` unread reason, worker status wakes to a coordinator, and PR probing. While a goal will continue, the notification listeners stay quiet. The PR probe keeps running because it only reads state.

### Phase 2 exit criteria

- A goal's state survives a reload, and a tab opened mid-goal shows the current state without a turn edge.
- A continuation never appears as something the user typed.
- A goal rings attention once when it ends or needs a person, and not on every iteration.

## Phase 3: Every provider

The same `/goal` works on OpenCode, Cursor, Grok and Pi. A provider's capability turns on only after its live run passes.

### P3.1 OpenCode

OpenCode runs through its SDK and server rather than a bridge. It has an environment-level MCP credential. Upstream is building its own goal plugin on an unreleased branch, so the pin upgrade guide must watch for it.

### P3.2 Cursor

Cursor has no provider command catalogue (`unsupported`), and its capabilities are `steer` and `rewindMessages`. The CLI has its own gated `/goal`, but `@cursor/sdk` 1.2.0 shows no goal surface.

### P3.3 Grok

Grok 1.0.67's binary contains a full goal system (`update_goal`, a classifier, budgets). Whether it reaches ACP is not documented. Commands arrive by `available_commands_update`, and restored rows are `stale`.

### P3.4 Pi

Pi has no native goal in 1.4.0. A third-party extension such as `pi-xai` can add `/goal` and `update_goal`, and extension commands only appear after the session attaches.

### P3.5 Browser scenario and qualification record

One browser scenario on a host worktree and in a container, plus the per-provider record in `docs/todo/cli-and-slash-commands/0015-slash-command-qualification.md`'s style.

### P3.6 Documentation

`docs/architecture/goals.md` holds behaviour as built. These plan files stay only as the record of the work.

### Phase 3 exit criteria

- All six providers pass the live goal suite at their current pins, or are listed unavailable with a reason.
- `docs/architecture/goals.md` and `native-agent-commands.md` match the behaviour.
- The browser scenario passes on a host worktree and in a container.

## Phase 4: Stronger verification and reach

Optional work that builds on a qualified loop. Each item is independent.

### P4.1 Verifier session

At an agent's `done` report, optionally start a fresh read-only session that can read files and run commands, and returns a `verification-verdict@1`. It can use any provider. This is stronger than a transcript-only evaluator, and costs more.

### P4.2 Public CLI and API

`session.goal.*` public actions and `orkestrator session goal set|get|pause|resume|clear`, with `--wait` following `session prompt --wait`.

### P4.3 Coordinator tools

Control MCP tools over the same actions. Delegating to a person's worker stays subject to the coordinator's existing rules, and limits are required rather than defaulted.

### Phase 4 exit criteria

- A verifier can judge a goal with no check command, and a failed verdict reaches the agent as evidence.
- The CLI and the coordinator can set, read and control a goal with the same rules as the composer.

## Testing strategy

- **Default tier:** the transition table, parsing, storage, the service with fake
  providers, and seeded restart interleavings. These use no real waits, and
  anything that does goes to the slow tier.
- **Live, opt-in:** `mise run test:agent:goals` (109 and the Phase 3 items). It is
  never part of the default run. Mocks do not confer provider support.
- **Browser:** the scenario in 305, on a host worktree and in a container.
- **On upgrades:** a pin change re-runs the live suite, because it can move a turn
  edge or add a native goal.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| A long goal spends far more than expected | The iteration cap is always on, plus an optional budget and the no-progress stop. The form shows the limits. |
| The agent games the check, for example by weakening a test | The check proves only what it runs. The goal form and guide say so, and 401 adds an independent reader. Constraints belong in the objective. |
| Context fills during a long goal | Each provider's own compaction. 109 includes a goal large enough to trigger it, and a failure pauses with a reason. |
| Unattended writes while nobody watches | The permission mode is unchanged (D11), and the panel warns about it. Grok's advisory enforcement is called out (303). |
| A provider adds or changes a native goal | The name is reserved, 002 closes the tools, and upgrades re-qualify (305). |
| A check has side effects and re-runs after a restart | The UI says checks may repeat. There is no attempt to detect this. |
| Turn-end listeners fire on every iteration | 204 reviews each listener. |
| Provider turn-end signals differ | 001 records them before the driver is built. |

## Tracking

Every work item has a numbered file in [`plans/goals/`](goals/000-index.md). The
ID is the phase times 100 plus the item number, so P1.3 is `103`; Phase 0 items
are `001` and `002`. Each file holds the item's status, checklist, notes and
progress log, and [`000-index.md`](goals/000-index.md) is the status board,
including the phase exit criteria. [`plans/goals/AGENTS.md`](goals/AGENTS.md) says
how agents keep both current, and `tests/unit/goals-plan.test.ts` checks that they
agree.

This plan holds the design and the decisions; change those here. Keep its Status
line current when a phase completes. The goals work is tracked only in
`plans/goals/`, not in `docs/todo/`. This plan is also the todo that
`docs/architecture/native-agent-commands.md` asks for before adding a shortcut.
