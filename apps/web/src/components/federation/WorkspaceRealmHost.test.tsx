import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toNodeProjectSummary } from "@orkestrator/protocol/node-summaries";
import type { BackendId } from "@orkestrator/protocol/federation";
import { hostMaintenanceSnapshotFixture } from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import { AppDialogHost } from "@/components/layout/AppDialogHost";
import { MachineUpdatesDialog } from "@/components/settings/machines/MachineUpdatesDialog";
import { useProjectHomeActivation } from "@/hooks/useProjectHomeActivation";
import { invoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import { realmSearchParams, type RealmSelectRequest } from "@/lib/federation/workspace-realm";
import type { MachineView } from "@/lib/federation/aggregate";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
import { useConfigStore } from "@/stores/configStore";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useFilesPanelStore } from "@/stores/filesPanelStore";
import { useRealmShellStore } from "@/stores/realmShellStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import type { Environment, Project } from "@/types";
import { RemoteProjectGroup } from "./RemoteMachineTree";
import { WorkspaceRealmHost } from "./WorkspaceRealmHost";

const happyDOM = (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM;
const originalHref = window.location.href;
const originalNative = window.orkestrator;
const originalPortal = portalStore.getState();
const originalRemote = useRemoteWorkspaceStore.getState();
const originalUI = useUIStore.getState();
const originalConfig = useConfigStore.getState();
const originalProjects = useProjectStore.getState();
const originalEnvironments = useEnvironmentStore.getState();
const nativeInvoke = invoke as ReturnType<typeof mock>;
const nodeId = "bk_leaf" as BackendId;
const project = { id: "project", name: "Checkout", localPath: "/checkout", order: 0 } as Project;
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

// This is the same tab/environment visibility decision made by the app shell,
// without mounting terminals and native agents in a navigation regression test.
function RealmWorkspace() {
  useProjectHomeActivation();
  const tab = useUIStore((state) => state.projectBoardTab);
  const environmentId = useUIStore((state) => state.selectedEnvironmentId);
  const environment = useEnvironmentStore((state) =>
    state.environments.find((entry) => entry.id === environmentId),
  );
  return (
    <>
      <WorkspaceRealmHost />
      <output aria-label="Visible workspace">
        {tab === "home" ? (environment?.name ?? "Loading Home") : tab}
      </output>
    </>
  );
}

function openRealm(request: Omit<RealmSelectRequest, "type"> = { projectId: project.id }) {
  happyDOM.setURL(`http://localhost/?${realmSearchParams(request)}`);
  window.orkestratorWorkspaceTarget = { nodeId, nodeName: "Leaf", path: "relay" } as never;
  return render(<RealmWorkspace />);
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
  useProjectStore.setState({
    projects: [],
    hasLoaded: false,
    isLoading: false,
    deletingProjects: new Set(),
  });
  useEnvironmentStore.setState({ environments: [], deletingEnvironments: new Set() });
  useUIStore.setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
    projectBoardTab: "coordinator",
  });
  useRemoteWorkspaceStore.setState(originalRemote, true);
});

afterEach(() => {
  cleanup();
  happyDOM.setURL(originalHref);
  window.orkestrator = originalNative;
  delete window.orkestratorWorkspaceTarget;
  useAppDialogStore.setState({ request: null });
  useConfigStore.setState(originalConfig, true);
  useUIStore.setState(originalUI, true);
  useProjectStore.setState(originalProjects, true);
  useEnvironmentStore.setState(originalEnvironments, true);
  portalStore.store.setState(originalPortal, true);
  useRemoteWorkspaceStore.setState(originalRemote, true);
});

test("initial leaf selection keeps Home through a delayed project snapshot and displays its environment", async () => {
  openRealm();
  await waitFor(() => expect(useUIStore.getState().selectedProjectId).toBe(project.id));
  expect(useUIStore.getState().projectBoardTab).toBe("home");
  expect(
    nativeInvoke.mock.calls.some(([command]) => command === "ensure_project_home_environment"),
  ).toBe(false);
  await act(async () => resolveProjects([project]));
  await waitFor(() =>
    expect(screen.getByLabelText("Visible workspace").textContent).toBe(home.name),
  );
  expect(useUIStore.getState().selectedEnvironmentId).toBe(home.id);
  expect(useUIStore.getState().projectBoardTab).toBe("home");
});

test("a project dialog asked of the realm opens once the node's projects have loaded", async () => {
  useAppDialogStore.setState({ request: null });
  openRealm({ projectId: project.id, dialog: "delete-project" });
  // The dialog reads the project from the node's list, so it waits for it.
  expect(useAppDialogStore.getState().request).toBeNull();
  await act(async () => resolveProjects([project]));
  await waitFor(() =>
    expect(useAppDialogStore.getState().request).toEqual({
      kind: "delete-project",
      projectId: project.id,
    }),
  );
  expect(useUIStore.getState().selectedProjectId).toBe(project.id);
  useAppDialogStore.setState({ request: null });
});

