import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Environment } from "@/types";

// Each of the modules stubbed below has its own test file. Snapshot the real
// modules before replacing them and restore in afterAll, so a non-isolated run
// does not leave those suites testing these fakes (AGENTS.md, Bun mock rules).
import * as realLoopedReview from "@/lib/looped-review-persistence";
import * as realBuildPipeline from "@/lib/build-pipeline-persistence";
import * as realPromptQueue from "@/lib/prompt-queue-persistence";
import * as realPromptQueueSources from "@/lib/prompt-queue-sources";

const realModules = {
  "@/lib/looped-review-persistence": { ...realLoopedReview },
  "@/lib/build-pipeline-persistence": { ...realBuildPipeline },
  "@/lib/prompt-queue-persistence": { ...realPromptQueue },
  "@/lib/prompt-queue-sources": { ...realPromptQueueSources },
};

afterAll(() => {
  for (const [path, module] of Object.entries(realModules)) {
    mock.module(path, () => module);
  }
});

/**
 * Every binding in this module is a guard plus a refetch, and the guards are
 * what stop a change for a scope this client is not showing from reloading the
 * wrong board or resurrecting a pipeline another client just finished. The
 * refetch targets are mocked so each test asserts on routing rather than on the
 * downstream store's own loading behaviour.
 */

const hydrateLoopedReviewWorkflow = mock(async (_id: string) => undefined);
const hydrateLoopedReviewWorkflowsForEnvironment = mock(async (_id: string) => []);
const hydrateBuildPipeline = mock(async (_id: string) => null as unknown);
const hydrateBuildPipelinesForProject = mock(async (_id: string) => []);
const hydratePromptQueuesForEnvironment = mock(async (_id: string, _sources: unknown) => undefined);
const createPromptQueueSources = mock(() => []);

mock.module("@/lib/looped-review-persistence", () => ({
  hydrateLoopedReviewWorkflow,
  hydrateLoopedReviewWorkflowsForEnvironment,
}));
mock.module("@/lib/build-pipeline-persistence", () => ({
  hydrateBuildPipeline,
  hydrateBuildPipelinesForProject,
}));
mock.module("@/lib/prompt-queue-persistence", () => ({ hydratePromptQueuesForEnvironment }));
mock.module("@/lib/prompt-queue-sources", () => ({ createPromptQueueSources }));

const {
  dispatchResourceChange,
  requestResourceResync,
  resetResourceSync,
} = await import("./resource-sync");
const { startStoreResourceSync } = await import("./store-resource-sync");
const { useBuildPipelineStore } = await import("@/stores/buildPipelineStore");
const { useConfigStore } = await import("@/stores/configStore");
const { useEnvironmentStore } = await import("@/stores/environmentStore");
const { useFeaturePlanStore } = await import("@/stores/featurePlanStore");
const { useKanbanStore } = await import("@/stores/kanbanStore");
const { useLoopedReviewStore } = await import("@/stores/loopedReviewStore");
const { usePaneLayoutStore } = await import("@/stores/paneLayoutStore");
const { useProjectStore } = await import("@/stores/projectStore");
const { useSessionStore } = await import("@/stores/sessionStore");

const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

let detach: (() => void) | null = null;

