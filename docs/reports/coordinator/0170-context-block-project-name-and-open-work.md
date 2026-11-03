# Add the project name and open work to the context block

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Name the project**: the context gives the project name and checkout path, not only its id. Status: open.
2. **Summarise open delegations**: a one-line "Waiting on" in the context. Status: open.

### 1. Name the project

**Problem.** The block says `Project: <uuid>`, which tells the model nothing.

**Context.** The report sized the block at about 850 tokens. It has grown since: the routing, environment choice, PR, validation, timers and other rules alone now come to about 4,800 characters on every main turn (source lengths in `packages/protocol/src/coordinator.ts`).

**Investigation.** `native-agent-service.ts:1323` writes the id. The function already reads the project's repository config (`:1285-1287`) and has `workspace`.

**Decisions.** None: add the name and the checkout path to that line. The path is already known to the agent as its working directory, so the name is the part that matters.

### 2. Summarise open delegations

**Problem.** After context compaction, the model has forgotten what it launched and has no cheap way to find out.

**Context.** This is the agent's half of [0140](0140-coordinator-cannot-read-delegation-state.md), at a cost on every turn including mail wakes.

**Investigation.** The block is built once per prompt at `native-agent-service.ts:1320-1335`. `listOpenCoordinatorDelegations` is available from storage, but names need an environment read each.

**Decisions.**

- **Always, or on demand?**
  - **Always, capped at a few names with a count for the rest, and omitted when nothing is open (recommended).**
    - Pros: fixes compaction without a tool call; costs nothing for an idle coordinator.
    - Cons: state changes turn to turn, which may reduce the cached prefix if it sits early, so it belongs at the end of the block.
  - **Rely on the tool from 0140.**
    - Pros: no per-turn cost.
    - Cons: a model that has forgotten may not think to ask.

## Needs verification

Whether a changing line in the block lowers the cache hit rate on each provider.

## Related

- [Coordinator report, 4.3 (A5)](../2026-10-27-coordinator.md#43-agent-experience-prompt-and-tools)
- [0360-coordinator-context-built-inline.md](0360-coordinator-context-built-inline.md)
