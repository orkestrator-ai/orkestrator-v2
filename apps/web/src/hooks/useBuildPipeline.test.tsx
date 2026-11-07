import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup } from "@testing-library/react";
import { renderHookInAppCommandScope } from "@/test/render-in-node-scope";
import type { BuildStepConfigs } from "@orkestrator/protocol/build-pipeline";
import * as realBackend from "@/lib/backend";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { buildPipelineStore } from "@/stores/buildPipelineStore";
import { configStore } from "@/stores/configStore";
import { getAllLeaves, paneLayoutStore } from "@/stores/paneLayoutStore";
import { uiStore } from "@/stores/uiStore";
import type { KanbanTask } from "@/lib/backend";
import { getWindowBuildPipelineActivation } from "@/lib/pane-selection-storage";
import {
  mockToastError as toastErrorMock,
  mockToastSuccess as toastSuccessMock,
} from "../../../../tests/mocks/sonner";
import { appCommandStore } from "@/test/app-command-store";

const realBackendSnapshot = { ...realBackend };
const startBuildPipelineMock = mock(async (_input: unknown) =>
  buildPipelineFixture({
    id: "pipeline-new",
    environmentId: "env-new",
    taskId: "task-1",
    projectId: "project-1",
  }),
);
// `startBuildPipelineMock` above answers `launch_build_pipeline`; this one is
// the raw start an older backend gets instead.
const legacyStartMock = mock(async (_input: unknown) =>
  buildPipelineFixture({
    id: "pipeline-new",
    environmentId: "env-new",
    taskId: "task-1",
    projectId: "project-1",
  }),
);
const getKanbanImageDataMock = mock(async (imageId: string) =>
  imageId === "image-bad" ? Promise.reject(new Error("missing image")) : `data:${imageId}`,
);

