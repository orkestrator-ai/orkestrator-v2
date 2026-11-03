# Branch switch and Sync are gated on the wrong turn

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Gate on any active turn**: the controls disable while any conversation's turn runs, and say which one. Status: open.

### 1. Gate on any active turn

**Problem.** With a side agent focused and the main running, the picker is enabled. The user confirms "Discard and switch", and the backend refuses.

**Context.** The panel's upstream check already computes the correct answer for an older backend.

**Investigation.** The backend's check counts the project home as well as every conversation (`apps/backend/src/core/index.ts:1256-1259`). `coordinatorTurnActive` reads only the selected conversation's phase (`CoordinatorPanel.tsx:579-581`, `:612-616`), and `branchSwitchDisabled` and `syncDisabled` use it (`:832-833`). The backend refuses when any turn is active (`project-git-service.ts:943-945`). `confirmUpstreamMerge`'s `turnRunning` walks every open conversation and the project home (`CoordinatorPanel.tsx:397-429`), but it reads the store once rather than subscribing.

**Decisions.**

- **Include the project home's turn?**
  - **Yes, and move the walk into one selector used by both (recommended).** The coordinator doc says nothing merges under a running coordinator or project-home turn.
    - Pros: one definition; the tooltip can name the busy conversation or "Home".
    - Cons: a selector across all projections re-runs on each projection change, so it must return a stable string or null.
  - **Coordinator conversations only.**
    - Pros: smaller.
    - Cons: the home's lease still refuses, with the same late error.

## Related

- [Coordinator report, 4.4 (U5)](../2026-10-27-coordinator.md#44-ui-and-ux)
