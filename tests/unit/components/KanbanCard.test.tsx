import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import * as realDndCore from "@dnd-kit/core";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { KanbanTask } from "@/stores/kanbanStore";
import type { ComponentProps } from "react";

const realDndCoreSnapshot = { ...realDndCore };
const draggableState = {
  isDragging: false,
  setNodeRef: mock(() => {}),
};

mock.module("@dnd-kit/core", () => ({
  ...realDndCoreSnapshot,
  useDraggable: mock(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: draggableState.setNodeRef,
    transform: null,
    isDragging: draggableState.isDragging,
  })),
}));

// The real context menu is Radix-portal + pointer driven, which behaves
// inconsistently across the shared Bun test process (act configuration and the
// global mock installed by EnvironmentItem.test.tsx both leak in). Mock it
// locally with the same shape EnvironmentItem uses so this suite is
// deterministic regardless of file execution order.
mock.module("@/components/ui/context-menu", () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="context-menu-content">{children}</div>
  ),
  ContextMenuItem: ({
    children,
    disabled,
    onClick,
    onSelect,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onClick?: () => void;
    onSelect?: () => void;
  }) => (
    <div
      role="menuitem"
      aria-disabled={disabled ? "true" : undefined}
      onClick={
        disabled
          ? undefined
          : () => {
              onClick?.();
              onSelect?.();
            }
      }
    >
      {children}
    </div>
  ),
  ContextMenuSeparator: () => <hr />,
}));

import { KanbanCard } from "@/components/kanban/KanbanCard";

const DndContext = realDndCoreSnapshot.DndContext;

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Stuck build task",
    description: "Needs reset",
    acceptanceCriteria: "",
    status: "backlog",
    comments: [],
    images: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    order: 0,
    ...overrides,
  };
}

function renderCard(task: KanbanTask, props: Partial<ComponentProps<typeof KanbanCard>> = {}) {
  return render(
    <DndContext>
      <KanbanCard task={task} onClick={() => {}} {...props} />
    </DndContext>,
  );
}

