/**
 * Plan item 3011: the pipeline, Kanban, feature plan, coordinator and graph
 * stores keep one instance per node scope.
 *
 * For each store: two scopes keep independent state, and the hook reads the
 * rendered scope's instance. Then each store's reads go to its own node, a
 * pipeline launched on the command scope stays out of a second scope, and a
 * disposed scope leaves no listener or timer behind (invariant 15).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, screen } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { COORDINATOR_ACTIVITY_COMMAND } from "@orkestrator/protocol/coordinator-activity";
import { COORDINATOR_LAUNCH_OVERRIDES_COMMAND } from "@orkestrator/protocol/coordinator-launch-overrides";
import type { StoreApi } from "zustand/vanilla";
import {
  buildPipelineChangeReadOptions,
  hydrateBuildPipeline,
  isBuildPipelineKnownUnavailable,
  watchBuildPipelineTranscript,
} from "@/lib/build-pipeline-persistence";
import { scheduleBuildPipelineTabActivation } from "@/lib/feature-build-activation";
import type { ResourceChange } from "@orkestrator/protocol/resource-events";
import { requestViewSafetyChecks } from "@/lib/resource-sync";
import type { StoreResourceSyncContext } from "@/lib/store-resource-sync";
import {
  featurePlanResourceHandlers,
  kanbanResourceHandlers,
  workflowResourceHandlers,
} from "@/lib/workflow-resource-handlers";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import type { ScopedStoreDef } from "@/lib/node-scope/scoped-store";
import type { ScopedStoreHook } from "@/lib/node-scope/scoped-store";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import type { PersistedBuildPipeline } from "@/types";
import {
  BUILD_PIPELINE_VERSION,
  buildPipelineStore,
  useBuildPipelineStore,
  type BuildPipeline,
} from "./buildPipelineStore";
import { coordinatorActivityStore, useCoordinatorActivityStore } from "./coordinatorActivityStore";
import {
  coordinatorLaunchOverrideStore,
  useCoordinatorLaunchOverrideStore,
} from "./coordinatorLaunchOverrideStore";
import {
  coordinatorPaneLayoutStore,
  useCoordinatorPaneLayoutStore,
} from "./coordinatorPaneLayoutStore";
import { featurePlanStore, useFeaturePlanStore } from "./featurePlanStore";
import { graphDescribeStore, useGraphDescribeStore } from "./graphDescribeStore";
import { graphDesignerStore, graphDesignerTab, useGraphDesignerStore } from "./graphDesignerStore";
import { graphRunStore, useGraphRunStore } from "./graphRunStore";
import { findTaskForEnvironment, kanbanStore, useKanbanStore } from "./kanbanStore";
import * as barrel from "./index";

const NODE_A = "bk_workflow-store-a" as BackendId;
const NODE_B = "bk_workflow-store-b" as BackendId;

interface Case<S> {
  def: ScopedStoreDef<S>;
  hook: ScopedStoreHook<S>;
  /** Changes the state through the store's own action (or a plain write). */
  write(store: StoreApi<S>): void;
  /** A string that differs once `write` ran. */
  read(state: S): string;
}

function scopedCase<S>(entry: Case<S>): Case<unknown> {
  return entry as unknown as Case<unknown>;
}

const CASES: ReadonlyArray<Case<unknown>> = [
  scopedCase({
    def: buildPipelineStore,
    hook: useBuildPipelineStore,
    write: (store) => store.getState().replacePipeline(buildPipelineFixture({ id: "pipe-a" })),
    read: (state) => String(state.pipelines.get("pipe-a")?.id ?? "none"),
  }),
  scopedCase({
    def: kanbanStore,
    hook: useKanbanStore,
    write: (store) => store.setState({ currentProjectId: "project-a" }),
    read: (state) => state.currentProjectId ?? "none",
  }),
  scopedCase({
    def: featurePlanStore,
    hook: useFeaturePlanStore,
    write: (store) => store.getState().setChatDraft("chat-1", "draft"),
    read: (state) => state.getChatDraft("chat-1") || "none",
  }),
  scopedCase({
    def: coordinatorActivityStore,
    hook: useCoordinatorActivityStore,
    write: (store) => store.setState({ projects: new Map([["project-a", "working"]]) }),
    read: (state) => state.projects.get("project-a") ?? "none",
  }),
  scopedCase({
    def: coordinatorLaunchOverrideStore,
    hook: useCoordinatorLaunchOverrideStore,
    write: (store) =>
      store.setState({
        overrides: new Map([
          ["key", { environmentId: "env-1", tabId: "tab-1", model: "model-a" } as never],
        ]),
      }),
    read: (state) => String(state.overrides.size),
  }),
  scopedCase({
    def: coordinatorPaneLayoutStore,
    hook: useCoordinatorPaneLayoutStore,
    write: (store) =>
      store.setState({ entries: { "project-a": { layout: undefined, revision: 3, ready: true } } }),
    read: (state) => String(state.entries["project-a"]?.revision ?? "none"),
  }),
  scopedCase({
    def: graphDesignerStore,
    hook: useGraphDesignerStore,
    write: (store) => store.getState().select("tab-1", { kind: "node", id: "node-a" } as never),
    read: (state) => (state.tabs.get("tab-1")?.selection ? "selected" : "none"),
  }),
  scopedCase({
    def: graphRunStore,
    hook: useGraphRunStore,
    write: (store) =>
      store.setState({ runs: new Map([["run-a", { run: null, status: "missing", error: null }]]) }),
    read: (state) => state.runs.get("run-a")?.status ?? "none",
  }),
  scopedCase({
    def: graphDescribeStore,
    hook: useGraphDescribeStore,
    write: (store) => store.getState().clearError("env-a"),
    read: (state) => (state.entries.has("env-a") ? "touched" : "none"),
  }),
];

