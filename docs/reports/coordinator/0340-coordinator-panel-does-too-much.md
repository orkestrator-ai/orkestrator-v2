# Split `CoordinatorPanel`

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Split the component**: toolbar, selection, launches and conversation pane move out. Status: open.

### 1. Split the component

**Problem.** One 1,227-line component holds the toolbar, Git actions, a selection serializer, the first-launch hold, layout bridging, notices and two dialogs, so unrelated changes collide there.

**Context.** Some has moved out since the report: `CoordinatorPanelNotices.tsx`, `CoordinatorWorkPanel.tsx` and `useCoordinatorWorkItems.ts`. The file still grew, from 1,150 lines.

**Investigation.** The selection serializer is at `CoordinatorPanel.tsx:245-299`, launches at `:133-141`, `:345-371` and `:584-640`, the upstream check at `:391-481`, the per-conversation render at `:724-831`, and the toolbar at `:878-1005`. Most state cards became banners (`CoordinatorPanelNotices.tsx`), so the report's `CoordinatorStateCard` is mostly no longer needed.

**Decisions.**

- **In what order?**
  - **`useCoordinatorLaunches` first, with [0220](0220-first-sends-in-two-groups-drop-a-prompt.md); `CoordinatorToolbar` and `useCoordinatorSelection` when next touched (recommended).**
    - Pros: each split pays for itself by fixing or containing something.
    - Cons: the file stays large for a while.
  - **One refactor now.**
    - Pros: done at once.
    - Cons: a large diff in a component with heavy tests (`CoordinatorPanel.test.tsx`, 2,339 lines), and it collides with the other UI files here.

## Related

- [Coordinator report, 6](../2026-10-27-coordinator.md#6-maintainability)
- [0350-one-busy-flag-for-unrelated-actions.md](0350-one-busy-flag-for-unrelated-actions.md)
