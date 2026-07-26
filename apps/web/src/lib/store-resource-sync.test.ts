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
const hydrateBuildPipeline = mock(async (_id: string) => null as unknown);
const hydratePromptQueuesForEnvironment = mock(async (_id: string, _sources: unknown) => undefined);
const createPromptQueueSources = mock(() => []);

mock.module("@/lib/looped-review-persistence", () => ({ hydrateLoopedReviewWorkflow }));
mock.module("@/lib/build-pipeline-persistence", () => ({ hydrateBuildPipeline }));
mock.module("@/lib/prompt-queue-persistence", () => ({ hydratePromptQueuesForEnvironment }));
mock.module("@/lib/prompt-queue-sources", () => ({ createPromptQueueSources }));

const { dispatchResourceChange, resetResourceSync } = await import("./resource-sync");
const { startStoreResourceSync } = await import("./store-resource-sync");
const { useBuildPipelineStore } = await import("@/stores/buildPipelineStore");
const { useConfigStore } = await import("@/stores/configStore");
const { useEnvironmentStore } = await import("@/stores/environmentStore");
const { useFeaturePlanStore } = await import("@/stores/featurePlanStore");
const { useKanbanStore } = await import("@/stores/kanbanStore");
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
  hydratePromptQueuesForEnvironment.mockClear();
  useEnvironmentStore.setState({ environments: [] });
  useBuildPipelineStore.setState({ pipelines: new Map(), buildEnvironmentIds: new Set() });
  useKanbanStore.setState({ currentProjectId: null, currentNotesProjectId: null });
  useFeaturePlanStore.setState({ currentProjectId: null });
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

describe("bindings absent by design", () => {
  test("does not mirror pane layout between windows", async () => {
    // Which panes a window has open is per-window state that merely happens to
    // be persisted; mirroring it live would fight the user.
    const loadTasks = mock(async () => {});
    useKanbanStore.setState({ currentProjectId: "project-1", loadTasks } as never);

    dispatchResourceChange({ resource: "pane-layout", id: "env-1", revision: 1 });
    await tick();

    expect(loadTasks).not.toHaveBeenCalled();
    expect(hydratePromptQueuesForEnvironment).not.toHaveBeenCalled();
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
