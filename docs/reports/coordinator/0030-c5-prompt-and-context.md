# C5: Prompt and context

This file combines 5 reports into one batch to build together. Build the `0360` context builder first. `0170` is the agent's half of `0140`.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0360](#0360-the-coordinator-context-is-built-inline) | Low | A pure builder for the context prompt. |
| [0170](#0170-add-the-project-name-and-open-work-to-the-context-block) | Medium | The project name and a one-line open-work summary in the context block. |
| [0140](#0140-the-coordinator-cannot-read-what-it-is-waiting-on) | Medium | Exposing delegation state to the coordinator. |
| [0030](#0030-with-agent-messaging-off-the-coordinator-is-still-told-to-delegate) | High | Gating the delegation prompt and a panel notice on agent messaging. |
| [0460](#0460-the-prompt-nudges-toward-over-delegation) | Low | Prompt wording that prefers an idle existing worker and softens the read rule. |

## 0360: The coordinator context is built inline

### Task analysis

#### Tasks

1. **Extract a pure builder**: `buildCoordinatorContext(...)`, testable for size and content. Status: open.

#### 1. Extract a pure builder

**Problem.** The prompt is a string concatenation inside `trustedInput`, so its size and content cannot be checked without the service. It has grown a lot since the report.

**Context.** Individual rules were moved to `packages/protocol/src/coordinator.ts`, but the assembly was not.

**Investigation.** Assembly is at `native-agent-service.ts:1297-1335`, mixing async reads (repository config, checkout update, node context, scheduling) with text.

**Decisions.**

- **Where does it live?**
  - **`packages/protocol`, taking already-read values as arguments (recommended).**
    - Pros: pure; the 0024 live suite can assert on it; a size test can guard it.
    - Cons: a long argument list while the prompt has this many inputs.
  - **A helper in `apps/backend`.**
    - Pros: can do its own reads.
    - Cons: not usable from the live suite, and it stays non-pure.

## 0170: Add the project name and open work to the context block

### Task analysis

#### Tasks

1. **Name the project**: the context gives the project name and checkout path, not only its id. Status: open.
2. **Summarise open delegations**: a one-line "Waiting on" in the context. Status: open.

#### 1. Name the project

**Problem.** The block says `Project: <uuid>`, which tells the model nothing.

**Context.** The report sized the block at about 850 tokens. It has grown since: the routing, environment choice, PR, validation, timers and other rules alone now come to about 4,800 characters on every main turn (source lengths in `packages/protocol/src/coordinator.ts`).

**Investigation.** `native-agent-service.ts:1323` writes the id. The function already reads the project's repository config (`:1285-1287`) and has `workspace`.

**Decisions.** None: add the name and the checkout path to that line. The path is already known to the agent as its working directory, so the name is the part that matters.

#### 2. Summarise open delegations

**Problem.** After context compaction, the model has forgotten what it launched and has no cheap way to find out.

**Context.** This is the agent's half of [0140](#0140-the-coordinator-cannot-read-what-it-is-waiting-on), at a cost on every turn including mail wakes.

**Investigation.** The block is built once per prompt at `native-agent-service.ts:1320-1335`. `listOpenCoordinatorDelegations` is available from storage, but names need an environment read each.

**Decisions.**

- **Always, or on demand?**
  - **Always, capped at a few names with a count for the rest, and omitted when nothing is open (recommended).**
    - Pros: fixes compaction without a tool call; costs nothing for an idle coordinator.
    - Cons: state changes turn to turn, which may reduce the cached prefix if it sits early, so it belongs at the end of the block.
  - **Rely on the tool from 0140.**
    - Pros: no per-turn cost.
    - Cons: a model that has forgotten may not think to ask.

### Needs verification

Whether a changing line in the block lowers the cache hit rate on each provider.

## 0140: The coordinator cannot read what it is waiting on

### Task analysis

#### Tasks

1. **Expose delegation state**: `list_workflows` or a new tool answers "what am I waiting on?". Status: open.

#### 1. Expose delegation state

**Problem.** Asked what is still running, a coordinator has to rebuild the answer from `list_environments` and `list_agents`, which is the polling the guard discourages. The UI has this answer; the agent does not.

**Context.** The two companion suggestions are done (see [Current state](#current-state)).

**Investigation.** `list_workflows` takes the last 200 associations (`control-mcp-coordinator-tools.ts:134`), which are mostly one row per message to the same environment. The returned row (`:209-221`) omits `delegation` entirely, so `state`, `workerTabId` and `waiting` are all hidden. The data is on the association (`packages/protocol/src/coordinator.ts:264-296`). The panel's worker row logic in `apps/web/src/lib/coordinator-work-items.ts` groups delegations per environment, but it is renderer code. `list_delegations` does not exist.

**Decisions.**

- **Extend the existing tool, or add one?**
  - **A `delegation` summary on each `list_workflows` row, plus an `openOnly` filter (recommended).**
    - Pros: no new tool in an already large surface; the description can say it replaces polling.
    - Cons: 200 rows still cost one environment read each (`:161-165`) unless the filter is used.
  - **A new `list_delegations`.**
    - Pros: a tight answer to the question, and no per-row resource reads.
    - Cons: adds a tool, in tension with [0160](0040-c4-tool-surface.md#0160-trim-the-coordinator-tool-surface-and-remove-the-legacy-node-tools).
- **Share code with the Work panel?** The report suggests one projection.
  - **Share only the waiting and bucket rules, if they move to `packages/protocol` (recommended).**
    - Pros: the agent and the panel cannot disagree on "needs you".
    - Cons: the panel also joins client stores (pipelines, reviews), which must stay out.
  - **Keep them separate.**
    - Pros: no refactor.
    - Cons: two definitions of the same states.

### Current state

- `stop_worker_turn` (`control-mcp-coordinator-worker-turns.ts:61`) covers the report's `cancel_delegation`, and `get_worker_changes` (`control-mcp-coordinator-worker-tools.ts:75`) its worker diff read; both `fbdea704c` (#1507). Their remaining live runs are in 1021.

## 0030: With agent messaging off, the coordinator is still told to delegate

### Task analysis

#### Tasks

1. **Include messaging in the availability check**: `coordinatorDelegationAvailable` also requires `agentMessaging.enabled`. Status: open.
2. **Say so in the panel**: show "Delegation unavailable: agent messaging is off" beside the Control MCP warning. Status: open.

#### 1. Include messaging in the availability check

**Problem.** With messaging off the coordinator is told to launch workers, finish its turn and wait for a wake that cannot arrive.

**Context.** Messaging is on by default (`packages/protocol/src/agent-mail.ts:167`), so this affects users who turned it off.

**Investigation.** `apps/backend/src/core/index.ts:1168-1170` checks only `controlMcp.getSettings().running` and the platform's qualification. The prompt branches on it at `native-agent-service.ts:1300`. Mail tools register only when messaging is on (`control-mcp-tools.ts:584-588`, `:1967`), and `sendAgentMail` throws `messaging-disabled` (`storage-agent-mail.ts:470`). The check is synchronous and config reads are async.

**Decisions.**

- **How does the synchronous check read the setting?**
  - **Make the callback async and await it at `:1300`, which is already in an async function (recommended).**
    - Pros: reads the current setting, as `schedulingEnabled` does for the timers line in the same prompt.
    - Cons: one more config read per coordinator turn.
  - **Cache the setting and refresh it on config changes.**
    - Pros: stays synchronous.
    - Cons: a second copy of the setting that can go stale.

#### 2. Say so in the panel

**Problem.** The panel explains Control MCP being off but not messaging being off.

**Context.** `CoordinatorSnapshot` carries `controlMcp` but no messaging state (`coordinator-service.ts:518-526`).

**Investigation.** The warning line is at `CoordinatorPanel.tsx:998-1004`.

**Decisions.** None: add the field to the snapshot, as `controlMcp` is, and render one more line in the same place.

## 0460: The prompt nudges toward over-delegation

### Task analysis

#### Tasks

1. **Mention existing workers first**: the prompt offers `launch_job` and `send_prompt_to_tab` on an idle worker before a new environment. Status: open.
2. **Soften the read rule**: "even when it only reads" applies when the read is expected to be long. Status: open.

#### 1. Mention existing workers first

**Problem.** A fresh worktree, with its setup scripts, can be started for each question when an idle worker could answer.

**Context.** Marked plausible in the report, not observed. Since then the routing and environment-choice rules have added more on how to start work (`packages/protocol/src/coordinator.ts:571-572`).

**Investigation.** The delegation line names only `launch_environment` (`native-agent-service.ts:1302`). The routing rule says "launch_environment with a prompt, then work with that worker back and forth". The MCP instructions, not the context, mention `launch_job` (`control-mcp-tools.ts:598-599`).

**Decisions.** None: one added clause in `COORDINATOR_ROUTING_RULE`, which is short and shared by every provider.

#### 2. Soften the read rule

**Problem.** The Scope line sends any "multi-file investigation" to a worker "even when it only reads".

**Context.** The same sentence stops a read-only coordinator doing long work itself, which is its purpose. The architecture doc records the intent at `docs/architecture/coordinator.md:610-611`.

**Investigation.** `native-agent-service.ts:1326`.

**Decisions.**

- **Change it now?**
  - **Reword after a live check of how often coordinators launch for reads (recommended).**
    - Pros: evidence first for a prompt that sets the role.
    - Cons: needs transcripts from real use.
  - **Reword now as the report suggests.**
    - Pros: one line.
    - Cons: may push long work back into the coordinator's turn, which the line is there to prevent.

### Needs verification

Whether over-delegation happens in practice. No transcript was read for this file.

## Related

- [Coordinator report, 6](../2026-10-27-coordinator.md#6-maintainability)
- [0024-coordinator-live-conformance.md](../../todo/coordinator-and-multi-review/0024-coordinator-live-conformance.md)
- [Coordinator report, 4.3 (A5)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [Coordinator report, 4.3 (A6)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [1021-coordinator-gap-tools-follow-ups.md](../../todo/coordinator-and-multi-review/1021-coordinator-gap-tools-follow-ups.md)
- [Coordinator report, 4.3 (A1)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- `messaging-disabled` no longer aborts the wake pass: such a wake is held and goes out when messaging returns (`wakeHeldByUserState` in `apps/backend/src/core/coordinator-service.ts`)
- [Coordinator report, 4.3 (A7)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)

## Outcome

Built on `coordinator-report-ada4f97dcdde-r1` from `main` at `ce7989a50`. Every finding was re-checked there first: all held, with new line numbers, because #1773 and #1778 moved the code (the assembly was at `native-agent-service.ts:1297-1354`, the panel notice at `CoordinatorToolbar.tsx:217-223`). #1773 changed one fact in part 0030: a wake is now held while messaging is off and goes out when it returns, so "cannot arrive" holds for as long as the setting stays off.

| Part | Task | Outcome | Code | Test or evidence |
| --- | --- | --- | --- | --- |
| 0360 | 1. Extract a pure builder | Done | `buildCoordinatorContext` in `packages/protocol/src/coordinator-context.ts`, called from `trustedSessionInput` in `native-agent-service.ts`. Recommended option taken: `packages/protocol`, taking already-read values. | `packages/protocol/src/coordinator-context.test.ts`, including "stays within its per-turn budget". |
| 0170 | 1. Name the project | Done | `projectLine` in `coordinator-context.ts`; the service reads the project. | "the project line" in `coordinator-context.test.ts`; `native-agent-service-base.test.ts` ("derives coordinator authority…"). |
| 0170 | 2. Summarise open delegations | Done | `coordinatorOpenWorkers` and `waitingOnLine` in `coordinator-context.ts`, `readCoordinatorWaitingOn` in `apps/backend/src/core/coordinator-context-reads.ts`. Recommended option taken: always, capped at three names with a count, omitted when nothing is open, last in the block. | "the waiting-on line" and `coordinatorOpenWorkers` in `coordinator-context.test.ts`; `coordinator-context-reads.test.ts`; `native-agent-service-base.test.ts` ("a coordinator with agent messaging off…"). |
| 0170 | Needs verification: the changing line and the cache hit rate | Moved to to-do [4901](../../todo/coordinator-and-multi-review/4901-coordinator-waiting-on-cache-cost.md) | None | Needs real provider turns, which this work could not spend. |
| 0140 | 1. Expose delegation state | Done | `list_workflows` in `control-mcp-coordinator-tools.ts`: a `delegation` summary on each row and an `openOnly` filter applied before the 200-row cap. Recommended options taken: extend the tool, and share only the bucket rule (`coordinatorDelegationBucket` and `coordinatorDelegationSummary` in `packages/protocol/src/coordinator.ts`, used by `coordinator-work-items.ts`). | `control-mcp-server-coordinator-workflows.test.ts` ("list_workflows answers what the coordinator is waiting on"); "coordinator delegation state" in `coordinator-context.test.ts`; `coordinator-work-items.test.ts`. |
| 0140 | Current state: `stop_worker_turn` and `get_worker_changes` | No longer holds | None: the file already recorded these as built. | Re-checked at `control-mcp-coordinator-worker-turns.ts:61` and `control-mcp-coordinator-worker-tools.ts:75`. Their live runs stay in to-do 1021. |
| 0030 | 1. Include messaging in the availability check | Done | `coordinatorDelegationAvailable` in `coordinator-context-reads.ts`, wired in `apps/backend/src/core/index.ts`. Recommended option taken: an async callback that reads the setting on each turn. Beyond the report, the same promise is removed from the Control MCP instructions and from coordinator tool results (`withoutWakePromise` in `control-mcp-tools.ts`), and a side agent is no longer told to mail. Tool descriptions are static and may still mention being woken. | `coordinator-context-reads.test.ts`; `native-agent-service-base.test.ts` ("a coordinator with agent messaging off is not told to wait for a wake"); `control-mcp-server-coordinator-workflows.test.ts` ("with agent messaging off no coordinator surface promises a wake", `withoutWakePromise`). |
| 0030 | 2. Say so in the panel | Done | `agentMessaging` on the snapshot (`coordinator-service.ts`, `packages/protocol/src/coordinator.ts`) and one line in `CoordinatorToolbar.tsx`. | `CoordinatorPanel.test.tsx` ("says delegation is unavailable while agent messaging is off"); `coordinator-service.test.ts` ("the snapshot says whether agent messaging is on"). Seen in a real browser on an isolated profile at 1280 and 390 wide, after a reload, with no provider turn. |
| 0460 | 1. Mention existing workers first | Done | One clause in `COORDINATOR_ROUTING_RULE`. | "the routing rule offers an idle worker before a new environment" in `coordinator-context.test.ts`; `coordinator-worker-mail.test.ts`. Whether it changes behaviour is part of to-do 4900. |
| 0460 | 2. Soften the read rule | Moved to to-do [4900](../../todo/coordinator-and-multi-review/4900-coordinator-over-delegation-and-read-rule.md), task 2 | None | The report's recommended option is to reword only after a live check, which needs transcripts from real use. |
| 0460 | Needs verification: whether over-delegation happens | Moved to to-do [4900](../../todo/coordinator-and-multi-review/4900-coordinator-over-delegation-and-read-rule.md), task 1 | None | Needs transcripts from real use. |
