import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import * as realBackend from "@/lib/backend";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { usePaneLayoutStore, getAllLeaves } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";
import type { KanbanTask } from "@/lib/backend";

const realBackendSnapshot = { ...realBackend };
const startBuildPipelineMock = mock(async (_input: unknown) =>
  buildPipelineFixture({
    id: "pipeline-new",
    environmentId: "env-new",
    taskId: "task-1",
    projectId: "project-1",
  }));
const getKanbanImageDataMock = mock(async (imageId: string) =>
  imageId === "image-bad"
    ? Promise.reject(new Error("missing image"))
    : `data:${imageId}`);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  startBuildPipeline: startBuildPipelineMock,
  getKanbanImageData: getKanbanImageDataMock,
}));

const { useBuildPipeline } = await import("./useBuildPipeline");

afterAll(() => {
  mock.module("@/lib/backend", () => realBackendSnapshot);
});

const task: KanbanTask = {
  id: "task-1",
  projectId: "project-1",
  title: "Ship feature",
  description: "Implement the feature",
  acceptanceCriteria: "It works",
  status: "backlog",
  comments: [{ id: "comment-1", text: "Remember tests", createdAt: "" }],
  images: [
    { id: "image-good", filename: "good.png", createdAt: "" },
    { id: "image-bad", filename: "bad.png", createdAt: "" },
  ],
  createdAt: "",
  order: 0,
};

function buildTabs(environmentId: string) {
  const state = usePaneLayoutStore.getState().environments.get(environmentId);
  return state ? getAllLeaves(state.root).flatMap((leaf) => leaf.tabs) : [];
}

