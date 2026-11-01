# Multi Review, graph runs and terminal agents still announce "completed its work" from the activity aggregate

Found on 2026-10-31 while finishing
[0940](0940-failed-turn-reads-as-completed.md) task 3.

## Task analysis

Analysed 2026-10-31 against `main` at `931e5541`, from reading the code; nothing here was reproduced. Re-checked and implemented 2026-11-01 against `main` at `0658de64`; task 2's reading turned out to be partly wrong (see [what the terminal paths really do](#task-2-what-the-terminal-paths-really-do)).

### Tasks

1. **Say what a failed workflow's end rings**: Multi Review and graph runs ring `agent_finished` however the work ended. Status: done (2026-11-01). A failure rings `agent_failed`, a cancel or pause rings nothing, and a success still rings `agent_finished`.
2. **Say what a terminal agent's unwatched end rings**: Status: done (2026-11-01) for `claude-tmux`, against fake tmux; a live failed turn in a real tab was not run (see Needs verification). `claude-terminal` was already honest, and its stuck `working` on a failed turn moved to [1200](1200-container-terminal-failed-turn-stays-working.md).

### 1. Say what a failed workflow's end rings

**Problem.** A Multi Review workflow or graph run that fails still reads "The agent completed its work."

**Context.** `setEnvironmentAgentActivity` (`storage-projects.ts`) rings `agent_finished` on any aggregate `working → idle`, unless the caller passes `completionAttention: false`. `MultiReviewService.syncWorkflowActivity` and `syncEnvironmentActivity`, its boot-time `reconcileEnvironmentActivity`, and `GraphRunAttention.syncEnvironment` all use the default. Each derives only working or idle from its records, so the phase they hold (failed, cancelled) never reaches the bell.

**Investigation.** Read only. Not checked: whether either surface already raises its own notice that makes this bell redundant.

**Decisions.**

- **What does a workflow's end ring?**
  - **Pass the workflow's outcome through, and ring `agent_failed` when it failed (recommended).**
    - Pros: honest, and the toast copy already exists.
    - Cons: one more option on a storage call several sources share, and "agent" is loose wording for a workflow.
  - **Leave it.**
    - Pros: nothing to change, and the workflow's own view shows the failure.
    - Cons: the toast still says the work completed.

### 2. Say what a terminal agent's unwatched end rings

**Problem.** A terminal Claude session that ends across a backend restart rings `agent_finished` through the same aggregate fallback.

**Context.** `tmux-poll.ts` writes the `claude-terminal` source from hook state, which says working, waiting or idle. It says nothing about how a turn ended, so there is no evidence to read.

**Investigation.** Read only. Not checked: whether a Claude hook such as a stop-failure event could supply the outcome.

**Decisions.**

- **What does it ring?**
  - **Leave it until a hook can report the outcome (recommended).**
    - Pros: never guesses.
    - Cons: a failed terminal turn keeps reading as finished.
  - **Make the copy neutral for this source.**
    - Pros: no false claim.
    - Cons: needs a new reason, and most of these turns did finish.

## Assumptions and decisions

Made 2026-11-01 against `main` at `0658de64`. Nothing from either task had merged: all four workflow writers and both terminal writers still used the storage default.

### Task 1: whether either surface already makes the bell redundant

- **Found:** no. Neither surface raises a notice for the user when work ends in the background. Multi Review and graph runs show their state only in their own tab, the web's workflow toasts answer a person's own action ("Could not start review"), and `coordinator-status-wakes.ts` tells only a coordinator that owns the work. The bell is the only signal someone away from the tab gets, so it has to stay and be right.

### Task 1: what a workflow's end rings

- **Chose:** the recommended option, passing the outcome through, as one new option on `setEnvironmentAgentActivity`: `completionOutcome: "failed" | "none"` (`AgentActivityCompletionOutcome` in `models.ts`). Absent, the aggregate's edge rings as before.
- **Why:** each writer holds the record that says how the work ended, and the toast copy already exists. "Agent" stays loose wording for a workflow, as the file accepted, and it is still true: the toast sends the person to the tab that shows the error.

### Task 1: what a cancel or pause rings

- **Chose:** nothing, through `completionOutcome: "none"`. The file did not decide this; the ticket requires only that a cancel does not say "completed". The same applies to a paused workflow or run, and to a stopped interactive Fix.
- **Why:** someone asked for it, so they know, and nothing completed. A new "stopped" reason would add a persisted enum value to tell a person what they just did. Graph runs have no record of who cancelled, so a run a coordinator cancelled is quiet too; the coordinator hears through its own status wake.
- **Why not `completionAttention: false`:** it also silences an aggregate that lands on `waiting`, so cancelling a workflow could swallow a sibling tab's "needs your input". `none` only quiets the idle ring, and a test pins that.

### Task 1: a failure rings on the source's own edge, not the aggregate's

- **Chose:** `failed` rings when this source goes from `working` to not working, even while a sibling keeps the aggregate `working`. An aggregate ring of `agent_finished` no longer replaces an unread `agent_failed`.
- **Why:** gating on the aggregate would lose the failure whenever anything else was working, because the sibling's later end can ring nothing (native sessions turn the fallback off) or ring "completed". The replacement rule matters for graph-engine reviews, which write both `multi-review` and `graph-run`: the review can read `failed` while its run reads `complete`, and either write can land first. Once the failure is read, the next end speaks for itself. `recordEnvironmentSessionCompletion` still overwrites: a native tab that finishes says so, which is true of that tab, and the 0940 per-session rule is unchanged.

### Task 1: which record decides