test("a board choice made while projects load survives Home activation", async () => {
  openRealm();
  act(() => useUIStore.getState().setProjectBoardTab("kanban"));
  await act(async () => resolveProjects([project]));
  await waitFor(() => expect(useUIStore.getState().selectedEnvironmentId).toBe(home.id));
  expect(screen.getByLabelText("Visible workspace").textContent).toBe("kanban");
});

test("a leaf project confirmed to have no checkout falls back to Coordinator after loading", async () => {
  openRealm();
  expect(useUIStore.getState().projectBoardTab).toBe("home");
  await act(async () => resolveProjects([{ ...project, localPath: null }]));
  await waitFor(() => expect(useUIStore.getState().projectBoardTab).toBe("coordinator"));
  expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
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
  test(`grouped by ${grouping}, remote project ${board ? "Open Board" : "name"} opens ${coordinator ? "Coordinator" : "Home"} in a leaf realm`, async () => {
    const summary = toNodeProjectSummary(nodeId, { ...project }, 0)!;
    const machine = {
      connectionId: nodeId,
      backendId: nodeId,
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
    const request = useRemoteWorkspaceStore.getState().requests[nodeId]!.request;
    expect(request).toEqual({
      type: "select",
      projectId: project.id,
      ...(coordinator ? { boardTab: "coordinator" } : {}),
    });
    tree.unmount();
    openRealm(request);
    await act(async () => resolveProjects([project]));
    await waitFor(() => expect(useUIStore.getState().selectedEnvironmentId).toBe(home.id));
    expect(screen.getByLabelText("Visible workspace").textContent).toBe(
      coordinator ? "coordinator" : home.name,
    );
  });
}

test("panel messages leave sidebar and selection untouched; only sidebar messages change its visibility", async () => {
  let deliver: (message: unknown) => void = () => undefined;
  window.orkestrator = {
    ...originalNative,
    workspaceRealm: {
      post: () => undefined,
      onMessage: (callback: (message: unknown) => void) => {
        deliver = callback;
        return () => {
          deliver = () => undefined;
        };
      },
    },
  } as typeof window.orkestrator;
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "get_projects") return [];
    return undefined;
  });
  useProjectStore.setState({ projects: [], hasLoaded: true });
  useUIStore.setState({ sidebarOpen: true, selectedProjectId: null, selectedEnvironmentId: null });
  render(<WorkspaceRealmHost />);
  await waitFor(() => expect(useProjectStore.getState().isLoading).toBe(false));
  const selection = useUIStore.getState().projectSelectionRevision;
  for (const open of [false, true]) {
    act(() => deliver({ type: "panel", panel: "agent", open, inset: 6, seq: 1 }));
    expect(useUIStore.getState().sidebarOpen).toBe(true);
    expect(useUIStore.getState().projectSelectionRevision).toBe(selection);
  }
  act(() => deliver({ type: "sidebar", open: false }));
  expect(useUIStore.getState().sidebarOpen).toBe(false);
  act(() => deliver({ type: "panel", panel: "usage", open: true, inset: 6, seq: 2 }));
  expect(useUIStore.getState().sidebarOpen).toBe(false);
  expect(useUIStore.getState().projectSelectionRevision).toBe(selection);
  // The window's grouping is kept for the coordinator gate.
  act(() => deliver({ type: "grouping", grouping: "project" }));
  expect(useRealmShellStore.getState().grouping).toBe("project");
  useRealmShellStore.setState({ grouping: null });
});

