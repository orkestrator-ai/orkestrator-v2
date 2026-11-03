# Work panel rows lack the ask, the agent and quick actions

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Show what was asked, on what, and since when**: a worker row adds its request, agent and model, and elapsed time. Status: open.
2. **Add row actions beyond Open**: Stop, Answer and Address where they apply. Status: open.

### 1. Show what was asked, on what, and since when

**Problem.** The rail shows name, machine and stage. The report's table also has the prompt, agent and model, and age. Without them the user still has to open each worker to learn what it is doing, and a launch that overrode the default is not visible.

**Context.** `docs/architecture/coordinator.md:2136-2137` says the missing override marker "is a tracked follow-up", but no todo file mentions it.

**Investigation.** `WorkRow` renders name, machine, stage and criteria (`CoordinatorWorkPanel.tsx:60-117`). The report says delegations hold a `selection`, but they do not: `CoordinatorDelegation` (`packages/protocol/src/coordinator.ts:264-296`) has none. `selection` is only in tool results (`coordinator.md:2128-2136`). The association has no prompt text either. The worker's `initialPromptPresentation` frame sits on the environment (`commands-registry-coordinator.ts:495-501`), and only for a launch.

**Decisions.**

- **Where does a request summary come from?**
  - **Persist a short bounded `summary` and the selection on the delegation when it opens (recommended).**
    - Pros: covers launches, jobs, prompts and messages alike; works for remote workers from the local record.
    - Cons: prompt text enters the coordinator store, which is rewritten whole, so it must be small; older records have none.
  - **Read each worker's first message from its transcript.**
    - Pros: nothing stored.
    - Cons: one read per row, unavailable for an offline node.

### 2. Add row actions beyond Open

**Problem.** Stopping a worker or addressing a review takes two steps through its own view.

**Context.** Open already lands on the right tab, so this is a convenience.

**Investigation.** Each row has one button (`CoordinatorWorkPanel.tsx:103-116`). The commands exist behind their own screens.

**Decisions.**

- **Build it now?**
  - **Only Stop, after use shows the need (recommended).**
    - Pros: the one action where a detour matters; the others want their own context.
    - Cons: the rail stays read-mostly.
  - **All three.**
    - Pros: the report's whole table.
    - Cons: Answer and Address duplicate surfaces that show more, in a narrow rail.

## Current state

- `eb6bf887a` (#1698) built the rail itself and the sections, stages, expiry and remote reads described in `docs/architecture/coordinator.md:989-1073`.

## Related

- [Coordinator report, 5.1](../2026-10-27-coordinator.md#51-make-delegated-work-a-first-class-visible-object)
- [0060-open-worker-from-mail-tiles-and-prompt-banner.md](0060-open-worker-from-mail-tiles-and-prompt-banner.md)
- [0140-coordinator-cannot-read-delegation-state.md](0140-coordinator-cannot-read-delegation-state.md)
