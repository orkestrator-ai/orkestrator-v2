import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { BuildStepConfigs } from "@orkestrator/protocol/build-pipeline";
import * as realBackend from "@/lib/backend";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { useBuildPipelineStore } from "@/stores/buildPipelineStore";
import { useConfigStore } from "@/stores/configStore";
import { usePaneLayoutStore, getAllLeaves } from "@/stores/paneLayoutStore";
import { useUIStore } from "@/stores/uiStore";
import type { KanbanTask } from "@/lib/backend";
import {
  mockToastError as toastErrorMock,
  mockToastSuccess as toastSuccessMock,
} from "../../../../tests/mocks/sonner";

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

/** What the build launcher submits: one harness per pipeline step. */
const steps: BuildStepConfigs = {
  build: { agent: "codex", model: "gpt-5.4", reasoningEffort: "high" },
  review: { agent: "claude", model: "opus[1m]" },
  verify: { agent: "opencode", model: "provider/model-a" },
  pr: { agent: "claude", model: "sonnet", reasoningEffort: "low" },
  "resolve-conflicts": { agent: "codex", model: "gpt-5.4" },
};

const githubIssue = {
  repositoryOwner: "Acme",
  repositoryName: "Widget",
  number: 7,
  url: "https://github.com/Acme/Widget/issues/7",
  title: "GitHub title",
  body: "GitHub body",
  labels: ["bug"],
  status: "open",
  comments: [],
};

const linearIssue = {
  id: "linear-id",
  identifier: "ENG-42",
  title: "Linear title",
  description: "Linear body",
  status: "In Progress",
  teamKey: "ENG",
  url: "https://linear.example/ENG-42",
  updatedAt: "2026-07-29",
  labels: [],
  comments: [],
};

