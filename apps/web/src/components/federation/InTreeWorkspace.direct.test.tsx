/**
 * Plan item 4005: an in-tree node's navigation and shared chrome are direct
 * reads and writes of the window's stores. Its loopback carries none of
 * `select`, `sidebar`, `filesPanel`, `grouping`, `visibility`, `ready`,
 * `selection` or `open`; `observeRealmLoopbacks` records everything that
 * still crosses it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { environmentKey, environmentRef, type BackendId } from "@orkestrator/protocol/federation";
import type { NodeInvokeOptions } from "@orkestrator/protocol/node-client";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  SELF_NODE_ID,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { setFilesPanelTestState } from "@/test/files-panel-state";
import { closeInTreeScopes, configureInTreeScopes } from "@/lib/federation/in-tree-scopes";
import { observeRealmLoopbacks, type RealmLoopbackTraffic } from "@/lib/federation/realm-channel";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { WindowScopeProvider } from "@/lib/node-scope/providers";
import { portalStore } from "@/lib/portal/portal-store";
import { getReadCoordinator, resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { createDefaultAppConfig } from "@orkestrator/protocol/app-config-defaults";
import type { NodeScope } from "@/lib/node-scope/node-scope";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useBugReportStore } from "@/stores/bugReportStore";
import { configStore } from "@/stores/configStore";
import { environmentStore } from "@/stores/environmentStore";
import { projectStore } from "@/stores/projectStore";
import { useInTreeNodesStore } from "@/stores/inTreeNodesStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { uiStore } from "@/stores/uiStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { openCoordinatorWorkTarget } from "@/lib/coordinator-work-navigation";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { projectLandingBoardTab } from "@/lib/federation/workspace-realm";
import { REALM_DIALOGS } from "@orkestrator/protocol/realm-request";
import { FederationProvider } from "./FederationProvider";
import { RemoteWorkspaceRegion } from "./RemoteWorkspaceRegion";

const INITIAL_REMOTE = useRemoteWorkspaceStore.getState();
const INITIAL_MACHINE = useMachineViewStore.getState();
const INITIAL_CHROME = useUIChromeStore.getState();
const INITIAL_PORTAL = portalStore.getState();
const LEAF = "bk_a" as BackendId;
const project = { id: "project-1", name: "Checkout", localPath: null, order: 0 };
const environment = {
  id: "env-1",
  projectId: project.id,
  name: "feature",
  environmentType: "local",
  status: "running",
};

/** The messages plan item 4005 replaces with direct calls. */
const DIRECT = new Set([
  "select",
  "sidebar",
  "filesPanel",
  "grouping",
  "visibility",
  "ready",
  "selection",
  "open",
]);

/** A leaf node that answers its workspace's reads; anything else answers nothing. */
class LeafClient extends FakeNodeClient {
  override async invokeRaw<T = unknown>(
    command: string,
    args: Readonly<Record<string, unknown>> = {},
    options?: NodeInvokeOptions,
  ): Promise<T> {
    try {
      return await super.invokeRaw<T>(command, args, options);
    } catch (error) {
      if (this.disposed) throw error;
      return null as T;
    }
  }
}

let traffic: RealmLoopbackTraffic[];
let stopObserving: () => void;
let restoreScopes: () => void;

/** Whether any loopback carried a message of `type`, either way. */
function exchanged(type: string): string[] {
  return directTraffic().filter((entry) => entry.endsWith(`:${type}`));
}

/** The messages of plan item 4005 that crossed a loopback. */
function directTraffic(): string[] {
  return traffic
    .map((entry) => `${entry.direction}:${entry.message.type}`)
    .filter((entry) => DIRECT.has(entry.split(":")[1]!));
}

function anchorElement(): HTMLDivElement {
  const anchor = document.createElement("div");
  anchor.getBoundingClientRect = () =>
    ({ left: 300, top: 40, width: 900, height: 700, right: 1200, bottom: 740 }) as DOMRect;
  document.body.appendChild(anchor);
  return anchor;
}

function renderRegion() {
  installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: sharedIdDataset("working") },
  });
  // A browser or iOS client: no desktop realms.
  delete (window.orkestrator as { workspaceViews?: unknown }).workspaceViews;
  return render(
    <WindowScopeProvider>
      <FederationProvider>
        <RemoteWorkspaceRegion anchor={anchorElement()} />
      </FederationProvider>
    </WindowScopeProvider>,
  );
}

