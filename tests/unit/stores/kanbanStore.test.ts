import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock tauri before importing the store
const mockUpdateKanbanTask = mock(() => Promise.resolve({
  id: "task-1",
  projectId: "proj-1",
  title: "Test",
  description: "desc",
  acceptanceCriteria: "",
  status: "backlog" as const,
  comments: [],
  images: [],
  createdAt: new Date().toISOString(),
  order: 0,
}));

const mockGetKanbanTasks = mock(() => Promise.resolve([]));
const mockAddKanbanTask = mock(() => Promise.resolve({
  id: "new-task",
  projectId: "proj-1",
  title: "New",
  description: "",
  acceptanceCriteria: "",
  status: "backlog" as const,
  comments: [],
  images: [],
  createdAt: new Date().toISOString(),
  order: 0,
}));
const mockAddKanbanComment = mock(() => Promise.resolve({
  id: "task-1",
  projectId: "proj-1",
  title: "Test",
  description: "desc",
  acceptanceCriteria: "",
  status: "backlog" as const,
  comments: [{ id: "c1", text: "comment", createdAt: new Date().toISOString() }],
  images: [],
  createdAt: new Date().toISOString(),
  order: 0,
}));

mock.module("@/lib/tauri", () => ({
  getKanbanTasks: mockGetKanbanTasks,
  addKanbanTask: mockAddKanbanTask,
  updateKanbanTask: mockUpdateKanbanTask,
  deleteKanbanTask: mock(() => Promise.resolve()),
  addKanbanComment: mockAddKanbanComment,
  deleteKanbanComment: mock(() => Promise.resolve()),
  addKanbanImage: mock(() => Promise.resolve()),
  deleteKanbanImage: mock(() => Promise.resolve()),
  getProjectNotes: mock(() => Promise.resolve({ projectId: "p1", content: "", updatedAt: "" })),
  saveProjectNotes: mock(() => Promise.resolve()),
}));

import { useKanbanStore, findTaskForEnvironment } from "@/stores/kanbanStore";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import type { KanbanTask } from "@/lib/tauri";

function createTask(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    projectId: "proj-1",
    title: "Test Task",
    description: "desc",
    acceptanceCriteria: "",
    status: "backlog",
    comments: [],
    images: [],
    createdAt: new Date().toISOString(),
    order: 0,
    ...overrides,
  };
}

describe("kanbanStore", () => {
  beforeEach(() => {
    useKanbanStore.setState({
      tasks: [],
      isLoading: false,
      currentProjectId: null,
      notes: "",
      notesLoading: false,
      currentNotesProjectId: null,
    });
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    mockUpdateKanbanTask.mockClear();
    mockAddKanbanComment.mockClear();
  });

  describe("updateTask with PR fields", () => {
    test("passes prUrl to updateKanbanTask", async () => {
      const task = createTask();
      useKanbanStore.setState({ tasks: [task] });

      const returnedTask = { ...task, prUrl: "https://github.com/org/repo/pull/1", prState: "open" as const };
      mockUpdateKanbanTask.mockResolvedValueOnce(returnedTask);

      await useKanbanStore.getState().updateTask("task-1", {
        prUrl: "https://github.com/org/repo/pull/1",
        prState: "open",
      });

      expect(mockUpdateKanbanTask).toHaveBeenCalledWith(
        "task-1",
        undefined, undefined, undefined, undefined, undefined, undefined,
        "https://github.com/org/repo/pull/1",
        "open",
        undefined,
      );

      const updatedTask = useKanbanStore.getState().tasks.find((t) => t.id === "task-1");
      expect(updatedTask?.prUrl).toBe("https://github.com/org/repo/pull/1");
      expect(updatedTask?.prState).toBe("open");
    });

    test("passes prMergeCommented to updateKanbanTask", async () => {
      const task = createTask({ prUrl: "https://github.com/org/repo/pull/1", prState: "merged" });
      useKanbanStore.setState({ tasks: [task] });

      const returnedTask = { ...task, prMergeCommented: true };
      mockUpdateKanbanTask.mockResolvedValueOnce(returnedTask);

      await useKanbanStore.getState().updateTask("task-1", {
        prState: "merged",
        prMergeCommented: true,
      });

      expect(mockUpdateKanbanTask).toHaveBeenCalledWith(
        "task-1",
        undefined, undefined, undefined, undefined, undefined, undefined,
        undefined,
        "merged",
        true,
      );
    });

    test("does not pass undefined PR fields when not in updates", async () => {
      const task = createTask();
      useKanbanStore.setState({ tasks: [task] });
      mockUpdateKanbanTask.mockResolvedValueOnce({ ...task, title: "Updated" });

      await useKanbanStore.getState().updateTask("task-1", { title: "Updated" });

      expect(mockUpdateKanbanTask).toHaveBeenCalledWith(
        "task-1",
        "Updated", undefined, undefined, undefined, undefined, undefined,
        undefined, undefined, undefined,
      );
    });
  });

  describe("addComment", () => {
    test("adds a comment to a task", async () => {
      const task = createTask();
      useKanbanStore.setState({ tasks: [task] });

      const taskWithComment = {
        ...task,
        comments: [{ id: "c1", text: "Build started", createdAt: new Date().toISOString() }],
      };
      mockAddKanbanComment.mockResolvedValueOnce(taskWithComment);

      await useKanbanStore.getState().addComment("task-1", "Build started");

      expect(mockAddKanbanComment).toHaveBeenCalledWith("task-1", "Build started");

      const updated = useKanbanStore.getState().tasks.find((t) => t.id === "task-1");
      expect(updated?.comments).toHaveLength(1);
      expect(updated?.comments[0]?.text).toBe("Build started");
    });
  });
});

