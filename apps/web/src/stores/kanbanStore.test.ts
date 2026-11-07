import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realBackend from "@/lib/backend";
import type { KanbanTask } from "@/lib/backend";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { appCommandScope } from "@/lib/node-scope-slots";
// The shared sonner replacement lives in tests/setup.ts; a competing local
// mock.module for it would leak through Bun's global module cache.
import { mockToastError, mockToastWarning } from "../../../../tests/mocks/sonner";
import { buildPipelineStore } from "./buildPipelineStore";
import { appCommandStore } from "@/test/app-command-store";

const realBackendSnapshot = { ...realBackend };
const clearTaskBuildStatusMock = mock(async (taskId: string) => ({
  task: task({ id: taskId, environmentId: undefined, buildPipelineId: undefined }),
  removedPipelineIds: [] as string[],
}));
const getProjectNotesMock = mock(async (_projectId: string) => ({ content: "" }));
const saveProjectNotesMock = mock(async (_projectId: string, _content: string) => {});
const getKanbanTasksMock = mock(async () => [] as KanbanTask[]);
const addKanbanTaskMock = mock(async () => task());
const updateKanbanTaskMock = mock(async () => task());
const deleteKanbanTaskMock = mock(async () => {});
const addKanbanCommentMock = mock(async () => task());
const deleteKanbanCommentMock = mock(async () => task());
const addKanbanImageMock = mock(async () => task());
const deleteKanbanImageMock = mock(async () => task());

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  clearTaskBuildStatus: clearTaskBuildStatusMock,
  getProjectNotes: getProjectNotesMock,
  saveProjectNotes: saveProjectNotesMock,
  getKanbanTasks: getKanbanTasksMock,
  addKanbanTask: addKanbanTaskMock,
  updateKanbanTask: updateKanbanTaskMock,
  deleteKanbanTask: deleteKanbanTaskMock,
  addKanbanComment: addKanbanCommentMock,
  deleteKanbanComment: deleteKanbanCommentMock,
  addKanbanImage: addKanbanImageMock,
  deleteKanbanImage: deleteKanbanImageMock,
}));

const { findTaskForEnvironment, kanbanStore } = await import("./kanbanStore");

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
    }));
    mockToastWarning.mockClear();
    mockToastError.mockClear();
    appCommandStore(kanbanStore).setState({
      tasks: [task()],
      isLoading: false,
      currentProjectId: "project-1",
    });
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
  });

  test("delegates the authoritative cleanup and applies the returned task", async () => {
    await appCommandStore(kanbanStore).getState().clearTaskBuildStatus("task-1");

    expect(clearTaskBuildStatusMock).toHaveBeenCalledWith("task-1");
    expect(appCommandStore(kanbanStore).getState().tasks[0]?.buildPipelineId).toBeUndefined();
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
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map([
        [first.id, first],
        [second.id, second],
      ]),
      buildEnvironmentIds: new Set(["env-a", "env-b"]),
    });

    await appCommandStore(kanbanStore).getState().clearTaskBuildStatus("task-1");

    expect(appCommandStore(buildPipelineStore).getState().pipelines.size).toBe(0);
  });

  test("fails closed when authoritative pipeline cleanup fails", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-fail",
      taskId: "task-1",
    });
    appCommandStore(kanbanStore).setState({
      tasks: [task({ buildPipelineId: pipeline.id, environmentId: "env-1" })],
    });
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    clearTaskBuildStatusMock.mockRejectedValueOnce(new Error("cleanup failed"));

    await appCommandStore(kanbanStore).getState().clearTaskBuildStatus("task-1");

    expect(appCommandStore(kanbanStore).getState().tasks[0]?.buildPipelineId).toBe(pipeline.id);
    expect(appCommandStore(buildPipelineStore).getState().pipelines.has("pipeline-fail")).toBe(
      true,
    );
    expect(mockToastError).toHaveBeenCalledTimes(1);
  });

  test("clears the task without warning when every delete succeeds", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-ok",
      taskId: "task-1",
    });
    appCommandStore(kanbanStore).setState({
      tasks: [task({ buildPipelineId: pipeline.id, environmentId: "env-1" })],
    });
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });

    await appCommandStore(kanbanStore).getState().clearTaskBuildStatus("task-1");

    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  // A rejection from the task update itself is a different failure: nothing was
  // unlinked, so the renderer must not pretend it was.
  test("leaves renderer state alone when the task update itself fails", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-update-fail",
      taskId: "task-1",
    });
    appCommandStore(kanbanStore).setState({
      tasks: [task({ buildPipelineId: pipeline.id, environmentId: "env-1" })],
    });
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map([[pipeline.id, pipeline]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    clearTaskBuildStatusMock.mockRejectedValueOnce(new Error("update failed"));

    await appCommandStore(kanbanStore).getState().clearTaskBuildStatus("task-1");

    expect(appCommandStore(kanbanStore).getState().tasks[0]?.buildPipelineId).toBe(
      "pipeline-update-fail",
    );
    expect(
      appCommandStore(buildPipelineStore).getState().pipelines.has("pipeline-update-fail"),
    ).toBe(true);
  });
});

