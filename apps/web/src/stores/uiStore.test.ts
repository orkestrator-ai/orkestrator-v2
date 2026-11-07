import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StoreApi } from "zustand";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  COMMAND_SCOPE_PROVISIONAL_NODE_ID,
  getWindowScope,
  resetWindowScopeForTests,
} from "@/lib/node-scope/app-window-scope";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { WindowScope } from "@/lib/node-scope/window-scope";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { uiStore, type UIState } from "./uiStore";
import { useRemoteWorkspaceStore, startRemoteWorkspaceSelectionSync } from "./remoteWorkspaceStore";
import { useMachineViewStore } from "./machineViewStore";
import { selectOnNode } from "@/test/node-selection";

const NODE_A = "bk_node-a" as BackendId;
const NODE_B = "bk_node-b" as BackendId;

let windowScope: WindowScope;
let a: NodeScope;
let b: NodeScope;
let uiA: StoreApi<UIState>;
let uiB: StoreApi<UIState>;

beforeEach(() => {
  localStorage.clear();
  windowScope = new WindowScope();
  a = windowScope.open({ role: "command", client: new FakeNodeClient({ nodeId: NODE_A }) });
  b = windowScope.open({ role: "leaf", client: new FakeNodeClient({ nodeId: NODE_B }) });
  uiA = a.store(uiStore);
  uiB = b.store(uiStore);
});

afterEach(() => {
  windowScope.dispose();
  localStorage.clear();
});

describe("the per-node uiStore", () => {
  test("selecting on node B does not change node A's per-node state", () => {
    uiA.getState().selectProject("shared-id");
    uiA.getState().setProjectCollapsed("shared-id", true);
    uiA.getState().setProjectFolderCollapsed("Folder", true);
    uiA.getState().toggleSessionsExpanded("env-a");
    uiA.getState().setProjectBoardTab("kanban");
    const before = uiA.getState();

    // The same project id on node B is another project.
    uiB.getState().selectProjectAndEnvironment("shared-id", "env-b");
    uiB.getState().setProjectCollapsed("shared-id", false);
    uiB.getState().setProjectFolderCollapsed("Folder", false);
    uiB.getState().setMultiSelection(["env-b", "env-c"]);

    const after = uiA.getState();
    expect(after.collapsedProjects).toEqual(before.collapsedProjects);
    expect(after.projectCollapseChoices).toEqual(before.projectCollapseChoices);
    expect(after.collapsedProjectFolders).toEqual(["Folder"]);
    expect(after.expandedSessionsEnvironments).toEqual(["env-a"]);
    expect(after.recentProjectIds).toEqual(["shared-id"]);
    expect(after.selectedEnvironmentIds).toEqual([]);
    expect(uiB.getState().recentProjectIds).toEqual(["shared-id"]);
    expect(uiB.getState().collapsedProjects).toEqual([]);
  });

  test("the window has one node-qualified selection, which each node projects", () => {
    uiA.getState().selectProjectAndEnvironment("p-a", "env-a");
    expect(windowScope.selection.get()).toMatchObject({
      nodeId: NODE_A,
      projectId: "p-a",
      environmentId: "env-a",
    });
    expect(uiB.getState().selectedProjectId).toBeNull();

    uiB.getState().selectProjectAndEnvironment("p-b", "env-b");
    expect(windowScope.selection.get()).toMatchObject({
      nodeId: NODE_B,
      projectId: "p-b",
      environmentId: "env-b",
    });
    // Node A's workspace shows nothing while B is shown, as before.
    expect(uiA.getState().selectedProjectId).toBeNull();
    expect(uiA.getState().selectedEnvironmentId).toBeNull();
    expect(uiB.getState().selectedEnvironmentId).toBe("env-b");

    // Choosing an environment on A brings the window back to A.
    uiA.getState().selectEnvironment("env-a2");
    expect(windowScope.selection.get()?.nodeId).toBe(NODE_A);
    expect(uiB.getState().selectedEnvironmentId).toBeNull();
  });

  test("a deselection on a node that is not shown leaves the window's selection alone", () => {
    uiB.getState().selectProjectAndEnvironment("p-b", "env-b");
    uiA.getState().selectEnvironment(null);
    expect(windowScope.selection.get()?.nodeId).toBe(NODE_B);
  });

  test("a selection set on the window is projected onto its node without counting as navigation", () => {
    const revision = uiB.getState().projectSelectionRevision;
    windowScope.select({ nodeId: NODE_B, projectId: "p-b", environmentId: "env-b" });
    expect(uiB.getState().selectedProjectId).toBe("p-b");
    expect(uiB.getState().selectedEnvironmentId).toBe("env-b");
    expect(uiB.getState().projectSelectionRevision).toBe(revision);
  });

  test("a disposed scope stops following the window's selection", () => {
    b.dispose();
    windowScope.select({ nodeId: NODE_A, projectId: "p-a", environmentId: null });
    expect(uiB.getState().selectedProjectId).toBeNull();
    expect(uiA.getState().selectedProjectId).toBe("p-a");
  });

  test("the selection follows the command scope to its proven id", () => {
    const provisionalWindow = new WindowScope();
    try {
      const command = provisionalWindow.open({
        role: "command",
        client: new FakeNodeClient({ nodeId: COMMAND_SCOPE_PROVISIONAL_NODE_ID }),
      });
      const ui = command.store(uiStore);
      ui.getState().selectProject("p-1");
      expect(provisionalWindow.adoptCommandNodeId(NODE_A)).toBe(true);
      expect(provisionalWindow.selection.get()?.nodeId).toBe(NODE_A);
      expect(ui.getState().selectedProjectId).toBe("p-1");
      ui.getState().selectEnvironment("env-1");
      expect(provisionalWindow.selection.get()).toMatchObject({
        nodeId: NODE_A,
        projectId: "p-1",
        environmentId: "env-1",
      });
    } finally {
      provisionalWindow.dispose();
    }
  });
});