/** Opens the leaf in the window's tree and waits for its scope. */
async function openLeaf(
  request: Parameters<ReturnType<typeof useRemoteWorkspaceStore.getState>["open"]>[1] = {
    projectId: project.id,
  },
) {
  renderRegion();
  act(() => useRemoteWorkspaceStore.getState().open(LEAF, request));
  await screen.findByTestId("in-tree-workspace");
  await waitFor(() => expect(getWindowScope().get(LEAF)?.role).toBe("leaf"));
  return getWindowScope().get(LEAF)!;
}

/** The node's config arrives (its warm services load it; they are off in this suite). */
function loadConfig(scope: NodeScope) {
  act(() => scope.store(configStore).getState().setConfig(createDefaultAppConfig()));
}

/** Lets microtask deliveries and effects land. */
async function settle() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useUIChromeStore.setState({ environmentSortMode: "project", sidebarOpen: true });
  useMachineViewStore.setState({ grouping: "machine" });
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  sessionStorage.clear();
  // The window's own node, so entry points tell it from another node's.
  portalStore.store.setState({ selfId: SELF_NODE_ID });
  traffic = [];
  stopObserving = observeRealmLoopbacks((entry) => traffic.push(entry));
  restoreScopes = configureInTreeScopes({
    host: {
      kind: "browser",
      async openLeafScope(windowScope, nodeId) {
        const client = new LeafClient({
          nodeId,
          invoke: {
            get_projects: [project],
            get_environments: [environment],
            get_environment_snapshots: [environment],
            check_docker: { available: false },
          },
        });
        return windowScope.open({ role: "leaf", client });
      },
    },
    startServices: () => () => undefined,
  });
});

afterEach(() => {
  cleanup();
  stopObserving();
  closeInTreeScopes();
  restoreScopes();
  uninstallDesktopFake();
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE, true);
  useMachineViewStore.setState(INITIAL_MACHINE, true);
  useUIChromeStore.setState(INITIAL_CHROME, true);
  useInTreeNodesStore.setState({ useRealmsForRemoteMachines: false });
  setFilesPanelTestState({ isOpen: false });
  useAppDialogStore.setState({ request: null });
  useBugReportStore.setState({ sheetOpen: false, sheetNodeId: null });
  portalStore.store.setState(INITIAL_PORTAL, true);
  resetReadCoordinatorForTests();
  resetWindowScopeForTests();
  document.body.innerHTML = "";
});

test("sidebar: the in-tree workspace and the window share one store; nothing is exchanged", async () => {
  await openLeaf();
  await settle();
  // The window hides its sidebar, and the workspace's toolbar shows it again.
  act(() => useUIChromeStore.getState().setSidebarOpen(false));
  await settle();
  act(() => useUIChromeStore.getState().setSidebarOpen(true));
  await settle();
  expect(useUIChromeStore.getState().sidebarOpen).toBe(true);
  expect(directTraffic().filter((entry) => entry.endsWith(":sidebar"))).toEqual([]);
});

test("filesPanel: one open state for every machine, read and toggled in place", async () => {
  await openLeaf();
  await settle();
  // The window opens the panel; the in-tree layout reads the same store.
  act(() => useFilesPanelChromeStore.getState().openPanel());
  await settle();
  act(() => useFilesPanelChromeStore.getState().togglePanel());
  await settle();
  expect(useFilesPanelChromeStore.getState().isOpen).toBe(false);
  expect(directTraffic().filter((entry) => entry.endsWith(":filesPanel"))).toEqual([]);
});

test("grouping: the in-tree workspace reads machineViewStore; nothing is exchanged", async () => {
  await openLeaf();
  await settle();
  act(() => useMachineViewStore.setState({ grouping: "repository" }));
  await settle();
  act(() => useUIChromeStore.setState({ environmentSortMode: "activity" }));
  await settle();
  expect(directTraffic().filter((entry) => entry.endsWith(":grouping"))).toEqual([]);
});

test("visibility: hiding an in-tree node leaves the window's reads alone and sends nothing", async () => {
  await openLeaf();
  await settle();
  // Showing the window's own node hides the in-tree one.
  act(() => useRemoteWorkspaceStore.getState().showLocal());
  await settle();
  expect(screen.getByTestId("in-tree-workspace").className).toContain("hidden");
  expect(getReadCoordinator().getDiagnostics().hostHidden).toBe(false);
  expect(directTraffic().filter((entry) => entry.endsWith(":visibility"))).toEqual([]);
});

