# C8: Tab strip

This file combines 4 reports into one batch to build together. Mostly the same `TabShell` and pane tree.

For the lane, order and conflicts, see [Parallel running](0000-index.md#parallel-running) in this folder's index.

Analysed 2026-11-03 against `main` at `a2bba9d8`.

## Parts

| Part | Criticality | Covers |
| --- | --- | --- |
| [0070](#0070-add-a-visible-change-agent-action-and-mark-the-main-tab) | High | A visible Change agent action and a marker on the main tab. |
| [0230](#0230-coordinator-tab-strip-accessibility) | Medium | Tab semantics, keyboard tab moves and a labelled spinner. |
| [0420](#0420-clicking-a-tab-in-an-unfocused-group-writes-the-selection-twice) | Low | One selection write per tab click. |
| [0430](#0430-coordinator-toolbar-on-narrow-screens) | Low | Collapsing the New side agent label on narrow screens. |

## 0070: Add a visible Change agent action and mark the main tab

### Task analysis

#### Tasks

1. **Add Change agent**: an action on the main tab that closes the conversation and starts the next main on a chosen platform. Status: open.
2. **Mark the main tab**: a visible marker separating it from side agents. Status: open.

#### 1. Add Change agent

**Problem.** Closing the main tab is the only way to change provider, and that is explained only in the close button's accessible name.

**Context.** The confirmation half is done (see [Current state](#current-state)). The binding is one-way once a provider session exists (`coordinator-service.ts:665-680`), so "change" means a new conversation.

**Investigation.** The explanation is `closeLabel` at `CoordinatorPanel.tsx:1078-1082`, which `TabShell` sets as `aria-label` with no `title` (`TabShell.tsx:62-66`), and the button hides until hover on fine pointers. The dialog at `:1196-1223` says a new main starts "with the default agent", and gives no choice and no mention that open delegations move. `ensureMainConversation` moves live work to the new main (`coordinator-service.ts:315`). `createConversation` creates an unassigned main when none is open (`:621-623`), and the composer then offers every qualified platform. So the choice already exists if the user is taken to a fresh main rather than left waiting for mail.

**Decisions.**

- **What does the action do?**
  - **Close, then create an unassigned main and focus its composer (recommended).**
    - Pros: reuses the picker and both backend paths; no new command; the user chooses before anything starts.
    - Cons: if mail arrives first, `ensureMainConversation` assigns the default agent before the user picks.
  - **A dialog that picks the platform, then assigns it as part of the close.**
    - Pros: closes the race with mail.
    - Cons: a new atomic backend command, and a second picker to keep in step with the composer's.

#### 2. Mark the main tab

**Problem.** Nothing but the title "Coordinator" (`coordinator-service.ts:115`) and tab order shows which conversation is the main.

**Context.** The report suggests a crown or a "Main" pill.

**Investigation.** The tab's contents are at `CoordinatorPanel.tsx:1091-1121`, where the brand mark and any "Choose agent" hint already sit. Its accessible name is set explicitly at `:1096-1100` and would need the same word.

**Decisions.** None: add a small "Main" label only when side agents are open, and include it in the accessible name.

### Current state

- Closing the main always asks first (`CoordinatorPanel.tsx:1083-1087`, dialog `:1196-1223`; `e5245dfd6`, #1644), which is broader than the report's "while a turn is running or delegations are open".

## 0230: Coordinator tab strip accessibility

### Task analysis

#### Tasks

1. **Use tab semantics without nesting**: `tablist`, `tab` and `aria-selected`, with one tab stop per tab. Status: open.
2. **Give keyboard users a way to move tabs**: a menu with move and split actions. Status: open.
3. **Label the loading spinner**: `role="status"` and text. Status: open.

#### 1. Use tab semantics without nesting

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

#### 2. Give keyboard users a way to move tabs

**Problem.** Keyboard users cannot move a tab to another group or split.

**Context.** The keyboard sensor was left out deliberately, because it claims Enter and Space, which select a tab (`CoordinatorPaneTree.tsx:101-102`).

**Investigation.** `moveCoordinatorConversation` and `splitCoordinatorPaneAtEdge` (`apps/web/src/lib/coordinator-pane-layout.ts`) already do the moves. There is no context menu.

**Decisions.** None: add a menu, reachable with the context-menu key, with "Move to new group" and "Move to group N", calling those functions. It is also the natural place for the Change agent action in [0070](#0070-add-a-visible-change-agent-action-and-mark-the-main-tab).

#### 3. Label the loading spinner

**Problem.** The loading state is a silent icon.

**Context.** None beyond the finding.

**Investigation.** `CoordinatorPanel.tsx:667-677`.

**Decisions.** None: add `role="status"` and visually hidden text.

## 0420: Clicking a tab in an unfocused group writes the selection twice

### Task analysis

#### Tasks

1. **Select once**: a click on a tab in another group writes one selection. Status: open.

#### 1. Select once

**Problem.** The pane's capture handler selects its front tab, then the click selects the tab that was clicked. The backend gets two writes, and there is a moment with the wrong selection.

**Context.** The click's `stopPropagation` only stops the bubbling `onClick`, as its comment intends (`CoordinatorPanel.tsx:1072-1074`).

**Investigation.** `onPointerDownCapture` calls `onFocusPane` (`CoordinatorPaneTree.tsx:309`), which goes through `changeLayout` to `selectConversation` for the front conversation (`CoordinatorPanel.tsx:305-316`). The serializer coalesces only when a request is in flight (`:271-272`).

**Decisions.** None: in the capture handler, skip focusing when the pointer target is inside the tab strip, since the tab's click does it. Check that dragging a tab still focuses the group, because a drag does not click.

## 0430: Coordinator toolbar on narrow screens

### Task analysis

#### Tasks

1. **Collapse New side agent to an icon**: and reduce toolbar wrapping when narrow. Status: open.

#### 1. Collapse New side agent to an icon

**Problem.** The toolbar wraps onto several rows, and "New side agent" keeps its full label in a tab strip that scrolls.

**Context.** The badge text is shorter than it was, and the path and revision moved to its tooltip.

**Investigation.** The toolbar uses `flex-wrap` (`CoordinatorPanel.tsx:879`). The strip button always renders its label (`:1139-1140`). The strip scrolls (`TAB_STRIP_CLASS`, `TabShell.tsx:18`).

**Decisions.** None: hide the label under the small breakpoint and keep an `aria-label`, with [0320](0240-c10-explanations.md#0320-side-agents-are-never-explained)'s tooltip on it.

### Needs verification

How many rows the toolbar takes at phone width now; seen only in code.

## Related

- [Coordinator report, 4.4 (U2)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [Architecture: One main coordinator](../../architecture/coordinator.md#one-main-coordinator-and-side-agents)
- [Coordinator report, 4.4 (U11)](../2026-10-27-coordinator.md#44-ui-and-ux)
- [Coordinator report, 4.4 (U13)](../2026-10-27-coordinator.md#44-ui-and-ux)

## Outcome

Checked back item by item on 2026-11-05. The work started from `main` at
`69a3b4ca5`. The findings were re-checked first: the C9 split had moved the
tab rendering to `CoordinatorPanel.tsx`'s `renderTab`, the toolbar to
`CoordinatorToolbar.tsx` and the selection to `useCoordinatorSelection.ts`, and
every finding still held. Live checks ran on an isolated `dev:test` profile with
no agent credentials and no provider turn.

| Part | Task | Outcome | Evidence |
| --- | --- | --- | --- |
| 0070 | 1. Add Change agent | Done; tab position after the change moved to to-do 5200 task 2 | Recommended option: a Change agent button on the assigned main tab and a menu item, both behind a confirmation that closes the main and then creates an unassigned main in the same group (`CoordinatorConversationTab.tsx`; `createConversation(replacingMain)` and the dialog in `CoordinatorPanel.tsx`). The dialog says open delegations move and that a report arriving first starts the default agent. Tests: `CoordinatorPanel.tabs.test.tsx` ("Change agent closes the main and opens an unassigned main in its place", "closing the main explains Change agent only when there is an agent to change"). Live: the old main closed, an unassigned main opened, and its composer held focus. |
| 0070 | 2. Mark the main tab | Done | "Main" label and ", main" in the accessible name when more than one conversation is open (`CoordinatorConversationTab.tsx`). Test: "marks the main tab only once side agents are open beside it". |
| 0070 | Current state: confirm closing the main | Already done; wording extended | The close dialog now also says open delegations move to the next main, and points to Change agent when the main has an agent. |
| 0230 | 1. Use tab semantics without nesting | Done for the coordinator strip; environment strip moved to to-do 5200 task 1 | Recommended option. `tablist` around each strip's tabs, `role="tab"` button with `aria-selected` and an id, a `presentation` shell without `useSortable`'s button role or tab stop, a `tabpanel` labelled by the front tab, arrow keys, Home and End (`CoordinatorPaneTree.tsx`, `CoordinatorConversationTab.tsx`). Tests: `CoordinatorPaneTree.test.tsx` ("the draggable shell is not a control", "each group is a labelled tab list", "arrow keys, Home and End"). |
| 0230 | 2. Give keyboard users a way to move tabs | Done | A tab menu opened by right-click, the context-menu key or Shift+F10, with Move to new group (`canSplitCoordinatorPane`) and Move to group N, and Change agent on the main (`CoordinatorConversationTab.tsx`, `coordinator-pane-layout.ts`). Tests: "the tab menu opens from the keyboard and moves a tab to a new group and back", `coordinator-pane-layout.test.ts`. Live: Shift+F10 then Enter split a side agent into its own group. |
| 0230 | 3. Label the loading spinner | Done | `role="status"` with visually hidden text on the panel's loading state and the conversation's lazy-load fallback (`CoordinatorPanel.tsx`, `CoordinatorConversationPane.tsx`). Test: "the loading state is announced". |
| 0420 | 1. Select once | Done | A press or focus inside a tab strip, or from a portalled menu, no longer focuses the group (`focusesPane` in `CoordinatorPaneTree.tsx`); every finished drag focuses the group it landed in or started from (`coordinatorDragEndChange`). Tests: "a click on a tab in another group writes the selection once" (fails with the old handlers), `CoordinatorPaneTree.test.tsx` ("a press in another group's strip", "every finished drag focuses a group"); the New side agent group test now asserts no write for the group's front tab. Live: a drag that dropped in place focused its group. |
| 0430 | 1. Collapse New side agent to an icon | Done; its tooltip wording stays with C10 part 0320 | Below `sm` the label is visually hidden and the button keeps its name and a `title` (`CoordinatorPanel.tsx`); Sync and Pause do the same and the isolation badge shows its icon and "Advisory" (`CoordinatorToolbar.tsx`, `CoordinatorPanelNotices.tsx`). Test: "New side agent keeps its name when only its icon shows". The 0320 tooltip text is C10's and still open in `0240-c10-explanations.md`. |
| 0430 | Needs verification: toolbar rows at phone width | Done | Measured live at 390 px: two rows before, one row after. |

To-do needed: [5200](../../todo/coordinator-and-multi-review/5200-c8-tab-strip-follow-ups.md).