describe("kanbanStore project notes", () => {
  beforeEach(() => {
    getProjectNotesMock.mockReset();
    getProjectNotesMock.mockResolvedValue({ content: "" });
    saveProjectNotesMock.mockReset();
    saveProjectNotesMock.mockResolvedValue(undefined);
    appCommandStore(kanbanStore).setState({
      notes: "",
      notesLoading: false,
      notesLoaded: false,
      notesError: null,
      currentNotesProjectId: null,
    });
  });

  test("clears the previous project's notes before it awaits the fetch", () => {
    const pending = deferred<{ content: string }>();
    appCommandStore(kanbanStore).setState({
      notes: "private notes from project 1",
      currentNotesProjectId: "project-1",
      notesError: "stale failure",
    });
    getProjectNotesMock.mockImplementationOnce(() => pending.promise);

    const load = appCommandStore(kanbanStore).getState().loadNotes("project-2");

    // Synchronously, before any await: an editor that rerenders during the load
    // must never see another project's content.
    expect(appCommandStore(kanbanStore).getState()).toMatchObject({
      notes: "",
      notesLoading: true,
      notesError: null,
      currentNotesProjectId: "project-2",
    });
    pending.resolve({ content: "project 2 notes" });
    return load;
  });

  test("loads notes and publishes the selected project", async () => {
    getProjectNotesMock.mockResolvedValue({ content: "project notes" });

    await appCommandStore(kanbanStore).getState().loadNotes("project-1");

    expect(appCommandStore(kanbanStore).getState()).toMatchObject({
      notes: "project notes",
      notesLoading: false,
      currentNotesProjectId: "project-1",
    });
  });

  test("clears the previous project's notes before a failed load becomes editable", async () => {
    appCommandStore(kanbanStore).setState({ notes: "private notes from project 1" });
    getProjectNotesMock.mockRejectedValue(new Error("unavailable"));

    await appCommandStore(kanbanStore).getState().loadNotes("project-2");

    // The lack of a successful snapshot keeps the editor disabled: an empty enabled editor
    // saves its first keystroke over the project's real notes.
    expect(appCommandStore(kanbanStore).getState()).toMatchObject({
      notes: "",
      notesLoading: false,
      notesError: "unavailable",
      currentNotesProjectId: "project-2",
    });
  });

  test("retains the loaded snapshot during a failed same-project refresh", async () => {
    getProjectNotesMock.mockResolvedValueOnce({ content: "known notes" });
    await appCommandStore(kanbanStore).getState().loadNotes("project-1");
    const refresh = deferred<{ content: string }>();
    getProjectNotesMock.mockImplementationOnce(() => refresh.promise);
    const loading = appCommandStore(kanbanStore).getState().loadNotes("project-1");
    expect(appCommandStore(kanbanStore).getState()).toMatchObject({
      notes: "known notes",
      notesLoaded: true,
      notesLoading: true,
    });
    refresh.reject(new Error("refresh unavailable"));
    await loading;
    expect(appCommandStore(kanbanStore).getState()).toMatchObject({
      notes: "known notes",
      notesLoaded: true,
      notesLoading: false,
      notesError: "refresh unavailable",
    });
  });

  test("clears a load error once a retry succeeds", async () => {
    getProjectNotesMock.mockRejectedValueOnce("not an Error");
    await appCommandStore(kanbanStore).getState().loadNotes("project-1");
    expect(appCommandStore(kanbanStore).getState().notesError).toBe("not an Error");

    getProjectNotesMock.mockResolvedValueOnce({ content: "recovered" });
    await appCommandStore(kanbanStore).getState().loadNotes("project-1");

    expect(appCommandStore(kanbanStore).getState()).toMatchObject({
      notes: "recovered",
      notesError: null,
      notesLoading: false,
    });
  });

  test("does not record a failure against a project the user already left", async () => {
    const older = deferred<{ content: string }>();
    getProjectNotesMock
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce({ content: "new project" });

    const first = appCommandStore(kanbanStore).getState().loadNotes("project-1");
    await appCommandStore(kanbanStore).getState().loadNotes("project-2");
    older.reject(new Error("older failure"));
    await first;

    expect(appCommandStore(kanbanStore).getState()).toMatchObject({
      notes: "new project",
      notesError: null,
      currentNotesProjectId: "project-2",
    });
  });

  test("ignores an older load after navigation to another project", async () => {
    const older = deferred<{ content: string }>();
    getProjectNotesMock
      .mockImplementationOnce(() => older.promise)
      .mockResolvedValueOnce({ content: "new project" });

    const first = appCommandStore(kanbanStore).getState().loadNotes("project-1");
    await appCommandStore(kanbanStore).getState().loadNotes("project-2");
    older.resolve({ content: "old project" });
    await first;

    expect(appCommandStore(kanbanStore).getState()).toMatchObject({
      notes: "new project",
      currentNotesProjectId: "project-2",
      notesLoading: false,
    });
  });

  test("saves notes only into the project that is still selected", async () => {
    appCommandStore(kanbanStore).setState({
      currentNotesProjectId: "project-2",
      notes: "project 2",
    });

    await appCommandStore(kanbanStore).getState().saveNotes("project-1", "project 1 update");

    expect(saveProjectNotesMock).toHaveBeenCalledWith("project-1", "project 1 update");
    expect(appCommandStore(kanbanStore).getState().notes).toBe("project 2");
  });

  test("rethrows save failures without changing the current notes", async () => {
    appCommandStore(kanbanStore).setState({
      currentNotesProjectId: "project-1",
      notes: "original",
    });
    saveProjectNotesMock.mockRejectedValue(new Error("disk full"));

    await expect(
      appCommandStore(kanbanStore).getState().saveNotes("project-1", "replacement"),
    ).rejects.toThrow("disk full");
    expect(appCommandStore(kanbanStore).getState().notes).toBe("original");
  });
});

