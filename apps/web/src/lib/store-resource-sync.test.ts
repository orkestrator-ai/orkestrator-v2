import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Environment } from "@/types";
import { loopedReviewFixture } from "@/test/looped-review-fixture";

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

const hydrateLoopedReviewWorkflow = mock(async (_id: string): Promise<unknown> => undefined);
const resolveLoopedReviewWorkflow = mock(
  async (_id: string): Promise<{ status: string; workflow?: unknown }> => ({ status: "unreadable" }),
);
const hydrateLoopedReviewWorkflowsForEnvironment = mock(async (_id: string) => []);
const hydrateBuildPipeline = mock(async (_id: string) => null as unknown);
const hydrateBuildPipelinesForProject = mock(async (_id: string) => []);
const hydratePromptQueuesForEnvironment = mock(async (_id: string, _sources: unknown) => undefined);
const createPromptQueueSources = mock(() => []);

mock.module("@/lib/looped-review-persistence", () => ({
  hydrateLoopedReviewWorkflow,
  hydrateLoopedReviewWorkflowsForEnvironment,
  resolveLoopedReviewWorkflow,
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
  startResourceSync,
} = await import("./resource-sync");
const { startStoreResourceSync } = await import("./store-resource-sync");
const { useBuildPipelineStore } = await import("@/stores/buildPipelineStore");
const { useConfigStore } = await import("@/stores/configStore");
const { useEnvironmentStore } = await import("@/stores/environmentStore");
const { useFeaturePlanStore } = await import("@/stores/featurePlanStore");
const { useKanbanStore } = await import("@/stores/kanbanStore");
const { useLoopedReviewStore } = await import("@/stores/loopedReviewStore");
const { usePaneLayoutStore } = await import("@/stores/paneLayoutStore");
const {
  invalidateProjectSnapshots,
  useProjectStore,
} = await import("@/stores/projectStore");
const { useSessionStore } = await import("@/stores/sessionStore");
const { PANE_LAYOUT_VERSION } = await import("@/types/paneLayout");

const startTestStoreResourceSync = (
  options: Parameters<typeof startStoreResourceSync>[0] = {},
) => startStoreResourceSync({
  getProjects: async () => useProjectStore.getState().projects,
  getEnvironmentSnapshots: async (projectId: string) =>
    useEnvironmentStore.getState().environments.filter(
      (environment) => environment.projectId === projectId,
    ),
  ...options,
});

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
  hydrateLoopedReviewWorkflow.mockImplementation(async () => undefined);
  resolveLoopedReviewWorkflow.mockClear();
  resolveLoopedReviewWorkflow.mockImplementation(async () => ({ status: "unreadable" }));
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
  detach = startTestStoreResourceSync();
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

    expect(resolveLoopedReviewWorkflow).toHaveBeenCalledWith("workflow-1");
  });

  test("does not reject when the refetch fails", async () => {
    resolveLoopedReviewWorkflow.mockImplementationOnce(async () => {
      throw new Error("backend down");
    });

    dispatchResourceChange({ resource: "looped-review", id: "workflow-1", revision: 1 });
    await tick();

    expect(resolveLoopedReviewWorkflow).toHaveBeenCalledTimes(1);
  });

  test("removes a stale projection after authoritative deletion", async () => {
    const workflow = loopedReviewFixture({ id: "workflow-deleted" });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    resolveLoopedReviewWorkflow.mockImplementationOnce(async () => ({ status: "missing" }));

    dispatchResourceChange({ resource: "looped-review", id: workflow.id, revision: 2 });
    await tick();

    expect(useLoopedReviewStore.getState().workflows.has(workflow.id)).toBe(false);
  });

  test("keeps a workflow whose snapshot this build cannot read", async () => {
    // A record the backend is still advancing but this bundle fails to
    // validate — a version skew — must not be mistaken for a deletion, or the
    // pane-layout reconciliation removes the user's tab along with it.
    const workflow = loopedReviewFixture({ id: "workflow-unreadable" });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    resolveLoopedReviewWorkflow.mockImplementationOnce(async () => ({ status: "unreadable" }));

    dispatchResourceChange({ resource: "looped-review", id: workflow.id, revision: 2 });
    await tick();

    expect(useLoopedReviewStore.getState().workflows.has(workflow.id)).toBe(true);
  });

  test("keeps a workflow when the refetch itself fails", async () => {
    const workflow = loopedReviewFixture({ id: "workflow-offline" });
    useLoopedReviewStore.getState().replaceWorkflow(workflow);
    resolveLoopedReviewWorkflow.mockImplementationOnce(async () => {
      throw new Error("backend down");
    });

    dispatchResourceChange({ resource: "looped-review", id: workflow.id, revision: 2 });
    await tick();

    expect(useLoopedReviewStore.getState().workflows.has(workflow.id)).toBe(true);
  });
});

