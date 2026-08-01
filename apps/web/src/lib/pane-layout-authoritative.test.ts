import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Environment } from "@/types";

// Both hydrators have their own test files. Snapshot and restore per the Bun
// mock rules in AGENTS.md so a non-isolated run does not leave them faked.
import * as realBuildPipeline from "@/lib/build-pipeline-persistence";
import * as realLoopedReview from "@/lib/looped-review-persistence";

const realModules = {
  "@/lib/build-pipeline-persistence": { ...realBuildPipeline },
  "@/lib/looped-review-persistence": { ...realLoopedReview },
};

afterAll(() => {
  for (const [path, module] of Object.entries(realModules)) {
    mock.module(path, () => module);
  }
});

const hydrateBuildPipeline = mock(async (_id: string) => null as unknown);
const hydrateLoopedReviewWorkflow = mock(async (_id: string) => undefined);

mock.module("@/lib/build-pipeline-persistence", () => ({ hydrateBuildPipeline }));
mock.module("@/lib/looped-review-persistence", () => ({ hydrateLoopedReviewWorkflow }));

const {
  collectPaneDependencyIds,
  hydratePaneLayoutDependencies,
  reconcileAuthoritativePaneLayout,
} = await import("./pane-layout-authoritative");
const { useBuildPipelineStore } = await import("@/stores/buildPipelineStore");
const { useEnvironmentStore } = await import("@/stores/environmentStore");
const { useLoopedReviewStore } = await import("@/stores/loopedReviewStore");
const { LEGACY_PANE_LAYOUT_VERSION, PANE_LAYOUT_VERSION } = await import("@/types/paneLayout");

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

function persisted(root: PaneNode, containerId: string | null = "container-1"): PersistedPaneLayout {
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
  hydrateBuildPipeline.mockClear();
  hydrateLoopedReviewWorkflow.mockClear();
  useEnvironmentStore.setState({ environments: [environment()] });
  useBuildPipelineStore.setState({
    pipelines: new Map(),
    buildEnvironmentIds: new Set(),
  });
  useLoopedReviewStore.setState({ workflows: new Map() });
});

