# The coordinator cannot read what it is waiting on

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Expose delegation state**: `list_workflows` or a new tool answers "what am I waiting on?". Status: open.

### 1. Expose delegation state

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
    - Cons: adds a tool, in tension with [0160](0160-tool-surface-and-legacy-node-tools.md).
- **Share code with the Work panel?** The report suggests one projection.
  - **Share only the waiting and bucket rules, if they move to `packages/protocol` (recommended).**
    - Pros: the agent and the panel cannot disagree on "needs you".
    - Cons: the panel also joins client stores (pipelines, reviews), which must stay out.
  - **Keep them separate.**
    - Pros: no refactor.
    - Cons: two definitions of the same states.

## Current state

- `stop_worker_turn` (`control-mcp-coordinator-worker-turns.ts:61`) covers the report's `cancel_delegation`, and `get_worker_changes` (`control-mcp-coordinator-worker-tools.ts:75`) its worker diff read; both `fbdea704c` (#1507). Their remaining live runs are in 1021.

## Related

- [Coordinator report, 4.3 (A6)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [1021-coordinator-gap-tools-follow-ups.md](../../todo/coordinator-and-multi-review/1021-coordinator-gap-tools-follow-ups.md)
- [0170-context-block-project-name-and-open-work.md](0170-context-block-project-name-and-open-work.md)