describe("useBuildPipeline", () => {
  beforeEach(() => {
    cleanup();
    startBuildPipelineMock.mockClear();
    getKanbanImageDataMock.mockClear();
    useBuildPipelineStore.setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    usePaneLayoutStore.setState({
      environments: new Map(),
      hydration: new Map(),
      activeEnvironmentId: null,
    });
    useUIStore.setState({
      selectedProjectId: null,
      selectedEnvironmentId: null,
      collapsedProjects: ["project-1"],
    });
  });

  test("starts from a Kanban snapshot and creates the build tab before the environment mounts", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    let pipelineId: string | undefined;
    await act(async () => {
      pipelineId = await result.current.startBuild(task, "local", "codex");
    });

    expect(pipelineId).toBe("pipeline-new");
    expect(startBuildPipelineMock).toHaveBeenCalledTimes(1);
    const input = startBuildPipelineMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input.agentType).toBe("codex");
    expect(input.taskSnapshot).toEqual({
      title: "Ship feature",
      description: "Implement the feature",
      acceptanceCriteria: "It works",
      comments: [{ text: "Remember tests" }],
      images: [{ filename: "good.png", data: "data:image-good" }],
    });
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-new");
    expect(useUIStore.getState().collapsedProjects).not.toContain("project-1");
    expect(buildTabs("env-new")).toEqual([
      expect.objectContaining({
        id: "build-pipeline-new",
        type: "claude-build",
      }),
    ]);
  });

  test("converts Linear and GitHub issues into backend-owned task snapshots", async () => {
    const { result } = renderHook(() => useBuildPipeline());
    await act(async () => {
      await result.current.startBuildFromLinearIssue({
        id: "linear-id",
        identifier: "ENG-42",
        title: "Linear title",
        description: "Linear body",
        status: "In Progress",
        teamKey: "ENG",
        url: "https://linear.example/ENG-42",
        updatedAt: "2026-07-29",
        labels: [],
        comments: [{
          id: "comment-1",
          body: "A comment",
          authorName: "Ada",
          createdAt: "2026-07-29",
        }],
      }, "project-1", "containerized");
    });
    const linear = startBuildPipelineMock.mock.calls[0]?.[0] as Record<string, any>;
    expect(linear.taskId).toBe("linear-id");
    expect(linear.source).toEqual(expect.objectContaining({
      type: "linear",
      issueIdentifier: "ENG-42",
    }));
    expect(linear.taskSnapshot.comments).toContainEqual({ text: "Ada: A comment" });

    startBuildPipelineMock.mockClear();
    await act(async () => {
      await result.current.startBuildFromGitHubIssue({
        repositoryOwner: "Acme",
        repositoryName: "Widget",
        number: 7,
        url: "https://github.com/Acme/Widget/issues/7",
        title: "GitHub title",
        body: "GitHub body",
        labels: ["bug"],
        status: "open",
        comments: [{ id: 1, body: "Please fix", authorLogin: "grace" }],
      }, "project-1", "local", "claude", {
        existingEnvironmentId: "env-existing",
        featurePlanId: "feature-1",
      });
    });
    const github = startBuildPipelineMock.mock.calls[0]?.[0] as Record<string, any>;
    expect(github.taskId).toBe("github:acme/widget#7");
    expect(github.existingEnvironmentId).toBe("env-existing");
    expect(github.featurePlanId).toBe("feature-1");
    expect(github.taskSnapshot.comments).toEqual([{ text: "@grace: Please fix" }]);
  });

  test("returns undefined without creating renderer state when the backend rejects start", async () => {
    startBuildPipelineMock.mockRejectedValueOnce(new Error("backend unavailable"));
    const { result } = renderHook(() => useBuildPipeline());

    let pipelineId: string | undefined;
    await act(async () => {
      pipelineId = await result.current.startBuild(task, "local");
    });

    expect(pipelineId).toBeUndefined();
    expect(useBuildPipelineStore.getState().pipelines.size).toBe(0);
    expect(usePaneLayoutStore.getState().environments.size).toBe(0);
  });

  test("navigation initializes, focuses, and reuses a task's existing build tab", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-nav",
      taskId: "task-nav",
      projectId: "project-nav",
      environmentId: "env-nav",
    });
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToPipeline(pipeline);
      await result.current.navigateToPipeline(pipeline);
    });

    expect(useUIStore.getState().selectedProjectId).toBe("project-nav");
    expect(usePaneLayoutStore.getState().activeEnvironmentId).toBe("env-nav");
    expect(buildTabs("env-nav")).toHaveLength(1);
    expect(buildTabs("env-nav")[0]?.id).toBe("build-pipeline-nav");
    const env = usePaneLayoutStore.getState().environments.get("env-nav");
    expect(env && getAllLeaves(env.root)[0]?.activeTabId).toBe(
      "build-pipeline-nav",
    );
  });

  test("waits for pending pane hydration before adding and focusing the build tab", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-hydrated",
      taskId: "task-hydrated",
      projectId: "project-hydrated",
      environmentId: "env-hydrated",
    });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.setActiveEnvironment("env-hydrated");
    paneStore.beginHydration("env-hydrated");
    const { result } = renderHook(() => useBuildPipeline());

    let navigation!: Promise<void>;
    act(() => {
      navigation = result.current.navigateToPipeline(pipeline);
    });
    expect(buildTabs("env-hydrated")).toHaveLength(0);

    act(() => {
      usePaneLayoutStore.getState().finishHydration("env-hydrated", {
        containerId: null,
        activePaneId: "restored",
        root: {
          kind: "leaf",
          id: "restored",
          tabs: [{ id: "restored-terminal", type: "plain" }],
          activeTabId: "restored-terminal",
        },
      });
    });
    await act(async () => {
      await navigation;
    });

    expect(buildTabs("env-hydrated").map((tab) => tab.id)).toEqual([
      "restored-terminal",
      "build-pipeline-hydrated",
    ]);
    const environment = usePaneLayoutStore
      .getState()
      .environments.get("env-hydrated");
    expect(environment?.activePaneId).toBe("restored");
    expect(environment && getAllLeaves(environment.root)[0]?.activeTabId).toBe(
      "build-pipeline-hydrated",
    );
  });
});