describe("KanbanCard", () => {
  afterEach(() => {
    cleanup();
    draggableState.isDragging = false;
    draggableState.setNodeRef.mockClear();
  });

  afterAll(() => {
    mock.module("@dnd-kit/core", () => realDndCoreSnapshot);
  });

  test("right-click menu can clear a linked build status", async () => {
    const task = makeTask({ environmentId: "env-1", buildPipelineId: "pipeline-1" });
    const onClearStatus = mock(() => {});

    renderCard(task, {
      canClearStatus: true,
      onClearStatus,
      buildPhase: "paused",
    });

    fireEvent.contextMenu(screen.getByText("Stuck build task"));

    await waitFor(() => {
      expect(screen.getByText("Clear status")).toBeTruthy();
    });

    fireEvent.click(screen.getByText("Clear status"));

    expect(onClearStatus).toHaveBeenCalledWith(task);
  });

  test("does not render clear status menu item for unlinked cards", () => {
    renderCard(makeTask(), { canClearStatus: false });

    expect(screen.queryByText("Clear status") === null).toBe(true);
  });

  test("does not render clear status menu item while a build is active", () => {
    // canClearStatus is computed by KanbanBoard; an actively-building card is
    // passed canClearStatus={false} so the action is never offered mid-build.
    renderCard(makeTask({ environmentId: "env-1" }), {
      canClearStatus: false,
      buildPhase: "building",
    });

    expect(screen.queryByText("Clear status") === null).toBe(true);
  });

  test("shows the linked environment name in the card footer", () => {
    renderCard(makeTask({ environmentId: "env-1", comments: [] }), {
      environmentName: "attach-images-to",
    });

    expect(screen.getByText("attach-images-to")).toBeTruthy();
  });

  test("separates the comment count from the environment name when both are shown", () => {
    renderCard(
      makeTask({
        environmentId: "env-1",
        comments: [
          {
            id: "c-1",
            text: "hi",
            createdAt: "2026-01-01T00:00:00.000Z",
          } as KanbanTask["comments"][number],
        ],
      }),
      { environmentName: "fix-provider-icons" },
    );

    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("fix-provider-icons")).toBeTruthy();
    expect(screen.getByText("|")).toBeTruthy();
  });

  test("renders no footer at all when there is neither a comment nor an environment", () => {
    renderCard(makeTask());

    expect(screen.queryByText("|") === null).toBe(true);
  });

  test("gives the card the accent colour of the column it sits in", () => {
    const { container } = renderCard(makeTask({ status: "review" }));

    expect(container.querySelector(".bg-amber-500")).toBeTruthy();
  });

  test("the Open affordance opens the task without needing the card body click", () => {
    const onClick = mock(() => {});
    renderCard(makeTask(), { onClick });

    fireEvent.click(screen.getByRole("button", { name: "Open" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("reserves an action row and disables hidden controls from intercepting pointers", () => {
    renderCard(makeTask({ description: "" }));

    const card = screen.getByTestId("kanban-card");
    expect(card.querySelector(".pb-8")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open" }).className).toContain("pointer-events-none");
    expect(screen.getByRole("button", { name: /Task actions/ }).className).toContain(
      "pointer-events-none",
    );
  });

  test("the Open task dropdown command invokes the card callback exactly once", () => {
    const onClick = mock(() => {});
    renderCard(makeTask(), { onClick });

    fireEvent.pointerDown(screen.getByRole("button", { name: /Task actions/ }));
    const menu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');
    expect(menu).toBeTruthy();
    fireEvent.click(within(menu!).getByRole("menuitem", { name: "Open task" }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("the Clear status dropdown command does not open the task", () => {
    const task = makeTask({ environmentId: "env-1" });
    const onClick = mock(() => {});
    const onClearStatus = mock(() => {});
    renderCard(task, { canClearStatus: true, onClick, onClearStatus });

    fireEvent.pointerDown(screen.getByRole("button", { name: /Task actions/ }));
    const menu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');
    expect(menu).toBeTruthy();
    fireEvent.click(within(menu!).getByRole("menuitem", { name: "Clear status" }));

    expect(onClearStatus).toHaveBeenCalledTimes(1);
    expect(onClearStatus).toHaveBeenCalledWith(task);
    expect(onClick).not.toHaveBeenCalled();
  });

  test("the dropdown omits Clear status when clearing is not allowed", async () => {
    renderCard(makeTask(), { canClearStatus: false });

    fireEvent.pointerDown(screen.getByRole("button", { name: /Task actions/ }));
    const menu = document.querySelector<HTMLElement>('[data-slot="dropdown-menu-content"]');
    expect(menu).toBeTruthy();
    expect(within(menu!).getByRole("menuitem", { name: "Open task" })).toBeTruthy();
    expect(within(menu!).queryByRole("menuitem", { name: "Clear status" }) === null).toBe(true);

    fireEvent.keyDown(menu!, { key: "Escape" });
    await waitFor(() => {
      expect(document.querySelector('[data-slot="dropdown-menu-content"]') === null).toBe(true);
    });
  });

  test("renders a size-matched placeholder while dragging and restores the card afterward", () => {
    draggableState.isDragging = true;
    const task = makeTask({
      title: "A title long enough that the source card must keep it to a single line",
      description: "Two lines of detail",
    });
    const view = renderCard(task, { environmentName: "attach-images-to" });

    const placeholder = screen.getByTestId("kanban-card-drop-placeholder");
    expect(screen.queryByTestId("kanban-card") === null).toBe(true);
    expect(placeholder.querySelector("h4")?.className).toContain("truncate");
    expect(placeholder.querySelector(".pl-4")).toBeTruthy();
    expect(placeholder.querySelector(".pb-8")).toBeTruthy();
    expect(draggableState.setNodeRef).toHaveBeenCalled();

    draggableState.isDragging = false;
    view.rerender(
      <DndContext>
        <KanbanCard task={task} onClick={() => {}} environmentName="attach-images-to" />
      </DndContext>,
    );

    expect(screen.getByTestId("kanban-card")).toBeTruthy();
    expect(screen.queryByTestId("kanban-card-drop-placeholder") === null).toBe(true);
  });

  test("the drag overlay copy carries no interactive controls", () => {
    renderCard(makeTask({ environmentId: "env-1" }), {
      isDragOverlay: true,
      canClearStatus: true,
      environmentName: "attach-images-to",
    });

    expect(screen.getByText("attach-images-to")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: /Task actions/ }) === null).toBe(true);
  });
});