let windowScope: WindowScope | null = null;

function twoScopes(
  invokeA: Record<string, unknown> = {},
  invokeB: Record<string, unknown> = {},
): { a: NodeScope; b: NodeScope; clientA: FakeNodeClient; clientB: FakeNodeClient } {
  windowScope = new WindowScope();
  const clientA = new FakeNodeClient({ nodeId: NODE_A, invoke: invokeA });
  const clientB = new FakeNodeClient({ nodeId: NODE_B, invoke: invokeB });
  return {
    a: windowScope.open({ role: "command", client: clientA }),
    b: windowScope.open({ role: "leaf", client: clientB }),
    clientA,
    clientB,
  };
}

afterEach(() => {
  cleanupNodeScopes();
  windowScope?.dispose();
  windowScope = null;
});

function record(pipeline: BuildPipeline, revision: number): PersistedBuildPipeline<BuildPipeline> {
  return {
    version: BUILD_PIPELINE_VERSION,
    id: pipeline.id,
    projectId: pipeline.projectId,
    environmentId: pipeline.environmentId,
    snapshot: pipeline,
    revision,
    updatedAt: "2026-11-07T00:00:00.000Z",
  };
}

describe("each workflow store, per node scope", () => {
  for (const { def, hook, write, read } of CASES) {
    test(`${def.name}: two scopes keep separate state`, () => {
      const { a, b } = twoScopes();
      const before = read(b.store(def).getState());
      write(a.store(def));
      expect(read(a.store(def).getState())).not.toBe(before);
      expect(read(b.store(def).getState())).toBe(before);
    });

    test(`${def.name}: the hook reads the rendered scope`, () => {
      function Probe() {
        return <span data-testid="probe">{read(hook())}</span>;
      }
      const { scope } = renderInNodeScope(<Probe />, { nodeId: NODE_A });
      const before = screen.getByTestId("probe").textContent;
      act(() => write(scope.store(def)));
      expect(screen.getByTestId("probe").textContent).not.toBe(before);
    });
  }

  test("the barrel exports each converted def beside its hook", () => {
    expect(barrel.buildPipelineStore).toBe(buildPipelineStore);
    expect(barrel.kanbanStore).toBe(kanbanStore);
    expect(barrel.featurePlanStore).toBe(featurePlanStore);
  });
});