describe("collectPaneDependencyIds", () => {
  test("finds ids in a leaf", () => {
    const root = leaf("default", [
      { id: "build", type: "claude-build", buildTabData: { pipelineId: "pipeline-1" } },
      { id: "review", type: "looped-review", loopedReviewTabData: { workflowId: "workflow-1" } },
      { id: "plain", type: "plain" },
    ]);

    expect(collectPaneDependencyIds(root)).toEqual({
      pipelineIds: new Set(["pipeline-1"]),
      workflowIds: new Set(["workflow-1"]),
    });
  });

  test("descends through splits", () => {
    // A dependency-carrying tab in a split pane is the ordinary case once a
    // user has split their layout, and it is invisible to a leaf-only scan.
    const root = split(
      split(
        leaf("a", [{ id: "b1", type: "claude-build", buildTabData: { pipelineId: "deep-pipeline" } }]),
        leaf("b", [{ id: "r1", type: "looped-review", loopedReviewTabData: { workflowId: "deep-workflow" } }]),
      ),
      leaf("c", [{ id: "b2", type: "claude-build", buildTabData: { pipelineId: "other-pipeline" } }]),
    );

    expect(collectPaneDependencyIds(root)).toEqual({
      pipelineIds: new Set(["deep-pipeline", "other-pipeline"]),
      workflowIds: new Set(["deep-workflow"]),
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
      workflowIds: new Set<string>(),
    };
    expect(collectPaneDependencyIds(null)).toEqual(empty);
    expect(collectPaneDependencyIds(undefined)).toEqual(empty);
    expect(collectPaneDependencyIds("leaf")).toEqual(empty);
    expect(collectPaneDependencyIds([{ kind: "leaf" }])).toEqual(empty);
    expect(collectPaneDependencyIds({ kind: "leaf", tabs: "nope" })).toEqual(empty);
    expect(collectPaneDependencyIds({ kind: "split", children: "nope" })).toEqual(empty);
    expect(collectPaneDependencyIds({ kind: "mystery", tabs: [] })).toEqual(empty);
    expect(collectPaneDependencyIds({
      kind: "leaf",
      tabs: [
        null,
        "tab",
        ["tab"],
        { id: "a", buildTabData: "nope" },
        { id: "b", buildTabData: { pipelineId: 7 } },
        { id: "c", buildTabData: { pipelineId: "   " } },
        { id: "d", loopedReviewTabData: [] },
        { id: "e", loopedReviewTabData: { workflowId: "" } },
      ],
    })).toEqual(empty);
  });
});

describe("hydratePaneLayoutDependencies", () => {
  test("loads only the records this client is missing", async () => {
    useBuildPipelineStore.setState({
      pipelines: new Map([["known-pipeline", {} as never]]),
      buildEnvironmentIds: new Set(),
    });
    const root = split(
      leaf("a", [
        { id: "b1", type: "claude-build", buildTabData: { pipelineId: "known-pipeline" } },
        { id: "b2", type: "claude-build", buildTabData: { pipelineId: "missing-pipeline" } },
      ]),
      leaf("b", [
        { id: "r1", type: "looped-review", loopedReviewTabData: { workflowId: "missing-workflow" } },
      ]),
    );

    await hydratePaneLayoutDependencies(root);

    expect(hydrateBuildPipeline.mock.calls.map(([id]) => id)).toEqual(["missing-pipeline"]);
    expect(hydrateLoopedReviewWorkflow.mock.calls.map(([id]) => id)).toEqual(["missing-workflow"]);
  });

  test("does no work when the snapshot references nothing", async () => {
    await hydratePaneLayoutDependencies(leaf("default", [{ id: "plain", type: "plain" }]));

    expect(hydrateBuildPipeline).not.toHaveBeenCalled();
    expect(hydrateLoopedReviewWorkflow).not.toHaveBeenCalled();
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

  test("installs the backend tree and its selection", () => {
    const current = paneState(leaf("default", [{ id: "tab-2", type: "plain" }]));
    current.root = { ...current.root, activeTabId: "tab-2" } as PaneNode;

    const restored = reconcileAuthoritativePaneLayout(
      "env-1",
      persisted(plainRoot),
      current,
    );

    expect(restored).not.toBeNull();
    expect(restored!.backendRevision).toBe(4);
    expect((restored!.root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id))
      .toEqual(["tab-1", "tab-2"]);
    expect((restored!.root as { activeTabId: string }).activeTabId).toBe("tab-1");
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
    useEnvironmentStore.setState({ environments: [] });

    expect(reconcileAuthoritativePaneLayout(
      "env-1",
      persisted(plainRoot),
      paneState(plainRoot),
    )).toBeNull();
  });

  test("refuses a snapshot from another container generation", () => {
    // The pane state still points at the old container, so its tabs address
    // sessions that no longer exist.
    expect(reconcileAuthoritativePaneLayout(
      "env-1",
      persisted(plainRoot),
      paneState(plainRoot, "container-old"),
    )).toBeNull();
  });

  test("refuses a snapshot reconciliation rejects", () => {
    expect(reconcileAuthoritativePaneLayout(
      "env-1",
      { ...persisted(plainRoot), version: PANE_LAYOUT_VERSION + 1 },
      paneState(plainRoot),
    )).toBeNull();
  });

  test("drops a tab whose backing record the backend no longer has", () => {
    const root = leaf("default", [
      { id: "plain", type: "plain" },
      { id: "build", type: "claude-build", buildTabData: { pipelineId: "gone" } },
    ]);

    const restored = reconcileAuthoritativePaneLayout(
      "env-1",
      persisted(root),
      paneState(root),
    );

    expect(restored).not.toBeNull();
    expect((restored!.root as { tabs: Array<{ id: string }> }).tabs.map(({ id }) => id))
      .toEqual(["plain"]);
  });

  test("resolves a local environment against a null container", () => {
    useEnvironmentStore.setState({
      environments: [environment({
        environmentType: "local",
        containerId: null,
        worktreePath: "/tmp/worktree",
      })],
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
