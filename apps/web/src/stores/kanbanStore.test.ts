import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import * as realBackend from "@/lib/backend";
import type { KanbanTask } from "@/lib/backend";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
// The shared sonner replacement lives in tests/setup.ts; a competing local
// mock.module for it would leak through Bun's global module cache.
import { mockToastWarning } from "../../../../tests/mocks/sonner";
import { useBuildPipelineStore } from "./buildPipelineStore";

const realBackendSnapshot = { ...realBackend };
const clearTaskBuildStatusMock = mock(async (taskId: string) => ({
  task: task({ id: taskId, environmentId: undefined, buildPipelineId: undefined }),
  removedPipelineIds: [] as string[],
  failedPipelineIds: [] as string[],
}));
const getProjectNotesMock = mock(async (_projectId: string) => ({ content: "" }));
const saveProjectNotesMock = mock(async (_projectId: string, _content: string) => {});

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  clearTaskBuildStatus: clearTaskBuildStatusMock,
  getProjectNotes: getProjectNotesMock,
  saveProjectNotes: saveProjectNotesMock,
}));

const { useKanbanStore } = await import("./kanbanStore");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

function task(overrides: Partial<KanbanTask> = {}): KanbanTask {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Task",
    description: "",
    acceptanceCriteria: "",
    status: "in-progress",
    comments: [],
    images: [],
    createdAt: "",
    order: 0,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe("kanbanStore.clearTaskBuildStatus", () => {
  beforeEach(() => {
    clearTaskBuildStatusMock.mockReset();
    clearTaskBuildStatusMock.mockImplementation(async (taskId: string) => ({
      task: task({ id: taskId, environmentId: undefined, buildPipelineId: undefined }),
      removedPipelineIds: [],
      failedPipelineIds: [],
    }));
    mockToastWarning.mockClear();
    useKanbanStore.setState({
      tasks: [task()],
      isLoading: false,
      currentProjectId: "project-1",
    });
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("delegates the authoritative cleanup and applies the returned task", async () => {
    await useKanbanStore.getState().clearTaskBuildStatus("task-1");

    expect(clearTaskBuildStatusMock).toHaveBeenCalledWith("task-1");
    expect(useKanbanStore.getState().tasks[0]?.buildPipelineId).toBeUndefined();
  });

  test("removes all cached pipelines for the task after the backend succeeds", async () => {
    const first = buildPipelineFixture({
      id: "pipeline-a",
      taskId: "task-1",
      environmentId: "env-a",
    });
    const second = buildPipelineFixture({
      id: "pipeline-b",
      taskId: "task-1",
      environmentId: "env-b",
    });
    useBuildPipelineStore.setState({
      pipelines: new Map([[first.id, first], [second.id, second]]),
      buildEnvironmentIds: new Set(["env-a", "env-b"]),
    });

    await useKanbanStore.getState().clearTaskBuildStatus("task-1");

    expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
  });

  // Deleting a pipeline cancels it first, and cancelling rethrows when the
  // agent abort cannot be confirmed — the normal state for a task whose
  // environment is already gone. Unlinking the task is what the user asked for,
  // so it must not be held hostage to that cleanup.
  test("still unlinks the task when an authoritative delete fails", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-fail",
      taskId: "task-1",
    });
    useKanbanStore.setState({
      tasks: [task({ buildPipelineId: pipeline.id, environmentId: "env-1" })],
    });
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    clearTaskBuildStatusMock.mockResolvedValueOnce({
      task: task({ environmentId: undefined, buildPipelineId: undefined }),
      removedPipelineIds: [],
      failedPipelineIds: [pipeline.id],
    });

    await useKanbanStore.getState().clearTaskBuildStatus("task-1");

    expect(useKanbanStore.getState().tasks[0]?.buildPipelineId).toBeUndefined();
    expect(useBuildPipelineStore.getState().pipelines.has("pipeline-fail")).toBe(
      false,
    );
    expect(mockToastWarning).toHaveBeenCalledTimes(1);
  });

  test("clears the task without warning when every delete succeeds", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-ok",
      taskId: "task-1",
    });
    useKanbanStore.setState({
      tasks: [task({ buildPipelineId: pipeline.id, environmentId: "env-1" })],
    });
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });

    await useKanbanStore.getState().clearTaskBuildStatus("task-1");

    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  // A rejection from the task update itself is a different failure: nothing was
  // unlinked, so the renderer must not pretend it was.
  test("leaves renderer state alone when the task update itself fails", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-update-fail",
      taskId: "task-1",
    });
    useKanbanStore.setState({
      tasks: [task({ buildPipelineId: pipeline.id, environmentId: "env-1" })],
    });
    useBuildPipelineStore.setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    clearTaskBuildStatusMock.mockRejectedValueOnce(new Error("update failed"));

    await useKanbanStore.getState().clearTaskBuildStatus("task-1");

    expect(useKanbanStore.getState().tasks[0]?.buildPipelineId).toBe(
      "pipeline-update-fail",
    );
    expect(
      useBuildPipelineStore.getState().pipelines.has("pipeline-update-fail"),
    ).toBe(true);
  });
});

describe("kanbanStore project notes", () => {
  beforeEach(() => {
    getProjectNotesMock.mockReset();
    getProjectNotesMock.mockResolvedValue({ content: "" });
    saveProjectNotesMock.mockReset();
    saveProjectNotesMock.mockResolvedValue(undefined);
    useKanbanStore.setState({
      notes: "",
      notesLoading: false,
      currentNotesProjectId: null,
    });
  });

  test("loads notes and publishes the selected project", async () => {
    getProjectNotesMock.mockResolvedValue({ content: "project notes" });

    await useKanbanStore.getState().loadNotes("project-1");

    expect(useKanbanStore.getState()).toMatchObject({
      notes: "project notes",
      notesLoading: false,
      currentNotesProjectId: "project-1",
    });
  });

  test("clears the previous project's notes before a failed load becomes editable", async () => {
    useKanbanStore.setState({ notes: "private notes from project 1" });
    getProjectNotesMock.mockRejectedValue(new Error("unavailable"));

    await useKanbanStore.getState().loadNotes("project-2");

    expect(useKanbanStore.getState()).toMatchObject({
      notes: "",
      notesLoading: false,
      currentNotesProjectId: "project-2",
    });
  });

  test("ignores an older load after navigation to another project", async () => {
    const older = deferred<{ content: string }>();
    getProjectNotesMock
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce({ content: "new project" });

    const first = useKanbanStore.getState().loadNotes("project-1");
    await useKanbanStore.getState().loadNotes("project-2");
    older.resolve({ content: "old project" });
    await first;

    expect(useKanbanStore.getState()).toMatchObject({
      notes: "new project",
      currentNotesProjectId: "project-2",
      notesLoading: false,
    });
  });

  test("saves notes only into the project that is still selected", async () => {
    useKanbanStore.setState({ currentNotesProjectId: "project-2", notes: "project 2" });

    await useKanbanStore.getState().saveNotes("project-1", "project 1 update");

    expect(saveProjectNotesMock).toHaveBeenCalledWith("project-1", "project 1 update");
    expect(useKanbanStore.getState().notes).toBe("project 2");
  });

  test("rethrows save failures without changing the current notes", async () => {
    useKanbanStore.setState({ currentNotesProjectId: "project-1", notes: "original" });
    saveProjectNotesMock.mockRejectedValue(new Error("disk full"));

    await expect(
      useKanbanStore.getState().saveNotes("project-1", "replacement"),
    ).rejects.toThrow("disk full");
    expect(useKanbanStore.getState().notes).toBe("original");
  });
});
