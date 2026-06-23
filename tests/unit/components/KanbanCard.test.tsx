import { afterEach, describe, expect, mock, test } from "bun:test";
import { DndContext } from "@dnd-kit/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KanbanCard } from "@/components/kanban/KanbanCard";
import type { KanbanTask } from "@/stores/kanbanStore";
import type { ComponentProps } from "react";

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
      buildPhase: "building",
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
});