mock.module("@/lib/backend", () => ({
  ...realBackendSnapshot,
  launchBuildPipeline: startBuildPipelineMock,
  startBuildPipeline: legacyStartMock,
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
  address: { agent: "codex", model: "gpt-5.4-mini", reasoningEffort: "medium" },
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
  return (legacyStartMock.mock.calls[0]?.[0] ??
    startBuildPipelineMock.mock.calls[0]?.[0]) as Record<string, unknown>;
}

/** The next launch answers as a backend that predates `launch_build_pipeline`. */
function olderBackend() {
  startBuildPipelineMock.mockImplementationOnce(async () => {
    throw new Error("Unknown backend command: launch_build_pipeline");
  });
}

function buildTabs(environmentId: string) {
  const state = appCommandStore(paneLayoutStore).getState().environments.get(environmentId);
  return state ? getAllLeaves(state.root).flatMap((leaf) => leaf.tabs) : [];
}

describe("useBuildPipeline", () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    startBuildPipelineMock.mockClear();
    legacyStartMock.mockClear();
    getKanbanImageDataMock.mockClear();
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    appCommandStore(paneLayoutStore).setState({
      environments: new Map(),
      hydration: new Map(),
      activeEnvironmentId: null,
    });
    appCommandStore(uiStore).setState({
      selectedProjectId: null,
      selectedEnvironmentId: null,
      collapsedProjects: ["project-1"],
    });
  });

  test("starts from a Kanban snapshot and leaves build-tab creation to the backend", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

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
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("env-new");
    expect(appCommandStore(uiStore).getState().collapsedProjects).not.toContain("project-1");
    expect(buildTabs("env-new")).toEqual([]);
  });

  test("arms the launching Electron window to focus the pipeline after setup", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

      await act(async () => {
        await result.current.startBuild(task, "local");
      });

      expect(getWindowBuildPipelineActivation("env-new")).toBe("pipeline-new");
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("defers arming when the idempotent start response has no environment yet", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    startBuildPipelineMock.mockResolvedValueOnce(
      buildPipelineFixture({
        id: "pipeline-pending",
        environmentId: "",
        taskId: "task-1",
        projectId: "project-1",
      }),
    );
    try {
      const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

      await act(async () => {
        await result.current.startBuild(task, "local");
      });

      expect(getWindowBuildPipelineActivation("env-later")).toBeNull();
      expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBeNull();

      await act(async () => {
        appCommandStore(buildPipelineStore)
          .getState()
          .replacePipeline(
            buildPipelineFixture({
              id: "pipeline-pending",
              environmentId: "env-later",
              taskId: "task-1",
              projectId: "project-1",
            }),
          );
      });

      expect(getWindowBuildPipelineActivation("env-later")).toBe("pipeline-pending");
      expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("env-later");
      expect(appCommandStore(uiStore).getState().selectedProjectId).toBe("project-1");
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("converts Linear and GitHub issues into backend-owned task snapshots", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());
    await act(async () => {
      await result.current.startBuildFromLinearIssue(
        {
          id: "linear-id",
          identifier: "ENG-42",
          title: "Linear title",
          description: "Linear body",
          status: "In Progress",
          teamKey: "ENG",
          url: "https://linear.example/ENG-42",
          updatedAt: "2026-07-29",
          labels: [],
          comments: [
            {
              id: "comment-1",
              body: "A comment",
              authorName: "Ada",
              createdAt: "2026-07-29",
            },
          ],
        },
        "project-1",
        "containerized",
      );
    });
    const linear = startBuildPipelineMock.mock.calls[0]?.[0] as Record<string, any>;
    expect(linear.taskId).toBe("linear-id");
    expect(linear.source).toEqual(
      expect.objectContaining({
        type: "linear",
        issueIdentifier: "ENG-42",
      }),
    );
    expect(linear.taskSnapshot.comments).toContainEqual({
      text: "Ada: A comment",
    });

    startBuildPipelineMock.mockClear();
    await act(async () => {
      await result.current.startBuildFromGitHubIssue(
        {
          repositoryOwner: "Acme",
          repositoryName: "Widget",
          number: 7,
          url: "https://github.com/Acme/Widget/issues/7",
          title: "GitHub title",
          body: "GitHub body",
          labels: ["bug"],
          status: "open",
          comments: [{ id: 1, body: "Please fix", authorLogin: "grace" }],
        },
        "project-1",
        "local",
        "claude",
        {
          existingEnvironmentId: "env-existing",
          featurePlanId: "feature-1",
        },
      );
    });
    const github = startBuildPipelineMock.mock.calls[0]?.[0] as Record<string, any>;
    expect(github.taskId).toBe("github:acme/widget#7");
    expect(github.existingEnvironmentId).toBe("env-existing");
    expect(github.featurePlanId).toBe("feature-1");
    expect(github.taskSnapshot.comments).toEqual([{ text: "@grace: Please fix" }]);
  });

  test("preserves supported Linear metadata and both comment attribution forms", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuildFromLinearIssue(
        {
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
        },
        "project-1",
        "local",
      );
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

  test("can omit Linear discussion while retaining issue metadata in build context", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuildFromLinearIssue(
        {
          ...linearIssue,
          comments: [
            {
              id: "comment-1",
              body: "Do not include this discussion",
              authorName: "Ada",
              createdAt: "2026-07-29",
            },
          ],
        },
        "project-1",
        "local",
        { includeComments: false },
      );
    });

    expect((startInput().taskSnapshot as { comments: Array<{ text: string }> }).comments).toEqual([
      { text: "Linear issue: ENG-42" },
      { text: "URL: https://linear.example/ENG-42" },
      { text: "Status: In Progress" },
    ]);
  });

  test("omits optional Linear context when it is unavailable", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuildFromLinearIssue(
        {
          ...linearIssue,
          description: "",
          status: "",
          url: undefined,
          teamKey: undefined,
          comments: [],
        },
        "project-1",
        "local",
      );
    });

    const input = startInput() as Record<string, any>;
    expect(input.namingPrompt).toBe("ENG-42\n\nLinear title");
    expect(input.taskSnapshot.comments).toEqual([{ text: "Linear issue: ENG-42" }]);
    expect(input.source.issueUrl).toBeUndefined();
    expect(input.source.status).toBe("");
    expect(input.source.teamKey).toBeUndefined();
  });

  test("preserves supported GitHub dates and both comment attribution forms", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuildFromGitHubIssue(
        {
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
        },
        "project-1",
        "local",
      );
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
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    let pipelineId: string | undefined;
    await act(async () => {
      pipelineId = await result.current.startBuild(task, "local");
    });

    expect(pipelineId).toBeUndefined();
    expect(appCommandStore(buildPipelineStore).getState().pipelines.size).toBe(0);
    expect(appCommandStore(paneLayoutStore).getState().environments.size).toBe(0);
  });

  test("forwards the launcher's per-step configuration verbatim", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild(task, "local", "codex", { steps });
    });

    // Verbatim: the backend, not the renderer, decides what a step means.
    expect(startInput().steps).toEqual(steps);
  });

  test("older backend: the build step's harness outranks an agent override", async () => {
    olderBackend();
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      // Both supplied, and they disagree on purpose.
      await result.current.startBuild(task, "local", "claude", { steps });
    });

    expect(startInput().agentType).toBe("codex");
  });

  test("older backend: an agent override wins when no step configuration was chosen", async () => {
    olderBackend();
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild(task, "local", "opencode");
    });

    expect(startInput().agentType).toBe("opencode");
    expect(startInput().steps).toMatchObject({
      review: { agent: "claude" },
      verify: { agent: "claude" },
    });
    expect(startInput().reviewers).toHaveLength(2);
  });

  test("older backend: an agent override wins when the step map pins no build harness", async () => {
    olderBackend();
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    // The backend accepts a sparse step map, so the launcher's build step can
    // legitimately be absent while other steps are pinned. The override then
    // still decides the pipeline agent, and both sides agree on the snapshot.
    await act(async () => {
      await result.current.startBuild(task, "local", "opencode", {
        steps: { review: { agent: "codex" } },
      });
    });

    expect(startInput().agentType).toBe("opencode");
    expect(startInput().steps).toMatchObject({ review: { agent: "codex" } });
    expect((startInput().reviewers as Array<{ agent: string }>)[0]).toEqual({
      agent: "codex",
    });
  });

  test("older backend: applies the configured Multi Review fan-out and verify model by default", async () => {
    olderBackend();
    const baseConfig = appCommandStore(configStore).getState().config;
    appCommandStore(configStore).setState({
      config: {
        ...baseConfig,
        global: {
          ...baseConfig.global,
          agentSettings: {
            ...baseConfig.global.agentSettings,
            platforms: {},
            actionDefaults: {
              review: { platform: "claude", model: "opus" },
              review2: { platform: "codex", model: "gpt-5.6" },
              reviewPreparation: { platform: "codex", model: "gpt-5.6" },
              verify: { platform: "opencode", model: "provider/verifier" },
            },
            multiReview: {
              reviewerCount: 3,
              additionalReviewers: [{ platform: "claude", model: "haiku" }],
            },
          },
        },
      },
    });
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild(task, "local");
    });

    expect(startInput().reviewers).toEqual([
      { agent: "claude", model: "opus" },
      { agent: "codex", model: "gpt-5.6" },
      { agent: "claude", model: "haiku" },
    ]);
    expect(startInput().reviewPreparation).toEqual({
      agent: "codex",
      model: "gpt-5.6",
    });
    expect((startInput().steps as BuildStepConfigs).verify).toEqual({
      agent: "opencode",
      model: "provider/verifier",
    });
  });

  test("older backend: falls back to the repository's configured agent when neither is given", async () => {
    olderBackend();
    const baseConfig = appCommandStore(configStore).getState().config;
    appCommandStore(configStore).setState({
      config: {
        ...baseConfig,
        repositories: {
          ...baseConfig.repositories,
          "project-1": {
            defaultBranch: "main",
            prBaseBranch: "main",
            agentSettings: { defaultAgent: "opencode" },
          },
        },
      },
    });

    try {
      const { result } = renderHookInAppCommandScope(() => useBuildPipeline());
      await act(async () => {
        await result.current.startBuild(task, "local");
      });

      expect(startInput().agentType).toBe("opencode");
    } finally {
      // The hook is still mounted and subscribed, so the restore is a render.
      act(() => {
        appCommandStore(configStore).setState({ config: baseConfig });
      });
    }
  });

  test("older backend: a single configured reviewer omits fan-out and review preparation", async () => {
    olderBackend();
    const baseConfig = appCommandStore(configStore).getState().config;
    appCommandStore(configStore).setState({
      config: {
        ...baseConfig,
        global: {
          ...baseConfig.global,
          agentSettings: {
            ...baseConfig.global.agentSettings,
            platforms: {},
            actionDefaults: {
              review: { platform: "claude", model: "opus" },
              reviewPreparation: { platform: "codex", model: "gpt-5.6" },
              verify: { platform: "claude", model: "sonnet" },
            },
            multiReview: { reviewerCount: 1 },
          },
        },
      },
    });
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild(task, "local");
    });

    expect(startInput().reviewers).toEqual([{ agent: "claude", model: "opus" }]);
    expect(startInput().reviewPreparation).toBeUndefined();
    expect((startInput().steps as BuildStepConfigs).verify).toEqual({
      agent: "claude",
      model: "sonnet",
    });
  });

  test("older backend: an explicit review step replaces only the first configured reviewer", async () => {
    olderBackend();
    const baseConfig = appCommandStore(configStore).getState().config;
    appCommandStore(configStore).setState({
      config: {
        ...baseConfig,
        global: {
          ...baseConfig.global,
          agentSettings: {
            ...baseConfig.global.agentSettings,
            platforms: {},
            actionDefaults: {
              review: { platform: "claude", model: "opus" },
              review2: { platform: "codex", model: "gpt-5.6" },
            },
            multiReview: { reviewerCount: 2 },
          },
        },
      },
    });
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild(task, "local", undefined, {
        steps: { review: { agent: "opencode", model: "provider/overridden" } },
      });
    });

    expect(startInput().reviewers).toEqual([
      { agent: "opencode", model: "provider/overridden" },
      { agent: "codex", model: "gpt-5.6" },
    ]);
  });

  test("older backend: a GitHub issue build without options sends the configured Multi Review defaults", async () => {
    olderBackend();
    const baseConfig = appCommandStore(configStore).getState().config;
    appCommandStore(configStore).setState({
      config: {
        ...baseConfig,
        global: {
          ...baseConfig.global,
          agentSettings: {
            ...baseConfig.global.agentSettings,
            platforms: {},
            actionDefaults: {
              review: { platform: "claude", model: "opus" },
              review2: { platform: "codex", model: "gpt-5.6" },
              reviewPreparation: { platform: "codex", model: "gpt-5.6" },
              verify: { platform: "opencode", model: "provider/verifier" },
            },
          },
        },
      },
    });
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuildFromGitHubIssue(githubIssue, "project-1", "local");
    });

    expect(startInput().reviewers).toEqual([
      { agent: "claude", model: "opus" },
      { agent: "codex", model: "gpt-5.6" },
    ]);
    expect(startInput().reviewPreparation).toEqual({
      agent: "codex",
      model: "gpt-5.6",
    });
    expect((startInput().steps as BuildStepConfigs).verify).toEqual({
      agent: "opencode",
      model: "provider/verifier",
    });
  });

  test("a GitHub issue build carries the same per-step configuration", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuildFromGitHubIssue(githubIssue, "project-1", "local", "claude", {
        steps,
      });
    });

    expect(startInput().steps).toEqual(steps);
    // The backend resolves the pipeline agent; the launcher's override travels as chosen.
    expect(startInput().agentType).toBe("claude");
  });

  test("the Linear entry point carries per-step launcher configuration", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    // The defaulted fourth argument preserves the existing three-argument API
    // shape while allowing the Linear launcher to configure every stage.
    expect(result.current.startBuildFromLinearIssue.length).toBe(3);
    await act(async () => {
      await result.current.startBuildFromLinearIssue(linearIssue, "project-1", "local", { steps });
    });

    expect(startInput().steps).toEqual(steps);
    expect(startInput().agentType).toBeUndefined();
  });

  test("sends only the launch's explicit choices, leaving defaults to the backend", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.startBuild(task, "local");
    });

    const input = startInput();
    expect(input).not.toHaveProperty("agentType");
    expect(input).not.toHaveProperty("steps");
    expect(input).not.toHaveProperty("reviewers");
    expect(input).not.toHaveProperty("reviewPreparation");
    expect(legacyStartMock).not.toHaveBeenCalled();
  });

  test("a refused launch never falls back to the raw start", async () => {
    startBuildPipelineMock.mockImplementationOnce(async () => {
      throw new Error("The selected pipeline environment does not belong to this project");
    });
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    let pipelineId: string | undefined;
    await act(async () => {
      pipelineId = await result.current.startBuild(task, "local");
    });

    expect(pipelineId).toBeUndefined();
    expect(legacyStartMock).not.toHaveBeenCalled();
  });

  test("announces the start and names the reason a start failed", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

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

  test("navigation does not synthesize a build tab before backend layout hydration", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-nav",
      taskId: "task-nav",
      projectId: "project-nav",
      environmentId: "env-nav",
    });
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToPipeline(pipeline);
      await result.current.navigateToPipeline(pipeline);
    });

    expect(appCommandStore(uiStore).getState().selectedProjectId).toBe("project-nav");
    expect(buildTabs("env-nav")).toHaveLength(0);
  });

  test("finds and focuses an existing build tab inside a nested split tree", async () => {
    appCommandStore(paneLayoutStore).setState({
      environments: new Map([
        [
          "env-split",
          {
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
                      tabs: [
                        {
                          id: "existing-build-tab",
                          type: "claude-build",
                          buildTabData: {
                            environmentId: "env-split",
                            pipelineId: "pipeline-original",
                            taskId: "task-split",
                            isLocal: true,
                          },
                        },
                      ],
                      activeTabId: null,
                    },
                  ],
                },
              ],
            },
          },
        ],
      ]),
      hydration: new Map(),
      activeEnvironmentId: null,
    });
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToPipeline({
        id: "pipeline-newer",
        environmentId: "env-split",
        environmentType: "local",
        projectId: "project-1",
        taskId: "task-split",
      });
    });

    const environment = appCommandStore(paneLayoutStore).getState().environments.get("env-split");
    expect(buildTabs("env-split").filter((tab) => tab.type === "claude-build")).toHaveLength(1);
    expect(environment?.activePaneId).toBe("pane-build");
    expect(
      environment &&
        getAllLeaves(environment.root).find((leaf) => leaf.id === "pane-build")?.activeTabId,
    ).toBe("existing-build-tab");
  });

  test("does not race pending hydration with renderer-owned tab creation", async () => {
    const pipeline = buildPipelineFixture({
      id: "pipeline-hydrated",
      taskId: "task-hydrated",
      projectId: "project-hydrated",
      environmentId: "env-hydrated",
    });
    const paneStore = appCommandStore(paneLayoutStore).getState();
    paneStore.setActiveEnvironment("env-hydrated");
    paneStore.beginHydration("env-hydrated");
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    let navigation!: Promise<void>;
    act(() => {
      navigation = result.current.navigateToPipeline(pipeline);
    });
    expect(buildTabs("env-hydrated")).toHaveLength(0);

    act(() => {
      appCommandStore(paneLayoutStore)
        .getState()
        .finishHydration("env-hydrated", {
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

    expect(buildTabs("env-hydrated").map((tab) => tab.id)).toEqual(["restored-terminal"]);
    const environment = appCommandStore(paneLayoutStore)
      .getState()
      .environments.get("env-hydrated");
    expect(environment?.activePaneId).toBe("restored");
    expect(environment && getAllLeaves(environment.root)[0]?.activeTabId).toBe("restored-terminal");
  });
});

describe("useBuildPipeline navigation", () => {
  beforeEach(() => {
    cleanup();
    startBuildPipelineMock.mockClear();
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map(),
      buildEnvironmentIds: new Set(),
    });
    appCommandStore(paneLayoutStore).setState({
      environments: new Map(),
      hydration: new Map(),
      activeEnvironmentId: null,
    });
    appCommandStore(uiStore).setState({
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
    appCommandStore(buildPipelineStore).getState().replacePipeline(pipeline);
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToBuild(task);
    });

    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("env-known");
    expect(buildTabs("env-known")).toEqual([]);
  });

  test("does nothing when the task has no pipeline in the store", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToBuild(task);
    });

    // Silently opening an empty environment would be worse than doing nothing.
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBeNull();
    expect(appCommandStore(paneLayoutStore).getState().environments.size).toBe(0);
  });

  test("ignores a pipeline that has no environment yet", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToPipeline({
        environmentId: "",
        projectId: "project-1",
        taskId: "task-1",
      });
    });

    expect(appCommandStore(paneLayoutStore).getState().environments.size).toBe(0);
  });

  test("does not create a containerized pipeline tab in the renderer", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToPipeline({
        id: "pipeline-container",
        environmentId: "env-container",
        environmentType: "containerized",
        projectId: "project-1",
        taskId: "task-1",
      });
    });

    expect(buildTabs("env-container")).toEqual([]);
  });

  test("navigates legacy pipeline references without inventing layout metadata", async () => {
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());

    await act(async () => {
      await result.current.navigateToPipeline({
        environmentId: "env-legacy",
        projectId: "project-legacy",
        taskId: "legacy-42",
      });
    });

    expect(buildTabs("env-legacy")).toEqual([]);
    expect(appCommandStore(uiStore).getState().selectedProjectId).toBe("project-legacy");
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("env-legacy");
  });

  test("navigation never waits on a stalled pane hydration", async () => {
    appCommandStore(paneLayoutStore).setState({
      environments: new Map(),
      hydration: new Map([["env-stalled", "pending"]]),
      activeEnvironmentId: null,
    });
    const { result } = renderHookInAppCommandScope(() => useBuildPipeline());
    await act(async () => {
      await result.current.navigateToPipeline({
        id: "pipeline-stalled",
        environmentId: "env-stalled",
        environmentType: "local",
        projectId: "project-1",
        taskId: "task-1",
      });
    });

    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("env-stalled");
    expect(buildTabs("env-stalled")).toEqual([]);
  });
});
