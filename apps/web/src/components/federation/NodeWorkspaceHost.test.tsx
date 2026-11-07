/**
 * The host of another node's workspace in the window's tree: it reads the
 * window's request for its node from the window's own store
 * (`remoteWorkspaceStore.requests`, plan item 4005) and applies it on the
 * node's stores once they have what it needs. The suites render it outside a
 * node scope provider, so it acts for the app's command scope, and ask
 * through the store under that scope's id.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toNodeProjectSummary } from "@orkestrator/protocol/node-summaries";
import type { BackendId } from "@orkestrator/protocol/federation";
import { hostMaintenanceSnapshotFixture } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import { AppDialogHost } from "@/components/layout/AppDialogHost";
import { MachineUpdatesDialog } from "@/components/settings/machines/MachineUpdatesDialog";
import { useProjectHomeActivation } from "@/hooks/useProjectHomeActivation";
import type { MachineView } from "@/lib/federation/aggregate";
import type { WorkspaceRequest } from "@/lib/federation/workspace-request";
import { invoke } from "@/lib/native/backend";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { portalStore } from "@/lib/portal/portal-store";
import { getReadCoordinator, resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { environmentStore, projectStore, uiStore, useEnvironmentStore, useUIStore } from "@/stores";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { configStore } from "@/stores/configStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import type { Environment, Project } from "@/types";
import { NodeWorkspaceHost } from "./NodeWorkspaceHost";
import { RemoteProjectGroup } from "./RemoteMachineTree";
import { appCommandStore } from "@/test/app-command-store";

/** Outside a node scope provider, components act for the app's command node. */
const commandNodeId = () => getWindowScope().commandScope().nodeId;

const originalPortal = portalStore.getState();
const originalRemote = useRemoteWorkspaceStore.getState();
const originalUI = appCommandStore(uiStore).getState();
const originalConfig = appCommandStore(configStore).getState();
const originalProjects = appCommandStore(projectStore).getState();
const originalEnvironments = appCommandStore(environmentStore).getState();
const nativeInvoke = invoke as ReturnType<typeof mock>;
const leafId = "bk_leaf" as BackendId;
const project = { id: "project", name: "Checkout", localPath: "/checkout", order: 0 } as Project;
const environment = {
  id: "env",
  projectId: project.id,
  name: "Feature",
  environmentType: "local",
  status: "stopped",
} as Environment;
const home = {
  id: "project-home",
  projectId: project.id,
  name: "Checkout Home",
  projectHome: true,
  environmentType: "local",
  status: "running",
  worktreePath: project.localPath,
} as Environment;
let resolveProjects: (projects: Project[]) => void;

// The tab/environment visibility decision the app shell makes, without
// mounting terminals and native agents in a navigation test.
function Workspace() {
  useProjectHomeActivation();
  const tab = useUIStore((state) => state.projectBoardTab);
  const environmentId = useUIStore((state) => state.selectedEnvironmentId);
  const shown = useEnvironmentStore((state) =>
    state.environments.find((entry) => entry.id === environmentId),
  );
  return (
    <>
      <NodeWorkspaceHost />
      <output aria-label="Visible workspace">
        {tab === "home" ? (shown?.name ?? "Loading Home") : tab}
      </output>
    </>
  );
}

/** The window asks, through its own store, keyed by the node the host shows. */
function ask(request: WorkspaceRequest) {
  act(() => useRemoteWorkspaceStore.getState().open(commandNodeId(), request));
}

function open(request: WorkspaceRequest = { projectId: project.id }, tree = <Workspace />) {
  ask(request);
  return render(tree);
}

/**
 * The node is a leaf, whose projects land on their Home: the window's own
 * node here, connected directly to a leaf (`scopeNodeIsLeaf`), stands in for
 * another node's leaf scope.
 */
function asLeaf() {
  portalStore.store.setState({ status: { mode: "leaf" } as never });
}

