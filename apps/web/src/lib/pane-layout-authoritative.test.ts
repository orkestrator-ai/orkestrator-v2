import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Environment } from "@/types";

// These hydrators have their own test files. Snapshot and restore per the Bun
// mock rules in AGENTS.md so a non-isolated run does not leave them faked.
import * as realBuildPipeline from "@/lib/build-pipeline-persistence";
import * as realMultiReview from "@/lib/multi-review-persistence";

const realModules = {
  "@/lib/build-pipeline-persistence": { ...realBuildPipeline },
  "@/lib/multi-review-persistence": { ...realMultiReview },
};

afterAll(() => {
  for (const [path, module] of Object.entries(realModules)) {
    mock.module(path, () => module);
  }
});

const hydrateBuildPipeline = mock(async (_id: string) => null as unknown);
const hydrateMultiReviewWorkflow = mock(async (_id: string) => undefined);
const unavailablePipelines = new Set<string>();
const unavailableWorkflows = new Set<string>();
const isBuildPipelineKnownUnavailable = (id: string) => unavailablePipelines.has(id);
const isMultiReviewWorkflowKnownUnavailable = (id: string) => unavailableWorkflows.has(id);

mock.module("@/lib/build-pipeline-persistence", () => ({
  hydrateBuildPipeline,
  isBuildPipelineKnownUnavailable,
}));
mock.module("@/lib/multi-review-persistence", () => ({
  hydrateMultiReviewWorkflow,
  isMultiReviewWorkflowKnownUnavailable,
}));

const {
  armBuildPipelineTabActivation,
  armStartupAgentTabActivation,
  cancelPaneTabActivation,
  flushPaneTabActivation,
  clearBuildPipelineTabActivation,
  collectPaneDependencyIds,
  commitBuildPipelineSetupHandoff,
  commitStartupAgentSetupHandoff,
  hydratePaneLayoutDependencies,
  reconcileAuthoritativePaneLayout,
  requestPaneTabActivation,
} = await import("./pane-layout-authoritative");
const { buildPipelineStore } = await import("@/stores/buildPipelineStore");
const { appCommandStore } = await import("@/test/app-command-store");
const { environmentStore } = await import("@/stores/environmentStore");
const { multiReviewStore } = await import("@/stores/multiReviewStore");
const { paneLayoutStore } = await import("@/stores/paneLayoutStore");
const { LEGACY_PANE_LAYOUT_VERSION, PANE_LAYOUT_VERSION } = await import("@/types/paneLayout");
const {
  consumeWindowStartupAgentActivation,
  getWindowBuildPipelineActivation,
  hasWindowBuildPipelineHandoffResolved,
  hasWindowStartupAgentActivation,
  markWindowBuildPipelineHandoffResolved,
} = await import("./pane-selection-storage");
const { STARTUP_AGENT_TAB_ID } = await import("@/lib/startup-agent-handoff");

type PaneNode = import("@/types/paneLayout").PaneNode;
type PersistedPaneLayout = import("@/types/paneLayout").PersistedPaneLayout;
type EnvironmentPaneState = import("@/stores/paneLayoutStore").EnvironmentPaneState;

function leaf(id: string, tabs: PaneNode extends { kind: "leaf" } ? never : unknown[]): PaneNode {
  return {
    kind: "leaf",
    id,
    tabs: tabs as never,
    activeTabId: (tabs[0] as { id?: string } | undefined)?.id ?? null,
  } as PaneNode;
}

function split(left: PaneNode, right: PaneNode): PaneNode {
  return {
    kind: "split",
    id: "split",
    direction: "horizontal",
    children: [left, right],
    sizes: [50, 50],
    depth: 1,
  } as PaneNode;
}

function findLeafForTest(root: PaneNode, id: string): Extract<PaneNode, { kind: "leaf" }> | null {
  if (root.kind === "leaf") return root.id === id ? root : null;
  return findLeafForTest(root.children[0], id) ?? findLeafForTest(root.children[1], id);
}

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "env-1",
    name: "env-1",
    projectId: "project-1",
    status: "running",
    environmentType: "docker",
    containerId: "container-1",
    branch: "main",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  } as Environment;
}

function persisted(
  root: PaneNode,
  containerId: string | null = "container-1",
): PersistedPaneLayout {
  return {
    version: PANE_LAYOUT_VERSION,
    environmentId: "env-1",
    containerId,
    activePaneId: "default",
    root,
    updatedAt: "2026-01-01T00:00:00.000Z",
    revision: 4,
  };
}

function paneState(
  root: PaneNode,
  containerId: string | null = "container-1",
): EnvironmentPaneState {
  return { root, activePaneId: "default", containerId };
}

beforeEach(() => {
  localStorage.clear();
  hydrateBuildPipeline.mockClear();
  hydrateMultiReviewWorkflow.mockClear();
  unavailablePipelines.clear();
  unavailableWorkflows.clear();
  appCommandStore(environmentStore).setState({ environments: [environment()] });
  appCommandStore(buildPipelineStore).setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
  });
  appCommandStore(multiReviewStore).setState({ workflows: new Map() });
  appCommandStore(paneLayoutStore).setState({
    environments: new Map(),
    hydration: new Map(),
    activeEnvironmentId: null,
  });
});

describe("collectPaneDependencyIds", () => {
  test("hydrates and selects a backend Multi Review action on reconciliation and reload", async () => {
    const root = leaf("default", [
      { id: "plain", type: "plain" },
      {
        id: "multi-review:action-1",
        type: "multi-review",
        multiReviewTabData: { environmentId: "env-1", workflowId: "action-1", isLocal: false },
      },
    ]);
    if (root.kind !== "leaf") throw new Error("expected leaf");
    root.activeTabId = "multi-review:action-1";
    hydrateMultiReviewWorkflow.mockImplementation(async (id) => {
      appCommandStore(multiReviewStore)
        .getState()
        .replaceWorkflow({ id, environmentId: "env-1", backendRevision: 3 } as never);
    });
    for (let reconnect = 0; reconnect < 2; reconnect += 1) {
      // A new client has missed both creation events. Dependency hydration must
      // precede layout reconciliation or the only visible review tab is dropped.
      appCommandStore(multiReviewStore).setState({ workflows: new Map() });
      await hydratePaneLayoutDependencies(root);
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(root),
        paneState(leaf("default", [{ id: "plain", type: "plain" }])),
      );
      expect(restored?.root).toMatchObject({
        activeTabId: "multi-review:action-1",
        tabs: [{ id: "plain" }, { id: "multi-review:action-1", type: "multi-review" }],
      });
      expect(
        appCommandStore(multiReviewStore).getState().workflows.get("action-1")?.backendRevision,
      ).toBe(3);
    }
  });
  test("finds ids in a leaf", () => {
    const root = leaf("default", [
      { id: "build", type: "claude-build", buildTabData: { pipelineId: "pipeline-1" } },
      { id: "review", type: "multi-review", multiReviewTabData: { workflowId: "workflow-1" } },
      { id: "plain", type: "plain" },
    ]);

    expect(collectPaneDependencyIds(root)).toEqual({
      pipelineIds: new Set(["pipeline-1"]),
    });
  });

  test("descends through splits", () => {
    // A dependency-carrying tab in a split pane is the ordinary case once a
    // user has split their layout, and it is invisible to a leaf-only scan.
    const root = split(
      split(
        leaf("a", [
          { id: "b1", type: "claude-build", buildTabData: { pipelineId: "deep-pipeline" } },
        ]),
        leaf("b", [
          { id: "r1", type: "multi-review", multiReviewTabData: { workflowId: "deep-workflow" } },
        ]),
      ),
      leaf("c", [
        { id: "b2", type: "claude-build", buildTabData: { pipelineId: "other-pipeline" } },
      ]),
    );

    expect(collectPaneDependencyIds(root)).toEqual({
      pipelineIds: new Set(["deep-pipeline", "other-pipeline"]),
    });
  });

  test("stops at the depth bound instead of recursing without limit", () => {
    const nest = (depth: number): PaneNode => {
      let node = leaf("deepest", [
        { id: "b", type: "claude-build", buildTabData: { pipelineId: "deep" } },
      ]);
      for (let level = 0; level < depth; level += 1) {
        node = split(node, leaf(`sibling-${level}`, []));
      }
      return node;
    };

    // MAX_SPLIT_DEPTH is 9, so anything the restore path accepts is still
    // scanned; only a record deeper than any legal layout is truncated.
    expect(collectPaneDependencyIds(nest(9)).pipelineIds).toEqual(new Set(["deep"]));
    expect(collectPaneDependencyIds(nest(12)).pipelineIds).toEqual(new Set<string>());
  });

  test("ignores malformed nodes, tabs, and ids", () => {
    const empty = {
      pipelineIds: new Set<string>(),
    };
    expect(collectPaneDependencyIds(null)).toEqual(empty);
    expect(collectPaneDependencyIds(undefined)).toEqual(empty);
    expect(collectPaneDependencyIds("leaf")).toEqual(empty);
    expect(collectPaneDependencyIds([{ kind: "leaf" }])).toEqual(empty);
    expect(collectPaneDependencyIds({ kind: "leaf", tabs: "nope" })).toEqual(empty);
    expect(collectPaneDependencyIds({ kind: "split", children: "nope" })).toEqual(empty);
    expect(collectPaneDependencyIds({ kind: "mystery", tabs: [] })).toEqual(empty);
    expect(
      collectPaneDependencyIds({
        kind: "leaf",
        tabs: [
          null,
          "tab",
          ["tab"],
          { id: "a", buildTabData: "nope" },
          { id: "b", buildTabData: { pipelineId: 7 } },
          { id: "c", buildTabData: { pipelineId: "   " } },
        ],
      }),
    ).toEqual(empty);
  });
});

