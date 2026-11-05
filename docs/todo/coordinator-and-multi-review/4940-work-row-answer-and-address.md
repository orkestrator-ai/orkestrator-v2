# Answer and Address actions on Work rows

## Task analysis

Analysed 2026-11-05 against main at af2e566e5, with coordinator batch C7 (Work panel and navigation) applied.

### Tasks

1. **Decide whether Work rows need Answer and Address**: C7 built Stop only, as its report recommended. Status: open.

### 1. Decide whether Work rows need Answer and Address

**Problem.** Answering a worker's question or addressing a review takes two steps: Open, then act in that view. The original coordinator report's table asked for these actions on the row.

**Context.** From coordinator report C7, part `0260` (Work panel rows lack the ask, the agent and quick actions), task 2, "Add row actions beyond Open". The report recommended "only Stop, after use shows the need", because Stop is the one action where a detour matters, and C7 built that (`WorkRow` in `CoordinatorWorkPanel.tsx`, through `stop_coordinator_worker_turn`). Open on a row with a question already goes to that tab, so this is a convenience.

**Investigation.** Each row now has Open and, on a running worker, Stop, in a 288 px rail. The commands exist behind their own screens: a question is answered in the worker's tab, and a review is addressed from the Multi Review tab, both of which show the question or the findings the decision depends on. Nothing in the rail shows that content.

**Decisions.**

- **Build them?**
  - **Leave them out until use shows the need (recommended).**
    - Pros: the row stays small; Answer and Address keep the surfaces that show what is being decided; Open is one click away.
    - Cons: the rail stays read-mostly; the row costs one extra step.
  - **Add both to the row.**
    - Pros: the report's whole table.
    - Cons: duplicates surfaces that show more, in a narrow rail; an answer given without the question in view is easy to get wrong.

## Related

- [The Work panel](../../architecture/coordinator.md#work-panel)