describe("kanbanStore task actions", () => {
  beforeEach(() => {
    getKanbanTasksMock.mockReset();
    addKanbanTaskMock.mockReset();
    updateKanbanTaskMock.mockReset();
    deleteKanbanTaskMock.mockReset();
    addKanbanCommentMock.mockReset();
    deleteKanbanCommentMock.mockReset();
    addKanbanImageMock.mockReset();
    deleteKanbanImageMock.mockReset();
    getKanbanTasksMock.mockResolvedValue([]);
    addKanbanTaskMock.mockResolvedValue(task());
    updateKanbanTaskMock.mockResolvedValue(task());
    deleteKanbanTaskMock.mockResolvedValue(undefined);
    addKanbanCommentMock.mockResolvedValue(task());
    deleteKanbanCommentMock.mockResolvedValue(task());
    addKanbanImageMock.mockResolvedValue(task());
    deleteKanbanImageMock.mockResolvedValue(task());
    appCommandStore(kanbanStore).setState({ tasks: [], isLoading: false, currentProjectId: null });
  });

  test("loads the latest selected project and ignores a stale response", async () => {
    const stale = deferred<KanbanTask[]>();
    getKanbanTasksMock
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValueOnce([task({ id: "new" })]);
    const first = appCommandStore(kanbanStore).getState().loadTasks("project-1");
    await appCommandStore(kanbanStore).getState().loadTasks("project-2");
    stale.resolve([task({ id: "old" })]);
    await first;
    expect(appCommandStore(kanbanStore).getState()).toMatchObject({
      currentProjectId: "project-2",
      isLoading: false,
    });
    expect(
      appCommandStore(kanbanStore)
        .getState()
        .tasks.map((item) => item.id),
    ).toEqual(["new"]);
  });

  test("finds environment tasks directly and through kanban-owned pipelines", () => {
    const direct = task({ id: "direct", environmentId: "env-direct" });
    appCommandStore(kanbanStore).setState({ tasks: [direct] });
    expect(findTaskForEnvironment("env-direct", appCommandScope())).toEqual({
      task: direct,
      taskId: "direct",
    });

    const pipeline = buildPipelineFixture({
      id: "pipeline-fallback",
      taskId: "fallback-task",
      environmentId: "env-fallback",
      source: { type: "kanban", taskId: "fallback-task" },
    });
    appCommandStore(buildPipelineStore).setState({ pipelines: new Map([[pipeline.id, pipeline]]) });
    expect(findTaskForEnvironment("env-fallback", appCommandScope())).toEqual({
      task: undefined,
      taskId: "fallback-task",
    });
    expect(findTaskForEnvironment("missing", appCommandScope())).toEqual({
      task: undefined,
      taskId: undefined,
    });
  });

  test("adds, updates, and deletes tasks", async () => {
    addKanbanTaskMock.mockResolvedValueOnce(task({ id: "created", title: "Created" }));
    await expect(
      appCommandStore(kanbanStore).getState().addTask("project-1", "Created", "Description"),
    ).resolves.toBe("created");
    updateKanbanTaskMock.mockResolvedValueOnce(task({ id: "created", title: "Updated" }));
    await appCommandStore(kanbanStore).getState().updateTask("created", { title: "Updated" });
    expect(appCommandStore(kanbanStore).getState().tasks[0]?.title).toBe("Updated");
    await appCommandStore(kanbanStore).getState().deleteTask("created");
    expect(appCommandStore(kanbanStore).getState().tasks).toEqual([]);
  });

  test("moves optimistically, adopts success, and rolls back failure", async () => {
    appCommandStore(kanbanStore).setState({ tasks: [task({ status: "backlog" })] });
    updateKanbanTaskMock.mockResolvedValueOnce(task({ status: "done" }));
    await appCommandStore(kanbanStore).getState().moveTask("task-1", "done");
    expect(appCommandStore(kanbanStore).getState().tasks[0]?.status).toBe("done");

    updateKanbanTaskMock.mockRejectedValueOnce(new Error("offline"));
    await appCommandStore(kanbanStore).getState().moveTask("task-1", "in-progress");
    expect(appCommandStore(kanbanStore).getState().tasks[0]?.status).toBe("done");
    const calls = updateKanbanTaskMock.mock.calls.length;
    await appCommandStore(kanbanStore).getState().moveTask("missing", "backlog");
    await appCommandStore(kanbanStore).getState().moveTask("task-1", "done");
    expect(updateKanbanTaskMock).toHaveBeenCalledTimes(calls);
  });

  test("applies comment and image mutations", async () => {
    appCommandStore(kanbanStore).setState({ tasks: [task()] });
    addKanbanCommentMock.mockResolvedValueOnce(task({ title: "comment added" }));
    deleteKanbanCommentMock.mockResolvedValueOnce(task({ title: "comment deleted" }));
    addKanbanImageMock.mockResolvedValueOnce(task({ title: "image added" }));
    deleteKanbanImageMock.mockResolvedValueOnce(task({ title: "image deleted" }));
    await appCommandStore(kanbanStore).getState().addComment("task-1", "hello");
    await appCommandStore(kanbanStore).getState().deleteComment("task-1", "comment-1");
    await appCommandStore(kanbanStore).getState().addImage("task-1", "image.png", "base64");
    await appCommandStore(kanbanStore).getState().deleteImage("task-1", "image-1");
    expect(appCommandStore(kanbanStore).getState().tasks[0]?.title).toBe("image deleted");
  });

  test("contains backend failures without corrupting cached tasks", async () => {
    appCommandStore(kanbanStore).setState({ tasks: [task()] });
    getKanbanTasksMock.mockRejectedValueOnce(new Error("load failed"));
    await appCommandStore(kanbanStore).getState().loadTasks("project-1");
    expect(appCommandStore(kanbanStore).getState().isLoading).toBe(false);
    addKanbanTaskMock.mockRejectedValueOnce(new Error("add failed"));
    await expect(
      appCommandStore(kanbanStore).getState().addTask("project-1", "x", "y"),
    ).resolves.toBeUndefined();
    for (const action of [
      () => appCommandStore(kanbanStore).getState().updateTask("task-1", { title: "x" }),
      () => appCommandStore(kanbanStore).getState().deleteTask("task-1"),
      () => appCommandStore(kanbanStore).getState().addComment("task-1", "x"),
      () => appCommandStore(kanbanStore).getState().deleteComment("task-1", "comment"),
      () => appCommandStore(kanbanStore).getState().addImage("task-1", "x", "y"),
      () => appCommandStore(kanbanStore).getState().deleteImage("task-1", "image"),
    ]) {
      updateKanbanTaskMock.mockRejectedValueOnce(new Error("ignored"));
      deleteKanbanTaskMock.mockRejectedValueOnce(new Error("ignored"));
      addKanbanCommentMock.mockRejectedValueOnce(new Error("ignored"));
      deleteKanbanCommentMock.mockRejectedValueOnce(new Error("ignored"));
      addKanbanImageMock.mockRejectedValueOnce(new Error("ignored"));
      deleteKanbanImageMock.mockRejectedValueOnce(new Error("ignored"));
      await action();
    }
    expect(appCommandStore(kanbanStore).getState().tasks).toEqual([task()]);
  });
});
