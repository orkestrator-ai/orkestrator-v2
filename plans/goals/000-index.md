# Goals plan: work items

Status board for [`plans/goals.md`](../goals.md). Each work item has its own
file, and the file's front matter is where its status lives. This index mirrors
it. Read [AGENTS.md](AGENTS.md) before starting or updating an item;
`tests/unit/goals-plan.test.ts` fails when a file and its row disagree.

An item is **ready** when every item in its *Depends on* column is `done`.
Statuses: `not-started`, `in-progress`, `blocked`, `done`, `dropped`.
Status changes reach `main` with the pull request that does the work, so this
board shows merged work. To see work in flight, search open pull requests for
the item ID (`gh pr list --search "goals 103"`).

## Phase 0: Qualify the assumptions

| ID | File | Phase | Status | Depends on | Summary |
| --- | --- | --- | --- | --- | --- |
| 001 | [001-provider-behaviour-probes.md](001-provider-behaviour-probes.md) | 0 | done | — | Replace assumptions about turn edges and native goals with recorded facts for all six providers. |
| 002 | [002-close-the-native-goal-paths.md](002-close-the-native-goal-paths.md) | 0 | done | 001 | A provider's own goal loop cannot start in an Orkestrator session behind the backend's back. |

Exit criteria (tick when demonstrated, and link the evidence from the item that proved it):

- [x] Each provider's turn-end edge and `sessionRequestOutcome` answer are recorded for a completed, a stopped and a failed turn, at the current pins.
- [x] We know, per provider, which native goal commands and tools reach an Orkestrator session.
- [x] No native goal loop can start in an Orkestrator session without the user asking for that provider's own command.

## Phase 1: The core loop on Claude and Codex

| ID | File | Phase | Status | Depends on | Summary |
| --- | --- | --- | --- | --- | --- |
| 101 | [101-goal-model-and-protocol.md](101-goal-model-and-protocol.md) | 1 | done | — | One shared definition of a goal, its statuses, its bounds and its transitions. |
| 102 | [102-goal-storage.md](102-goal-storage.md) | 1 | done | 101 | A goal is durable, changes atomically with its session, and follows the session's lifecycle correctly. |
| 103 | [103-goal-service-and-turn-edge-driver.md](103-goal-service-and-turn-edge-driver.md) | 1 | done | 001, 102 | The backend decides what happens after every turn of a session with an active goal, whether or not any client is connected. |
| 104 | [104-continuation-prompts.md](104-continuation-prompts.md) | 1 | done | 103 | The next goal turn reaches the agent exactly once, behind anything the user already queued. |
| 105 | [105-agent-signal-tool.md](105-agent-signal-tool.md) | 1 | done | 102 | Any agent can say it is done or blocked, through the MCP server it already loads. |
| 106 | [106-done-check.md](106-done-check.md) | 1 | done | 103, 105 | A goal completes because a command proved it, not because the agent said so. |
| 107 | [107-limits-and-no-progress-stop.md](107-limits-and-no-progress-stop.md) | 1 | done | 103 | No goal can run or spend without bound, and a stuck agent stops early. |
| 108 | [108-the-goal-slash-command.md](108-the-goal-slash-command.md) | 1 | done | 002, 104, 105, 106, 107 | `/goal` sets, reads and controls a goal from the composer on qualified providers. |
| 109 | [109-live-qualification-on-claude-and-codex.md](109-live-qualification-on-claude-and-codex.md) | 1 | done | 108 | The loop is proven against real models on the first two providers before anything is built on it. |

Exit criteria (tick when demonstrated, and link the evidence from the item that proved it):

- [x] A goal with a passing check ends `complete`, and one with no check ends `claimed`, on Claude and Codex in live runs.
- [x] Stop pauses a goal, and no further turn starts until the user resumes it.
- [x] A backend restart at each step of the loop sends no duplicate continuation and loses no goal.
- [x] Every goal stops at its iteration cap, and an agent that makes no progress is stopped before that.

## Phase 2: The goal surface

| ID | File | Phase | Status | Depends on | Summary |
| --- | --- | --- | --- | --- | --- |
| 201 | [201-goal-state-in-snapshots-and-events.md](201-goal-state-in-snapshots-and-events.md) | 2 | done | 102 | Any client can read a goal's current state, and live updates are only an optimisation. |
| 202 | [202-composer-goal-pill-and-panel.md](202-composer-goal-pill-and-panel.md) | 2 | done | 108, 201 | Users can see a goal's progress and control it without typing. |
| 203 | [203-transcript-rendering.md](203-transcript-rendering.md) | 2 | done | 104 | A transcript shows what the goal loop did, and never shows a continuation as the user's words. |
| 204 | [204-attention-and-turn-end-side-effects.md](204-attention-and-turn-end-side-effects.md) | 2 | done | 103 | A goal interrupts the user once when it needs them, not on every iteration. |

Exit criteria (tick when demonstrated, and link the evidence from the item that proved it):

- [x] A goal's state survives a reload, and a tab opened mid-goal shows the current state without a turn edge.
- [x] A continuation never appears as something the user typed.
- [x] A goal rings attention once when it ends or needs a person, and not on every iteration.

## Phase 3: Every provider

| ID | File | Phase | Status | Depends on | Summary |
| --- | --- | --- | --- | --- | --- |
| 301 | [301-opencode.md](301-opencode.md) | 3 | done | 108 | Goals work on OpenCode with the same behaviour. |
| 302 | [302-cursor.md](302-cursor.md) | 3 | done | 108 | Goals work on Cursor through the SDK we use. |
| 303 | [303-grok.md](303-grok.md) | 3 | done | 108 | Goals work on Grok over ACP, with Grok's own goal loop out of the way. |
| 304 | [304-pi.md](304-pi.md) | 3 | done | 108 | Goals work on Pi, including for users with goal extensions installed. |
| 305 | [305-browser-scenario-and-qualification-record.md](305-browser-scenario-and-qualification-record.md) | 3 | done | 202, 203, 204, 301, 302, 303, 304 | The finished feature is proven in the real app, and the record says exactly what was run. |
| 306 | [306-documentation.md](306-documentation.md) | 3 | done | 305 | Durable behaviour moves from this plan to the living docs. |

Exit criteria (tick when demonstrated, and link the evidence from the item that proved it):

- [x] All six providers pass the live goal suite at their current pins, or are listed unavailable with a reason.
- [x] `docs/architecture/goals.md` and `native-agent-commands.md` match the behaviour.
- [x] The browser scenario passes on a host worktree and in a container.

## Phase 4: Stronger verification and reach

| ID | File | Phase | Status | Depends on | Summary |
| --- | --- | --- | --- | --- | --- |
| 401 | [401-verifier-session.md](401-verifier-session.md) | 4 | done | 106 | A goal with no check command can still be judged by something other than the agent doing the work. |
| 402 | [402-public-cli-and-api.md](402-public-cli-and-api.md) | 4 | done | 108 | Scripts can run goals with the same rules as the composer. |
| 403 | [403-coordinator-tools.md](403-coordinator-tools.md) | 4 | done | 402 | A coordinator can give a worker a goal and be woken when it ends. |

Exit criteria (tick when demonstrated, and link the evidence from the item that proved it):

- [x] A verifier can judge a goal with no check command, and a failed verdict reaches the agent as evidence.
- [x] The CLI and the coordinator can set, read and control a goal with the same rules as the composer.