describe("hydratePaneLayoutDependencies", () => {
  test("does not re-read a pipeline or review a point read already found missing", async () => {
    const root = leaf("default", [
      { id: "build", type: "claude-build", buildTabData: { pipelineId: "gone-pipeline" } },
      { id: "review", type: "multi-review", multiReviewTabData: { workflowId: "gone-review" } },
      { id: "live", type: "claude-build", buildTabData: { pipelineId: "live-pipeline" } },
    ]);
    unavailablePipelines.add("gone-pipeline");
    unavailableWorkflows.add("gone-review");

    await hydratePaneLayoutDependencies(root);

    expect(hydrateBuildPipeline.mock.calls.map(([id]) => id)).toEqual(["live-pipeline"]);
    expect(hydrateMultiReviewWorkflow).not.toHaveBeenCalled();
  });

  test("runs at most four dependency reads at once", async () => {
    const root = leaf(
      "default",
      Array.from({ length: 10 }, (_, index) => ({
        id: `build-${index}`,
        type: "claude-build",
        buildTabData: { pipelineId: `pipeline-${index}` },
      })),
    );
    let inFlight = 0;
    let peak = 0;
    hydrateBuildPipeline.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return null;
    });
    try {
      await hydratePaneLayoutDependencies(root);
    } finally {
      hydrateBuildPipeline.mockImplementation(async () => null);
    }
    expect(hydrateBuildPipeline).toHaveBeenCalledTimes(10);
    expect(peak).toBe(4);
  });

  test("hydrates a persisted pipeline pass before reconciliation, including on reload", async () => {
    const root = leaf("default", [
      {
        id: "pipeline-pass",
        type: "multi-review",
        multiReviewTabData: {
          environmentId: "env-1",
          workflowId: "pipeline-1",
          pipelinePass: "review-pass-1",
          isLocal: true,
        },
      },
    ]);
    for (let reload = 0; reload < 2; reload++) {
      appCommandStore(buildPipelineStore).setState({ pipelines: new Map() });
      hydrateBuildPipeline.mockImplementationOnce(async (id) => {
        appCommandStore(buildPipelineStore).setState({
          pipelines: new Map([[id, { id, environmentId: "env-1" } as never]]),
        });
      });
      expect([...collectPaneDependencyIds(root).pipelineIds]).toEqual(["pipeline-1"]);
      await hydratePaneLayoutDependencies(root);
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(root),
        paneState(leaf("default", [{ id: "plain", type: "plain" }])),
      );
      expect(restored?.root).toMatchObject({
        tabs: [{ id: "pipeline-pass", multiReviewTabData: { pipelinePass: "review-pass-1" } }],
      });
    }
    expect(hydrateBuildPipeline.mock.calls.map(([id]) => id)).toEqual(["pipeline-1", "pipeline-1"]);
    expect(hydrateMultiReviewWorkflow).not.toHaveBeenCalled();
  });

  test("hydrates a standalone key-information tab on cold restore and reload", async () => {
    const root = leaf("default", [
      {
        id: "brief",
        type: "key-information",
        keyInformationTabData: { environmentId: "env-1", pipelineId: "pipeline-1" },
      },
    ]);
    for (let reload = 0; reload < 2; reload++) {
      appCommandStore(buildPipelineStore).setState({ pipelines: new Map() });
      hydrateBuildPipeline.mockImplementationOnce(async (id) => {
        appCommandStore(buildPipelineStore).setState({
          pipelines: new Map([[id, { id, environmentId: "env-1" } as never]]),
        });
      });
      await hydratePaneLayoutDependencies(root);
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(root),
        paneState(leaf("default", [{ id: "plain", type: "plain" }])),
      );
      expect(restored?.root).toMatchObject({ tabs: [{ id: "brief", type: "key-information" }] });
    }
    expect(hydrateBuildPipeline.mock.calls.map(([id]) => id)).toEqual(["pipeline-1", "pipeline-1"]);
  });

  test("notes and brief survive serialization and authoritative cold reload", async () => {
    const { createPersistedPaneLayoutInput } = await import("./pane-layout-persistence");
    const root = leaf("default", [
      {
        id: "brief",
        type: "key-information",
        keyInformationTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
        },
      },
      {
        id: "notes",
        type: "key-information",
        keyInformationTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
          view: "notes",
        },
      },
    ]);
    if (root.kind !== "leaf") throw new Error("expected leaf");
    root.activeTabId = "notes";
    let state = paneState(root);
    for (let reload = 0; reload < 2; reload++) {
      const saved = JSON.parse(
        JSON.stringify({
          ...persisted(root),
          ...createPersistedPaneLayoutInput(state),
        }),
      );
      appCommandStore(buildPipelineStore).setState({ pipelines: new Map() });
      hydrateBuildPipeline.mockImplementationOnce(async (id) => {
        appCommandStore(buildPipelineStore).setState({
          pipelines: new Map([[id, { id, environmentId: "env-1" } as never]]),
        });
      });
      await hydratePaneLayoutDependencies(saved.root);
      state = reconcileAuthoritativePaneLayout(
        "env-1",
        saved,
        paneState(leaf("default", [{ id: "plain", type: "plain" }])),
      )!;
      expect(state.root).toEqual(root);
    }
    expect(hydrateBuildPipeline.mock.calls.map(([id]) => id)).toEqual(["pipeline-1", "pipeline-1"]);
  });

  test("loads only the records this client is missing", async () => {
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map([["known-pipeline", {} as never]]),
      buildEnvironmentIds: new Set(),
    });
    const root = split(
      leaf("a", [
        { id: "b1", type: "claude-build", buildTabData: { pipelineId: "known-pipeline" } },
        { id: "b2", type: "claude-build", buildTabData: { pipelineId: "missing-pipeline" } },
      ]),
      leaf("b", [
        { id: "m1", type: "multi-review", multiReviewTabData: { workflowId: "missing-multi" } },
      ]),
    );

    await hydratePaneLayoutDependencies(root);

    expect(hydrateBuildPipeline.mock.calls.map(([id]) => id)).toEqual(["missing-pipeline"]);
    expect(hydrateMultiReviewWorkflow.mock.calls.map(([id]) => id)).toEqual(["missing-multi"]);
  });

  test("does no work when the snapshot references nothing", async () => {
    await hydratePaneLayoutDependencies(leaf("default", [{ id: "plain", type: "plain" }]));

    expect(hydrateBuildPipeline).not.toHaveBeenCalled();
    expect(hydrateMultiReviewWorkflow).not.toHaveBeenCalled();
  });

  test("propagates a hydration failure so callers can skip the install", async () => {
    hydrateBuildPipeline.mockImplementationOnce(async () => {
      throw new Error("backend down");
    });
    const root = leaf("default", [
      { id: "b", type: "claude-build", buildTabData: { pipelineId: "missing" } },
    ]);

    await expect(hydratePaneLayoutDependencies(root)).rejects.toThrow("backend down");
  });
});