describe("pane-layout binding", () => {
  test("shows a tab created by another client and adopts backend selection", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", {
      id: "review-3",
      type: "agent-native",
      displayTitle: "Review",
      nativeAgentData: {
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
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          {
            id: "review-3",
            type: "agent-native",
            displayTitle: "Review",
            nativeAgentData: {
              environmentId: "env-1",
              sessionId: "session-3",
              isLocal: true,
            },
          },
          {
            id: "review-4",
            type: "agent-native",
            displayTitle: "Review",
            nativeAgentData: {
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
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 1 });
    await tick();

    const pane = usePaneLayoutStore.getState().getPane("default", "env-1");
    expect(getPaneLayout).toHaveBeenCalledWith("env-1");
    expect(pane?.tabs.map(({ id }) => id)).toEqual(["review-3", "review-4"]);
    expect(pane?.activeTabId).toBe("review-4");
    expect(pane?.tabs[1]?.nativeAgentData?.sessionId).toBe("session-4");
  });

  test("moves focus to the build tab on setup completion without a pane-layout frame", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    useBuildPipelineStore.setState({
      pipelines: new Map([["pipe-1", pipeline("pipe-1", 1)]]),
    } as never);

    // The renderer is sitting on the setup terminal it seeded while the setup
    // script ran, exactly as it does mid-provision.
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", {
      id: "build-pipe-1",
      type: "claude-build",
      buildTabData: {
        environmentId: "env-1",
        pipelineId: "pipe-1",
        taskId: "task-1",
        isLocal: true,
      },
    }, "env-1");
    paneStore.addTab("default", { id: "default", type: "plain", isSetupTab: true }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );
    expect(usePaneLayoutStore.getState().getPane("default", "env-1")?.activeTabId)
      .toBe("default");

    // The backend already handed selection to the build surface.
    const getPaneLayout = mock(async () => ({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          {
            id: "build-pipe-1",
            type: "claude-build",
            buildTabData: {
              environmentId: "env-1",
              pipelineId: "pipe-1",
              taskId: "task-1",
              isLocal: true,
            },
          },
          { id: "default", type: "plain", isSetupTab: true },
        ],
        activeTabId: "build-pipe-1",
      },
      updatedAt: "2026-07-29T08:00:00.000Z",
      revision: 7,
    }));

    let emitSetupComplete: ((environmentId: string, success?: boolean) => void) | null = null;
    const listen = mock(async (event: string, handler: (e: { payload: unknown }) => void) => {
      if (event === "environment-setup-complete") {
        emitSetupComplete = (environmentId, success = true) =>
          handler({ payload: { environment_id: environmentId, success } });
      }
      return () => {};
    });

    detach = startTestStoreResourceSync({
      getPaneLayout: getPaneLayout as never,
      listen: listen as never,
    });
    await tick();

    // Deliberately never dispatch a "pane-layout" resource change: this is the
    // frame a mid-write or briefly disconnected client misses, which used to
    // strand the user on the setup terminal while the build ran unseen.
    emitSetupComplete!("env-1");
    await tick();

    expect(getPaneLayout).toHaveBeenCalledWith("env-1");
    expect(usePaneLayoutStore.getState().getPane("default", "env-1")?.activeTabId)
      .toBe("build-pipe-1");

    // A failed setup publishes the same event. The backend is still the
    // authority on what the layout should be, so re-reading it is correct there
    // too — what must not happen is the refresh being skipped or throwing.
    getPaneLayout.mockClear();
    emitSetupComplete!("env-1", false);
    await tick();
    expect(getPaneLayout).toHaveBeenCalledWith("env-1");
  });

  test("stops observing setup completion once detached", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });

    const getPaneLayout = mock(async () => null);
    let emitSetupComplete: ((environmentId: string) => void) | null = null;
    const unlisten = mock(() => {});
    const listen = mock(async (event: string, handler: (e: { payload: unknown }) => void) => {
      if (event === "environment-setup-complete") {
        emitSetupComplete = (environmentId) =>
          handler({ payload: { environment_id: environmentId } });
      }
      return unlisten;
    });

    const stop = startTestStoreResourceSync({
      getPaneLayout: getPaneLayout as never,
      listen: listen as never,
    });
    await tick();

    stop();
    expect(unlisten).toHaveBeenCalled();

    // Even if a frame is already in flight when the subscription is torn down,
    // it must not reach into stores this sync no longer owns.
    getPaneLayout.mockClear();
    emitSetupComplete!("env-1");
    await tick();
    expect(getPaneLayout).not.toHaveBeenCalled();
  });

  test("detaches a setup-completion listener that resolves after disposal", async () => {
    detach?.();

    let resolveListen: ((stop: () => void) => void) | null = null;
    const unlisten = mock(() => {});
    const listen = mock(
      (event: string) =>
        event === "environment-setup-complete"
          ? new Promise<() => void>((resolve) => {
            resolveListen = resolve;
          })
          : Promise.resolve(() => {}),
    );

    const stop = startTestStoreResourceSync({
      getPaneLayout: (mock(async () => null)) as never,
      listen: listen as never,
    });

    // Disposal wins the race: the subscription does not exist yet, so the only
    // place it can be cleaned up is the resolution handler itself. Without that,
    // the listener outlives the sync it belongs to.
    stop();
    expect(unlisten).not.toHaveBeenCalled();
    resolveListen!(unlisten);
    await tick();
    expect(unlisten).toHaveBeenCalled();
  });

  test("warns and keeps the sync alive when observing setup completion fails", async () => {
    detach?.();

    // A native bridge that throws while subscribing must not take down the
    // whole store sync: the ordinary resource-change feed still works, and the
    // handoff still converges through it.
    const listen = mock(async () => {
      throw new Error("native bridge unavailable");
    });
    const warn = mock((_args: unknown[]) => {});
    const originalWarn = console.warn;
    console.warn = warn;
    try {
      const stop = startTestStoreResourceSync({
        getPaneLayout: (mock(async () => null)) as never,
        listen: listen as never,
      });
      await tick();

      // The rejection is contained and attributed to the subscription it came
      // from, rather than surfacing as an unhandled rejection.
      expect(warn).toHaveBeenCalled();
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("Failed to observe setup completion");

      // The sync remains usable and tears down cleanly despite the failure.
      expect(() => stop()).not.toThrow();
    } finally {
      console.warn = originalWarn;
    }
  });

  test("replays a change that arrives while initial layout hydration is pending", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.beginHydration("env-1");

    const getPaneLayout = mock(async () => ({
      version: PANE_LAYOUT_VERSION,
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
            type: "agent-native",
            nativeAgentData: {
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
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

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

  test("preserves renderer-only launch and connection fields on self-echo", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    for (const [id, type, dataKey, port] of [
      ["claude", "agent-native", "nativeAgentData", 4101],
      ["codex", "agent-native", "nativeAgentData", 4102],
      ["opencode", "agent-native", "nativeAgentData", 4103],
    ] as const) {
      paneStore.addTab("default", {
        id,
        type,
        initialPrompt: `prompt-${id}`,
        initialCommands: [`command-${id}`],
        [dataKey]: {
          environmentId: "env-1",
          isLocal: true,
          hostPort: port,
          sessionId: `local-${id}`,
        },
      }, "env-1");
    }
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );
    const getPaneLayout = mock(async () => ({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          {
            id: "claude",
            type: "agent-native",
            nativeAgentData: {
              environmentId: "env-1",
              isLocal: true,
              sessionId: "backend-claude",
            },
          },
          {
            id: "codex",
            type: "agent-native",
            nativeAgentData: {
              environmentId: "env-1",
              isLocal: true,
              sessionId: "backend-codex",
            },
          },
          {
            id: "opencode",
            type: "agent-native",
            nativeAgentData: {
              environmentId: "env-1",
              isLocal: true,
              sessionId: "backend-opencode",
            },
          },
          { id: "remote", type: "plain" },
        ],
        activeTabId: "remote",
      },
      updatedAt: "2026-07-29T08:00:00.000Z",
      revision: 5,
    }));
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 1 });
    await tick();

    const byId = new Map(
      usePaneLayoutStore.getState().getAllTabs("env-1").map((tab) => [tab.id, tab]),
    );
    expect(byId.get("claude")).toMatchObject({
      initialPrompt: "prompt-claude",
      initialCommands: ["command-claude"],
      nativeAgentData: { hostPort: 4101, sessionId: "backend-claude" },
    });
    expect(byId.get("codex")).toMatchObject({
      initialPrompt: "prompt-codex",
      initialCommands: ["command-codex"],
      nativeAgentData: { hostPort: 4102, sessionId: "backend-codex" },
    });
    expect(byId.get("opencode")).toMatchObject({
      initialPrompt: "prompt-opencode",
      initialCommands: ["command-opencode"],
      nativeAgentData: { hostPort: 4103, sessionId: "backend-opencode" },
    });
    expect(byId.has("remote")).toBe(true);
  });

  test("hydrates referenced pipeline and review records before validating tabs", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );
    hydrateBuildPipeline.mockImplementationOnce(async (pipelineId) => {
      useBuildPipelineStore.setState({
        pipelines: new Map([[pipelineId, pipeline(pipelineId, 1)]]),
      } as never);
      return pipeline(pipelineId, 1);
    });
    hydrateLoopedReviewWorkflow.mockImplementationOnce(async (workflowId) => {
      useLoopedReviewStore.setState({
        workflows: new Map([[
          workflowId,
          { id: workflowId, environmentId: "env-1", backendRevision: 1 } as never,
        ]]),
      });
      return {} as never;
    });
    const getPaneLayout = mock(async () => ({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          { id: "base", type: "plain" },
          {
            id: "build",
            type: "claude-build",
            buildTabData: {
              environmentId: "env-1",
              pipelineId: "pipeline-remote",
              taskId: "task-1",
              isLocal: true,
            },
          },
          {
            id: "review",
            type: "looped-review",
            loopedReviewTabData: {
              environmentId: "env-1",
              workflowId: "workflow-remote",
              isLocal: true,
            },
          },
        ],
        activeTabId: "base",
      },
      updatedAt: "2026-07-29T08:00:00.000Z",
      revision: 2,
    }));
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 1 });
    await tick();

    expect(hydrateBuildPipeline).toHaveBeenCalledWith("pipeline-remote");
    expect(hydrateLoopedReviewWorkflow).toHaveBeenCalledWith("workflow-remote");
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["base", "build", "review"]);
  });

  test("does not adopt a layout after disposal during dependency hydration", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );

    let releaseDependency!: () => void;
    let markDependencyStarted!: () => void;
    const dependencyStarted = new Promise<void>((resolve) => {
      markDependencyStarted = resolve;
    });
    const dependencyBlocked = new Promise<void>((resolve) => {
      releaseDependency = resolve;
    });
    hydrateLoopedReviewWorkflow.mockImplementationOnce(async () => {
      markDependencyStarted();
      await dependencyBlocked;
      return undefined;
    });
    const getPaneLayout = mock(async () => ({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          { id: "base", type: "plain" },
          {
            id: "review-after-detach",
            type: "looped-review",
            loopedReviewTabData: { workflowId: "workflow-after-detach" },
          },
        ],
        activeTabId: "base",
      },
      updatedAt: "2026-07-29T08:00:00.000Z",
      revision: 3,
    }));
    const adoptPaneLayout = mock(() => true);
    detach = startTestStoreResourceSync({
      getPaneLayout: getPaneLayout as never,
      adoptPaneLayout,
    });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 3 });
    await dependencyStarted;
    detach?.();
    detach = null;
    releaseDependency();
    await tick(0);

    expect(adoptPaneLayout).not.toHaveBeenCalled();
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["base"]);
  });

  test("ignores a delayed layout response after the container is replaced", async () => {
    detach?.();
    const containerEnvironment = (containerId: string) => ({
      ...environment("env-1"),
      environmentType: "containerized",
      containerId,
    }) as Environment;
    useEnvironmentStore.setState({
      environments: [containerEnvironment("container-a")],
    });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize("container-a", "env-1");
    paneStore.addTab("default", { id: "container-a-tab", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );
    let resolveLayout!: (value: unknown) => void;
    let markLayoutRequestStarted!: () => void;
    const layoutRequestStarted = new Promise<void>((resolve) => {
      markLayoutRequestStarted = resolve;
    });
    const getPaneLayout = mock(() => new Promise((resolve) => {
      resolveLayout = resolve;
      markLayoutRequestStarted();
    }));
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 1 });
    await layoutRequestStarted;
    useEnvironmentStore.setState({
      environments: [containerEnvironment("container-b")],
    });
    // TerminalContainer resets the old container's tabs before initializing
    // the replacement. Mirror that production transition here so this test
    // isolates the delayed authoritative read rather than initialize()'s
    // intentional preservation of tabs inserted before a container mounts.
    usePaneLayoutStore.getState().reset("env-1");
    usePaneLayoutStore.getState().initialize("container-b", "env-1");
    usePaneLayoutStore.getState().addTab(
      "default",
      { id: "container-b-tab", type: "plain" },
      "env-1",
    );
    // Initializing a replacement container intentionally preserves already
    // opened tabs so that an active build or agent tab is not lost during a
    // container restart. Capture that authoritative local state before the
    // stale request resolves: the assertion below verifies the response does
    // not install its own tab tree over this generation.
    const tabsBeforeStaleResponse = usePaneLayoutStore
      .getState()
      .getAllTabs("env-1")
      .map(({ id }) => id);
    resolveLayout({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-1",
      containerId: "container-a",
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "stale-a-tab", type: "plain" }],
        activeTabId: "stale-a-tab",
      },
      updatedAt: "2026-07-29T08:00:00.000Z",
      revision: 2,
    });
    await tick(0);

    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(tabsBeforeStaleResponse);
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).not.toContain("stale-a-tab");
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").some(
        ({ id }) => id === "stale-a-tab",
      ),
    ).toBe(false);
    expect(
      usePaneLayoutStore.getState().environments.get("env-1")?.containerId,
    ).toBe("container-b");
  });

  test("ignores older overlapping reads and pending reads after detach", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );
    const resolvers: Array<(value: unknown) => void> = [];
    const getPaneLayout = mock(() => new Promise((resolve) => {
      resolvers.push(resolve);
    }));
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });
    const saved = (tabId: string, revision: number) => ({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: tabId, type: "plain" }],
        activeTabId: tabId,
      },
      updatedAt: "2026-07-29T08:00:00.000Z",
      revision,
    });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 1 });
    await tick();
    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 2 });
    await tick();
    resolvers[1]?.(saved("newer", 3));
    await tick(0);
    resolvers[0]?.(saved("older", 2));
    await tick(0);
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["newer"]);

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 3 });
    await tick();
    detach?.();
    detach = null;
    resolvers[2]?.(saved("after-detach", 4));
    await tick(0);
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["newer"]);
  });

  test("contains fetch failures, invalid snapshots, and declined adoption", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );
    const getPaneLayout = mock()
      .mockImplementationOnce(async () => {
        throw new Error("offline");
      })
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({
        version: PANE_LAYOUT_VERSION,
        environmentId: "env-1",
        containerId: null,
        activePaneId: "default",
        root: { kind: "broken" },
        updatedAt: "2026-07-29T08:00:00.000Z",
        revision: 2,
      }))
      .mockImplementationOnce(async () => ({
        version: PANE_LAYOUT_VERSION,
        environmentId: "env-1",
        containerId: null,
        activePaneId: "default",
        root: {
          kind: "leaf",
          id: "default",
          tabs: [{ id: "declined", type: "plain" }],
          activeTabId: "declined",
        },
        updatedAt: "2026-07-29T08:00:00.000Z",
        revision: 3,
      }));
    const adoptPaneLayout = mock(() => false);
    detach = startTestStoreResourceSync({
      getPaneLayout: getPaneLayout as never,
      adoptPaneLayout,
    });

    for (let revision = 1; revision <= 4; revision += 1) {
      dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision });
      await tick();
    }

    expect(getPaneLayout).toHaveBeenCalledTimes(4);
    expect(adoptPaneLayout).toHaveBeenCalledTimes(1);
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["base"]);
  });

  test("re-reads a snapshot it declined once the local write chain settles", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );

    const remoteLayout = (revision: number) => ({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          { id: "base", type: "plain" },
          { id: "from-other-client", type: "plain" },
        ],
        activeTabId: "base",
      },
      updatedAt: "2026-07-29T08:00:00.000Z",
      revision,
    });
    const getPaneLayout = mock(async () => remoteLayout(5));
    // The first adoption is declined because a local write is in flight; the
    // second, after that write settled, is accepted.
    const adoptPaneLayout = mock(() => adoptPaneLayout.mock.calls.length > 1);
    const settledBinding: { notify: ((environmentId: string) => void) | null } = {
      notify: null,
    };
    const onWriteSettled = mock((handler: (environmentId: string) => void) => {
      settledBinding.notify = handler;
      return () => {
        settledBinding.notify = null;
      };
    });

    detach = startTestStoreResourceSync({
      getPaneLayout: getPaneLayout as never,
      adoptPaneLayout,
      onPaneLayoutWriteSettled: onWriteSettled as never,
    });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 5 });
    await tick();
    expect(adoptPaneLayout).toHaveBeenCalledTimes(1);
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["base"]);

    // Without this replay the dropped snapshot is only recoverable if the write
    // it deferred to succeeds and announces its own revision.
    settledBinding.notify?.("env-1");
    await tick();

    expect(getPaneLayout).toHaveBeenCalledTimes(2);
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["base", "from-other-client"]);

    // A settle for an environment with nothing queued is not a refresh trigger.
    settledBinding.notify?.("env-1");
    await tick();
    expect(getPaneLayout).toHaveBeenCalledTimes(2);
  });

  test("ignores a change for an environment this client has not loaded", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [] });
    const getPaneLayout = mock(async () => null);
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    dispatchResourceChange({ resource: "pane-layout", id: "env-unknown", revision: 1 });
    await tick();

    expect(getPaneLayout).not.toHaveBeenCalled();
  });

  test("drops a snapshot once the environment changed shape mid-read", async () => {
    detach?.();
    useEnvironmentStore.setState({
      environments: [{ ...environment("env-1"), worktreePath: "/tmp/before" } as never],
    });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );

    const getPaneLayout = mock(async () => {
      // The environment is re-created onto a different worktree while the read
      // is in flight, so its file tabs would resolve against the wrong tree.
      useEnvironmentStore.setState({
        environments: [{ ...environment("env-1"), worktreePath: "/tmp/after" } as never],
      });
      return {
        version: PANE_LAYOUT_VERSION,
        environmentId: "env-1",
        containerId: null,
        activePaneId: "default",
        root: {
          kind: "leaf",
          id: "default",
          tabs: [
            { id: "base", type: "plain" },
            { id: "late", type: "plain" },
          ],
          activeTabId: "base",
        },
        updatedAt: "2026-07-29T08:00:00.000Z",
        revision: 6,
      };
    });
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 6 });
    await tick();

    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["base"]);
  });

  test("drops a snapshot when its environment disappears during the read", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );
    const getPaneLayout = mock(async () => {
      useEnvironmentStore.setState({ environments: [] });
      return {
        version: PANE_LAYOUT_VERSION,
        environmentId: "env-1",
        containerId: null,
        activePaneId: "default",
        root: {
          kind: "leaf",
          id: "default",
          tabs: [
            { id: "base", type: "plain" },
            { id: "late", type: "plain" },
          ],
          activeTabId: "base",
        },
        updatedAt: "2026-07-29T08:00:00.000Z",
        revision: 7,
      };
    });
    const adoptPaneLayout = mock(() => true);
    detach = startTestStoreResourceSync({
      getPaneLayout: getPaneLayout as never,
      adoptPaneLayout,
    });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 7 });
    await tick();

    expect(adoptPaneLayout).not.toHaveBeenCalled();
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["base"]);
  });

  test("drops a snapshot when pane hydration disappears during the read", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );
    const getPaneLayout = mock(async () => {
      usePaneLayoutStore.setState({ hydration: new Map() });
      return {
        version: PANE_LAYOUT_VERSION,
        environmentId: "env-1",
        containerId: null,
        activePaneId: "default",
        root: {
          kind: "leaf",
          id: "default",
          tabs: [
            { id: "base", type: "plain" },
            { id: "late", type: "plain" },
          ],
          activeTabId: "base",
        },
        updatedAt: "2026-07-29T08:00:00.000Z",
        revision: 8,
      };
    });
    const adoptPaneLayout = mock(() => true);
    detach = startTestStoreResourceSync({
      getPaneLayout: getPaneLayout as never,
      adoptPaneLayout,
    });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 8 });
    await tick();

    expect(adoptPaneLayout).not.toHaveBeenCalled();
    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["base"]);
  });

  test("drops a snapshot once the environment type changed mid-read", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );

    const getPaneLayout = mock(async () => {
      useEnvironmentStore.setState({
        environments: [{
          ...environment("env-1"),
          environmentType: "docker",
          containerId: null,
        } as never],
      });
      return {
        version: PANE_LAYOUT_VERSION,
        environmentId: "env-1",
        containerId: null,
        activePaneId: "default",
        root: {
          kind: "leaf",
          id: "default",
          tabs: [
            { id: "base", type: "plain" },
            { id: "late", type: "plain" },
          ],
          activeTabId: "base",
        },
        updatedAt: "2026-07-29T08:00:00.000Z",
        revision: 7,
      };
    });
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 7 });
    await tick();

    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["base"]);
  });

  test("drops a snapshot superseded while its dependencies were hydrating", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );

    const staleLayout = {
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          { id: "base", type: "plain" },
          {
            id: "stale",
            type: "looped-review",
            loopedReviewTabData: { workflowId: "workflow-stale" },
          },
        ],
        activeTabId: "base",
      },
      updatedAt: "2026-07-29T08:00:00.000Z",
      revision: 8,
    };
    const freshLayout = {
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [
          { id: "base", type: "plain" },
          { id: "fresh", type: "plain" },
        ],
        activeTabId: "fresh",
      },
      updatedAt: "2026-07-29T08:00:01.000Z",
      revision: 9,
    };
    const getPaneLayout = mock()
      .mockImplementationOnce(async () => staleLayout)
      .mockImplementationOnce(async () => freshLayout);
    let releaseStaleDependency!: () => void;
    let markStaleDependencyStarted!: () => void;
    const staleDependencyStarted = new Promise<void>((resolve) => {
      markStaleDependencyStarted = resolve;
    });
    const staleDependencyBlocked = new Promise<void>((resolve) => {
      releaseStaleDependency = resolve;
    });
    hydrateLoopedReviewWorkflow.mockImplementationOnce(async () => {
      markStaleDependencyStarted();
      await staleDependencyBlocked;
      return undefined;
    });
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 8 });
    await staleDependencyStarted;
    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 9 });
    await tick();
    releaseStaleDependency();
    await tick(0);

    expect(
      usePaneLayoutStore.getState().getAllTabs("env-1").map(({ id }) => id),
    ).toEqual(["base", "fresh"]);
    expect(
      usePaneLayoutStore.getState().getPane("default", "env-1")?.activeTabId,
    ).toBe("fresh");
  });

  test("removes a deferred refresh when its hydration record disappears", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    const getPaneLayout = mock(async () => null);
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 10 });
    await tick();
    expect(getPaneLayout).not.toHaveBeenCalled();

    usePaneLayoutStore.setState({ hydration: new Map() });
    usePaneLayoutStore.getState().finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );
    await tick(0);
    expect(getPaneLayout).not.toHaveBeenCalled();

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 11 });
    await tick();
    expect(getPaneLayout).toHaveBeenCalledTimes(1);
  });

  test("forgets a declined refresh when its pane environment disappears", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );
    const getPaneLayout = mock(async () => ({
      version: PANE_LAYOUT_VERSION,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: {
        kind: "leaf",
        id: "default",
        tabs: [{ id: "remote", type: "plain" }],
        activeTabId: "remote",
      },
      updatedAt: "2026-07-29T08:00:00.000Z",
      revision: 12,
    }));
    const settledBinding: { notify: ((environmentId: string) => void) | null } = {
      notify: null,
    };
    const onWriteSettled = mock((handler: (environmentId: string) => void) => {
      settledBinding.notify = handler;
      return () => {
        settledBinding.notify = null;
      };
    });
    detach = startTestStoreResourceSync({
      getPaneLayout: getPaneLayout as never,
      adoptPaneLayout: () => false,
      onPaneLayoutWriteSettled: onWriteSettled as never,
    });

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 12 });
    await tick();
    expect(getPaneLayout).toHaveBeenCalledTimes(1);

    usePaneLayoutStore.setState({ environments: new Map() });
    settledBinding.notify?.("env-1");
    await tick();

    expect(getPaneLayout).toHaveBeenCalledTimes(1);
  });
});