describe("reads go to their own node", () => {
  test("Kanban and feature plans load from the scope's node", async () => {
    const task = { id: "task-b", environmentId: "env-b" };
    const { a, b, clientA, clientB } = twoScopes(
      {},
      { get_kanban_tasks: [task], get_feature_plans: [] },
    );
    await b.store(kanbanStore).getState().loadTasks("project-1");
    await b.store(featurePlanStore).getState().loadFeatures("project-1");
    expect(clientB.calls("get_kanban_tasks")).toHaveLength(1);
    expect(clientB.calls("get_feature_plans")).toHaveLength(1);
    expect(clientA.invocations).toHaveLength(0);
    expect(b.store(kanbanStore).getState().tasks).toEqual([task] as never);
    expect(a.store(kanbanStore).getState().tasks).toEqual([]);
    expect(findTaskForEnvironment("env-b", b).taskId).toBe("task-b");
    expect(findTaskForEnvironment("env-b", a).taskId).toBeUndefined();
  });

  test("graph runs, describe jobs and the template library read the scope's node", async () => {
    const { b, clientA, clientB } = twoScopes(
      {},
      {
        graph_run_get: () =>
          Promise.reject(Object.assign(new Error("gone"), { code: "not-found" })),
        graph_describe_status: null,
        graph_templates_list: { templates: [], diagnostics: [] },
      },
    );
    await b.store(graphRunStore).getState().loadRun("run-1");
    await b.store(graphDescribeStore).getState().refresh("env-1");
    await b.store(graphDesignerStore).getState().loadLibrary(null);
    expect(b.store(graphRunStore).getState().runs.get("run-1")?.status).toBe("missing");
    expect(clientB.calls("graph_run_get")).toHaveLength(1);
    expect(clientB.calls("graph_describe_status")).toHaveLength(1);
    expect(clientB.calls("graph_templates_list")).toHaveLength(1);
    expect(clientA.invocations).toHaveLength(0);
    expect(graphDesignerTab("tab-1", b).selected).toBeNull();
  });

  test("coordinator activity, overrides and layouts read the scope's node", async () => {
    const { b, clientA, clientB } = twoScopes(
      {},
      {
        [COORDINATOR_ACTIVITY_COMMAND]: { projects: { "project-1": "working" } },
        [COORDINATOR_LAUNCH_OVERRIDES_COMMAND]: { overrides: [] },
        get_client_state_capabilities: { coordinatorPaneLayouts: false },
      },
    );
    await b.store(coordinatorActivityStore).getState().refresh();
    await b.store(coordinatorLaunchOverrideStore).getState().refresh();
    await b.store(coordinatorPaneLayoutStore).getState().hydrate("project-1");
    expect(b.store(coordinatorActivityStore).getState().projects.get("project-1")).toBe("working");
    expect(clientB.calls(COORDINATOR_ACTIVITY_COMMAND)).toHaveLength(1);
    expect(clientB.calls(COORDINATOR_LAUNCH_OVERRIDES_COMMAND)).toHaveLength(1);
    expect(clientB.calls("get_client_state_capabilities")).toHaveLength(1);
    expect(b.store(coordinatorPaneLayoutStore).getState().entries["project-1"]?.ready).toBe(true);
    expect(clientA.invocations).toHaveLength(0);
  });
});

describe("the workflow change handlers run on every scope", () => {
  test("a leaf's changes refresh the leaf's board, plans and pipelines from the leaf", async () => {
    const { a, b, clientA, clientB } = twoScopes(
      {},
      {
        get_kanban_tasks: [],
        get_feature_plans: [],
        get_build_pipeline: null,
      },
    );
    for (const registration of [
      workflowResourceHandlers,
      kanbanResourceHandlers,
      featurePlanResourceHandlers,
    ]) {
      expect(registration.runsOn).toBe("every-scope");
    }
    b.store(kanbanStore).setState({ currentProjectId: "project-1" });
    b.store(featurePlanStore).setState({ currentProjectId: "project-1" });
    b.store(buildPipelineStore)
      .getState()
      .replacePipeline(buildPipelineFixture({ id: "pipe-b" }));
    // The registrations' own view of the sync: the change handlers they bind.
    const handlers = new Map<string, (change: ResourceChange) => unknown>();
    const stops: Array<() => void> = [];
    const context: StoreResourceSyncContext = {
      scope: b,
      signal: new AbortController().signal,
      options: {},
      disposed: () => false,
      onResourceChanged: (resource, handler) => handlers.set(resource, handler),
      onResync: () => undefined,
      listen: () => undefined,
      onStop: (stop) => stops.push(stop),
      requestResync: async () => undefined,
    };
    for (const registration of [
      workflowResourceHandlers,
      kanbanResourceHandlers,
      featurePlanResourceHandlers,
    ]) {
      registration.register(context);
    }
    try {
      await handlers.get("kanban")!({ resource: "kanban", id: "project-1", revision: 1 });
      await handlers.get("feature-plan")!({
        resource: "feature-plan",
        id: "project-1",
        revision: 1,
      });
      await handlers.get("build-pipeline")!({
        resource: "build-pipeline",
        id: "pipe-b",
        revision: 2,
      });
      expect(clientB.calls("get_kanban_tasks")).toHaveLength(1);
      expect(clientB.calls("get_feature_plans")).toHaveLength(1);
      expect(clientB.calls("get_build_pipeline")).toHaveLength(1);
      // The leaf's node no longer has the pipeline, so the leaf drops it.
      expect(b.store(buildPipelineStore).getState().pipelines.has("pipe-b")).toBe(false);
      expect(clientA.invocations).toHaveLength(0);
      expect(a.store(kanbanStore).getState().currentProjectId).toBeNull();
    } finally {
      for (const stop of stops) stop();
    }
  });
});