function startInput() {
  return startBuildPipelineMock.mock.calls[0]?.[0] as Record<string, unknown>;
}

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

  test("preserves supported Linear metadata and both comment attribution forms", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuildFromLinearIssue({
        ...linearIssue,
        creatorName: "Grace",
        assigneeName: "Ada",
        createdAt: "2026-07-28",
        projectName: "Desktop",
        cycleName: "July",
        comments: [
          {
            id: "comment-attributed",
            body: "Attributed comment",
            authorName: "Ada",
            createdAt: "2026-07-29",
            updatedAt: "2026-07-30",
          },
          {
            id: "comment-anonymous",
            body: "Unattributed comment",
            createdAt: "2026-07-30",
          },
        ],
      }, "project-1", "local");
    });

    const input = startInput() as Record<string, any>;
    expect(input.source).toEqual({
      type: "linear",
      issueId: "linear-id",
      issueIdentifier: "ENG-42",
      issueUrl: "https://linear.example/ENG-42",
      status: "In Progress",
      teamKey: "ENG",
      updatedAt: "2026-07-29",
    });
    expect(input.taskSnapshot.comments).toEqual([
      { text: "Linear issue: ENG-42" },
      { text: "URL: https://linear.example/ENG-42" },
      { text: "Status: In Progress" },
      { text: "Ada: Attributed comment" },
      { text: "Unattributed comment" },
    ]);
    // Creator, assignee, and creation dates are accepted input metadata, but
    // are deliberately not invented as fields on the narrower protocol source.
    expect(input.source).not.toHaveProperty("creatorName");
    expect(input.source).not.toHaveProperty("assigneeName");
    expect(input.source).not.toHaveProperty("createdAt");
  });

  test("omits optional Linear context when it is unavailable", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuildFromLinearIssue({
        ...linearIssue,
        description: "",
        status: "",
        url: undefined,
        teamKey: undefined,
        comments: [],
      }, "project-1", "local");
    });

    const input = startInput() as Record<string, any>;
    expect(input.namingPrompt).toBe("ENG-42\n\nLinear title");
    expect(input.taskSnapshot.comments).toEqual([
      { text: "Linear issue: ENG-42" },
    ]);
    expect(input.source).toEqual(expect.objectContaining({
      issueUrl: undefined,
      status: "",
      teamKey: undefined,
    }));
  });

  test("preserves supported GitHub dates and both comment attribution forms", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuildFromGitHubIssue({
        ...githubIssue,
        authorLogin: "grace",
        assigneeLogins: ["ada", "linus"],
        createdAt: "2026-07-28",
        updatedAt: "2026-07-30",
        comments: [
          {
            id: 1,
            body: "Attributed comment",
            authorLogin: "ada",
            createdAt: "2026-07-29",
            updatedAt: "2026-07-30",
          },
          {
            id: "anonymous",
            body: "Unattributed comment",
            createdAt: "2026-07-30",
          },
        ],
      }, "project-1", "local");
    });

    const input = startInput() as Record<string, any>;
    expect(input.source).toEqual({
      type: "github",
      repositoryOwner: "Acme",
      repositoryName: "Widget",
      issueNumber: 7,
      issueUrl: "https://github.com/Acme/Widget/issues/7",
      status: "open",
      updatedAt: "2026-07-30",
    });
    expect(input.taskSnapshot.comments).toEqual([
      { text: "@ada: Attributed comment" },
      { text: "Unattributed comment" },
    ]);
    // The protocol source identifies the issue; personal metadata and comment
    // dates stay out of that durable routing object.
    expect(input.source).not.toHaveProperty("authorLogin");
    expect(input.source).not.toHaveProperty("assigneeLogins");
    expect(input.source).not.toHaveProperty("createdAt");
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

  test("forwards the launcher's per-step configuration verbatim", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild(task, "local", "codex", { steps });
    });

    // Verbatim: the backend, not the renderer, decides what a step means.
    expect(startInput().steps).toEqual(steps);
  });

  test("the build step's harness outranks an agent override", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      // Both supplied, and they disagree on purpose.
      await result.current.startBuild(task, "local", "claude", { steps });
    });

    expect(startInput().agentType).toBe("codex");
  });

  test("an agent override wins when no step configuration was chosen", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild(task, "local", "opencode");
    });

    expect(startInput().agentType).toBe("opencode");
    expect(startInput().steps).toBeUndefined();
  });

  test("an agent override wins when the step map pins no build harness", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    // The backend accepts a sparse step map, so the launcher's build step can
    // legitimately be absent while other steps are pinned. The override then
    // still decides the pipeline agent, and both sides agree on the snapshot.
    await act(async () => {
      await result.current.startBuild(task, "local", "opencode", {
        steps: { review: { agent: "codex" } },
      });
    });

    expect(startInput().agentType).toBe("opencode");
    expect(startInput().steps).toEqual({ review: { agent: "codex" } });
  });

  test("falls back to the repository's configured agent when neither is given", async () => {
    const baseConfig = useConfigStore.getState().config;
    useConfigStore.setState({
      config: {
        ...baseConfig,
        repositories: {
          ...baseConfig.repositories,
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
            defaultAgent: "opencode",
          },
        },
      },
    });

    try {
      const { result } = renderHook(() => useBuildPipeline());
      await act(async () => {
        await result.current.startBuild(task, "local");
      });

      expect(startInput().agentType).toBe("opencode");
    } finally {
      // The hook is still mounted and subscribed, so the restore is a render.
      act(() => {
        useConfigStore.setState({ config: baseConfig });
      });
    }
  });

  test("a GitHub issue build carries the same per-step configuration", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuildFromGitHubIssue(
        githubIssue,
        "project-1",
        "local",
        "claude",
        { steps },
      );
    });

    expect(startInput().steps).toEqual(steps);
    expect(startInput().agentType).toBe("codex");
  });

  test("the Linear entry point takes neither an override nor step configuration", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    // Locked in deliberately: Linear builds have no launcher in front of them,
    // so they resolve their harness from config alone.
    expect(result.current.startBuildFromLinearIssue.length).toBe(3);
    await act(async () => {
      await result.current.startBuildFromLinearIssue(linearIssue, "project-1", "local");
    });

    expect(startInput().steps).toBeUndefined();
    expect(startInput().agentType).toBe("claude");
  });

  test("announces the start and names the reason a start failed", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild(task, "local");
    });
    expect(toastSuccessMock).toHaveBeenCalledWith("Build pipeline started");
    expect(toastErrorMock).not.toHaveBeenCalled();

    startBuildPipelineMock.mockRejectedValueOnce(new Error("backend unavailable"));
    await act(async () => {
      await result.current.startBuild(task, "local");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to start build pipeline", {
      description: "backend unavailable",
    });

    toastErrorMock.mockClear();
    // A non-Error rejection still has to say something to the user.
    startBuildPipelineMock.mockRejectedValueOnce("plain string failure");
    await act(async () => {
      await result.current.startBuild(task, "local");
    });
    expect(toastErrorMock).toHaveBeenCalledWith("Failed to start build pipeline", {
      description: "Unknown error",
    });
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

  test("finds and focuses an existing build tab inside a nested split tree", async () => {
    usePaneLayoutStore.setState({
      environments: new Map([["env-split", {
        containerId: null,
        activePaneId: "pane-other",
        root: {
          kind: "split",
          id: "split-root",
          direction: "horizontal",
          sizes: [40, 60],
          depth: 0,
          children: [
            {
              kind: "leaf",
              id: "pane-other",
              tabs: [{ id: "terminal", type: "plain" }],
              activeTabId: "terminal",
            },
            {
              kind: "split",
              id: "split-nested",
              direction: "vertical",
              sizes: [50, 50],
              depth: 1,
              children: [
                {
                  kind: "leaf",
                  id: "pane-empty",
                  tabs: [],
                  activeTabId: null,
                },
                {
                  kind: "leaf",
                  id: "pane-build",
                  tabs: [{
                    id: "existing-build-tab",
                    type: "claude-build",
                    buildTabData: {
                      environmentId: "env-split",
                      pipelineId: "pipeline-original",
                      taskId: "task-split",
                      isLocal: true,
                    },
                  }],
                  activeTabId: null,
                },
              ],
            },
          ],
        },
      }]]),
      hydration: new Map(),
      activeEnvironmentId: null,
    });
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToPipeline({
        id: "pipeline-newer",
        environmentId: "env-split",
        environmentType: "local",
        projectId: "project-1",
        taskId: "task-split",
      });
    });

    const environment = usePaneLayoutStore.getState().environments.get("env-split");
    expect(buildTabs("env-split").filter((tab) => tab.type === "claude-build"))
      .toHaveLength(1);
    expect(environment?.activePaneId).toBe("pane-build");
    expect(environment && getAllLeaves(environment.root)
      .find((leaf) => leaf.id === "pane-build")?.activeTabId)
      .toBe("existing-build-tab");
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

