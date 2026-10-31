# Multi Review, graph runs and terminal agents still announce "completed its work" from the activity aggregate

Found on 2026-10-31 while finishing
[0940](0940-failed-turn-reads-as-completed.md) task 3.

## Task analysis

Analysed 2026-10-31 against `main` at `931e5541`, from reading the code; nothing here was reproduced.

### Tasks

1. **Say what a failed workflow's end rings**: Multi Review and graph runs ring `agent_finished` however the work ended. Status: open.
2. **Say what a terminal agent's unwatched end rings**: Status: open.

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

None yet.

## Related

- [0940-failed-turn-reads-as-completed.md](0940-failed-turn-reads-as-completed.md)
