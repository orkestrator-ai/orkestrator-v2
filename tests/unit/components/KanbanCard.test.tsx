import { afterEach, describe, expect, mock, test } from "bun:test";
import { DndContext } from "@dnd-kit/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { KanbanTask } from "@/stores/kanbanStore";
import type { ComponentProps } from "react";

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

    expect(screen.queryByText("Clear status")).toBeNull();
  });

  test("does not render clear status menu item while a build is active", () => {
    // canClearStatus is computed by KanbanBoard; an actively-building card is
    // passed canClearStatus={false} so the action is never offered mid-build.
    renderCard(makeTask({ environmentId: "env-1" }), {
      canClearStatus: false,
      buildPhase: "building",
    });

    expect(screen.queryByText("Clear status")).toBeNull();
  });
});
