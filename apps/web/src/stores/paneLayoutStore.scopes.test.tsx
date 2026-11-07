/**
 * Plan item 3013: one pane layout per node scope.
 *
 * Pane ids (`"default"`) and tab ids are only unique on their node, so two
 * nodes' layouts with identical ids must never meet: each scope has its own
 * store, tears its tabs down on its own node, persists to its own node and
 * adopts its own node's authoritative layout, after a reload too.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, screen, waitFor } from "@testing-library/react";
import type { BackendId } from "@orkestrator/protocol/federation";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { requestPaneTabActivation } from "@/lib/pane-layout-authoritative";
import {
  createPersistedPaneLayoutInput,
  paneLayoutPersistenceService,
} from "@/lib/pane-layout-persistence";
import { readWindowPaneSelection } from "@/lib/pane-selection-storage";
import { dispatchResourceChange } from "@/lib/resource-sync";
import { STORE_RESOURCE_HANDLERS, startStoreResourceSync } from "@/lib/store-resource-sync";
import { cleanupNodeScopes, FakeNodeClient, renderInNodeScope } from "@/test/render-in-node-scope";
import type { Environment } from "@/types";
import type { PersistedPaneLayout, TabInfo } from "@/types/paneLayout";
import { buildPipelineCompletionNotesService } from "@/lib/build-pipeline-completion-notes";
import { buildPipelineFixture } from "@/test/build-pipeline-fixture";
import { buildPipelineStore } from "./buildPipelineStore";
import { environmentStore } from "./environmentStore";
import * as barrel from "./index";
import { getAllLeaves, paneLayoutStore, usePaneLayoutStore } from "./paneLayoutStore";
import { createSessionKey, terminalSessionStore } from "./terminalSessionStore";
import { appCommandStore } from "@/test/app-command-store";

const NODE_A = "bk_pane-layout-a" as BackendId;
const NODE_B = "bk_pane-layout-b" as BackendId;
const ENVIRONMENT_ID = "env-1";
const TAB: TabInfo = { id: "tab-1", type: "plain" };

let windowScopes: WindowScope[] = [];
const savedIsolation = window.orkestrator;

afterEach(() => {
  for (const windowScope of windowScopes) windowScope.dispose();
  windowScopes = [];
  cleanupNodeScopes();
  resetWindowScopeForTests();
  window.orkestrator = savedIsolation;
  localStorage.clear();
});

/** A layout record as `get_pane_layout`/`apply_pane_layout_intent` return it. */
function savedLayout(tabs: TabInfo[], revision: number): PersistedPaneLayout {
  return {
    environmentId: ENVIRONMENT_ID,
    version: PANE_LAYOUT_VERSION,
    containerId: null,
    activePaneId: "default",
    root: { kind: "leaf", id: "default", tabs, activeTabId: tabs[0]?.id ?? null },
    revision,
  } as PersistedPaneLayout;
}

function localEnvironment(): Environment {
  return {
    id: ENVIRONMENT_ID,
    projectId: "project-1",
    environmentType: "local",
    containerId: null,
    worktreePath: "/work/env-1",
    status: "running",
  } as unknown as Environment;
}

function twoScopes(
  invokeA: Record<string, unknown> = {},
  invokeB: Record<string, unknown> = {},
): { a: NodeScope; b: NodeScope; clientA: FakeNodeClient; clientB: FakeNodeClient } {
  const windowScope = new WindowScope();
  windowScopes.push(windowScope);
  const clientA = new FakeNodeClient({ nodeId: NODE_A, invoke: invokeA });
  const clientB = new FakeNodeClient({ nodeId: NODE_B, invoke: invokeB });
  const a = windowScope.open({ role: "command", client: clientA });
  const b = windowScope.open({ role: "leaf", client: clientB });
  return { a, b, clientA, clientB };
}

/** The node's layout for the environment, hydrated and holding `tabs` in the "default" pane. */
function seedLayout(scope: NodeScope, tabs: TabInfo[]): void {
  const panes = scope.store(paneLayoutStore).getState();
  panes.setActiveEnvironment(ENVIRONMENT_ID);
  panes.initialize(null, ENVIRONMENT_ID);
  for (const tab of tabs) panes.addTab("default", tab, ENVIRONMENT_ID);
  panes.beginHydration(ENVIRONMENT_ID);
  scope.store(paneLayoutStore).getState().finishHydration(ENVIRONMENT_ID);
}