describe("authoritative resync", () => {
  test("converges renderer collections through the real command boundary after a backend restart", async () => {
    detach?.();
    detach = null;

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-resource-restart-"));
    const {
      StorageService,
      createEnvironment,
      createProject,
    } = await import("../../../backend/src/core/storage");
    const { createCommandRegistry } = await import("../../../backend/src/core/commands");
    const nativeEvents = await import("@/lib/native/events");
    const listenMock = nativeEvents.listen as ReturnType<typeof mock>;
    const eventHandlers = new Map<string, (event: { payload: unknown }) => void>();
    listenMock.mockImplementation(async (
      event: string,
      handler: (event: { payload: unknown }) => void,
    ) => {
      eventHandlers.set(event, handler);
      return () => eventHandlers.delete(event);
    });

    let stopTransport: (() => void) | undefined;
    let stopStores: (() => void) | undefined;
    try {
      const firstBackend = new StorageService(dataDir);
      await firstBackend.init();
      const project = await firstBackend.addProject(
        createProject("https://example.test/owner/project.git"),
      );
      const environmentSnapshot = await firstBackend.addEnvironment(
        createEnvironment(project.id, {
          name: "Before restart",
          environmentType: "local",
        }),
      );
      let activeBackend = firstBackend;
      const commands = createCommandRegistry();
      const commandContext = () => ({ storage: activeBackend }) as never;
      const invokeCommand = async (name: string, args: Record<string, unknown>) => {
        const command = commands.get(name);
        if (!command) throw new Error(`Missing command: ${name}`);
        return command(args, commandContext());
      };
      const manifestCalls: Array<{
        knownGeneration?: string;
        knownRevisions?: Record<string, string>;
      }> = [];

      useSessionStore.setState({
        loadSessionsForEnvironment: mock(async () => undefined),
      } as never);
      stopStores = startStoreResourceSync({
        getConfig: async () => ({}) as never,
        getProjects: async () =>
          await invokeCommand("get_projects", {}) as never,
        getEnvironmentSnapshots: async (projectId: string) =>
          await invokeCommand("get_environment_snapshots", { projectId }) as never,
      });
      stopTransport = startResourceSync({
        loadManifest: async (knownGeneration, knownRevisions) => {
          manifestCalls.push({ knownGeneration, knownRevisions });
          return await invokeCommand("get_resource_revision_manifest", {
            knownGeneration,
            knownRevisions,
          }) as never;
        },
      });

      await tick();
      expect(useProjectStore.getState().projects).toEqual([project]);
      expect(useEnvironmentStore.getState().environments).toEqual([
        expect.objectContaining({
          id: environmentSnapshot.id,
          name: environmentSnapshot.name,
        }),
      ]);
      const firstGeneration = manifestCalls[0]?.knownGeneration;
      expect(firstGeneration).toBeUndefined();

      const restartedBackend = new StorageService(dataDir);
      await restartedBackend.init();
      activeBackend = restartedBackend;
      await restartedBackend.updateProject(project.id, { name: "After restart" });
      await restartedBackend.updateEnvironment(environmentSnapshot.id, {
        name: "After restart",
      });

      const connected = eventHandlers.get(
        nativeEvents.NATIVE_EVENT_STREAM_CONNECTED_EVENT,
      );
      if (!connected) throw new Error("Connection listener did not attach");
      // The first connection announcement shares the attach-time reconciliation
      // window and is deliberately coalesced. A subsequent announcement models
      // the backend process reconnect that must retain the first generation.
      connected({ payload: undefined });
      connected({ payload: undefined });
      await tick();

      expect(manifestCalls).toHaveLength(2);
      expect(manifestCalls[1]?.knownGeneration).toEqual(expect.any(String));
      expect(manifestCalls[1]?.knownGeneration).not.toBe(
        restartedBackend.getResourceGeneration(),
      );
      expect(useProjectStore.getState().projects).toEqual([
        expect.objectContaining({ id: project.id, name: "After restart" }),
      ]);
      expect(useEnvironmentStore.getState().environments).toEqual([
        expect.objectContaining({ id: environmentSnapshot.id, name: "After restart" }),
      ]);
    } finally {
      stopTransport?.();
      stopStores?.();
      listenMock.mockImplementation(async () => () => undefined);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("does not let an older project snapshot overwrite a newer collection", async () => {
    detach?.();
    const stale = { id: "project-stale", name: "stale", order: 0 } as never;
    const current = { id: "project-current", name: "current", order: 0 } as never;
    let resolveProjects!: (projects: never[]) => void;
    const getProjects = mock()
      .mockImplementationOnce(() => new Promise<never[]>((resolve) => {
        resolveProjects = resolve;
      }))
      .mockImplementation(async () => [current]);
    detach = startTestStoreResourceSync({
      getProjects: getProjects as never,
      getEnvironmentSnapshots: mock(async () => []) as never,
    });

    requestResourceResync();
    await tick(0);
    useProjectStore.setState({ projects: [current] });
    resolveProjects([stale]);
    await tick();

    expect(useProjectStore.getState().projects).toEqual([current]);
    expect(getProjects).toHaveBeenCalledTimes(2);
  });

  test("reruns project hydration when its mutation version changes mid-read", async () => {
    detach?.();
    const initial = { id: "project-initial", name: "initial", order: 0 } as never;
    const stale = { id: "project-stale", name: "stale", order: 0 } as never;
    const converged = { id: "project-current", name: "current", order: 0 } as never;
    useProjectStore.setState({ projects: [initial] });
    let resolveProjects!: (projects: never[]) => void;
    const getProjects = mock()
      .mockImplementationOnce(() => new Promise<never[]>((resolve) => {
        resolveProjects = resolve;
      }))
      .mockImplementation(async () => [converged]);
    detach = startTestStoreResourceSync({
      getProjects: getProjects as never,
      getEnvironmentSnapshots: mock(async () => []) as never,
    });

    requestResourceResync();
    await tick(0);
    // Leave the array identity alone so this specifically exercises the
    // applyProjectSnapshot mutation-version rejection path.
    invalidateProjectSnapshots();
    resolveProjects([stale]);
    await tick();

    expect(getProjects).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().projects).toEqual([converged]);
  });

  test("does not let an older environment snapshot overwrite a newer collection", async () => {
    detach?.();
    const project = { id: "project-1", name: "project", order: 0 } as never;
    const stale = environment("env-stale");
    const current = environment("env-current");
    useProjectStore.setState({ projects: [project] });
    let resolveEnvironments!: (environments: Environment[]) => void;
    const getEnvironmentSnapshots = mock()
      .mockImplementationOnce(() => new Promise<Environment[]>((resolve) => {
        resolveEnvironments = resolve;
      }))
      .mockImplementation(async () => [current]);
    detach = startTestStoreResourceSync({
      getProjects: mock(async () => [project]) as never,
      getEnvironmentSnapshots: getEnvironmentSnapshots as never,
    });

    requestResourceResync();
    await tick(0);
    useEnvironmentStore.setState({ environments: [current] });
    resolveEnvironments([stale]);
    await tick();

    expect(useEnvironmentStore.getState().environments).toEqual([current]);
    expect(getEnvironmentSnapshots).toHaveBeenCalledTimes(2);
  });

  test("rehydrates project and environment collections without mounted UI loaders", async () => {
    detach?.();
    const project = { id: "project-new", name: "new", order: 0 } as never;
    const authoritativeEnvironment = {
      ...environment("env-new"),
      projectId: "project-new",
    };
    const getProjects = mock(async () => [project]);
    const getEnvironmentSnapshots = mock(async (projectId: string) =>
      projectId === "project-new" ? [authoritativeEnvironment] : []
    );
    detach = startTestStoreResourceSync({
      getProjects: getProjects as never,
      getEnvironmentSnapshots: getEnvironmentSnapshots as never,
    });

    requestResourceResync();
    await tick();

    expect(useProjectStore.getState().projects).toEqual([project]);
    expect(useEnvironmentStore.getState().environments).toEqual([
      authoritativeEnvironment,
    ]);
    expect(getEnvironmentSnapshots).toHaveBeenCalledWith("project-new");
  });

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
    detach = startTestStoreResourceSync({ getConfig: getConfig as never });

    requestResourceResync();
    await tick();
    expect(setConfig).not.toHaveBeenCalled();

    requestResourceResync();
    await tick();
    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(setConfig).toHaveBeenCalledWith({ theme: "dark" });
  });

  test("retries failed project and environment collection reads", async () => {
    detach?.();
    const project = { id: "project-1", name: "project", order: 0 } as never;
    const authoritativeEnvironment = environment("env-1");
    const getProjects = mock()
      .mockImplementationOnce(async () => { throw new Error("projects offline"); })
      .mockImplementation(async () => [project]);
    const getEnvironmentSnapshots = mock()
      .mockImplementationOnce(async () => { throw new Error("environments offline"); })
      .mockImplementation(async () => [authoritativeEnvironment]);
    useProjectStore.setState({ projects: [project] });
    detach = startTestStoreResourceSync({
      getProjects: getProjects as never,
      getEnvironmentSnapshots: getEnvironmentSnapshots as never,
    });

    requestResourceResync();
    await tick();
    requestResourceResync();
    await tick();

    expect(getProjects).toHaveBeenCalledTimes(2);
    expect(getEnvironmentSnapshots).toHaveBeenCalledTimes(2);
    expect(useEnvironmentStore.getState().environments).toEqual([
      authoritativeEnvironment,
    ]);
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
    detach = startTestStoreResourceSync({ getConfig: getConfig as never });

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
    detach = startTestStoreResourceSync({ getConfig: getConfig as never });

    requestResourceResync();
    detach();
    detach = null;
    resolveConfig?.({ theme: "dark" });
    await tick(0);

    expect(setConfig).not.toHaveBeenCalled();
  });

  test("waits for dependency hydration before applying pane layouts", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    useProjectStore.setState({ projects: [{ id: "project-1" } as never] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.addTab("default", { id: "base", type: "plain" }, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration(
      "env-1",
      usePaneLayoutStore.getState().environments.get("env-1"),
    );
    let releaseReviews!: () => void;
    const reviewsBlocked = new Promise<void>((resolve) => {
      releaseReviews = resolve;
    });
    hydrateLoopedReviewWorkflowsForEnvironment.mockImplementationOnce(async () => {
      await reviewsBlocked;
      return [];
    });
    const getPaneLayout = mock(async () => null);
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    requestResourceResync();
    await tick(0);
    expect(getPaneLayout).not.toHaveBeenCalled();
    releaseReviews();
    await tick();
    expect(getPaneLayout).toHaveBeenCalledWith("env-1");
  });

  test("continues pane resync after another authoritative read fails", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    useProjectStore.setState({ projects: [{ id: "project-1" } as never] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.beginHydration("env-1");
    paneStore.finishHydration("env-1");
    hydratePromptQueuesForEnvironment.mockImplementationOnce(async () => {
      throw new Error("queue offline");
    });
    const getPaneLayout = mock(async () => null);
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    requestResourceResync();
    await tick();

    expect(getPaneLayout).toHaveBeenCalledWith("env-1");
  });

  test("reports a failed pane read without abandoning the other environments", async () => {
    detach?.();
    useEnvironmentStore.setState({
      environments: [environment("env-1"), environment("env-2")],
    });
    useProjectStore.setState({ projects: [{ id: "project-1" } as never] });
    const paneStore = usePaneLayoutStore.getState();
    for (const environmentId of ["env-1", "env-2"]) {
      paneStore.initialize(null, environmentId);
      usePaneLayoutStore.getState().beginHydration(environmentId);
      usePaneLayoutStore.getState().finishHydration(environmentId);
    }
    const getPaneLayout = mock(async (environmentId: string) => {
      if (environmentId === "env-1") throw new Error("pane read offline");
      return null;
    });
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    // A rejected read is settled, not awaited-and-thrown: one bad environment
    // must not strand the reconnect resync for every other one.
    requestResourceResync();
    await tick();

    expect(getPaneLayout.mock.calls.map(([id]) => id).sort()).toEqual(["env-1", "env-2"]);
  });

  test("retries a deferred pane read that fails after initial hydration", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    useProjectStore.setState({ projects: [{ id: "project-1" } as never] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.beginHydration("env-1");
    const getPaneLayout = mock()
      .mockImplementationOnce(async () => { throw new Error("pane offline"); })
      .mockImplementation(async () => null);
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });

    requestResourceResync();
    await tick(0);
    expect(getPaneLayout).not.toHaveBeenCalled();
    usePaneLayoutStore.getState().finishHydration("env-1");
    await tick();
    expect(getPaneLayout).toHaveBeenCalledTimes(1);

    requestResourceResync();
    await tick();
    expect(getPaneLayout).toHaveBeenCalledTimes(2);
  });

  test("does not acknowledge a pane manifest revision until deferred hydration succeeds", async () => {
    detach?.();
    useEnvironmentStore.setState({ environments: [environment("env-1")] });
    const paneStore = usePaneLayoutStore.getState();
    paneStore.initialize(null, "env-1");
    paneStore.beginHydration("env-1");
    const getPaneLayout = mock()
      .mockImplementationOnce(async () => { throw new Error("pane offline"); })
      .mockImplementation(async () => null);
    detach = startTestStoreResourceSync({ getPaneLayout: getPaneLayout as never });
    const manifestArguments: Array<{ generation?: string; revisions?: unknown }> = [];
    const loadManifest = mock(async (generation?: string, revisions?: unknown) => {
      manifestArguments.push({ generation, revisions });
      return {
        generation: "a".repeat(32),
        reset: false,
        revisions: { "pane-layout": "b".repeat(32) },
      };
    });
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let intervalCallback: (() => void) | undefined;
    globalThis.setInterval = ((callback: TimerHandler) => {
      intervalCallback = callback as () => void;
      return 42 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = mock(() => undefined) as unknown as typeof clearInterval;
    let stopResourceSync: (() => void) | null = null;
    try {
      stopResourceSync = startResourceSync({ loadManifest });
      await tick(10);
      expect(getPaneLayout).not.toHaveBeenCalled();
      usePaneLayoutStore.getState().finishHydration("env-1");
      await tick();
      expect(getPaneLayout).toHaveBeenCalledTimes(1);

      intervalCallback?.();
      await tick();

      expect(getPaneLayout).toHaveBeenCalledTimes(2);
      expect(manifestArguments).toHaveLength(2);
      expect(manifestArguments[1]).toEqual({ generation: undefined, revisions: {} });
    } finally {
      stopResourceSync?.();
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("coalesces a resync requested while one is running into one follow-up", async () => {
    detach?.();
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const getConfig = mock()
      .mockImplementationOnce(async () => {
        await firstBlocked;
        return { theme: "first" };
      })
      .mockImplementationOnce(async () => ({ theme: "second" }));
    detach = startTestStoreResourceSync({ getConfig: getConfig as never });

    requestResourceResync();
    requestResourceResync();
    await tick(0);
    expect(getConfig).toHaveBeenCalledTimes(1);
    releaseFirst();
    await tick();
    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  test("unions selective resource sets queued behind an active resync", async () => {
    detach?.();
    let releaseConfig!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseConfig = resolve; });
    const getConfig = mock(async () => {
      await blocked;
      return { theme: "dark" };
    });
    const loadTasks = mock(async () => {});
    useKanbanStore.setState({ currentProjectId: "project-1", loadTasks } as never);
    detach = startTestStoreResourceSync({ getConfig: getConfig as never });
    const stableGeneration = "a".repeat(32);

    startResourceSync({ loadManifest: async () => ({
      generation: stableGeneration,
      reset: false,
      revisions: { config: "b".repeat(32) },
    }) });
    await tick(0);
    startResourceSync({ loadManifest: async () => ({
      generation: stableGeneration,
      reset: false,
      revisions: { kanban: "c".repeat(32) },
    }) });
    await tick(10);
    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(loadTasks).not.toHaveBeenCalled();

    releaseConfig();
    await tick();
    expect(loadTasks).toHaveBeenCalledWith("project-1");
  });

  test("keeps a queued full resync authoritative over later selective requests", async () => {
    detach?.();
    let releaseConfig!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseConfig = resolve; });
    const getConfig = mock()
      .mockImplementationOnce(async () => {
        await blocked;
        return { theme: "first" };
      })
      .mockImplementation(async () => ({ theme: "full" }));
    const getProjects = mock(async () => []);
    detach = startTestStoreResourceSync({
      getConfig: getConfig as never,
      getProjects: getProjects as never,
    });
    const stableGeneration = "a".repeat(32);

    startResourceSync({ loadManifest: async () => ({
      generation: stableGeneration,
      reset: false,
      revisions: { config: "b".repeat(32) },
    }) });
    await tick(0);
    requestResourceResync();
    startResourceSync({ loadManifest: async () => ({
      generation: stableGeneration,
      reset: false,
      revisions: { "feature-plan": "c".repeat(32) },
    }) });
    await tick(10);
    releaseConfig();
    await tick();

    expect(getConfig).toHaveBeenCalledTimes(2);
    expect(getProjects).toHaveBeenCalledTimes(1);
  });

  test("hydrates only resources named by a selective manifest", async () => {
    detach?.();
    const getConfig = mock(async () => ({ theme: "dark" }));
    const getProjects = mock(async () => []);
    const getEnvironmentSnapshots = mock(async () => []);
    detach = startTestStoreResourceSync({
      getConfig: getConfig as never,
      getProjects: getProjects as never,
      getEnvironmentSnapshots: getEnvironmentSnapshots as never,
    });

    startResourceSync({ loadManifest: async () => ({
      generation: "a".repeat(32),
      reset: false,
      revisions: { config: "b".repeat(32) },
    }) });
    await tick();

    expect(getConfig).toHaveBeenCalledTimes(1);
    expect(getProjects).not.toHaveBeenCalled();
    expect(getEnvironmentSnapshots).not.toHaveBeenCalled();
  });

  test("converges a generation reset through manifest phases into final stores", async () => {
    detach?.();
    const order: string[] = [];
    const project = { id: "project-new", name: "new", order: 0 } as never;
    const authoritativeEnvironment = {
      ...environment("env-new"),
      projectId: "project-new",
    };
    detach = startTestStoreResourceSync({
      getProjects: mock(async () => {
        order.push("project");
        return [project];
      }) as never,
      getEnvironmentSnapshots: mock(async () => {
        order.push("environment");
        return [authoritativeEnvironment];
      }) as never,
    });

    startResourceSync({ loadManifest: async () => ({
      generation: "a".repeat(32),
      reset: true,
      revisions: {
        project: "b".repeat(32),
        environment: "c".repeat(32),
      },
    }) });
    await tick();

    expect(order).toEqual(["project", "environment"]);
    expect(useProjectStore.getState().projects).toEqual([project]);
    expect(useEnvironmentStore.getState().environments).toEqual([
      authoritativeEnvironment,
    ]);
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
