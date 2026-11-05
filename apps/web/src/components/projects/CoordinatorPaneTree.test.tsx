import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as sortable from "@dnd-kit/sortable";
import {
  collectCoordinatorLeaves,
  focusedCoordinatorConversationId,
  reconcileCoordinatorLayout,
  splitCoordinatorPaneAtEdge,
  type CoordinatorPaneLayout,
} from "@/lib/coordinator-pane-layout";
import { createDraggableTabId } from "@/types/paneLayout";
import {
  CoordinatorPaneTree,
  SortableCoordinatorTab,
  coordinatorDragEndChange,
  coordinatorTabElementId,
} from "./CoordinatorPaneTree";

afterEach(cleanup);

/** Two groups: `a` and `b` on the left (focused), `c` on the right. */
function twoGroups(): CoordinatorPaneLayout {
  const single = reconcileCoordinatorLayout(null, ["a", "b", "c"]);
  const split = splitCoordinatorPaneAtEdge(
    single,
    single.activePaneId,
    "right",
    "c",
    single.activePaneId,
  );
  const [left] = collectCoordinatorLeaves(split.root);
  return { ...split, activePaneId: left!.id };
}

test("coordinator tabs omit non-unit scales when dragged over unequal-width tabs", () => {
  const useSortable = sortable.useSortable;
  const sortableSpy = spyOn(sortable, "useSortable").mockImplementation((options) => ({
    ...useSortable(options),
    transform: { x: 120, y: -6, scaleX: 2.5, scaleY: 0.75 },
    transition: "transform 200ms ease",
    isDragging: true,
  }));
  try {
    render(
      <SortableCoordinatorTab
        conversationId="conversation-1"
        paneId="pane-1"
        isActive
        style={{ width: 120 }}
        data-testid="coordinator-tab"
      >
        Coordinator
      </SortableCoordinatorTab>,
    );

    const tab = screen.getByTestId("coordinator-tab");
    expect(tab.style.transform).toBe("translate3d(120px, -6px, 0)");
    expect(tab.style.transition).toBe("transform 200ms ease");
    expect(tab.style.width).toBe("120px");
  } finally {
    sortableSpy.mockRestore();
  }
});

test("the draggable shell is not a control: no button role and no tab stop of its own", () => {
  render(
    <SortableCoordinatorTab
      conversationId="conversation-1"
      paneId="pane-1"
      isActive
      data-testid="coordinator-tab"
    >
      <button type="button" role="tab" aria-selected>
        Coordinator
      </button>
    </SortableCoordinatorTab>,
  );
  const shell = screen.getByTestId("coordinator-tab");
  expect(shell.getAttribute("role")).toBe("presentation");
  expect(shell.hasAttribute("tabindex")).toBe(false);
  expect(shell.hasAttribute("aria-roledescription")).toBe(false);
  expect(screen.getAllByRole("tab")).toHaveLength(1);
});

function renderTree(layout: CoordinatorPaneLayout, onFocusPane = mock((_paneId: string) => {})) {
  render(
    <CoordinatorPaneTree
      layout={layout}
      onLayoutChange={() => {}}
      onFocusPane={onFocusPane}
      conversationLabel={(id) => id}
      renderTab={(id, pane) => (
        <SortableCoordinatorTab key={id} conversationId={id} paneId={pane.id} isActive={false}>
          <button
            type="button"
            role="tab"
            id={coordinatorTabElementId(pane.id, id)}
            aria-selected={pane.activeConversationId === id}
          >
            {id}
          </button>
        </SortableCoordinatorTab>
      )}
      renderStripActions={() => <button type="button">New</button>}
      renderContent={(pane) => <button type="button">Content {pane.id}</button>}
    />,
  );
  return onFocusPane;
}

test("each group is a labelled tab list whose panel is labelled by its front tab", () => {
  const layout = twoGroups();
  renderTree(layout);
  const lists = screen.getAllByRole("tablist", { name: "Coordinator conversations" });
  expect(lists).toHaveLength(2);
  // Only tabs in the list; the strip's own actions sit beside it.
  expect(lists[0]!.querySelectorAll("button:not([role=tab])")).toHaveLength(0);
  const [left] = collectCoordinatorLeaves(layout.root);
  const panel = screen.getAllByRole("tabpanel")[0]!;
  expect(panel.getAttribute("aria-labelledby")).toBe(
    coordinatorTabElementId(left!.id, left!.activeConversationId!),
  );
  expect(document.getElementById(panel.getAttribute("aria-labelledby")!)?.textContent).toBe(
    left!.activeConversationId!,
  );
});

test("arrow keys, Home and End move focus between a strip's tabs", () => {
  renderTree(twoGroups());
  const [a, b] = screen.getAllByRole("tab");
  a!.focus();
  fireEvent.keyDown(a!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(b!);
  fireEvent.keyDown(b!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(a!);
  fireEvent.keyDown(a!, { key: "End" });
  expect(document.activeElement).toBe(b!);
  fireEvent.keyDown(b!, { key: "Home" });
  expect(document.activeElement).toBe(a!);
  fireEvent.keyDown(a!, { key: "ArrowLeft" });
  expect(document.activeElement).toBe(b!);
});

test("a press in another group's strip leaves focusing to the tab; one in its content focuses it", () => {
  const layout = twoGroups();
  const onFocusPane = renderTree(layout);
  const [, right] = collectCoordinatorLeaves(layout.root);
  const tab = screen.getByRole("tab", { name: "c" });
  fireEvent.pointerDown(tab);
  fireEvent.focus(tab);
  expect(onFocusPane).not.toHaveBeenCalled();
  fireEvent.pointerDown(screen.getByRole("button", { name: `Content ${right!.id}` }));
  expect(onFocusPane).toHaveBeenCalledWith(right!.id);
});

test("every finished drag focuses a group, since a drag does not click", () => {
  const layout = twoGroups();
  const [left, right] = collectCoordinatorLeaves(layout.root);
  const unfocused = { ...layout, activePaneId: right!.id };

  const reordered = coordinatorDragEndChange(
    { type: "reorder", paneId: left!.id, fromIndex: 0, toIndex: 1 },
    createDraggableTabId("a", left!.id),
  )(unfocused);
  expect(reordered.activePaneId).toBe(left!.id);
  expect(collectCoordinatorLeaves(reordered.root)[0]!.conversationIds).toEqual(["b", "a"]);

  const dropped = coordinatorDragEndChange(
    { type: "none" },
    createDraggableTabId("a", left!.id),
  )(unfocused);
  expect(dropped.activePaneId).toBe(left!.id);

  const moved = coordinatorDragEndChange(
    { type: "move", fromPaneId: left!.id, toPaneId: right!.id, tabId: "a" },
    createDraggableTabId("a", left!.id),
  )(layout);
  expect(moved.activePaneId).toBe(right!.id);
  expect(focusedCoordinatorConversationId(moved)).toBe("a");

  // A split the layout refuses (a lone tab off its own group) still focuses the source.
  const refused = coordinatorDragEndChange(
    { type: "split", targetPaneId: right!.id, edge: "left", tabId: "c", fromPaneId: right!.id },
    createDraggableTabId("c", right!.id),
  )(layout);
  expect(refused.activePaneId).toBe(right!.id);
  expect(collectCoordinatorLeaves(refused.root)).toHaveLength(2);
});