describe("findTaskForEnvironment", () => {
  beforeEach(() => {
    useKanbanStore.setState({
      tasks: [],
      isLoading: false,
      currentProjectId: null,
      notes: "",
      notesLoading: false,
      currentNotesProjectId: null,
    });
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("finds task by environmentId in kanban store", () => {
    const task = createTask({ environmentId: "env-1" });
    useKanbanStore.setState({ tasks: [task] });

    const result = findTaskForEnvironment("env-1");
    expect(result.task).toBeDefined();
    expect(result.taskId).toBe("task-1");
  });

  test("falls back to build pipeline store when not in kanban store", () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([
        ["pipeline-1", {
          id: "pipeline-1",
          taskId: "task-99",
          projectId: "proj-1",
          environmentId: "env-2",
          environmentType: "local" as const,
          phase: "building" as any,
          sessions: [],
          currentSessionIndex: -1,
          iteration: 0,
          maxIterations: 3,
          createdAt: new Date().toISOString(),
          taskTitle: "Task from pipeline",
          taskSnapshot: {
            title: "Task from pipeline",
            description: "",
            acceptanceCriteria: "",
            comments: [],
            images: [],
          },
        }],
      ]),
    });

    const result = findTaskForEnvironment("env-2");
    expect(result.task).toBeUndefined();
    expect(result.taskId).toBe("task-99");
  });

  test("returns undefined when environment has no associated task", () => {
    const result = findTaskForEnvironment("env-nonexistent");
    expect(result.task).toBeUndefined();
    expect(result.taskId).toBeUndefined();
  });

  test("prefers kanban store over pipeline store", () => {
    const task = createTask({ id: "kanban-task", environmentId: "env-1" });
    useKanbanStore.setState({ tasks: [task] });

    useBuildPipelineStore.setState({
      pipelines: new Map([
        ["pipeline-1", {
          id: "pipeline-1",
          taskId: "pipeline-task",
          projectId: "proj-1",
          environmentId: "env-1",
          environmentType: "local" as const,
          phase: "building" as any,
          sessions: [],
          currentSessionIndex: -1,
          iteration: 0,
          maxIterations: 3,
          createdAt: new Date().toISOString(),
          taskTitle: "Task",
          taskSnapshot: {
            title: "Task",
            description: "",
            acceptanceCriteria: "",
            comments: [],
            images: [],
          },
        }],
      ]),
    });

    const result = findTaskForEnvironment("env-1");
    expect(result.task).toBeDefined();
    expect(result.taskId).toBe("kanban-task");
  });
});