function tabIds(scope: NodeScope): string[] {
  const root = scope.store(paneLayoutStore).getState().getRoot(ENVIRONMENT_ID);
  return getAllLeaves(root).flatMap((leaf) => leaf.tabs.map((tab) => tab.id));
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("pane layouts per node", () => {
  test('two nodes\' "default" panes with identical tab ids stay independent', async () => {
    const { a, b, clientA, clientB } = twoScopes(
      { teardown_tab: { completed: true } },
      { teardown_tab: { completed: true } },
    );
    seedLayout(a, [TAB, { id: "tab-2", type: "plain" }]);
    seedLayout(b, [TAB, { id: "tab-2", type: "plain" }]);
    // Each node holds a terminal session for its own "tab-1".
    const key = createSessionKey(null, TAB.id, ENVIRONMENT_ID);
    for (const scope of [a, b]) {
      scope
        .store(terminalSessionStore)
        .getState()
        .setSession(key, { sessionId: `pty-${scope.nodeId}` } as never);
    }

    for (const scope of [a, b]) {
      scope.store(paneLayoutStore).getState().setActiveTab("default", TAB.id, ENVIRONMENT_ID);
    }
    a.store(paneLayoutStore).getState().removeTab("default", TAB.id, ENVIRONMENT_ID);
    await settle();

    expect(tabIds(a)).toEqual(["tab-2"]);
    expect(tabIds(b)).toEqual(["tab-1", "tab-2"]);
    expect(b.store(paneLayoutStore).getState().getActivePane(ENVIRONMENT_ID)?.activeTabId).toBe(
      "tab-1",
    );
    // The teardown and the session release reached A's node only.
    expect(a.store(terminalSessionStore).getState().sessions.has(key)).toBe(false);
    expect(b.store(terminalSessionStore).getState().sessions.get(key)?.sessionId).toBe(
      `pty-${NODE_B}`,
    );
    expect(clientA.calls("teardown_tab").map(({ args }) => args)).toEqual([
      expect.objectContaining({ environmentId: ENVIRONMENT_ID, tabId: TAB.id, kind: "terminal" }),
    ]);
    expect(clientB.calls("teardown_tab")).toEqual([]);
  });

  test("the hook reads the rendered scope; the barrel exports the def; the statics are the app's", () => {
    expect(barrel.paneLayoutStore).toBe(paneLayoutStore);
    expect(barrel.usePaneLayoutStore).toBe(usePaneLayoutStore);
    function TabCount() {
      const count = usePaneLayoutStore((state) => state.getAllTabs(ENVIRONMENT_ID).length);
      return <span data-testid="tab-count">{count}</span>;
    }
    const { scope } = renderInNodeScope(<TabCount />, { nodeId: NODE_B, role: "leaf" });
    expect(screen.getByTestId("tab-count").textContent).toBe("0");
    act(() => seedLayout(scope, [TAB]));
    expect(screen.getByTestId("tab-count").textContent).toBe("1");
    // The deprecated statics reach the app's command scope, a different instance.
    expect(appCommandStore(paneLayoutStore).getState().getAllTabs(ENVIRONMENT_ID)).toEqual([]);
    expect(getWindowScope().commandScope().store(paneLayoutStore)).not.toBe(
      scope.store(paneLayoutStore),
    );
  });

  test("a pending tab activation is the node's own", () => {
    const { a, b } = twoScopes();
    seedLayout(a, [TAB, { id: "tab-2", type: "plain" }]);
    seedLayout(b, [TAB, { id: "tab-2", type: "plain" }]);
    for (const scope of [a, b]) {
      scope.store(paneLayoutStore).getState().setActiveTab("default", TAB.id, ENVIRONMENT_ID);
    }
    requestPaneTabActivation(ENVIRONMENT_ID, "tab-2", b);
    expect(b.store(paneLayoutStore).getState().getActivePane(ENVIRONMENT_ID)?.activeTabId).toBe(
      "tab-2",
    );
    expect(a.store(paneLayoutStore).getState().getActivePane(ENVIRONMENT_ID)?.activeTabId).toBe(
      "tab-1",
    );
  });

  test("layout persistence round-trips per node", async () => {
    let revision = 1;
    const intent = (args: Readonly<Record<string, unknown>>) => {
      const desired = args.desiredLayout as ReturnType<typeof createPersistedPaneLayoutInput>;
      revision += 1;
      return { ...desired, environmentId: args.environmentId, revision };
    };
    const { a, b, clientA, clientB } = twoScopes(
      { apply_pane_layout_intent: intent },
      { apply_pane_layout_intent: intent },
    );
    // An Electron window keeps its pane selection per node in local storage.
    window.orkestrator = { ...window.orkestrator, isolatedViewState: true } as never;
    for (const scope of [a, b]) {
      scope.store(environmentStore).getState().setEnvironments([localEnvironment()]);
      seedLayout(scope, [TAB]);
      // Both nodes run their own persistence, as warm scopes do.
      expect(scope.service(paneLayoutPersistenceService).status).toBe("running");
    }

    b.store(paneLayoutStore)
      .getState()
      .addTab("default", { id: "tab-b", type: "plain" }, ENVIRONMENT_ID);
    await waitFor(() => expect(clientB.calls("apply_pane_layout_intent")).toHaveLength(1));
    await settle();

    expect(clientA.calls("apply_pane_layout_intent")).toEqual([]);
    const [write] = clientB.calls("apply_pane_layout_intent");
    expect(write?.args.environmentId).toBe(ENVIRONMENT_ID);
    const desired = write?.args.desiredLayout as ReturnType<typeof createPersistedPaneLayoutInput>;
    expect(getAllLeaves(desired.root).flatMap((leaf) => leaf.tabs.map((tab) => tab.id))).toEqual([
      "tab-1",
      "tab-b",
    ]);
    // The installed result is B's, at B's revision; A is unchanged.
    expect(tabIds(b)).toEqual(["tab-1", "tab-b"]);
    expect(
      b.store(paneLayoutStore).getState().environments.get(ENVIRONMENT_ID)?.backendRevision,
    ).toBe(2);
    expect(tabIds(a)).toEqual(["tab-1"]);
    // The window's pane selection is kept under each node's own key.
    expect(readWindowPaneSelection(ENVIRONMENT_ID, b)?.activeTabIds.default).toBe("tab-b");
    expect(readWindowPaneSelection(ENVIRONMENT_ID, a)).toBeNull();
  });

  test("a leaf adopts its own node's authoritative layout after a reload", async () => {
    // Before the reload: node B persisted a layout with two tabs.
    const persisted = savedLayout([TAB, { id: "tab-b", type: "plain" }], 7);
    const reload = () => {
      const { a, b, clientA, clientB } = twoScopes({}, { get_pane_layout: persisted });
      b.store(environmentStore).getState().setEnvironments([localEnvironment()]);
      a.store(environmentStore).getState().setEnvironments([localEnvironment()]);
      // The renderer starts empty: the environment is registered and hydrated
      // with nothing restored yet (a pane-layout announcement follows).
      for (const scope of [a, b]) seedLayout(scope, []);
      return { a, b, clientA, clientB };
    };
    // The first window goes away, a new one opens (a renderer reload).
    const first = reload();
    for (const windowScope of windowScopes.splice(0)) windowScope.dispose();
    expect(first.b.disposed).toBe(true);
    const { a, b, clientA, clientB } = reload();

    const handlers = STORE_RESOURCE_HANDLERS.filter(({ name }) => name === "pane-layout");
    expect(handlers.map(({ runsOn }) => runsOn)).toEqual(["every-scope"]);
    b.service(paneLayoutPersistenceService);
    const stop = startStoreResourceSync({}, { scope: b, handlers });
    try {
      dispatchResourceChange({ resource: "pane-layout", id: ENVIRONMENT_ID, revision: 7 }, b);
      await waitFor(() => expect(tabIds(b)).toEqual(["tab-1", "tab-b"]));
      expect(
        b.store(paneLayoutStore).getState().environments.get(ENVIRONMENT_ID)?.backendRevision,
      ).toBe(7);
      expect(clientB.calls("get_pane_layout")).toHaveLength(1);
      expect(clientA.calls("get_pane_layout")).toEqual([]);
      expect(tabIds(a)).toEqual([]);
      // Adopted, not echoed: the persistence mirror was primed before install.
      await settle();
      expect(clientB.calls("apply_pane_layout_intent")).toEqual([]);
    } finally {
      stop();
    }
  });

  test("a leaf's completion notes open in the leaf's own layout", () => {
    const { a, b } = twoScopes();
    const buildTab: TabInfo = {
      id: "build",
      type: "claude-build",
      buildTabData: { environmentId: ENVIRONMENT_ID, pipelineId: "pipeline-1", taskId: "task-1" },
    };
    for (const scope of [a, b]) {
      seedLayout(scope, [buildTab]);
      scope.service(buildPipelineCompletionNotesService);
    }
    const pipelines = b.store(buildPipelineStore).getState();
    pipelines.replacePipeline(
      buildPipelineFixture({ phase: "resolving-conflicts", backendRevision: 1 }),
    );
    pipelines.replacePipeline(buildPipelineFixture({ phase: "complete", backendRevision: 2 }));

    const notes = (scope: NodeScope) =>
      scope
        .store(paneLayoutStore)
        .getState()
        .getAllTabs(ENVIRONMENT_ID)
        .filter((tab) => tab.type === "key-information");
    expect(notes(b).map((tab) => tab.keyInformationTabData)).toEqual([
      { environmentId: ENVIRONMENT_ID, pipelineId: "pipeline-1", view: "notes" },
    ]);
    expect(notes(a)).toEqual([]);
    expect(b.health.get()).toEqual({ state: "ok" });
  });
});
