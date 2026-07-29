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
import { useBuildPipelineStore } from "./buildPipelineStore";

const realBackendSnapshot = { ...realBackend };
const deleteBuildPipelineMock = mock(async (_pipelineId: string) => {});
const updateKanbanTaskMock = mock(async (taskId: string) =>
  task({ id: taskId, environmentId: undefined, buildPipelineId: undefined }));

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  deleteBuildPipeline: deleteBuildPipelineMock,
  updateKanbanTask: updateKanbanTaskMock,
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

describe("kanbanStore.clearTaskBuildStatus", () => {
  beforeEach(() => {
    deleteBuildPipelineMock.mockReset();
    deleteBuildPipelineMock.mockImplementation(async () => {});
    updateKanbanTaskMock.mockReset();
    updateKanbanTaskMock.mockImplementation(async (taskId: string) =>
      task({ id: taskId, environmentId: undefined, buildPipelineId: undefined }));
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

  test("clears an unlinked task without issuing a pipeline delete", async () => {
    await useKanbanStore.getState().clearTaskBuildStatus("task-1");

    expect(deleteBuildPipelineMock).not.toHaveBeenCalled();
    expect(updateKanbanTaskMock).toHaveBeenCalledTimes(1);
    const updateCall = updateKanbanTaskMock.mock.calls[0] as unknown[];
    expect(updateCall.slice(0, 7)).toEqual([
      "task-1",
      undefined,
      undefined,
      undefined,
      undefined,
      "",
      "",
    ]);
  });

  test("deletes the backend-authoritative task link even when the pipeline cache is empty", async () => {
    useKanbanStore.setState({
      tasks: [task({ buildPipelineId: "persisted-pipeline" })],
    });

    await useKanbanStore.getState().clearTaskBuildStatus("task-1");

    expect(deleteBuildPipelineMock).toHaveBeenCalledTimes(1);
    expect(deleteBuildPipelineMock).toHaveBeenCalledWith("persisted-pipeline");
  });

  test("deletes every distinct cached and persisted pipeline before clearing the task", async () => {
    useKanbanStore.setState({
      tasks: [task({ buildPipelineId: "pipeline-a" })],
    });
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

    expect(deleteBuildPipelineMock).toHaveBeenCalledTimes(2);
    expect(new Set(deleteBuildPipelineMock.mock.calls.map(([id]) => id))).toEqual(
      new Set(["pipeline-a", "pipeline-b"]),
    );
    expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
  });

  test("preserves task and renderer state when an authoritative delete fails", async () => {
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
    deleteBuildPipelineMock.mockRejectedValueOnce(new Error("delete failed"));

    await useKanbanStore.getState().clearTaskBuildStatus("task-1");

    expect(updateKanbanTaskMock).not.toHaveBeenCalled();
    expect(useKanbanStore.getState().tasks[0]?.buildPipelineId).toBe(
      "pipeline-fail",
    );
    expect(useBuildPipelineStore.getState().pipelines.has("pipeline-fail")).toBe(
      true,
    );
  });
});
