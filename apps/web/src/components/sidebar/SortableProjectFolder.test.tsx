import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as sortable from "@dnd-kit/sortable";
import { installControlledTimeout } from "../../../../../tests/helpers/controlled-timeout";
import { DndContext, KeyboardSensor, useSensor, useSensors } from "@dnd-kit/core";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { useState, type ReactNode } from "react";
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
  renderInAppCommandScope(
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
    renderInAppCommandScope(
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
    const view = renderInAppCommandScope(content());
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

test.each([false, true])(
  "selected=%s controls repository currentness and background",
  (selected) => {
    renderInAppCommandScope(
      <SortableProjectFolder
        name="acme/app"
        repository
        selected={selected}
        onOpen={() => {}}
        projectCount={1}
        isCollapsed={false}
        onToggleCollapse={() => {}}
      >
        <span>Member</span>
      </SortableProjectFolder>,
    );
    const heading = screen.getByRole("button", { name: "Open acme/app" });
    expect(heading.getAttribute("aria-current")).toBe(selected ? "page" : null);
    const frame = heading.closest("[data-project-folder]")!.querySelector(".relative")!;
    expect(frame.classList.contains("from-selected")).toBe(selected);
  },
);

function ToggleableHeading({
  addAction,
  onOpen,
  repository,
}: {
  addAction?: { label: string; title: string; onAdd: () => void };
  onOpen?: () => void;
  repository: boolean;
}) {
  const [isCollapsed, setCollapsed] = useState(false);
  return (
    <DndContext>
      <SortableProjectFolder
        name={repository ? "github.com/acme/app" : "Work"}
        label={repository ? "acme/app" : "Work"}
        repository={repository}
        onOpen={onOpen}
        addAction={addAction}
        projectCount={1}
        isCollapsed={isCollapsed}
        onToggleCollapse={() => setCollapsed((collapsed) => !collapsed)}
      >
        <span>Member</span>
      </SortableProjectFolder>
    </DndContext>
  );
}

test("a repository heading with a + has a project chevron to its right that only toggles", () => {
  const onOpen = mock(() => {});
  const onAdd = mock(() => {});
  renderInAppCommandScope(
    <ToggleableHeading
      repository
      onOpen={onOpen}
      addAction={{ label: "New environment in acme/app", title: "New environment", onAdd }}
    />,
  );
  const add = screen.getByRole("button", { name: "New environment in acme/app" });
  const chevron = screen.getByRole("button", { name: "Collapse project acme/app" });
  expect(add.nextElementSibling).toBe(chevron);
  expect(chevron.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Open acme/app" }).hasAttribute("aria-expanded")).toBe(
    false,
  );

  fireEvent.click(chevron);
  expect(screen.queryByText("Member") === null).toBe(true);
  expect(chevron.getAttribute("aria-expanded")).toBe("false");
  expect(chevron.getAttribute("aria-label")).toBe("Expand project acme/app");
  expect(onOpen).not.toHaveBeenCalled();
  expect(onAdd).not.toHaveBeenCalled();
  fireEvent.click(chevron);
  expect(screen.getByText("Member")).toBeTruthy();

  fireEvent.click(add);
  expect(onAdd).toHaveBeenCalledTimes(1);
  expect(chevron.getAttribute("aria-expanded")).toBe("true");
});

test("a folder heading keeps its single folder chevron and no +", () => {
  renderInAppCommandScope(<ToggleableHeading repository={false} />);
  const buttons = screen.getAllByRole("button");
  expect(buttons).toHaveLength(2);
  expect(screen.queryByTestId("repository-new-environment") === null).toBe(true);
  expect(screen.queryByTestId("repository-collapse-toggle") === null).toBe(true);
  const chevron = screen.getByRole("button", { name: "Collapse folder Work" });
  expect(chevron.hasAttribute("title")).toBe(false);
  expect(chevron.parentElement!.lastElementChild).toBe(chevron);
  // The folder's heading toggles too, and reports the same state.
  const heading = screen.getByTitle("Collapse folder Work");
  expect(heading.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(chevron);
  expect(screen.queryByText("Member") === null).toBe(true);
  expect(heading.getAttribute("aria-expanded")).toBe("false");
  expect(chevron.getAttribute("aria-label")).toBe("Expand folder Work");
});
