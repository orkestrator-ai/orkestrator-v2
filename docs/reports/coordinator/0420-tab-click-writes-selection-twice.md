# Clicking a tab in an unfocused group writes the selection twice

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Select once**: a click on a tab in another group writes one selection. Status: open.

### 1. Select once

**Problem.** The pane's capture handler selects its front tab, then the click selects the tab that was clicked. The backend gets two writes, and there is a moment with the wrong selection.

**Context.** The click's `stopPropagation` only stops the bubbling `onClick`, as its comment intends (`CoordinatorPanel.tsx:1072-1074`).

**Investigation.** `onPointerDownCapture` calls `onFocusPane` (`CoordinatorPaneTree.tsx:309`), which goes through `changeLayout` to `selectConversation` for the front conversation (`CoordinatorPanel.tsx:305-316`). The serializer coalesces only when a request is in flight (`:271-272`).

**Decisions.** None: in the capture handler, skip focusing when the pointer target is inside the tab strip, since the tab's click does it. Check that dragging a tab still focuses the group, because a drag does not click.

## Related

- [Coordinator report, 4.4 (U13)](../2026-10-27-coordinator.md#44-ui-and-ux)