describe("a pipeline launched on the command scope, observed from a second scope", () => {
  test("keeps independent state, markers and transcript watches per scope", async () => {
    const launched = buildPipelineFixture({ id: "pipeline-1", phase: "building" });
    const { a, b, clientA, clientB } = twoScopes(
      { get_build_pipeline: record(launched, 4) },
      { get_build_pipeline: null },
    );
    // The command scope launches (installs the backend's answer) and re-reads.
    a.store(buildPipelineStore)
      .getState()
      .replacePipeline({ ...launched, backendRevision: 3 });
    const unwatch = watchBuildPipelineTranscript("pipeline-1", "build-key", a);
    expect(await hydrateBuildPipeline("pipeline-1", undefined, {}, a)).toMatchObject({
      id: "pipeline-1",
      backendRevision: 4,
    });

    // The second scope asks its own node, which holds no such pipeline.
    expect(await hydrateBuildPipeline("pipeline-1", undefined, {}, b)).toBeNull();
    expect(clientA.calls("get_build_pipeline")).toHaveLength(1);
    expect(clientB.calls("get_build_pipeline")).toHaveLength(1);

    expect(
      a.store(buildPipelineStore).getState().pipelines.get("pipeline-1")?.backendRevision,
    ).toBe(4);
    expect(a.store(buildPipelineStore).getState().activeBuildEnvironmentIds.has("env-1")).toBe(
      true,
    );
    expect(b.store(buildPipelineStore).getState().pipelines.size).toBe(0);
    expect(b.store(buildPipelineStore).getState().isBuildEnvironment("env-1")).toBe(false);
    expect(isBuildPipelineKnownUnavailable("pipeline-1", a)).toBe(false);
    expect(isBuildPipelineKnownUnavailable("pipeline-1", b)).toBe(true);
    expect(buildPipelineChangeReadOptions("pipeline-1", a)).toEqual({
      transcripts: true,
      prioritySessionKey: "build-key",
    });
    expect(buildPipelineChangeReadOptions("pipeline-1", b)).toEqual({});
    unwatch();
    expect(buildPipelineChangeReadOptions("pipeline-1", a)).toEqual({});

    // Removing it on one node leaves the other's projection alone.
    b.store(buildPipelineStore)
      .getState()
      .replacePipeline({ ...launched, id: "pipeline-b" });
    a.store(buildPipelineStore).getState().removePipelinesForEnvironment("env-1");
    expect(a.store(buildPipelineStore).getState().pipelines.size).toBe(0);
    expect(b.store(buildPipelineStore).getState().pipelines.has("pipeline-b")).toBe(true);
  });

  test("a pending tab activation waits on its own scope's pipelines", async () => {
    const { a, b } = twoScopes(
      { get_build_pipeline: null },
      { get_build_pipeline: null, get_environment: null },
    );
    scheduleBuildPipelineTabActivation("project-1", "pipeline-1", undefined, b);
    await Promise.resolve();
    // The pipeline arriving on the other node does not resolve it.
    a.store(buildPipelineStore)
      .getState()
      .replacePipeline(buildPipelineFixture({ id: "pipeline-1", environmentId: "env-a" }));
    expect(a.store(buildPipelineStore).getState().pipelines.has("pipeline-1")).toBe(true);
    expect(b.store(buildPipelineStore).getState().pipelines.has("pipeline-1")).toBe(false);
    // Disposing the scope stops its subscription (nothing to assert beyond no throw).
    windowScope?.dispose();
    windowScope = null;
  });
});

describe("disposing a scope stops what its stores started", () => {
  test("a retained coordinator projection leaves no hint subscription or timer", async () => {
    const { b, clientB } = twoScopes(
      {},
      {
        [COORDINATOR_ACTIVITY_COMMAND]: { projects: {} },
        [COORDINATOR_LAUNCH_OVERRIDES_COMMAND]: { overrides: [] },
      },
    );
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const live = new Set<ReturnType<typeof setTimeout>>();
    globalThis.setTimeout = ((callback: () => void, ms?: number) => {
      const handle = realSetTimeout(() => {
        live.delete(handle);
        callback();
      }, ms);
      live.add(handle);
      return handle;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
      live.delete(handle);
      realClearTimeout(handle);
    }) as typeof clearTimeout;
    try {
      b.store(coordinatorActivityStore).getState().retain();
      b.store(coordinatorLaunchOverrideStore).getState().retain();
      await new Promise((resolve) => realSetTimeout(resolve, 0));
      // A safety check on this node schedules each store's coalesced read.
      requestViewSafetyChecks("interval", b);
      expect(live.size).toBe(2);
      // The activity store listens for this node's observation announcements.
      expect(clientB.listenerCount()).toBeGreaterThan(0);
      windowScope?.dispose();
      windowScope = null;
      expect(live.size).toBe(0);
    } finally {
      for (const handle of live) realClearTimeout(handle);
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });
});