function environment(id: string): Environment {
  return {
    id,
    name: id,
    projectId: "project-1",
    status: "running",
    environmentType: "local",
    branch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as Environment;
}

function pipeline(id: string, backendRevision: number) {
  return {
    id,
    taskId: "task-1",
    projectId: "project-1",
    environmentId: "env-1",
    phase: "building",
    sessions: [],
    currentSessionIndex: -1,
    iteration: 0,
    maxIterations: 3,
    createdAt: "2026-01-01T00:00:00.000Z",
    taskTitle: "Test task",
    taskSnapshot: { title: "t", description: "", acceptanceCriteria: "", comments: [], images: [] },
    backendRevision,
  } as never;
}

beforeEach(() => {
  resetResourceSync();
  hydrateLoopedReviewWorkflow.mockClear();
  hydrateBuildPipeline.mockClear();
  hydrateBuildPipeline.mockImplementation(async () => null);
  hydrateBuildPipelinesForProject.mockClear();
  hydrateBuildPipelinesForProject.mockImplementation(async () => []);
  hydrateLoopedReviewWorkflowsForEnvironment.mockClear();
  hydrateLoopedReviewWorkflowsForEnvironment.mockImplementation(async () => []);
  hydratePromptQueuesForEnvironment.mockClear();
  useEnvironmentStore.setState({ environments: [] });
  useBuildPipelineStore.setState({ pipelines: new Map(), buildEnvironmentIds: new Set() });
  useKanbanStore.setState({ currentProjectId: null, currentNotesProjectId: null });
  useFeaturePlanStore.setState({ currentProjectId: null });
  useProjectStore.setState({ projects: [] });
  useLoopedReviewStore.setState({ workflows: new Map() });
  usePaneLayoutStore.setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
  detach = startStoreResourceSync();
});

afterEach(() => {
  detach?.();
  detach = null;
  resetResourceSync();
});

describe("prompt-queue binding", () => {
  test("refetches the environment's queues when it is known to this client", async () => {
    useEnvironmentStore.setState({ environments: [environment("env-1")] });

    dispatchResourceChange({ resource: "prompt-queue", id: "env-1", revision: 1 });
    await tick();

    expect(hydratePromptQueuesForEnvironment).toHaveBeenCalledTimes(1);
    expect(hydratePromptQueuesForEnvironment.mock.calls[0]?.[0]).toBe("env-1");
  });

  test("ignores a queue change for an environment this client has not loaded", async () => {
    dispatchResourceChange({ resource: "prompt-queue", id: "env-unknown", revision: 1 });
    await tick();

    expect(hydratePromptQueuesForEnvironment).not.toHaveBeenCalled();
  });

  test("does not reject when the refetch fails", async () => {
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    hydratePromptQueuesForEnvironment.mockImplementationOnce(async () => {
      throw new Error("backend down");
    });

    dispatchResourceChange({ resource: "prompt-queue", id: "env-1", revision: 1 });
    await tick();

    expect(hydratePromptQueuesForEnvironment).toHaveBeenCalledTimes(1);
  });
});

describe("session binding", () => {
  test("reloads sessions for a known environment", async () => {
    const loadSessionsForEnvironment = mock(async () => {});
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    useSessionStore.setState({ loadSessionsForEnvironment } as never);

    dispatchResourceChange({ resource: "session", id: "env-1", revision: 1 });
    await tick();

    expect(loadSessionsForEnvironment).toHaveBeenCalledWith("env-1");
  });

  test("ignores sessions for an environment this client has not loaded", async () => {
    const loadSessionsForEnvironment = mock(async () => {});
    useSessionStore.setState({ loadSessionsForEnvironment } as never);

    dispatchResourceChange({ resource: "session", id: "env-unknown", revision: 1 });
    await tick();

    expect(loadSessionsForEnvironment).not.toHaveBeenCalled();
  });
});

describe("kanban and notes bindings", () => {
  test("reloads the board only for the project currently open", async () => {
    const loadTasks = mock(async () => {});
    useKanbanStore.setState({ currentProjectId: "project-1", loadTasks } as never);

    dispatchResourceChange({ resource: "kanban", id: "project-1", revision: 1 });
    await tick();

    expect(loadTasks).toHaveBeenCalledWith("project-1");
  });

  test("ignores a board change for a project the user has navigated away from", async () => {
    const loadTasks = mock(async () => {});
    useKanbanStore.setState({ currentProjectId: "project-1", loadTasks } as never);

    dispatchResourceChange({ resource: "kanban", id: "project-2", revision: 1 });
    await tick();

    expect(loadTasks).not.toHaveBeenCalled();
  });

  test("reloads notes only for the project whose notes are open", async () => {
    const loadNotes = mock(async () => {});
    useKanbanStore.setState({ currentNotesProjectId: "project-1", loadNotes } as never);

    dispatchResourceChange({ resource: "project-notes", id: "project-1", revision: 1 });
    await tick();
    dispatchResourceChange({ resource: "project-notes", id: "project-2", revision: 2 });
    await tick();

    expect(loadNotes).toHaveBeenCalledTimes(1);
    expect(loadNotes).toHaveBeenCalledWith("project-1");
  });
});

describe("feature-plan binding", () => {
  test("reloads features only for the project currently open", async () => {
    const loadFeatures = mock(async () => {});
    useFeaturePlanStore.setState({ currentProjectId: "project-1", loadFeatures } as never);

    dispatchResourceChange({ resource: "feature-plan", id: "project-1", revision: 1 });
    await tick();
    dispatchResourceChange({ resource: "feature-plan", id: "project-2", revision: 2 });
    await tick();

    expect(loadFeatures).toHaveBeenCalledTimes(1);
    expect(loadFeatures).toHaveBeenCalledWith("project-1");
  });
});

describe("config binding", () => {
  test("refetches and installs the config for any config change", async () => {
    // Config is global, so unlike the project-scoped bindings there is no
    // scope guard to satisfy — every client wants every config change.
    const setConfig = mock(() => {});
    useConfigStore.setState({ setConfig } as never);

    dispatchResourceChange({ resource: "config", id: "app", revision: 1 });
    await tick();

    expect(setConfig).toHaveBeenCalledTimes(1);
  });
});

describe("build-pipeline binding", () => {
  test("rehydrates the pipeline from the backend", async () => {
    dispatchResourceChange({ resource: "build-pipeline", id: "pipeline-1", revision: 1 });
    await tick();

    expect(hydrateBuildPipeline).toHaveBeenCalledWith("pipeline-1");
  });

  test("drops a locally persisted pipeline the backend no longer holds", async () => {
    // Treating "not found" as authoritative is what stops a stale tab resuming
    // a build another client already finished.
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipeline-1", pipeline("pipeline-1", 4)]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });

    dispatchResourceChange({ resource: "build-pipeline", id: "pipeline-1", revision: 5 });
    await tick();

    expect(useBuildPipelineStore.getState().pipelines.has("pipeline-1")).toBe(false);
  });

  test("keeps a pipeline the backend has never seen", async () => {
    // backendRevision 0 means a sibling client may still be mid-way through
    // creating it; deleting locally would race that.
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipeline-new", pipeline("pipeline-new", 0)]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });

    dispatchResourceChange({ resource: "build-pipeline", id: "pipeline-new", revision: 1 });
    await tick();

    expect(useBuildPipelineStore.getState().pipelines.has("pipeline-new")).toBe(true);
  });

  test("keeps the local pipeline when the backend still holds it", async () => {
    hydrateBuildPipeline.mockImplementationOnce(async () => pipeline("pipeline-1", 5));
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipeline-1", pipeline("pipeline-1", 4)]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });

    dispatchResourceChange({ resource: "build-pipeline", id: "pipeline-1", revision: 5 });
    await tick();

    expect(useBuildPipelineStore.getState().pipelines.has("pipeline-1")).toBe(true);
  });

  test("leaves the store alone when the refetch fails", async () => {
    hydrateBuildPipeline.mockImplementationOnce(async () => { throw new Error("backend down"); });
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipeline-1", pipeline("pipeline-1", 4)]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });

    dispatchResourceChange({ resource: "build-pipeline", id: "pipeline-1", revision: 5 });
    await tick();

    expect(useBuildPipelineStore.getState().pipelines.has("pipeline-1")).toBe(true);
  });
});

describe("looped-review binding", () => {
  test("rehydrates the workflow", async () => {
    dispatchResourceChange({ resource: "looped-review", id: "workflow-1", revision: 1 });
    await tick();

    expect(hydrateLoopedReviewWorkflow).toHaveBeenCalledWith("workflow-1");
  });

  test("does not reject when the refetch fails", async () => {
    hydrateLoopedReviewWorkflow.mockImplementationOnce(async () => {
      throw new Error("backend down");
    });

    dispatchResourceChange({ resource: "looped-review", id: "workflow-1", revision: 1 });
    await tick();

    expect(hydrateLoopedReviewWorkflow).toHaveBeenCalledTimes(1);
  });
});

describe("pane-layout binding", () => {
  test("shows a tab created by another client without changing local selection", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", {
      id: "review-3",
      type: "claude-native",
      displayTitle: "Review",
      claudeNativeData: {
        environmentId: "env-1",
        isLocal: true,
        sessionId: "session-3",
      },
    }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );

    const getPaneLayout = mock(async () => ({
      version: 1,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          {
            id: "review-3",
            type: "claude-native",
            displayTitle: "Review",
            claudeNativeData: {
              environmentId: "env-1",
              sessionId: "session-3",
              isLocal: true,
            },
          },
          {
            id: "review-4",
            type: "claude-native",
            displayTitle: "Review",
            claudeNativeData: {
              environmentId: "env-1",
              sessionId: "session-4",
              isLocal: true,
            },
          },
        ],
        activeTabId: "review-4",
      },
      updatedAt: "2026-07-29T08:00:00.000Z",
      revision: 4,
    }));
    detach = startStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 1 });
    await tick();

    const pane = usePaneLayoutStore.getState().getPane("default", "env-1");
    expect(getPaneLayout).toHaveBeenCalledWith("env-1");
    expect(pane?.tabs.map(({ id }) => id)).toEqual(["review-3", "review-4"]);
    expect(pane?.activeTabId).toBe("review-3");
    expect(pane?.tabs[1]?.claudeNativeData?.sessionId).toBe("session-4");
  });

  test("replays a change that arrives while initial layout hydration is pending", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.beginHydration("env-1");

    const getPaneLayout = mock(async () => ({
      version: 1,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          { id: "terminal-1", type: "plain" },
          {
            id: "review-mobile",
            type: "claude-native",
            claudeNativeData: {
              environmentId: "env-1",
              sessionId: "session-mobile",
              isLocal: true,
            },
          },
        ],
        activeTabId: "review-mobile",
      },
      updatedAt: "2026-07-29T08:00:00.000Z",
      revision: 2,
    }));
    detach = startStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 1 });
    await tick();
    expect(getPaneLayout).not.toHaveBeenCalled();

    usePaneLayoutStore.getState().finishHydration("env-1", {
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "terminal-1", type: "plain" }],
        activeTabId: "terminal-1",
      },
    });
    await tick();

    expect(getPaneLayout).toHaveBeenCalledWith("env-1");
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["terminal-1", "review-mobile"]);
  });
});