describe("useBuildPipeline navigation", () => {
  beforeEach(() => {
    cleanup();
    startBuildPipelineMock.mockClear();
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

  test("navigates to the pipeline the store holds for a task", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-known",
      environmentId: "env-known",
      taskId: "task-1",
      projectId: "project-1",
    });
    useBuildPipelineStore.getState().replacePipeline(pipeline);
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToBuild(task);
    });

    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-known");
    expect(buildTabs("env-known").map((tab) => tab.id))
      .toContain("build-pipeline-known");
  });

  test("does nothing when the task has no pipeline in the store", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToBuild(task);
    });

    // Silently opening an empty environment would be worse than doing nothing.
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
    expect(usePaneLayoutStore.getState().environments.size).toBe(0);
  });

  test("ignores a pipeline that has no environment yet", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToPipeline({
        environmentId: "",
        projectId: "project-1",
        taskId: "task-1",
      });
    });

    expect(usePaneLayoutStore.getState().environments.size).toBe(0);
  });

  test("marks a containerized pipeline's build tab as not local", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToPipeline({
        id: "pipeline-container",
        environmentId: "env-container",
        environmentType: "containerized",
        projectId: "project-1",
        taskId: "task-1",
      });
    });

    const [tab] = buildTabs("env-container");
    expect(tab?.buildTabData?.isLocal).toBe(false);
  });

  test("uses stable local defaults when navigation receives a legacy pipeline reference", async () => {
    const { result } = renderHook(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToPipeline({
        environmentId: "env-legacy",
        projectId: "project-legacy",
        taskId: "legacy-42",
      });
    });

    const [tab] = buildTabs("env-legacy");
    expect(tab).toEqual(expect.objectContaining({
      id: "build-task-legacy-42",
      type: "claude-build",
      buildTabData: expect.objectContaining({
        environmentId: "env-legacy",
        pipelineId: "task-legacy-42",
        taskId: "legacy-42",
        isLocal: true,
      }),
    }));
    expect(useUIStore.getState().selectedProjectId).toBe("project-legacy");
    expect(useUIStore.getState().selectedEnvironmentId).toBe("env-legacy");
  });

  test("gives up waiting on a hydration that never finishes", async () => {
    // The wait exists so a restore does not replace the tab we just added. It
    // must not become an indefinite block when a restore stalls or is dropped.
    usePaneLayoutStore.setState({
      environments: new Map(),
      hydration: new Map([["env-stalled", "pending"]]),
      activeEnvironmentId: null,
    });
    const timeouts: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void, delay?: number) => {
      if (delay === 5_000) {
        timeouts.push(callback);
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return realSetTimeout(callback, delay);
    }) as typeof setTimeout;

    try {
      const { result } = renderHook(() => useBuildPipeline());
      let navigation!: Promise<void>;
      await act(async () => {
        navigation = result.current.navigateToPipeline({
          id: "pipeline-stalled",
          environmentId: "env-stalled",
          environmentType: "local",
          projectId: "project-1",
          taskId: "task-1",
        });
        await Promise.resolve();
        expect(timeouts).toHaveLength(1);
        timeouts[0]!();
        await navigation;
      });

      expect(buildTabs("env-stalled").map((tab) => tab.id))
        .toContain("build-pipeline-stalled");
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});
