import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as sortable from "@dnd-kit/sortable";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { DndContext, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SortableProjectFolder } from "./SortableProjectFolder";

afterEach(cleanup);

function KeyboardDragContext({
  onDragStart,
  children,
}: {
  onDragStart: () => void;
  children: ReactNode;
}) {
  const sensors = useSensors(useSensor(KeyboardSensor));
  return (
    <DndContext sensors={sensors} onDragStart={onDragStart}>
      {children}
    </DndContext>
  );
}

function renderRepositoryHeading(onOpen: () => void, onDragStart: () => void) {
  const onToggleCollapse = mock(() => {});
  render(
    <KeyboardDragContext onDragStart={onDragStart}>
      <SortableProjectFolder
        name="github.com/acme/app"
        label="acme/app"
        repository
        onOpen={onOpen}
        openMachineName="This computer"
        projectCount={1}
        isCollapsed={false}
        onToggleCollapse={onToggleCollapse}
      >
        <span>Member</span>
      </SortableProjectFolder>
    </KeyboardDragContext>,
  );
  const heading = screen.getByRole("button", { name: "Open acme/app on This computer" });
  return { heading, onToggleCollapse };
}

test("Enter preserves native opening on the repository heading", () => {
  const onOpen = mock(() => {});
  const onDragStart = mock(() => {});
  const { heading, onToggleCollapse } = renderRepositoryHeading(onOpen, onDragStart);
  act(() => heading.focus());
  expect(fireEvent.keyDown(heading, { key: "Enter", code: "Enter" })).toBe(true);
  expect(fireEvent.keyUp(heading, { key: "Enter", code: "Enter" })).toBe(true);
  // Happy DOM does not generate the native button click from keyboard events.
  // The browser suite covers that default action; here verify it stays uncancelled.
  fireEvent.click(heading);
  expect(onOpen).toHaveBeenCalledTimes(1);
  expect(onDragStart).not.toHaveBeenCalled();
  expect(onToggleCollapse).not.toHaveBeenCalled();
});

test("Space starts dragging the repository from its heading", () => {
  const onOpen = mock(() => {});
  const onDragStart = mock(() => {});
  const { heading, onToggleCollapse } = renderRepositoryHeading(onOpen, onDragStart);
  expect(heading.getAttribute("aria-roledescription")).toBe("sortable");
  act(() => heading.focus());
  expect(fireEvent.keyDown(heading, { key: " ", code: "Space" })).toBe(false);
  expect(onDragStart).toHaveBeenCalledTimes(1);
  expect(heading.getAttribute("aria-pressed")).toBe("true");
  expect(onOpen).not.toHaveBeenCalled();
  expect(onToggleCollapse).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: /^Move repository/ }) === null).toBe(true);
});

test.each([false, true])(
  "right-click is captured only when folder actions exist (actions: %s)",
  async (hasActions) => {
    render(
      <SortableProjectFolder
        name="acme/app"
        repository
        onOpen={() => {}}
        projectCount={1}
        isCollapsed={false}
        onToggleCollapse={() => {}}
        onSort={hasActions ? () => {} : undefined}
      >
        <span>Member</span>
      </SortableProjectFolder>,
    );
    let notCancelled = false;
    await act(async () => {
      notCancelled = fireEvent.contextMenu(screen.getByRole("button", { name: "Open acme/app" }));
    });
    expect(notCancelled).toBe(!hasActions);
    expect(screen.queryByRole("menu") !== null).toBe(hasActions);
    if (hasActions) expect(screen.getByRole("menuitem", { name: "Sort" })).toBeTruthy();
  },
);

test("a completed drag suppresses its click until the next task and then permits opening", () => {
  let dragging = true;
  const useSortable = sortable.useSortable;
  const sortableSpy = spyOn(sortable, "useSortable").mockImplementation((options) => ({
    ...useSortable(options),
    isDragging: dragging,
  }));
  const timer = installControlledTimeout(0, { label: "post-drag click guard" });
  const onOpen = mock(() => {});
  const onToggleCollapse = mock(() => {});
  const content = () => (
    <DndContext>
      <SortableProjectFolder
        name="acme/app"
        repository
        onOpen={onOpen}
        projectCount={1}
        isCollapsed={false}
        onToggleCollapse={onToggleCollapse}
      >
        <span>Member</span>
      </SortableProjectFolder>
    </DndContext>
  );
  try {
    const view = render(content());
    const heading = screen.getByRole("button", { name: "Open acme/app" });
    fireEvent.click(heading);
    expect(onOpen).not.toHaveBeenCalled();
    dragging = false;
    view.rerender(content());
    expect(timer.pendingCount()).toBe(1);
    // Deliver a click directly so this checks the local guard independently
    // of any click suppression performed by the drag sensor itself.
    fireEvent.click(heading);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onToggleCollapse).not.toHaveBeenCalled();
    act(() => {
      timer.advance();
    });
    fireEvent.click(heading);
    expect(onOpen).toHaveBeenCalledTimes(1);
    timer.assertDrained();
  } finally {
    cleanup();
    timer.restore();
    sortableSpy.mockRestore();
  }
});