test("the files panel follows the window, and only a choice made here is reported back", async () => {
  let deliver: (message: unknown) => void = () => undefined;
  const post = mock((_message: unknown) => undefined);
  window.orkestrator = {
    ...originalNative,
    workspaceRealm: {
      post,
      onMessage: (callback: (message: unknown) => void) => {
        deliver = callback;
        return () => {
          deliver = () => undefined;
        };
      },
    },
  } as typeof window.orkestrator;
  nativeInvoke.mockImplementation(async (command: string) => {
    if (command === "get_projects") return [];
    return undefined;
  });
  useProjectStore.setState({ projects: [], hasLoaded: true });
  useFilesPanelStore.setState({ isOpen: false });
  render(<WorkspaceRealmHost />);
  await waitFor(() => expect(useProjectStore.getState().isLoading).toBe(false));
  const reports = () =>
    post.mock.calls
      .map(([message]) => message as { type: string; open?: boolean })
      .filter((message) => message.type === "filesPanel");

  // Applying the window's state is not a choice: reporting it would echo forever.
  act(() => deliver({ type: "filesPanel", open: true }));
  expect(useFilesPanelStore.getState().isOpen).toBe(true);
  act(() => deliver({ type: "filesPanel", open: false }));
  expect(useFilesPanelStore.getState().isOpen).toBe(false);
  expect(reports()).toEqual([]);

  // The toolbar's toggle and an opened pull request both reach the window.
  act(() => useFilesPanelStore.getState().togglePanel());
  expect(reports()).toEqual([{ type: "filesPanel", open: true }]);
  act(() => useFilesPanelStore.getState().closePanel());
  act(() =>
    useFilesPanelStore.getState().openPullRequest("target", { owner: "o", repo: "r", number: 1 }),
  );
  expect(reports().slice(1)).toEqual([
    { type: "filesPanel", open: false },
    { type: "filesPanel", open: true },
  ]);
  useFilesPanelStore.setState({ isOpen: false, activeTab: "changes", pullRequestTabs: {} });
});

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
    useAppDialogStore.setState({ request: null });
    happyDOM.setURL(
      `http://localhost/?${realmSearchParams({ projectId: project.id, dialog: "delete-project" })}`,
    );
    render(<WorkspaceRealmHost />);
    await waitFor(() => expect(useProjectStore.getState().hasLoaded).toBe(true));
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
  useConfigStore.setState({ hasLoaded: false });
  useAppDialogStore.setState({ request: null });
  openRealm({ projectId: project.id, dialog: "repository-settings" });
  await act(async () => resolveProjects([project]));
  await waitFor(() => expect(useProjectStore.getState().hasLoaded).toBe(true));
  expect(useAppDialogStore.getState().request).toBeNull();
  act(() => useConfigStore.setState({ hasLoaded: true }));
  await waitFor(() =>
    expect(useAppDialogStore.getState().request).toEqual({
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
  happyDOM.setURL(
    `http://localhost/?${realmSearchParams({ projectId: project.id, environmentId: home.id, boardTab: "home" })}`,
  );
  window.orkestratorWorkspaceTarget = { nodeId, nodeName: "Leaf", path: "relay" } as never;
  render(<WorkspaceRealmHost />);
  await waitFor(() => expect(useUIStore.getState().selectedEnvironmentId).toBe(home.id));
  expect(useUIStore.getState().projectBoardTab).toBe("home");
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
  useAppDialogStore.setState({ request: null });
  happyDOM.setURL(
    `http://localhost/?${realmSearchParams({ projectId: project.id, environmentId: stopped.id, dialog: "environment-settings" })}`,
  );
  render(<WorkspaceRealmHost />);
  await waitFor(() => expect(useProjectStore.getState().hasLoaded).toBe(true));
  expect(useAppDialogStore.getState().request).toBeNull();
  expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
  await act(async () => finish([stopped]));
  await waitFor(() =>
    expect(useAppDialogStore.getState().request).toEqual({
      kind: "environment-settings",
      environmentId: stopped.id,
    }),
  );
  expect(useUIStore.getState().selectedEnvironmentId).toBe(stopped.id);
  expect(
    nativeInvoke.mock.calls.filter(([command]) => String(command).startsWith("start_environment")),
  ).toEqual([]);
});

test("remote Updates Rebuild reaches the loaded realm's visible Container section without starting a stopped environment", async () => {
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
        key: nodeId,
        role: "node",
        nodeId,
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
  const request = useRemoteWorkspaceStore.getState().requests[nodeId]!.request;
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
  happyDOM.setURL(`http://localhost/?${realmSearchParams(request)}`);
  window.orkestratorWorkspaceTarget = { nodeId, nodeName: "Leaf", path: "relay" } as never;
  render(
    <>
      <WorkspaceRealmHost />
      <AppDialogHost />
    </>,
  );
  await waitFor(() => expect(useProjectStore.getState().hasLoaded).toBe(true));
  expect(useAppDialogStore.getState().request).toBeNull();
  await act(async () => finish([stopped]));
  expect(await screen.findByRole("button", { name: "Rebuild (keeps files)…" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Container" }).getAttribute("aria-current")).toBe(
    "page",
  );
  expect(useUIStore.getState().selectedEnvironmentId).toBe(stopped.id);
  expect(
    nativeInvoke.mock.calls.some(([command]) => String(command).startsWith("start_environment")),
  ).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Ports" }));
  expect(screen.getByRole("button", { name: "Ports" }).getAttribute("aria-current")).toBe("page");
  // Another request through the realm uses the same environment and section.
  const { openDialog } = await import("@/lib/federation/open-workspace");
  act(() => openDialog("environment-rebuild", project.id, stopped.id));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Container" }).getAttribute("aria-current")).toBe(
      "page",
    ),
  );
});