/** Lets microtask deliveries land. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  nativeInvoke.mockReset();
  const projects = new Promise<Project[]>((resolve) => {
    resolveProjects = resolve;
  });
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "get_projects") return projects;
    if (command === "ensure_project_home_environment") return home;
    if (command === "get_environments" || command === "get_environment_snapshots") return [home];
    return undefined;
  });
  portalStore.store.setState({
    loaded: true,
    status: { mode: "command" } as never,
    selfId: "bk_command" as BackendId,
  });
  appCommandStore(projectStore).setState({
    projects: [],
    hasLoaded: false,
    isLoading: false,
    deletingProjects: new Set(),
  });
  appCommandStore(environmentStore).setState({ environments: [], deletingEnvironments: new Set() });
  appCommandStore(uiStore).setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
    projectBoardTab: "coordinator",
  });
  useAppDialogStore.setState({ request: null });
  useRemoteWorkspaceStore.setState(originalRemote, true);
  resetReadCoordinatorForTests();
});

afterEach(() => {
  cleanup();
  useAppDialogStore.setState({ request: null });
  useRemoteWorkspaceStore.setState(originalRemote, true);
  appCommandStore(configStore).setState(originalConfig, true);
  appCommandStore(uiStore).setState(originalUI, true);
  appCommandStore(projectStore).setState(originalProjects, true);
  appCommandStore(environmentStore).setState(originalEnvironments, true);
  portalStore.store.setState(originalPortal, true);
  resetReadCoordinatorForTests();
  resetWindowScopeForTests();
});

test("opens on the window's request; the selection is the window's own", async () => {
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "get_projects") return [project];
    if (command === "get_environments" || command === "get_environment_snapshots")
      return [environment];
    return undefined;
  });
  open({ projectId: project.id, environmentId: environment.id }, <NodeWorkspaceHost />);
  await waitFor(() =>
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe(environment.id),
  );
  expect(appCommandStore(uiStore).getState().selectedProjectId).toBe(project.id);
  expect(getWindowScope().selection.get()).toMatchObject({
    projectId: project.id,
    environmentId: environment.id,
  });
});

test("a later request from the window is applied as a sidebar click would", async () => {
  open({}, <NodeWorkspaceHost />);
  await act(async () => resolveProjects([project]));
  await settle();
  ask({ projectId: project.id, boardTab: "kanban" });
  await waitFor(() =>
    expect(appCommandStore(uiStore).getState().selectedProjectId).toBe(project.id),
  );
  expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("kanban");
});

test("the window's own document visibility stands: a hidden node is its scope's tier, not a hidden page", async () => {
  open({}, <NodeWorkspaceHost />);
  await settle();
  expect(getReadCoordinator().getDiagnostics().hostHidden).toBe(false);
});

test("initial leaf selection keeps Home through a delayed project snapshot and displays its environment", async () => {
  asLeaf();
  open();
  await waitFor(() =>
    expect(appCommandStore(uiStore).getState().selectedProjectId).toBe(project.id),
  );
  expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("home");
  expect(
    nativeInvoke.mock.calls.some(([command]) => command === "ensure_project_home_environment"),
  ).toBe(false);
  await act(async () => resolveProjects([project]));
  await waitFor(() =>
    expect(screen.getByLabelText("Visible workspace").textContent).toBe(home.name),
  );
  expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe(home.id);
  expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("home");
});

test("a project dialog waits for the node's projects, then opens for this node once", async () => {
  open({ projectId: project.id, dialog: "delete-project" });
  await settle();
  // The dialog reads the project from the node's list, so it waits for it.
  expect(useAppDialogStore.getState().request).toBeNull();
  await act(async () => resolveProjects([project]));
  await waitFor(() =>
    expect(useAppDialogStore.getState().request).toEqual({
      nodeId: commandNodeId(),
      kind: "delete-project",
      projectId: project.id,
    }),
  );
  expect(appCommandStore(uiStore).getState().selectedProjectId).toBe(project.id);
  const first = useAppDialogStore.getState().requestSequence;
  // A rerender does not reopen it.
  await settle();
  expect(useAppDialogStore.getState().requestSequence).toBe(first);
});

test("a host remounted on the same scope resumes without reopening a one-shot dialog", async () => {
  open({ projectId: project.id, dialog: "delete-project" }, <NodeWorkspaceHost />);
  await act(async () => resolveProjects([project]));
  await waitFor(() => expect(useAppDialogStore.getState().request?.kind).toBe("delete-project"));
  const first = useAppDialogStore.getState().requestSequence;
  // Try again after a crash: a new host, on the same node scope and request.
  cleanup();
  render(<NodeWorkspaceHost />);
  await settle();
  expect(useAppDialogStore.getState().requestSequence).toBe(first);
});

test("a board choice made while projects load survives Home activation", async () => {
  open();
  act(() => appCommandStore(uiStore).getState().setProjectBoardTab("kanban"));
  await act(async () => resolveProjects([project]));
  await waitFor(() =>
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe(home.id),
  );
  expect(screen.getByLabelText("Visible workspace").textContent).toBe("kanban");
});

test("a leaf project confirmed to have no checkout falls back to Coordinator after loading", async () => {
  asLeaf();
  open();
  expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("home");
  await act(async () => resolveProjects([{ ...project, localPath: null }]));
  await waitFor(() =>
    expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("coordinator"),
  );
  expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBeNull();
  expect(
    nativeInvoke.mock.calls.some(([command]) => command === "ensure_project_home_environment"),
  ).toBe(false);
});

for (const [grouping, board] of [
  ["repository", false],
  ["repository", true],
  ["machine", false],
  ["machine", true],
  ["project", false],
] as const) {
  const coordinator = board || grouping !== "repository";
  test(`grouped by ${grouping}, remote project ${board ? "Open Board" : "name"} opens ${coordinator ? "Coordinator" : "Home"} on the leaf`, async () => {
    const summary = toNodeProjectSummary(leafId, { ...project }, 0)!;
    const machine = {
      connectionId: leafId,
      backendId: leafId,
      name: "Leaf",
      colorToken: "teal",
      bound: false,
      transport: "connected",
      freshness: "current",
      projects: [summary],
      environmentsByProject: new Map(),
      truncated: false,
      loadedAt: 1,
    } satisfies MachineView;
    const tree = render(
      <RemoteProjectGroup
        machine={machine}
        project={summary}
        environments={[]}
        isCollapsed
        onToggleCollapse={() => {}}
        sortable={false}
        grouping={grouping}
      />,
    );
    const row = screen.getByRole("button", { name: `Open ${project.name} on Leaf` });
    if (board) {
      fireEvent.contextMenu(row);
      fireEvent.click(screen.getByText("Open Board"));
    } else fireEvent.click(row);
    const request = useRemoteWorkspaceStore.getState().requests[leafId]!.request;
    expect(request).toEqual({
      projectId: project.id,
      ...(coordinator ? { boardTab: "coordinator" } : {}),
    });
    tree.unmount();
    asLeaf();
    open(request);
    await act(async () => resolveProjects([project]));
    await waitFor(() =>
      expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe(home.id),
    );
    expect(screen.getByLabelText("Visible workspace").textContent).toBe(
      coordinator ? "coordinator" : home.name,
    );
  });
}

for (const fail of [false, true]) {
  test(`delete request waits for ${fail ? "a successful" : "the delayed"} environment snapshot`, async () => {
    let finish!: (environments: Environment[]) => void;
    let reject!: (error: unknown) => void;
    const snapshot = new Promise<Environment[]>((resolve, no) => {
      finish = resolve;
      reject = no;
    });
    nativeInvoke.mockImplementation(async (command: string) => {
      if (command === "get_projects") return [project];
      if (command === "get_environments") return snapshot;
      return undefined;
    });
    open({ projectId: project.id, dialog: "delete-project" }, <NodeWorkspaceHost />);
    await waitFor(() => expect(appCommandStore(projectStore).getState().hasLoaded).toBe(true));
    expect(useAppDialogStore.getState().request).toBeNull();
    await act(async () => {
      if (fail) reject(new Error("snapshot unavailable"));
      else finish([home]);
    });
    if (fail) expect(useAppDialogStore.getState().request).toBeNull();
    else
      await waitFor(() =>
        expect(useAppDialogStore.getState().request?.kind).toBe("delete-project"),
      );
  });
}

test("repository settings request waits for configuration after projects have loaded", async () => {
  appCommandStore(configStore).setState({ hasLoaded: false });
  open({ projectId: project.id, dialog: "repository-settings" });
  await act(async () => resolveProjects([project]));
  await waitFor(() => expect(appCommandStore(projectStore).getState().hasLoaded).toBe(true));
  expect(useAppDialogStore.getState().request).toBeNull();
  act(() => appCommandStore(configStore).setState({ hasLoaded: true }));
  await waitFor(() =>
    expect(useAppDialogStore.getState().request).toEqual({
      nodeId: commandNodeId(),
      kind: "repository-settings",
      projectId: project.id,
    }),
  );
});

test("a project home opened from another machine's sidebar lands on its Home tab", async () => {
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "get_projects") return [project];
    if (command === "get_environments" || command === "get_environment_snapshots") return [home];
    return undefined;
  });
  open({ projectId: project.id, environmentId: home.id, boardTab: "home" }, <NodeWorkspaceHost />);
  await waitFor(() =>
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe(home.id),
  );
  expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("home");
});

test("environment settings waits for its environment and selects without starting it", async () => {
  let finish!: (environments: Environment[]) => void;
  const snapshot = new Promise<Environment[]>((resolve) => {
    finish = resolve;
  });
  const stopped = { ...home, id: "stopped", projectHome: false, status: "stopped" as const };
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "get_projects") return [project];
    if (command === "get_environments") return snapshot;
    return undefined;
  });
  open(
    { projectId: project.id, environmentId: stopped.id, dialog: "environment-settings" },
    <NodeWorkspaceHost />,
  );
  await waitFor(() => expect(appCommandStore(projectStore).getState().hasLoaded).toBe(true));
  expect(useAppDialogStore.getState().request).toBeNull();
  await act(async () => finish([stopped]));
  await waitFor(() =>
    expect(useAppDialogStore.getState().request).toEqual({
      nodeId: commandNodeId(),
      kind: "environment-settings",
      environmentId: stopped.id,
    }),
  );
  expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe(stopped.id);
  expect(
    nativeInvoke.mock.calls.filter(([command]) => String(command).startsWith("start_environment")),
  ).toEqual([]);
});

test("remote Updates Rebuild reaches the node's visible Container section without starting a stopped environment", async () => {
  const stopped = {
    ...home,
    id: "stopped-container",
    name: "Old container",
    projectHome: false,
    environmentType: "containerized",
    containerId: "container-old",
    status: "stopped",
  } as Environment;
  const snapshot = hostMaintenanceSnapshotFixture({
    image: {
      name: "orkestrator-v2:latest",
      present: true,
      compatible: true,
      reason: null,
      releaseReference: "old",
      outdatedEnvironments: [{ id: stopped.id, projectId: project.id, name: stopped.name }],
    },
  });
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "invoke_on_node") return { outcome: "ok", result: snapshot };
    return undefined;
  });
  const updates = render(
    <MachineUpdatesDialog
      machine={{
        key: leafId,
        role: "node",
        nodeId: leafId,
        name: "Leaf",
        colorToken: "teal",
        connected: true,
        current: false,
        maintenance: true,
        address: null,
        via: "relay",
        statusText: "Connected",
      }}
      open
      onOpenChange={() => {}}
      initial={snapshot}
      onSnapshot={() => {}}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Rebuild Old container" }));
  const request = useRemoteWorkspaceStore.getState().requests[leafId]!.request;
  expect(request.dialog).toBe("environment-rebuild");
  updates.unmount();

  let finish!: (environments: Environment[]) => void;
  const environments = new Promise<Environment[]>((resolve) => {
    finish = resolve;
  });
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "get_projects") return [project];
    if (command === "get_environments") return environments;
    if (command === "get_config") return originalConfig.config;
    if (command === "get_environment_resources") return null;
    if (command === "get_environment_inputs" || command === "get_container_lifecycle_snapshot")
      return null;
    if (command === "list_recovery_copies") return { copies: [], limit: 3 };
    return [];
  });
  open(
    request,
    <>
      <NodeWorkspaceHost />
      <AppDialogHost />
    </>,
  );
  await waitFor(() => expect(appCommandStore(projectStore).getState().hasLoaded).toBe(true));
  expect(useAppDialogStore.getState().request).toBeNull();
  await act(async () => finish([stopped]));
  expect(await screen.findByRole("button", { name: "Rebuild (keeps files)…" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Container" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe(stopped.id);
  expect(
    nativeInvoke.mock.calls.some(([command]) => String(command).startsWith("start_environment")),
  ).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Ports" }));
  expect(screen.getByRole("button", { name: "Ports" }).getAttribute("aria-current")).toBe("page");
  // Another request for the same environment opens the same section.
  const { openDialog } = await import("@/lib/federation/open-workspace");
  act(() => openDialog("environment-rebuild", project.id, stopped.id));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Container" }).getAttribute("aria-current")).toBe(
      "page",
    ),
  );
});

for (const ensured of [false, true]) {
  test(`Home activation marks the window's selection as a project home before summaries refresh (ensured: ${ensured})`, async () => {
    let finish!: (value: Environment) => void;
    const pending = new Promise<Environment>((resolve) => {
      finish = resolve;
    });
    nativeInvoke.mockImplementation(async (command: string) => {
      if (command === "get_projects") return [project];
      if (command === "get_environments" || command === "get_environment_snapshots")
        return ensured ? [] : [home];
      if (command === "ensure_project_home_environment") return ensured ? pending : home;
      return undefined;
    });
    open({ projectId: project.id, boardTab: "coordinator" });
    if (ensured) {
      await waitFor(() =>
        expect(
          nativeInvoke.mock.calls.some(
            ([command]) => command === "ensure_project_home_environment",
          ),
        ).toBe(true),
      );
      await act(async () => finish(home));
    }
    await waitFor(() =>
      expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe(home.id),
    );
    await waitFor(() =>
      expect(getWindowScope().selection.get()).toMatchObject({
        projectId: project.id,
        environmentId: home.id,
        projectHome: true,
      }),
    );
    expect(screen.getByLabelText("Visible workspace").textContent).toBe("coordinator");
  });
}

test("remote worker selection activates its delegated tab after delayed layout hydration", async () => {
  const { paneLayoutStore } = await import("@/stores/paneLayoutStore");
  const original = appCommandStore(paneLayoutStore).getState();
  try {
    appCommandStore(paneLayoutStore).setState({ environments: new Map(), hydration: new Map() });
    open({
      projectId: project.id,
      environmentId: home.id,
      workTarget: {
        type: "worker-tab",
        projectId: project.id,
        environmentId: home.id,
        tabId: "delegated",
      },
    });
    await act(async () => resolveProjects([project]));
    await waitFor(() =>
      expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe(home.id),
    );
    act(() =>
      appCommandStore(paneLayoutStore).setState({
        activeEnvironmentId: home.id,
        hydration: new Map([[home.id, "done"]]),
        environments: new Map([
          [
            home.id,
            {
              containerId: null,
              root: {
                kind: "leaf",
                id: "pane",
                tabs: [
                  { id: "terminal", type: "plain" },
                  {
                    id: "delegated",
                    type: "agent-native",
                    nativeAgentData: { environmentId: home.id, platform: "codex" },
                  },
                ],
                activeTabId: "terminal",
              },
              activePaneId: "pane",
              minimizedPaneIds: [],
            },
          ],
        ]),
      }),
    );
    await waitFor(() =>
      expect(
        appCommandStore(paneLayoutStore)
          .getState()
          .getAllTabs(home.id)
          .find((tab) => tab.id === "delegated"),
      ).toBeDefined(),
    );
    const layout = appCommandStore(paneLayoutStore).getState().environments.get(home.id)!;
    expect(layout.root).toHaveProperty("activeTabId", "delegated");
  } finally {
    appCommandStore(paneLayoutStore).setState(original, true);
  }
});