test("select: a sidebar click on the node's environment selects it on the node's scope, read from the window's store", async () => {
  // What a sidebar row (and every other portal entry point) calls.
  renderRegion();
  act(() =>
    openMachineWorkspace({
      connectionId: LEAF,
      projectId: project.id,
      environmentId: environment.id,
      title: environment.name,
    }),
  );
  await screen.findByTestId("in-tree-workspace");
  await waitFor(() => expect(getWindowScope().get(LEAF)?.role).toBe("leaf"));
  const ui = getWindowScope().get(LEAF)!.store(uiStore);
  await waitFor(() => expect(ui.getState().projectSelectionRevision).toBeGreaterThan(0));
  expect(ui.getState().selectedEnvironmentId).toBe(environment.id);
  expect(getWindowScope().selection.get()).toMatchObject({
    nodeId: LEAF,
    projectId: project.id,
    environmentId: environment.id,
  });
  expect(exchanged("select")).toEqual([]);
});

test("select: ⌘K's project result lands on the asked tab of the node's project", async () => {
  const scope = await openLeaf({ projectId: project.id });
  const ui = scope.store(uiStore);
  await waitFor(() => expect(ui.getState().selectedProjectId).toBe(project.id));
  act(() => ui.getState().setProjectBoardTab("kanban"));
  // The search's result for another node's project, as `ProjectSearchBar`
  // opens it grouped by machine: on its coordinator.
  act(() =>
    openMachineWorkspace({
      connectionId: LEAF,
      projectId: project.id,
      boardTab: projectLandingBoardTab("machine", false),
      title: project.name,
    }),
  );
  await waitFor(() => expect(ui.getState().projectBoardTab).toBe("coordinator"));
  expect(ui.getState().selectedProjectId).toBe(project.id);
  expect(exchanged("select")).toEqual([]);
});

test("select: a coordinator's work target on the node opens there, in its scope", async () => {
  const scope = await openLeaf({ projectId: project.id });
  // A coordinator's mail tile for a worker on this node.
  act(() =>
    openCoordinatorWorkTarget({
      type: "remote",
      nodeId: LEAF,
      projectId: project.id,
      environmentId: environment.id,
      title: environment.name,
      workTarget: {
        type: "worker-tab",
        projectId: project.id,
        environmentId: environment.id,
      },
    }),
  );
  await waitFor(() =>
    expect(scope.store(uiStore).getState().selectedEnvironmentId).toBe(environment.id),
  );
  // The command node's own selection was not touched.
  expect(getWindowScope().commandScope().store(uiStore).getState().selectedEnvironmentId).toBe(
    null,
  );
  expect(exchanged("select")).toEqual([]);
});

for (const dialog of REALM_DIALOGS) {
  const onEnvironment = dialog.startsWith("environment-");
  test(`select: the ${dialog} dialog opens for the node once its stores have hydrated`, async () => {
    const scope = await openLeaf({
      projectId: project.id,
      ...(onEnvironment ? { environmentId: environment.id } : {}),
      dialog,
    });
    await waitFor(() =>
      expect(
        scope
          .store(projectStore)
          .getState()
          .projects.map((item) => item.id),
      ).toEqual([project.id]),
    );
    await settle();
    if (dialog === "repository-settings") {
      // Its dialog reads the node's config, which has not arrived yet.
      expect(useAppDialogStore.getState().request).toBeNull();
    }
    loadConfig(scope);
    await waitFor(() => expect(useAppDialogStore.getState().request).not.toBeNull());
    const expected: unknown = onEnvironment
      ? {
          kind: "environment-settings",
          nodeId: LEAF,
          environmentId: environment.id,
          ...(dialog === "environment-rebuild" ? { section: "container" } : {}),
        }
      : { kind: dialog, nodeId: LEAF, projectId: project.id };
    expect(useAppDialogStore.getState().request).toEqual(expected as never);
    expect(exchanged("select")).toEqual([]);
  });
}

test("select: Add Project and New Environment open in the node's workspace once its stores have hydrated", async () => {
  renderRegion();
  // The machine's "Add project" entry: an empty project.
  act(() => openMachineWorkspace({ connectionId: LEAF, projectId: "", title: "Machine A" }));
  expect((await screen.findByRole("dialog")).textContent).toContain("Add project");
  const scope = getWindowScope().get(LEAF)!;
  // The machine's "New environment" entry for one of its projects.
  act(() =>
    openMachineWorkspace({
      connectionId: LEAF,
      projectId: project.id,
      createEnvironment: true,
      title: project.name,
    }),
  );
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  // Its defaults are the node's config, which has not arrived yet.
  await settle();
  expect(screen.queryByText(/Configure a new Ork environment/u)).toBeNull();
  loadConfig(scope);
  expect(await screen.findByText(/Configure a new Ork environment/u)).toBeTruthy();
  expect(exchanged("select")).toEqual([]);
});

