import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { KanbanBoard, canClearTaskBuildStatus } from "@/components/kanban/KanbanBoard";
import { useProjectStore } from "@/stores/projectStore";
import { useKanbanStore } from "@/stores/kanbanStore";
import { useUIStore } from "@/stores/uiStore";
import type { KanbanTask } from "@/stores/kanbanStore";
import type { BuildPhase } from "@/stores/buildPipelineStore";

const loadTasksMock = mock(async () => undefined);
const loadNotesMock = mock(async () => undefined);
const saveNotesMock = mock(async () => undefined);

beforeEach(() => {
  cleanup();
  loadTasksMock.mockClear();
  loadNotesMock.mockClear();
  saveNotesMock.mockClear();
  useProjectStore.setState({
    projects: [{
      id: "project-1",
      name: "Project",
      gitUrl: "https://github.com/acme/repo.git",
      localPath: null,
      addedAt: "2026-01-01T00:00:00.000Z",
      order: 0,
    }],
    isLoading: false,
    error: null,
  });
  useKanbanStore.setState({
    tasks: [],
    notes: "",
    loadTasks: loadTasksMock as unknown as ReturnType<typeof useKanbanStore.getState>["loadTasks"],
    loadNotes: loadNotesMock as unknown as ReturnType<typeof useKanbanStore.getState>["loadNotes"],
    saveNotes: saveNotesMock as unknown as ReturnType<typeof useKanbanStore.getState>["saveNotes"],
  });
  useUIStore.setState({
    projectBoardTab: "kanban",
    projectBoardNotesOpen: false,
  });
});

function makeTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Task",
    description: "",
    acceptanceCriteria: "",
    status: "backlog",
    comments: [],
    images: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    order: 0,
    ...overrides,
  };
}

describe("canClearTaskBuildStatus", () => {
  test("is false for a plain task with no links or build phase", () => {
    expect(canClearTaskBuildStatus(makeTask(), undefined)).toBe(false);
  });

  test("is true when the task has a leftover environment link and no build phase", () => {
    expect(canClearTaskBuildStatus(makeTask({ environmentId: "env-1" }), undefined)).toBe(true);
  });

  test("is true when the task has a leftover pipeline link and no build phase", () => {
    expect(canClearTaskBuildStatus(makeTask({ buildPipelineId: "pipeline-1" }), undefined)).toBe(true);
  });

  test.each<BuildPhase>(["complete", "failed", "paused"])(
    "is true for the terminal/paused phase %s",
    (phase) => {
      expect(canClearTaskBuildStatus(makeTask({ environmentId: "env-1" }), phase)).toBe(true);
    },
  );

  test.each<BuildPhase>([
    "creating-environment",
    "starting-environment",
    "waiting-for-setup",
    "building",
    "reviewing",
    "addressing",
    "verifying",
    "fixing",
    "creating-pr",
    "resolving-conflicts",
  ])("is false while actively building (phase %s) even with links", (phase) => {
    expect(canClearTaskBuildStatus(makeTask({ environmentId: "env-1", buildPipelineId: "p-1" }), phase)).toBe(
      false,
    );
  });
});

describe("KanbanBoard ticket sources", () => {
  test("renders the kanban board content for a project board", async () => {
    render(<KanbanBoard projectId="project-1" />);

    expect(screen.getByText("Backlog")).toBeTruthy();
    expect(screen.getByText("In Progress")).toBeTruthy();
    await waitFor(() => {
      expect(loadTasksMock).toHaveBeenCalledWith("project-1");
    });
  });

  test("renders the project notes view instead of the board when notes are open", () => {
    useUIStore.setState({ projectBoardTab: "kanban", projectBoardNotesOpen: true });

    render(<KanbanBoard projectId="project-1" />);

    // Board columns are replaced by the notes view.
    expect(screen.queryByText("Backlog")).toBeNull();
    expect(screen.getByText("Project Notes")).toBeTruthy();
    expect(loadNotesMock).toHaveBeenCalledWith("project-1");
  });
});