describe("remoteWorkspaceStore derived from the window selection", () => {
  const initialRemote = useRemoteWorkspaceStore.getState();
  const initialViews = useMachineViewStore.getState();
  afterEach(() => {
    useRemoteWorkspaceStore.setState(initialRemote, true);
    useMachineViewStore.setState(initialViews, true);
    resetWindowScopeForTests();
  });

  test("opening another node moves the selection to it; selecting locally brings it back", () => {
    resetWindowScopeForTests();
    const appWindow = getWindowScope();
    const local = appWindow.commandScope().store(uiStore);
    local.getState().selectProjectAndEnvironment("local-project", "local-env");
    const stop = startRemoteWorkspaceSelectionSync();
    try {
      useRemoteWorkspaceStore
        .getState()
        .open("bk_remote", { projectId: "remote-project", environmentId: "remote-env" });
      expect(appWindow.selection.get()).toMatchObject({
        nodeId: "bk_remote",
        projectId: "remote-project",
        environmentId: "remote-env",
      });
      expect(useRemoteWorkspaceStore.getState().active).toMatchObject({
        nodeId: "bk_remote",
        environmentId: "remote-env",
      });
      expect(local.getState().selectedProjectId).toBeNull();
      expect(local.getState().selectedEnvironmentId).toBeNull();

      selectOnNode("bk_remote", { projectId: "remote-project", environmentId: null });
      expect(appWindow.selection.get()?.environmentId).toBeNull();
      expect(useRemoteWorkspaceStore.getState().active?.environmentId).toBeNull();

      local.getState().selectProject("local-project");
      expect(appWindow.selection.get()?.nodeId).toBe(appWindow.commandScope().nodeId);
      expect(useRemoteWorkspaceStore.getState().active).toBeNull();
      // The node stays held, hidden.
      expect(useRemoteWorkspaceStore.getState().openNodes).toEqual(["bk_remote"]);
    } finally {
      stop();
    }
  });

  test("closing the shown node clears the selection; showing local keeps a local one", () => {
    resetWindowScopeForTests();
    const appWindow = getWindowScope();
    useRemoteWorkspaceStore.getState().open("bk_remote", { projectId: "remote-project" });
    useRemoteWorkspaceStore.getState().closeNode("bk_remote");
    expect(appWindow.selection.get()).toBeNull();
    expect(useRemoteWorkspaceStore.getState().active).toBeNull();

    useRemoteWorkspaceStore.getState().open("bk_remote", { projectId: "remote-project" });
    useRemoteWorkspaceStore.getState().showLocal();
    expect(appWindow.selection.get()).toBeNull();
    expect(useRemoteWorkspaceStore.getState().active).toBeNull();
  });
});
