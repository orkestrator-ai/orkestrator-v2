# C8 tab strip follow-ups

## Task analysis

Analysed 2026-11-05 against main at 69a3b4ca5, with coordinator batch C8 (Tab strip) applied.

### Tasks

1. **Give the environment tab strip the same tab semantics**: the follow-up the C8 part `0230` decision left for later. Status: open.
2. **Place a new main where the old one was**: the C8 review repair now restores the replacement to the original group and index. Status: done.

### 1. Give the environment tab strip the same tab semantics

**Problem.** In an environment's panes, each tab is still a `role="button"` element with its own tab stop that holds a close button, and nothing announces a tab list. A screen reader user hears a list of buttons, and the controls nest.

**Context.** From coordinator report C8, part `0230` (Coordinator tab strip accessibility), task 1. Its recommended option fixed the coordinator strip first and accepted, as its con, that "the environment strip keeps the problem until it follows". C8 built the coordinator half: `SortableCoordinatorTab` no longer spreads `useSortable`'s `attributes`, the strip wraps its tabs in a `tablist`, the tab is a `role="tab"` button with `aria-selected`, and each group's content is a `tabpanel` (`CoordinatorPaneTree.tsx`, `CoordinatorConversationTab.tsx`).

**Investigation.** `DraggableTab` spreads `useSortable`'s `attributes` (button role, `tabIndex=0`, `aria-roledescription`) onto `TabShell` (`apps/web/src/components/pane-layout/DraggableTab.tsx:347-351`), and its title is not a separate control, so the shell itself is the focusable element and the close button nests inside it. The strip is `DraggableTabBar.tsx` (`TAB_STRIP_CLASS` at `:372`), with no `tablist`. The environment tabs already have a context menu (`DraggableTab.tsx`, `ContextMenu` around the shell) and their own focus handling in the terminal container, which is why the C8 report kept them out of scope.

**Decisions.**

- **How should the environment tab carry the semantics?**
  - **Make the shell the `role="tab"` element and keep it focusable, with `aria-selected`; give the strip `role="tablist"` (recommended).**
    - Pros: one focusable element per tab, no new inner button, and the existing context menu and tooltip handlers stay on the element they are on.
    - Cons: the close button stays nested inside a `tab`, which some checkers flag; it needs `tabIndex={-1}` and a menu or keyboard shortcut to close.
  - **Do what the coordinator strip does: an inner `role="tab"` button and a presentational shell.**
    - Pros: the same structure in both strips, and the close button is a sibling rather than a child of the tab.
    - Cons: every tab type's title rendering moves into a button, and the terminal container's focus handling has to be checked against the new focus target.

### 2. Place a new main where the old one was

**Problem.** After Change agent, the new main joins the end of its tab group, after any side agents in that group, while a project opened fresh lists the main first.

**Context.** Change agent (C8 part `0070`) closes the main, then creates an unassigned main. The layout is reconciled against the open conversations: the closed main is dropped, and the new conversation is appended to the focused group (`reconcileCoordinatorLayout` in `apps/web/src/lib/coordinator-pane-layout.ts`). The panel sorts conversations main first, but that order only seeds a layout with no stored groups.

**Investigation.** Seen on an isolated `dev:test` profile on 2026-11-05: with `Coordinator` and `Side 1` in one group, Change agent left `Side 1` first and the new `Coordinator` second. With its "Main" and "Choose agent" labels the new tab's title also truncated to "Coordi…" at 1280 px. Nothing is lost; it is a matter of order.

**Decisions.**

- **Where should the new main go?**
  - **At the index the closed main had in its group (recommended).** Record the index before closing, and move the new main there once the snapshot names it.
    - Pros: nothing in the strip appears to move.
    - Cons: a second layout write after the create, and a case where the group closed with the old main.
  - **Always first in its group.**
    - Pros: matches the panel's main-first order; one rule.
    - Cons: moves the main ahead of tabs the user had put before it.
  - **Leave it at the end.**
    - Pros: no code.
    - Cons: the main moves every time its agent changes.

## Assumptions and decisions

### Task 2: Preserve the replacement slot

The C8 review repair retains the pre-close layout and replaces the old main ID
in that layout after creation succeeds. This preserves the group even when it
held only the main, and preserves its tab index. Close rejection leaves the old
main visible; creation rejection publishes the successful close instead of
leaving a closed conversation visible. Regression tests cover delayed creation
in split groups and both rejection paths.

## Related

- `apps/web/src/components/pane-layout/DraggableTab.tsx`
- `apps/web/src/components/pane-layout/DraggableTabBar.tsx`
- `apps/web/src/components/projects/CoordinatorConversationTab.tsx`
- `apps/web/src/lib/coordinator-pane-layout.ts`
- [Architecture: Tab groups](../../architecture/coordinator.md#tab-groups)