test("select: a request's bug-report flag opens the window's sheet on the node's scope", async () => {
  // A request made while the node was still shown by a realm (0001's flag).
  await openLeaf({ projectId: project.id, bugReport: true });
  await waitFor(() => expect(useBugReportStore.getState().sheetOpen).toBe(true));
  expect(useBugReportStore.getState().sheetNodeId).toBe(LEAF);
  expect(exchanged("select")).toEqual([]);
});

test("selection: navigating inside the in-tree workspace is the window's one selection, with its recents", async () => {
  const scope = await openLeaf({ projectId: project.id });
  const ui = scope.store(uiStore);
  await waitFor(() => expect(ui.getState().selectedProjectId).toBe(project.id));
  await waitFor(() =>
    expect(
      scope
        .store(environmentStore)
        .getState()
        .environments.map((item) => item.id),
    ).toContain(environment.id),
  );
  // An environment chosen inside the node's own workspace (its project home's list).
  act(() => ui.getState().selectProjectAndEnvironment(project.id, environment.id));
  expect(getWindowScope().selection.get()).toEqual({
    nodeId: LEAF,
    projectId: project.id,
    environmentId: environment.id,
  });
  expect(useRemoteWorkspaceStore.getState().active).toMatchObject({
    nodeId: LEAF,
    environmentId: environment.id,
  });
  expect(useMachineViewStore.getState().recentKeys[0]).toBe(
    environmentKey(environmentRef(LEAF, environment.id)),
  );
  await settle();
  expect(exchanged("selection")).toEqual([]);
});

test("open: a cross-node open from inside the in-tree workspace is the window's direct open", async () => {
  await openLeaf({ projectId: project.id });
  await settle();
  // "Open the coordinator on <command node>" inside the node's workspace
  // (`LeafModeCoordinatorGate`) runs in the window's document.
  act(() =>
    openMachineWorkspace({
      connectionId: SELF_NODE_ID,
      projectId: "own-project",
      boardTab: "coordinator",
      title: "app",
    }),
  );
  expect(useRemoteWorkspaceStore.getState().active).toBeNull();
  const own = getWindowScope().commandScope().store(uiStore).getState();
  expect(own.selectedProjectId).toBe("own-project");
  expect(own.projectBoardTab).toBe("coordinator");
  expect(screen.getByTestId("in-tree-workspace").className).toContain("hidden");
  // And back to the node, from the window's side.
  act(() =>
    openMachineWorkspace({ connectionId: LEAF, projectId: project.id, title: project.name }),
  );
  expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe(LEAF);
  await settle();
  expect(exchanged("open")).toEqual([]);
});

test("ready: there is no handshake, and the window's title-bar requests still reach the node", async () => {
  await openLeaf();
  await settle();
  expect(exchanged("ready")).toEqual([]);
  // A title-bar popover request (plan item 5002's message) is delivered
  // without one: the document listens from its first commit.
  act(() => useRemoteWorkspaceStore.getState().requestRealmPanel(LEAF, "usage", true, 12));
  await settle();
  expect(
    traffic.some((entry) => entry.direction === "to-realm" && entry.message.type === "panel"),
  ).toBe(true);
});

test("done when: an in-tree node exchanges none of the navigation messages", async () => {
  // Open, navigate, open dialogs, toggle chrome, hide and show again.
  const scope = await openLeaf({ projectId: project.id, environmentId: environment.id });
  loadConfig(scope);
  await waitFor(() =>
    expect(scope.store(uiStore).getState().selectedEnvironmentId).toBe(environment.id),
  );
  act(() => useUIChromeStore.getState().setSidebarOpen(false));
  act(() => useFilesPanelChromeStore.getState().openPanel());
  act(() => useMachineViewStore.setState({ grouping: "repository" }));
  act(() =>
    openMachineWorkspace({
      connectionId: LEAF,
      projectId: project.id,
      dialog: "repository-settings",
      title: project.name,
    }),
  );
  await waitFor(() =>
    expect(useAppDialogStore.getState().request?.kind).toBe("repository-settings"),
  );
  act(() => useRemoteWorkspaceStore.getState().showLocal());
  act(() =>
    openMachineWorkspace({ connectionId: LEAF, projectId: project.id, title: project.name }),
  );
  await settle();
  expect(directTraffic()).toEqual([]);
});