- **Multi Review, a save:** the saved workflow (`workflowCompletionOutcome`). `failed` phase or a failed interactive Fix is a failure; `cancelled`, `paused` or a stopped interactive Fix is `none`; anything else (`ready`, `completed`, a finished `interactive`) is a completion.
- **Multi Review, closing a workflow:** `none`, since only a person's close lands in `syncEnvironmentActivity`.
- **Multi Review, boot:** a source still `working` with nothing active means the process stopped between saving and syncing, so the last-saved workflow decides. With no workflow left, it was closed, and it rings nothing.
- **Graph runs:** the runs that ended since the source went `working` (`graphRunCompletionOutcome`, by `finishedAt` against the source's `observedAt`). Any failure wins, then any completion; otherwise `none`. The window keeps an old failure from colouring a later success, and keeps run A's failure when run B ends later.
- **A paused graph run** used to ring "completed". It now rings nothing, for the same reason as a pause above.
- **A failed auto PR launch** still rings `agent_finished`: the review and Fix did complete, and a stored `autoPrLaunch` can belong to an earlier Fix (the wake compares fix identities for this reason). Only the coordinator's wake reports it. This is the one workflow end left reading as complete with something wrong, and it needs a fix-identity check to change.

### Task 2: what the terminal paths really do

The file described only `claude-terminal` and assumed no hook reports the outcome. Reading both paths and probing the CLI found otherwise:

| Path | How a turn ends | Before | Now |
| --- | --- | --- | --- |
| `claude-terminal`, Stop hook | `waiting` | `agent_waiting` | Unchanged |
| `claude-terminal`, a whole turn missed | `completions` counter | `agent_finished`, and honest: the script counts only a Stop | Unchanged |
| `claude-terminal`, `idle` | Only an older hook writer; the current script cannot write it | `agent_finished` | Unchanged |
| `claude-terminal`, API error | No hook fires | Stuck `working`, no bell | Unchanged; see [1200](1200-container-terminal-failed-turn-stays-working.md) |
| `claude-tmux`, Stop hook | `busy` clears | `agent_finished` | Unchanged |
| `claude-tmux`, API error | No hook was installed | Stuck `working` until the tab closes, then "completed" | `agent_failed` |
| `claude-tmux`, tab stopped or interrupted mid-turn | `busy` clears | `agent_finished` | Nothing |
| `claude-tmux`, tmux dies mid-turn | Liveness check | `agent_finished` | Nothing |
| `claude-tmux`, re-attached after a restart | New session starts not busy | `agent_finished`, even for a turn still running | Nothing until its Stop or StopFailure arrives, then that |

**Evidence for the hook.** `StopFailure` is in `HOOK_EVENTS` in the pinned Agent SDK (0.3.314), and the hooks reference says it "runs instead of Stop when the turn ends due to an API error". Probed 2026-11-01 with Claude Code 2.1.310 in print mode, a throwaway `HOME` and config directory, a dummy key and a local server answering 400 to `POST /v1/messages`: the CLI fired `UserPromptSubmit`, then `StopFailure` with `{"error":"unknown","last_assistant_message":"API Error: 400 fake refusal"}`, and no `Stop`. No login, provider or billed turn was involved.

### Task 2: what it rings

- **Chose:** not the recommended "leave it", because its condition has been met: a hook can report the outcome. The principle it was recommended for, "never guesses", is kept: on `claude-tmux`, only a Stop hook rings "completed" and only a StopFailure hook rings a failure. Every other idle edge passes `completionOutcome: "none"`.
- **Neutral copy was rejected:** it needs a new reason, and the hook makes it unnecessary.
- **The failure rings from the event:** `recordEnvironmentSessionCompletion` with a key of session and hook id, not the activity edge, because a hook file outlives a backend restart and a re-attached session has no edge. StopFailure also clears `busy` in the backend and the tab, so a failed turn no longer reads as working.
- **A Stop drained after a re-attach** rings once through `unexplainedEnds`, so a turn that really finished across a restart is still announced.

### Task 2: a session that dies mid-turn

- **Chose:** ring nothing rather than `agent_failed`, unlike 0940's lost bridge.
- **Why:** `busy` is not proof here. Pressing Escape inside the pane interrupts a turn with no hook, so `busy` can stay set long after the turn ended, and closing that tab later would report an error that never happened. A real crash mid-turn therefore rings nothing, and the sidebar just goes idle.

### Task 2: `claude-terminal` left as it is

- **Chose:** no change, and a follow-up ([1200](1200-container-terminal-failed-turn-stays-working.md)).
- **Why:** it makes no false "completed" claim on current hooks, which is what this file is about. Fixing the stuck `working` means a new state word in `orkestrator-state-signal`, a capability bump and an image change, which needs a built image to prove.

### Found while checking: build pipelines

- `BuildPipelineActivity.syncEnvironment` has the same bug, from the same default. It is outside this file's tasks, so it moved to [1201](1201-build-pipeline-bell-reads-as-finished.md).

## Needs verification

- A real failed turn in a real `claude-tmux` tab, in a disposable `dev:test` profile, to confirm the bell reads "Agent stopped with an error" and the tab stops thinking. The tests drive the real session manager against fake tmux and hand-written hook files, and the probe above used print mode, not the interactive TUI.
- A real failed and cancelled Multi Review and graph run in a disposable profile, watching the toast. The tests use the real services and storage with stub providers.

## Related

- [0940-failed-turn-reads-as-completed.md](0940-failed-turn-reads-as-completed.md)
- [1200-container-terminal-failed-turn-stays-working.md](1200-container-terminal-failed-turn-stays-working.md)
- [1201-build-pipeline-bell-reads-as-finished.md](1201-build-pipeline-bell-reads-as-finished.md)