describe("authoritative resync", () => {
  test("refreshes every active backend-owned store after a reconnect or gap", async () => {
    const loadSessionsForEnvironment = mock(async () => {});
    const loadTasks = mock(async () => {});
    const loadNotes = mock(async () => {});
    const loadFeatures = mock(async () => {});
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    useProjectStore.setState({
      projects: [{ id: "project-1" } as never],
    });
    useSessionStore.setState({ loadSessionsForEnvironment } as never);
    useKanbanStore.setState({
      currentProjectId: "project-1",
      currentNotesProjectId: "project-1",
      loadTasks,
      loadNotes,
    } as never);
    useFeaturePlanStore.setState({
      currentProjectId: "project-1",
      loadFeatures,
    } as never);

    requestResourceResync();
    await tick();

    expect(hydratePromptQueuesForEnvironment).toHaveBeenCalledWith(
      "env-1",
      expect.anything(),
    );
    expect(loadSessionsForEnvironment).toHaveBeenCalledWith("env-1");
    expect(hydrateLoopedReviewWorkflowsForEnvironment).toHaveBeenCalledWith("env-1");
    expect(hydrateBuildPipelinesForProject).toHaveBeenCalledWith("project-1");
    expect(loadTasks).toHaveBeenCalledWith("project-1");
    expect(loadNotes).toHaveBeenCalledWith("project-1");
    expect(loadFeatures).toHaveBeenCalledWith("project-1");
  });

  test("removes persisted pipelines and reviews absent from authoritative lists", async () => {
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    useProjectStore.setState({ projects: [{ id: "project-1" } as never] });
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipeline-1", pipeline("pipeline-1", 4)]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    useLoopedReviewStore.setState({
      workflows: new Map([[
        "workflow-1",
        {
          id: "workflow-1",
          environmentId: "env-1",
          backendRevision: 3,
        } as never,
      ]]),
    });

    requestResourceResync();
    await tick();

    expect(useBuildPipelineStore.getState().pipelines.has("pipeline-1")).toBe(false);
    expect(useLoopedReviewStore.getState().workflows.has("workflow-1")).toBe(false);
  });

  test("keeps unsaved local records when an authoritative list does not contain them", async () => {
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    useProjectStore.setState({ projects: [{ id: "project-1" } as never] });
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipeline-1", pipeline("pipeline-1", 0)]]),
      buildEnvironmentIds: new Set(["env-1"]),
    });
    useLoopedReviewStore.setState({
      workflows: new Map([[
        "workflow-1",
        {
          id: "workflow-1",
          environmentId: "env-1",
          backendRevision: 0,
        } as never,
      ]]),
    });

    requestResourceResync();
    await tick();

    expect(useBuildPipelineStore.getState().pipelines.has("pipeline-1")).toBe(true);
    expect(useLoopedReviewStore.getState().workflows.has("workflow-1")).toBe(true);
  });

  test("retries a failed config refresh on the next resync", async () => {
    detach?.();
    const getConfig = mock()
      .mockImplementationOnce(async () => {
        throw new Error("backend down");
      })
      .mockImplementationOnce(async () => ({ theme: "dark" }));
    const setConfig = mock(() => {});
    useConfigStore.setState({ setConfig } as never);
    detach = startStoreResourceSync({ getConfig: getConfig as never });

    requestResourceResync();
    await tick();
    expect(setConfig).not.toHaveBeenCalled();

    requestResourceResync();
    await tick();
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(setConfig).toHaveBeenCalledWith({ theme: "dark" });
  });

  test("does not let an older config read overwrite a newer event refresh", async () => {
    detach?.();
    let resolveOlder: ((value: unknown) => void) | undefined;
    let resolveNewer: ((value: unknown) => void) | undefined;
    const getConfig = mock()
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveOlder = resolve;
      }))
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveNewer = resolve;
      }));
    const setConfig = mock(() => {});
    useConfigStore.setState({ setConfig } as never);
    detach = startStoreResourceSync({ getConfig: getConfig as never });

    requestResourceResync();
    dispatchResourceChange({ resource: "config", id: "app", revision: 1 });
    await tick();
    expect(getConfig).toHaveBeenCalledTimes(2);

    resolveNewer?.({ theme: "dark" });
    await tick(0);
    resolveOlder?.({ theme: "light" });
    await tick(0);

    expect(setConfig).toHaveBeenCalledTimes(1);
    expect(setConfig).toHaveBeenCalledWith({ theme: "dark" });
  });

  test("ignores a resync result after detaching", async () => {
    detach?.();
    let resolveConfig: ((value: unknown) => void) | undefined;
    const getConfig = mock(() => new Promise((resolve) => {
      resolveConfig = resolve;
    }));
    const setConfig = mock(() => {});
    useConfigStore.setState({ setConfig } as never);
    detach = startStoreResourceSync({ getConfig: getConfig as never });

    requestResourceResync();
    detach();
    detach = null;
    resolveConfig?.({ theme: "dark" });
    await tick(0);

    expect(setConfig).not.toHaveBeenCalled();
  });
});

describe("detach", () => {
  test("stops routing once detached", async () => {
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    detach?.();
    detach = null;

    dispatchResourceChange({ resource: "prompt-queue", id: "env-1", revision: 1 });
    await tick();

    expect(hydratePromptQueuesForEnvironment).not.toHaveBeenCalled();
  });
});