describe("reconcileAuthoritativePaneLayout", () => {
  const plainRoot = leaf("default", [
    { id: "tab-1", type: "plain" },
    { id: "tab-2", type: "plain" },
  ]);

  test("does not arm a renderer-local startup handoff in a browser client", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: undefined,
    });
    try {
      armStartupAgentTabActivation("env-1");

      expect(consumeWindowStartupAgentActivation("env-1")).toBe(false);
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("installs the backend tree and its selection", () => {
    const current = paneState(leaf("default", [{ id: "tab-2", type: "plain" }]));
    current.root = { ...current.root, activeTabId: "tab-2" } as PaneNode;

    const restored = reconcileAuthoritativePaneLayout("env-1", persisted(plainRoot), current);

    expect(restored).not.toBeNull();
    expect(restored!.backendRevision).toBe(4);
    expect((restored!.root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id)).toEqual([
      "tab-1",
      "tab-2",
    ]);
    expect((restored!.root as { activeTabId: string }).activeTabId).toBe("tab-1");
  });

  test("preserves pane selection inside an isolated Electron window", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      const currentRoot = leaf("default", [
        { id: "tab-1", type: "plain" },
        { id: "tab-2", type: "plain" },
      ]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "tab-2";

      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(plainRoot),
        paneState(currentRoot),
      );

      expect(restored?.root).toMatchObject({ activeTabId: "tab-2" });
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("hands the launching Electron window from setup to its pipeline tab", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "running", setupScriptsComplete: false })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([["pipeline-1", {} as never]]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const setupTab = { id: "setup", type: "plain" as const, isSetupTab: true };
      const buildTab = {
        id: "build-pipeline-1",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
          taskId: "task-1",
          isLocal: false,
        },
      };
      const currentRoot = leaf("default", [setupTab, buildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "setup";
      const backendRoot = leaf("default", [setupTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-1";

      armBuildPipelineTabActivation("env-1", "pipeline-1");
      const beforeSetupCompletes = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );
      expect(beforeSetupCompletes?.root).toMatchObject({ activeTabId: "setup" });
      expect(getWindowBuildPipelineActivation("env-1")).toBe("pipeline-1");
      if (!beforeSetupCompletes) throw new Error("expected a pending layout");

      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      const handedOff = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        beforeSetupCompletes,
      );

      expect(handedOff?.root).toMatchObject({ activeTabId: "build-pipeline-1" });
      expect(getWindowBuildPipelineActivation("env-1")).toBe("pipeline-1");
      if (!handedOff) throw new Error("expected a handed-off layout");
      commitBuildPipelineSetupHandoff("env-1", handedOff);
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("does not arm or apply a renderer-local pipeline handoff in a browser client", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: undefined,
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([["pipeline-1", {} as never]]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const setupTab = { id: "setup", type: "plain" as const, isSetupTab: true };
      const buildTab = {
        id: "build-pipeline-1",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
          taskId: "task-1",
          isLocal: false,
        },
      };
      const currentRoot = leaf("default", [setupTab, buildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "setup";
      const backendRoot = leaf("default", [setupTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-1";

      armBuildPipelineTabActivation("env-1", "pipeline-1");
      clearBuildPipelineTabActivation("env-1");
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();

      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );
      expect(restored?.root).toMatchObject({ activeTabId: "build-pipeline-1" });
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("does not steal focus from another tab when the pipeline becomes ready", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "running", setupScriptsComplete: false })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([["pipeline-1", {} as never]]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const setupTab = { id: "setup", type: "plain" as const, isSetupTab: true };
      const otherTab = { id: "notes", type: "plain" as const };
      const buildTab = {
        id: "build-pipeline-1",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
          taskId: "task-1",
          isLocal: false,
        },
      };
      const setupRoot = leaf("default", [setupTab, otherTab, buildTab]);
      if (setupRoot.kind !== "leaf") throw new Error("expected leaf");
      setupRoot.activeTabId = "setup";
      const notesRoot = leaf("default", [setupTab, otherTab, buildTab]);
      if (notesRoot.kind !== "leaf") throw new Error("expected leaf");
      notesRoot.activeTabId = "notes";
      const backendRoot = leaf("default", [setupTab, otherTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-1";

      armBuildPipelineTabActivation("env-1", "pipeline-1");
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(notesRoot),
      );
      if (!restored) throw new Error("expected a restored layout");

      expect(restored.root).toMatchObject({ activeTabId: "notes" });
      commitBuildPipelineSetupHandoff("env-1", restored);
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("activates a rebuild pipeline tab on an already-ready environment", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([
          ["pipeline-old", {} as never],
          ["pipeline-new", {} as never],
        ]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const previousBuildTab = {
        id: "build-pipeline-old",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-old",
          taskId: "task-old",
          isLocal: false,
        },
      };
      const newBuildTab = {
        id: "build-pipeline-new",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-new",
          taskId: "task-new",
          isLocal: false,
        },
      };
      const currentRoot = leaf("default", [previousBuildTab, newBuildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "build-pipeline-old";
      const backendRoot = leaf("default", [previousBuildTab, newBuildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-new";

      armBuildPipelineTabActivation("env-1", "pipeline-new");
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );
      if (!restored) throw new Error("expected a restored layout");

      expect(restored.root).toMatchObject({ activeTabId: "build-pipeline-new" });
      commitBuildPipelineSetupHandoff("env-1", restored);
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("does not activate a different pipeline's tab while another pipeline is armed", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([
          ["pipeline-1", {} as never],
          ["pipeline-2", {} as never],
        ]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const setupTab = { id: "setup", type: "plain" as const, isSetupTab: true };
      const firstBuildTab = {
        id: "build-pipeline-1",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
          taskId: "task-1",
          isLocal: false,
        },
      };
      const secondBuildTab = {
        id: "build-pipeline-2",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-2",
          taskId: "task-2",
          isLocal: false,
        },
      };
      const currentRoot = leaf("default", [setupTab, firstBuildTab, secondBuildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "setup";
      const backendRoot = leaf("default", [setupTab, firstBuildTab, secondBuildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-2";

      armBuildPipelineTabActivation("env-1", "pipeline-1");
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );
      if (!restored) throw new Error("expected a restored layout");

      expect(restored.root).toMatchObject({ activeTabId: "setup" });
      commitBuildPipelineSetupHandoff("env-1", restored);
      expect(getWindowBuildPipelineActivation("env-1")).toBe("pipeline-1");
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("keeps the pipeline handoff armed until the backend selects that tab", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([["pipeline-1", {} as never]]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const setupTab = { id: "setup", type: "plain" as const, isSetupTab: true };
      const buildTab = {
        id: "build-pipeline-1",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
          taskId: "task-1",
          isLocal: false,
        },
      };
      const currentRoot = leaf("default", [setupTab, buildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "setup";
      const backendRoot = leaf("default", [setupTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "setup";

      armBuildPipelineTabActivation("env-1", "pipeline-1");
      const awaitingSelection = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );
      if (!awaitingSelection) throw new Error("expected a pending layout");
      commitBuildPipelineSetupHandoff("env-1", awaitingSelection);
      expect(awaitingSelection.root).toMatchObject({ activeTabId: "setup" });
      expect(getWindowBuildPipelineActivation("env-1")).toBe("pipeline-1");

      const selectedRoot = leaf("default", [setupTab, buildTab]);
      if (selectedRoot.kind !== "leaf") throw new Error("expected leaf");
      selectedRoot.activeTabId = "build-pipeline-1";
      const handedOff = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(selectedRoot),
        awaitingSelection,
      );
      if (!handedOff) throw new Error("expected a handed-off layout");
      expect(handedOff.root).toMatchObject({ activeTabId: "build-pipeline-1" });
      commitBuildPipelineSetupHandoff("env-1", handedOff);
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("immediately activates a rebuild pipeline tab from a previous build tab", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      const previousBuildTab = {
        id: "build-pipeline-old",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-old",
          taskId: "task-old",
          isLocal: false,
        },
      };
      const newBuildTab = {
        id: "build-pipeline-new",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-new",
          taskId: "task-new",
          isLocal: false,
        },
      };
      const currentRoot = leaf("default", [previousBuildTab, newBuildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "build-pipeline-old";
      appCommandStore(paneLayoutStore).setState({
        environments: new Map([["env-1", paneState(currentRoot)]]),
        hydration: new Map([["env-1", "done"]]),
        activeEnvironmentId: "env-1",
      });

      armBuildPipelineTabActivation("env-1", "pipeline-new");

      expect(
        appCommandStore(paneLayoutStore).getState().getPane("default", "env-1")?.activeTabId,
      ).toBe("build-pipeline-new");
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-new")).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("lets a pipeline start win over the startup-agent handoff in the same frame", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "running", setupScriptsComplete: false })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([["pipeline-1", {} as never]]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const setupTab = { id: "setup", type: "plain" as const, isSetupTab: true };
      const agentTab = {
        id: "startup-agent",
        type: "agent-native" as const,
        nativeAgentData: {
          environmentId: "env-1",
          platform: "codex" as const,
          sessionId: "provider-session",
        },
      };
      const buildTab = {
        id: "build-pipeline-1",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
          taskId: "task-1",
          isLocal: false,
        },
      };
      const currentRoot = leaf("default", [setupTab, agentTab, buildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "setup";
      const backendRoot = leaf("default", [setupTab, agentTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-1";

      armStartupAgentTabActivation("env-1");
      armBuildPipelineTabActivation("env-1", "pipeline-1");
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );
      if (!restored) throw new Error("expected a restored layout");

      expect(restored.root).toMatchObject({ activeTabId: "build-pipeline-1" });
      commitBuildPipelineSetupHandoff("env-1", restored);
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("still activates the pipeline after an automatic startup-agent landing", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "running", setupScriptsComplete: false })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([["pipeline-1", {} as never]]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const setupTab = { id: "setup", type: "plain" as const, isSetupTab: true };
      const agentTab = {
        id: "startup-agent",
        type: "agent-native" as const,
        nativeAgentData: {
          environmentId: "env-1",
          platform: "codex" as const,
          sessionId: "provider-session",
        },
      };
      const buildTab = {
        id: "build-pipeline-1",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
          taskId: "task-1",
          isLocal: false,
        },
      };
      const setupRoot = leaf("default", [setupTab, agentTab, buildTab]);
      if (setupRoot.kind !== "leaf") throw new Error("expected leaf");
      setupRoot.activeTabId = "setup";
      const agentRoot = leaf("default", [setupTab, agentTab, buildTab]);
      if (agentRoot.kind !== "leaf") throw new Error("expected leaf");
      agentRoot.activeTabId = "startup-agent";
      const pipelineRoot = leaf("default", [setupTab, agentTab, buildTab]);
      if (pipelineRoot.kind !== "leaf") throw new Error("expected leaf");
      pipelineRoot.activeTabId = "build-pipeline-1";

      armStartupAgentTabActivation("env-1");
      armBuildPipelineTabActivation("env-1", "pipeline-1");
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      const afterAgent = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(agentRoot),
        paneState(setupRoot),
      );
      if (!afterAgent) throw new Error("expected a startup-agent layout");
      expect(afterAgent.root).toMatchObject({ activeTabId: "startup-agent" });
      expect(getWindowBuildPipelineActivation("env-1")).toBe("pipeline-1");

      const handedOff = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(pipelineRoot),
        afterAgent,
      );
      if (!handedOff) throw new Error("expected a handed-off layout");
      expect(handedOff.root).toMatchObject({ activeTabId: "build-pipeline-1" });
      commitBuildPipelineSetupHandoff("env-1", handedOff);
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("does not steal split-pane focus when the user selected a non-setup pipeline pane", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "running", setupScriptsComplete: false })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([["pipeline-1", {} as never]]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const setupTab = { id: "setup", type: "plain" as const, isSetupTab: true };
      const buildTab = {
        id: "build-pipeline-1",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
          taskId: "task-1",
          isLocal: false,
        },
      };
      const pipelinePane = leaf("pipeline-pane", [setupTab, buildTab]);
      const notesPane = leaf("notes-pane", [{ id: "notes", type: "plain" as const }]);
      if (pipelinePane.kind !== "leaf") throw new Error("expected pipeline leaf");
      pipelinePane.activeTabId = "setup";
      const current = paneState(split(pipelinePane, notesPane));
      current.activePaneId = "notes-pane";

      const authoritativePipelinePane = leaf("pipeline-pane", [setupTab, buildTab]);
      if (authoritativePipelinePane.kind !== "leaf") throw new Error("expected pipeline leaf");
      authoritativePipelinePane.activeTabId = "build-pipeline-1";
      const saved = persisted(split(authoritativePipelinePane, notesPane));
      saved.activePaneId = "pipeline-pane";

      armBuildPipelineTabActivation("env-1", "pipeline-1");
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      const restored = reconcileAuthoritativePaneLayout("env-1", saved, current);
      if (!restored) throw new Error("expected a restored layout");

      expect(restored.activePaneId).toBe("notes-pane");
      const restoredPipelinePane = findLeafForTest(restored.root, "pipeline-pane");
      expect(restoredPipelinePane?.activeTabId).toBe("setup");
      commitBuildPipelineSetupHandoff("env-1", restored);
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("immediately activates a pipeline tab when setup is already ready", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      const setupTab = { id: "setup", type: "plain" as const, isSetupTab: true };
      const buildTab = {
        id: "build-pipeline-1",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
          taskId: "task-1",
          isLocal: false,
        },
      };
      const currentRoot = leaf("default", [setupTab, buildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "setup";
      appCommandStore(paneLayoutStore).setState({
        environments: new Map([["env-1", paneState(currentRoot)]]),
        hydration: new Map([["env-1", "done"]]),
        activeEnvironmentId: "env-1",
      });

      armBuildPipelineTabActivation("env-1", "pipeline-1");

      expect(
        appCommandStore(paneLayoutStore).getState().getPane("default", "env-1")?.activeTabId,
      ).toBe("build-pipeline-1");
      expect(
        appCommandStore(paneLayoutStore).getState().environments.get("env-1")?.activePaneId,
      ).toBe("default");
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("leaves the immediate pipeline handoff armed when setActiveTab is a no-op", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    const originalSetActiveTab = appCommandStore(paneLayoutStore).getState().setActiveTab;
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      const setupTab = { id: "setup", type: "plain" as const, isSetupTab: true };
      const buildTab = {
        id: "build-pipeline-1",
        type: "claude-build" as const,
        buildTabData: {
          environmentId: "env-1",
          pipelineId: "pipeline-1",
          taskId: "task-1",
          isLocal: false,
        },
      };
      const currentRoot = leaf("default", [setupTab, buildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "setup";
      appCommandStore(paneLayoutStore).setState({
        environments: new Map([["env-1", paneState(currentRoot)]]),
        hydration: new Map([["env-1", "done"]]),
        activeEnvironmentId: "env-1",
        setActiveTab: () => {},
      });

      armBuildPipelineTabActivation("env-1", "pipeline-1");

      expect(
        appCommandStore(paneLayoutStore).getState().getPane("default", "env-1")?.activeTabId,
      ).toBe("setup");
      expect(getWindowBuildPipelineActivation("env-1")).toBe("pipeline-1");
    } finally {
      appCommandStore(paneLayoutStore).setState({ setActiveTab: originalSetActiveTab });
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("focuses a requested tab when the layout carrying it is installed", () => {
    const currentRoot = leaf("default", [{ id: "tab-1", type: "plain" }]);
    appCommandStore(paneLayoutStore).setState({
      environments: new Map([["env-1", paneState(currentRoot)]]),
    });
    requestPaneTabActivation("env-1", "agent-job-pr");

    flushPaneTabActivation("env-1");
    expect(
      appCommandStore(paneLayoutStore).getState().getActivePane("env-1")?.activeTabId,
    ).not.toBe("agent-job-pr");

    appCommandStore(paneLayoutStore).setState({
      environments: new Map([
        [
          "env-1",
          paneState(
            leaf("default", [
              { id: "tab-1", type: "plain" },
              { id: "agent-job-pr", type: "plain" },
            ]),
          ),
        ],
      ]),
    });
    flushPaneTabActivation("env-1");

    expect(appCommandStore(paneLayoutStore).getState().getActivePane("env-1")?.activeTabId).toBe(
      "agent-job-pr",
    );
  });

  test("hands an isolated Electron window from setup to its provider-bound startup agent", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      const setupTab = { id: "default", type: "plain" as const, isSetupTab: true };
      const pendingAgentTab = {
        id: "startup-agent",
        type: "agent-native" as const,
        nativeAgentData: { environmentId: "env-1", platform: "codex" as const },
      };
      const currentRoot = leaf("default", [setupTab, pendingAgentTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "default";

      const readyAgentTab = {
        ...pendingAgentTab,
        nativeAgentData: {
          ...pendingAgentTab.nativeAgentData,
          sessionId: "provider-session",
        },
      };
      const backendRoot = leaf("default", [setupTab, readyAgentTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "startup-agent";

      armStartupAgentTabActivation("env-1");
      const awaitingProvider = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(currentRoot),
        paneState(currentRoot),
      );
      expect(awaitingProvider?.root).toMatchObject({ activeTabId: "default" });
      if (!awaitingProvider) throw new Error("expected a pending layout");

      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        awaitingProvider,
      );

      expect(restored?.root).toMatchObject({ activeTabId: "startup-agent" });
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("hands an isolated Electron window from setup to a prompt-less startup agent", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      const setupTab = { id: "default", type: "plain" as const, isSetupTab: true };
      const promptlessAgentTab = {
        id: "startup-agent",
        type: "agent-native" as const,
        nativeAgentData: { environmentId: "env-1", isLocal: true },
        initialAgentPlatform: "cursor" as const,
      };
      const currentRoot = leaf("default", [setupTab, promptlessAgentTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "default";

      const backendRoot = leaf("default", [setupTab, promptlessAgentTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "startup-agent";

      armStartupAgentTabActivation("env-1");
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );

      expect(restored?.root).toMatchObject({ activeTabId: "startup-agent" });
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("does not hand a prompt-less startup agent focus before setup is ready", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "running", setupScriptsComplete: false })],
      });
      const setupTab = { id: "default", type: "plain" as const, isSetupTab: true };
      const promptlessAgentTab = {
        id: "startup-agent",
        type: "agent-native" as const,
        nativeAgentData: { environmentId: "env-1", isLocal: true },
      };
      const currentRoot = leaf("default", [setupTab, promptlessAgentTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "default";
      const backendRoot = leaf("default", [setupTab, promptlessAgentTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "startup-agent";

      armStartupAgentTabActivation("env-1");
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );

      expect(restored?.root).toMatchObject({ activeTabId: "default" });
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("does not retire a prompt-less activation on a setup-ready snapshot that still shows the setup tab", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      const setupTab = { id: "default", type: "plain" as const, isSetupTab: true };
      const promptlessAgentTab = {
        id: "startup-agent",
        type: "agent-native" as const,
        nativeAgentData: { environmentId: "env-1", isLocal: true },
        initialAgentPlatform: "cursor" as const,
      };
      const setupRoot = leaf("default", [setupTab, promptlessAgentTab]);
      if (setupRoot.kind !== "leaf") throw new Error("expected leaf");
      setupRoot.activeTabId = "default";
      const handedOffRoot = leaf("default", [setupTab, promptlessAgentTab]);
      if (handedOffRoot.kind !== "leaf") throw new Error("expected leaf");
      handedOffRoot.activeTabId = "startup-agent";

      armStartupAgentTabActivation("env-1");
      const awaitingHandoff = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(setupRoot),
        paneState(setupRoot),
      );
      expect(awaitingHandoff?.root).toMatchObject({ activeTabId: "default" });
      if (!awaitingHandoff) throw new Error("expected a pending layout");
      // Production commits as soon as the reconciled tree is installed. A
      // setup-ready snapshot that has not selected the agent must leave the
      // one-shot armed for the later handoff revision.
      commitStartupAgentSetupHandoff("env-1", awaitingHandoff);
      expect(hasWindowStartupAgentActivation("env-1")).toBe(true);

      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(handedOffRoot),
        awaitingHandoff,
      );

      expect(restored?.root).toMatchObject({ activeTabId: "startup-agent" });
      expect(hasWindowStartupAgentActivation("env-1")).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("does not steal focus from another tab when the startup agent becomes ready", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      const setupTab = { id: "default", type: "plain" as const, isSetupTab: true };
      const otherTab = { id: "notes", type: "plain" as const };
      const agentTab = {
        id: "startup-agent",
        type: "agent-native" as const,
        nativeAgentData: {
          environmentId: "env-1",
          platform: "codex" as const,
          sessionId: "provider-session",
        },
      };
      const currentRoot = leaf("default", [setupTab, otherTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "notes";
      const backendRoot = leaf("default", [setupTab, otherTab, agentTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "startup-agent";

      armStartupAgentTabActivation("env-1");
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );

      expect(restored?.root).toMatchObject({ activeTabId: "notes" });
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("does not reactivate a startup agent after its setup handoff was consumed", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      const setupTab = { id: "default", type: "plain" as const, isSetupTab: true };
      const agentTab = {
        id: "startup-agent",
        type: "agent-native" as const,
        nativeAgentData: {
          environmentId: "env-1",
          platform: "codex" as const,
          sessionId: "provider-session",
        },
      };
      const backendRoot = leaf("default", [setupTab, agentTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "startup-agent";
      const setupRoot = leaf("default", [setupTab, agentTab]);
      if (setupRoot.kind !== "leaf") throw new Error("expected leaf");
      setupRoot.activeTabId = "default";

      armStartupAgentTabActivation("env-1");
      const handedOff = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(setupRoot),
      );
      if (!handedOff) throw new Error("expected a restored layout");
      commitStartupAgentSetupHandoff("env-1", handedOff);
      const returnedToSetup = {
        ...handedOff,
        root: { ...handedOff.root, activeTabId: "default" } as PaneNode,
      };

      const restoredAgain = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        returnedToSetup,
      );

      expect(restoredAgain?.root).toMatchObject({ activeTabId: "default" });
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("does not steal split-pane focus when the user selected a non-setup tab", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    try {
      const setupTab = { id: "setup", type: "plain" as const, isSetupTab: true };
      const agentTab = {
        id: "startup-agent",
        type: "agent-native" as const,
        nativeAgentData: {
          environmentId: "env-1",
          platform: "codex" as const,
          sessionId: "provider-session",
        },
      };
      const agentPane = leaf("agent-pane", [setupTab, agentTab]);
      const notesPane = leaf("notes-pane", [{ id: "notes", type: "plain" as const }]);
      if (agentPane.kind !== "leaf") throw new Error("expected agent leaf");
      agentPane.activeTabId = "setup";
      const current = paneState(split(agentPane, notesPane));
      current.activePaneId = "notes-pane";

      const authoritativeAgentPane = leaf("agent-pane", [setupTab, agentTab]);
      if (authoritativeAgentPane.kind !== "leaf") throw new Error("expected agent leaf");
      authoritativeAgentPane.activeTabId = "startup-agent";
      const authoritativeRoot = split(authoritativeAgentPane, notesPane);
      const saved = persisted(authoritativeRoot);
      saved.activePaneId = "agent-pane";

      armStartupAgentTabActivation("env-1");
      const restored = reconcileAuthoritativePaneLayout("env-1", saved, current);

      expect(restored?.activePaneId).toBe("notes-pane");
      const restoredAgentPane = restored ? findLeafForTest(restored.root, "agent-pane") : null;
      expect(restoredAgentPane?.activeTabId).toBe("setup");
    } finally {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    }
  });

  test("the latest request holds, and cancelling it leaves the tab unfocused", () => {
    appCommandStore(paneLayoutStore).setState({
      environments: new Map([
        [
          "env-1",
          paneState(
            leaf("default", [
              { id: "tab-1", type: "plain" },
              { id: "terminal-job-run", type: "plain" },
              { id: "agent-job-push", type: "plain" },
            ]),
          ),
        ],
      ]),
    });
    const activeTab = () =>
      appCommandStore(paneLayoutStore).getState().getActivePane("env-1")?.activeTabId;
    const installed = activeTab();

    requestPaneTabActivation("env-1", "missing-older");
    requestPaneTabActivation("env-1", "agent-job-push");
    expect(activeTab()).toBe("agent-job-push");

    requestPaneTabActivation("env-1", "missing-newer");
    cancelPaneTabActivation("env-1");
    flushPaneTabActivation("env-1");
    expect(activeTab()).toBe("agent-job-push");
    expect(installed).not.toBe("agent-job-push");
  });

  describe("tabs arriving in a window that owns its selection", () => {
    let descriptor: PropertyDescriptor | undefined;
    beforeEach(() => {
      descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
      Object.defineProperty(window, "orkestrator", {
        configurable: true,
        value: { isolatedViewState: true },
      });
    });
    afterEach(() => {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    });
    const setupTab = { id: "default", type: "plain" as const, isSetupTab: true };
    const userTab = { id: "user-tab", type: "plain" as const };
    const jobTab = {
      id: "startup-agent",
      type: "agent-native" as const,
      nativeAgentData: { environmentId: "env-1", isLocal: true },
    };
    const selecting = (tabs: Parameters<typeof leaf>[1], activeTabId: string) => {
      const root = leaf("default", tabs);
      if (root.kind !== "leaf") throw new Error("expected leaf");
      root.activeTabId = activeTabId;
      return root;
    };

    test("the job tab takes focus from the setup terminal, even unarmed", () => {
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(selecting([setupTab, jobTab], "startup-agent")),
        paneState(selecting([setupTab], "default")),
      );

      expect(restored?.root).toMatchObject({ activeTabId: "startup-agent" });
    });

    test("the job tab leaves a tab the user opened during setup focused", () => {
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(selecting([setupTab, userTab, jobTab], "user-tab")),
        paneState(selecting([setupTab, userTab], "user-tab")),
      );

      expect(restored?.root).toMatchObject({ activeTabId: "user-tab" });
    });

    test("a setup terminal the backend selected takes focus when it first appears", () => {
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(selecting([setupTab, userTab], "default")),
        paneState(selecting([userTab], "user-tab")),
      );

      expect(restored?.root).toMatchObject({ activeTabId: "default" });
    });

    test("a window that went back to another tab is not pulled to a known setup terminal", () => {
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(selecting([setupTab, userTab], "default")),
        paneState(selecting([setupTab, userTab], "user-tab")),
      );

      expect(restored?.root).toMatchObject({ activeTabId: "user-tab" });
    });
  });

  test("does not treat a legacy record's canonical pointers as real focus", () => {
    const currentRoot = leaf("default", [
      { id: "tab-1", type: "plain" },
      { id: "tab-2", type: "plain" },
    ]);
    if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
    currentRoot.activeTabId = "tab-2";

    const restored = reconcileAuthoritativePaneLayout(
      "env-1",
      { ...persisted(plainRoot), version: LEGACY_PANE_LAYOUT_VERSION },
      paneState(currentRoot),
    );

    expect(restored?.root).toMatchObject({ activeTabId: "tab-2" });
  });

  test("refuses a snapshot for an environment this client no longer has", () => {
    appCommandStore(environmentStore).setState({ environments: [] });

    expect(
      reconcileAuthoritativePaneLayout("env-1", persisted(plainRoot), paneState(plainRoot)),
    ).toBeNull();
  });

  test("refuses a snapshot from another container generation", () => {
    // The pane state still points at the old container, so its tabs address
    // sessions that no longer exist.
    expect(
      reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(plainRoot),
        paneState(plainRoot, "container-old"),
      ),
    ).toBeNull();
  });

  test("refuses a snapshot reconciliation rejects", () => {
    expect(
      reconcileAuthoritativePaneLayout(
        "env-1",
        { ...persisted(plainRoot), version: PANE_LAYOUT_VERSION + 1 },
        paneState(plainRoot),
      ),
    ).toBeNull();
  });

  test("drops a tab whose backing record the backend no longer has", () => {
    const root = leaf("default", [
      { id: "plain", type: "plain" },
      { id: "build", type: "claude-build", buildTabData: { pipelineId: "gone" } },
    ]);

    const restored = reconcileAuthoritativePaneLayout("env-1", persisted(root), paneState(root));

    expect(restored).not.toBeNull();
    expect((restored!.root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id)).toEqual([
      "plain",
    ]);
  });

  test("restores a Multi Review tab only while its authoritative workflow exists", () => {
    const root = leaf("default", [
      { id: "plain", type: "plain" },
      { id: "multi", type: "multi-review", multiReviewTabData: { workflowId: "multi-1" } },
    ]);
    appCommandStore(multiReviewStore).setState({
      workflows: new Map([
        [
          "multi-1",
          {
            id: "multi-1",
          } as never,
        ],
      ]),
    });

    const restored = reconcileAuthoritativePaneLayout("env-1", persisted(root), paneState(root));
    expect((restored!.root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id)).toEqual([
      "plain",
      "multi",
    ]);

    appCommandStore(multiReviewStore).setState({ workflows: new Map() });
    const dropped = reconcileAuthoritativePaneLayout("env-1", persisted(root), paneState(root));
    expect((dropped!.root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id)).toEqual([
      "plain",
    ]);
  });

  test("resolves a local environment against a null container", () => {
    appCommandStore(environmentStore).setState({
      environments: [
        environment({
          environmentType: "local",
          containerId: null,
          worktreePath: "/tmp/worktree",
        }),
      ],
    });
    const root = leaf("default", [
      { id: "file", type: "file", fileData: { filePath: "src/index.ts" } },
    ]);

    const restored = reconcileAuthoritativePaneLayout(
      "env-1",
      persisted(root, null),
      paneState(root, null),
    );

    expect(restored).not.toBeNull();
    const tab = (restored!.root as { tabs: Array<{ fileData?: Record<string, unknown> }> }).tabs[0];
    expect(tab?.fileData).toMatchObject({
      filePath: "src/index.ts",
      isLocalEnvironment: true,
      worktreePath: "/tmp/worktree",
    });
  });
});

describe("backend-published pipeline handoff", () => {
  function isolatedWindow(): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(window, "orkestrator");
    Object.defineProperty(window, "orkestrator", {
      configurable: true,
      value: { isolatedViewState: true },
    });
    return () => {
      if (descriptor) Object.defineProperty(window, "orkestrator", descriptor);
      else delete window.orkestrator;
    };
  }

  function pipelineTabs(pipelineId = "pipeline-1") {
    const setupTab = { id: "setup", type: "plain" as const, isSetupTab: true };
    const buildTab = {
      id: `build-${pipelineId}`,
      type: "claude-build" as const,
      buildTabData: {
        environmentId: "env-1",
        pipelineId,
        taskId: `task-${pipelineId}`,
        isLocal: false,
      },
    };
    return { setupTab, buildTab };
  }

  function readyEnvironmentWithPipelines(...pipelineIds: string[]): void {
    appCommandStore(environmentStore).setState({
      environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
    });
    appCommandStore(buildPipelineStore).setState({
      pipelines: new Map(pipelineIds.map((pipelineId) => [pipelineId, {} as never])),
      buildEnvironmentIds: new Set(["env-1"]),
    });
  }

  test("moves a window that did not launch the pipeline onto the backend-selected tab", () => {
    const restore = isolatedWindow();
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([["pipeline-1", {} as never]]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const { setupTab, buildTab } = pipelineTabs();
      const currentRoot = leaf("default", [setupTab, buildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "setup";
      const backendRoot = leaf("default", [setupTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-1";

      // No armBuildPipelineTabActivation: the pipeline was started by an agent,
      // a coordinator or another client, so this window holds no one-shot.
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();

      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );
      if (!restored) throw new Error("expected a restored layout");
      expect(restored.root).toMatchObject({ activeTabId: "build-pipeline-1" });

      commitBuildPipelineSetupHandoff("env-1", restored);
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(true);
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
    } finally {
      restore();
    }
  });

  test("does not re-steal after an armed handoff was already consumed", () => {
    const restore = isolatedWindow();
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([["pipeline-1", {} as never]]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const { setupTab, buildTab } = pipelineTabs();
      const setupRoot = leaf("default", [setupTab, buildTab]);
      if (setupRoot.kind !== "leaf") throw new Error("expected leaf");
      setupRoot.activeTabId = "setup";
      const backendRoot = leaf("default", [setupTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-1";

      armBuildPipelineTabActivation("env-1", "pipeline-1");
      const first = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(setupRoot),
      );
      if (!first) throw new Error("expected a restored layout");
      expect(first.root).toMatchObject({ activeTabId: "build-pipeline-1" });
      commitBuildPipelineSetupHandoff("env-1", first);
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(true);

      // The user returns to the setup terminal while the backend still selects
      // the build tab. Consuming the armed one-shot must leave the window alone.
      const second = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(setupRoot),
      );
      if (!second) throw new Error("expected a restored layout");
      expect(second.root).toMatchObject({ activeTabId: "setup" });
    } finally {
      restore();
    }
  });

  test("does not re-steal focus after a deliberate return to the setup tab", () => {
    const restore = isolatedWindow();
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([["pipeline-1", {} as never]]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const { setupTab, buildTab } = pipelineTabs();
      const backendRoot = leaf("default", [setupTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-1";

      const setupRoot = leaf("default", [setupTab, buildTab]);
      if (setupRoot.kind !== "leaf") throw new Error("expected leaf");
      setupRoot.activeTabId = "setup";

      // First reconcile resolves the backend handoff and records it.
      const first = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(setupRoot),
      );
      if (!first) throw new Error("expected a restored layout");
      expect(first.root).toMatchObject({ activeTabId: "build-pipeline-1" });
      commitBuildPipelineSetupHandoff("env-1", first);

      // The user then clicks back to the setup terminal. The backend has not yet
      // observed that write, so the authoritative tree still selects the build
      // tab — the window must not yank them forward again.
      const second = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(setupRoot),
      );
      if (!second) throw new Error("expected a restored layout");
      expect(second.root).toMatchObject({ activeTabId: "setup" });
    } finally {
      restore();
    }
  });

  test("waits for setup readiness before stealing focus from a watched setup terminal", () => {
    const restore = isolatedWindow();
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "running", setupScriptsComplete: false })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([["pipeline-1", {} as never]]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const { setupTab, buildTab } = pipelineTabs();
      const currentRoot = leaf("default", [setupTab, buildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "setup";
      const backendRoot = leaf("default", [setupTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-1";

      const notReady = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );
      if (!notReady) throw new Error("expected a restored layout");
      expect(notReady.root).toMatchObject({ activeTabId: "setup" });
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(false);

      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      const ready = reconcileAuthoritativePaneLayout("env-1", persisted(backendRoot), notReady);
      if (!ready) throw new Error("expected a restored layout");
      expect(ready.root).toMatchObject({ activeTabId: "build-pipeline-1" });
    } finally {
      restore();
    }
  });

  test("does not follow a build tab merely because it is open, not authoritative", () => {
    const restore = isolatedWindow();
    try {
      appCommandStore(environmentStore).setState({
        environments: [environment({ setupPhase: "ready", setupScriptsComplete: true })],
      });
      appCommandStore(buildPipelineStore).setState({
        pipelines: new Map([["pipeline-1", {} as never]]),
        buildEnvironmentIds: new Set(["env-1"]),
      });
      const { setupTab, buildTab } = pipelineTabs();
      const currentRoot = leaf("default", [setupTab, buildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = "setup";
      const backendRoot = leaf("default", [setupTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "setup";

      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );
      if (!restored) throw new Error("expected a restored layout");
      expect(restored.root).toMatchObject({ activeTabId: "setup" });
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(false);
    } finally {
      restore();
    }
  });

  test("immediate ready-environment arm records a resolution and does not re-steal", () => {
    const restore = isolatedWindow();
    try {
      readyEnvironmentWithPipelines("pipeline-1");
      const { setupTab, buildTab } = pipelineTabs();
      const setupRoot = leaf("default", [setupTab, buildTab]);
      if (setupRoot.kind !== "leaf") throw new Error("expected leaf");
      setupRoot.activeTabId = "setup";
      const buildRoot = leaf("default", [setupTab, buildTab]);
      if (buildRoot.kind !== "leaf") throw new Error("expected leaf");
      buildRoot.activeTabId = "build-pipeline-1";
      appCommandStore(paneLayoutStore).setState({
        environments: new Map([["env-1", paneState(setupRoot)]]),
        hydration: new Map([["env-1", "done"]]),
        activeEnvironmentId: "env-1",
      });

      armBuildPipelineTabActivation("env-1", "pipeline-1");
      expect(
        appCommandStore(paneLayoutStore).getState().getPane("default", "env-1")?.activeTabId,
      ).toBe("build-pipeline-1");
      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(true);

      const second = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(buildRoot),
        paneState(setupRoot),
      );
      if (!second) throw new Error("expected a restored layout");
      expect(second.root).toMatchObject({ activeTabId: "setup" });
    } finally {
      restore();
    }
  });

  test("clearing a pending one-shot does not forget a resolved backend handoff", () => {
    const restore = isolatedWindow();
    try {
      readyEnvironmentWithPipelines("pipeline-1");
      const { setupTab, buildTab } = pipelineTabs();
      const setupRoot = leaf("default", [setupTab, buildTab]);
      if (setupRoot.kind !== "leaf") throw new Error("expected leaf");
      setupRoot.activeTabId = "setup";
      const backendRoot = leaf("default", [setupTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-1";

      const first = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(setupRoot),
      );
      if (!first) throw new Error("expected a restored layout");
      expect(first.root).toMatchObject({ activeTabId: "build-pipeline-1" });
      commitBuildPipelineSetupHandoff("env-1", first);
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(true);

      clearBuildPipelineTabActivation("env-1");
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(true);

      const second = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(setupRoot),
      );
      if (!second) throw new Error("expected a restored layout");
      expect(second.root).toMatchObject({ activeTabId: "setup" });
    } finally {
      restore();
    }
  });

  test("does not re-steal an earlier pipeline after a later one was followed", () => {
    const restore = isolatedWindow();
    try {
      readyEnvironmentWithPipelines("pipeline-1", "pipeline-2");
      markWindowBuildPipelineHandoffResolved("env-1", "pipeline-1");
      markWindowBuildPipelineHandoffResolved("env-1", "pipeline-2");
      const { setupTab, buildTab: firstBuildTab } = pipelineTabs("pipeline-1");
      const { buildTab: secondBuildTab } = pipelineTabs("pipeline-2");
      const setupRoot = leaf("default", [setupTab, firstBuildTab, secondBuildTab]);
      if (setupRoot.kind !== "leaf") throw new Error("expected leaf");
      setupRoot.activeTabId = "setup";
      const backendRoot = leaf("default", [setupTab, firstBuildTab, secondBuildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-1";

      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(setupRoot),
      );
      if (!restored) throw new Error("expected a restored layout");
      expect(restored.root).toMatchObject({ activeTabId: "setup" });
    } finally {
      restore();
    }
  });

  test("an unarmed window still follows a later backend-published pipeline", () => {
    const restore = isolatedWindow();
    try {
      readyEnvironmentWithPipelines("pipeline-1", "pipeline-2");
      const { setupTab, buildTab: firstBuildTab } = pipelineTabs("pipeline-1");
      const { buildTab: secondBuildTab } = pipelineTabs("pipeline-2");
      const setupRoot = leaf("default", [setupTab, firstBuildTab, secondBuildTab]);
      if (setupRoot.kind !== "leaf") throw new Error("expected leaf");
      setupRoot.activeTabId = "setup";
      const firstBackend = leaf("default", [setupTab, firstBuildTab, secondBuildTab]);
      if (firstBackend.kind !== "leaf") throw new Error("expected leaf");
      firstBackend.activeTabId = "build-pipeline-1";

      const first = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(firstBackend),
        paneState(setupRoot),
      );
      if (!first) throw new Error("expected a restored layout");
      expect(first.root).toMatchObject({ activeTabId: "build-pipeline-1" });
      commitBuildPipelineSetupHandoff("env-1", first);

      const secondBackend = leaf("default", [setupTab, firstBuildTab, secondBuildTab]);
      if (secondBackend.kind !== "leaf") throw new Error("expected leaf");
      secondBackend.activeTabId = "build-pipeline-2";
      const second = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(secondBackend),
        paneState(setupRoot),
      );
      if (!second) throw new Error("expected a restored layout");
      expect(second.root).toMatchObject({ activeTabId: "build-pipeline-2" });
      commitBuildPipelineSetupHandoff("env-1", second);
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(true);
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-2")).toBe(true);
    } finally {
      restore();
    }
  });

  test("does not pull an unarmed window off a user-chosen startup-agent tab", () => {
    const restore = isolatedWindow();
    try {
      readyEnvironmentWithPipelines("pipeline-1");
      const { setupTab, buildTab } = pipelineTabs();
      const agentTab = {
        id: STARTUP_AGENT_TAB_ID,
        type: "agent-native" as const,
        nativeAgentData: {
          environmentId: "env-1",
          platform: "codex" as const,
          sessionId: "provider-session",
        },
      };
      const currentRoot = leaf("default", [setupTab, agentTab, buildTab]);
      if (currentRoot.kind !== "leaf") throw new Error("expected leaf");
      currentRoot.activeTabId = STARTUP_AGENT_TAB_ID;
      const backendRoot = leaf("default", [setupTab, agentTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-1";

      expect(getWindowBuildPipelineActivation("env-1")).toBeNull();
      const restored = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(currentRoot),
      );
      if (!restored) throw new Error("expected a restored layout");
      expect(restored.root).toMatchObject({ activeTabId: STARTUP_AGENT_TAB_ID });
    } finally {
      restore();
    }
  });

  test("burns a declined backend pipeline so a later return to setup does not follow it", () => {
    const restore = isolatedWindow();
    try {
      readyEnvironmentWithPipelines("pipeline-1");
      const { setupTab, buildTab } = pipelineTabs();
      const notesTab = { id: "notes", type: "plain" as const };
      const notesRoot = leaf("default", [setupTab, notesTab, buildTab]);
      if (notesRoot.kind !== "leaf") throw new Error("expected leaf");
      notesRoot.activeTabId = "notes";
      const setupRoot = leaf("default", [setupTab, notesTab, buildTab]);
      if (setupRoot.kind !== "leaf") throw new Error("expected leaf");
      setupRoot.activeTabId = "setup";
      const backendRoot = leaf("default", [setupTab, notesTab, buildTab]);
      if (backendRoot.kind !== "leaf") throw new Error("expected leaf");
      backendRoot.activeTabId = "build-pipeline-1";

      const declined = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(notesRoot),
      );
      if (!declined) throw new Error("expected a restored layout");
      expect(declined.root).toMatchObject({ activeTabId: "notes" });
      commitBuildPipelineSetupHandoff("env-1", declined);
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(true);

      const returned = reconcileAuthoritativePaneLayout(
        "env-1",
        persisted(backendRoot),
        paneState(setupRoot),
      );
      if (!returned) throw new Error("expected a restored layout");
      expect(returned.root).toMatchObject({ activeTabId: "setup" });
    } finally {
      restore();
    }
  });

  test("does not follow a build tab active in a non-focused authoritative pane", () => {
    const restore = isolatedWindow();
    try {
      readyEnvironmentWithPipelines("pipeline-1");
      const { setupTab, buildTab } = pipelineTabs();
      const setupPane = leaf("setup-pane", [setupTab]);
      const pipelinePane = leaf("pipeline-pane", [buildTab]);
      if (pipelinePane.kind !== "leaf") throw new Error("expected pipeline leaf");
      pipelinePane.activeTabId = "build-pipeline-1";
      const current = paneState(split(setupPane, pipelinePane));
      current.activePaneId = "setup-pane";

      const authoritativePipelinePane = leaf("pipeline-pane", [buildTab]);
      if (authoritativePipelinePane.kind !== "leaf") throw new Error("expected pipeline leaf");
      authoritativePipelinePane.activeTabId = "build-pipeline-1";
      const saved = persisted(split(setupPane, authoritativePipelinePane));
      saved.activePaneId = "setup-pane";

      const restored = reconcileAuthoritativePaneLayout("env-1", saved, current);
      if (!restored) throw new Error("expected a restored layout");
      expect(restored.activePaneId).toBe("setup-pane");
      expect(findLeafForTest(restored.root, "setup-pane")?.activeTabId).toBe("setup");
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(false);
    } finally {
      restore();
    }
  });

  test("follows a backend-focused build pane and moves this window's active pane", () => {
    const restore = isolatedWindow();
    try {
      readyEnvironmentWithPipelines("pipeline-1");
      const { buildTab } = pipelineTabs();
      const leftSetupTab = { id: "setup-left", type: "plain" as const, isSetupTab: true };
      const rightSetupTab = { id: "setup-right", type: "plain" as const, isSetupTab: true };
      const setupPane = leaf("setup-pane", [leftSetupTab]);
      const pipelinePane = leaf("pipeline-pane", [rightSetupTab, buildTab]);
      if (pipelinePane.kind !== "leaf") throw new Error("expected pipeline leaf");
      pipelinePane.activeTabId = "setup-right";
      const current = paneState(split(setupPane, pipelinePane));
      current.activePaneId = "setup-pane";

      const authoritativePipelinePane = leaf("pipeline-pane", [rightSetupTab, buildTab]);
      if (authoritativePipelinePane.kind !== "leaf") throw new Error("expected pipeline leaf");
      authoritativePipelinePane.activeTabId = "build-pipeline-1";
      const saved = persisted(split(setupPane, authoritativePipelinePane));
      saved.activePaneId = "pipeline-pane";

      const restored = reconcileAuthoritativePaneLayout("env-1", saved, current);
      if (!restored) throw new Error("expected a restored layout");
      expect(restored.activePaneId).toBe("pipeline-pane");
      expect(findLeafForTest(restored.root, "pipeline-pane")?.activeTabId).toBe("build-pipeline-1");
      commitBuildPipelineSetupHandoff("env-1", restored);
      expect(hasWindowBuildPipelineHandoffResolved("env-1", "pipeline-1")).toBe(true);
    } finally {
      restore();
    }
  });
});
