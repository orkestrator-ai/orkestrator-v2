# Coordinator tab strip accessibility

## Task analysis

Analysed 2026-11-03 against `main` at `a2bba9d8`.

### Tasks

1. **Use tab semantics without nesting**: `tablist`, `tab` and `aria-selected`, with one tab stop per tab. Status: open.
2. **Give keyboard users a way to move tabs**: a menu with move and split actions. Status: open.
3. **Label the loading spinner**: `role="status"` and text. Status: open.

### 1. Use tab semantics without nesting

**Problem.** Each tab is a `role="button"` div holding real buttons, so controls nest, there are two tab stops, and nothing announces a tab list.

**Context.** `TabShell` is shared with every tab strip in the app, so a change here affects environment panes as well.

**Investigation.** `SortableCoordinatorTab` spreads `useSortable`'s `attributes` onto the `TabShell` div (`CoordinatorPaneTree.tsx:340-348`). The panel puts a `<button>` inside (`CoordinatorPanel.tsx:1091-1101`), and `TabShell` adds the close button (`TabShell.tsx:60-73`). The strip (`CoordinatorPaneTree.tsx:315-323`) has no role, and `tablist`, `tab` and `aria-selected` appear nowhere in these files.

**Decisions.**

- **Scope?**
  - **Fix the coordinator strip first, overriding `attributes` to remove the role and tabindex, and making the inner button `role="tab"` (recommended).**
    - Pros: can be tested alone; no risk to the terminal strip.
    - Cons: the environment strip keeps the problem until it follows.
  - **Fix `TabShell` for every strip.**
    - Pros: one fix.
    - Cons: much wider testing; the terminal tabs have their own focus handling.

### 2. Give keyboard users a way to move tabs

**Problem.** Keyboard users cannot move a tab to another group or split.

**Context.** The keyboard sensor was left out deliberately, because it claims Enter and Space, which select a tab (`CoordinatorPaneTree.tsx:101-102`).

**Investigation.** `moveCoordinatorConversation` and `splitCoordinatorPaneAtEdge` (`apps/web/src/lib/coordinator-pane-layout.ts`) already do the moves. There is no context menu.

**Decisions.** None: add a menu, reachable with the context-menu key, with "Move to new group" and "Move to group N", calling those functions. It is also the natural place for the Change agent action in [0070](0070-change-agent-action-and-main-tab-marker.md).

### 3. Label the loading spinner

**Problem.** The loading state is a silent icon.

**Context.** None beyond the finding.

**Investigation.** `CoordinatorPanel.tsx:667-677`.

**Decisions.** None: add `role="status"` and visually hidden text.

## Related

- [Coordinator report, 4.4 (U11)](../2026-10-27-coordinator.md#44-ui-and-ux)
