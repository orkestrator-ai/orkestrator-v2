import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toNodeProjectSummary } from "@orkestrator/protocol/node-summaries";
import type { BackendId } from "@orkestrator/protocol/federation";
import { useProjectHomeActivation } from "@/hooks/useProjectHomeActivation";
import { invoke } from "@/lib/native/backend";
import { portalStore } from "@/lib/portal/portal-store";
import { realmSearchParams, type RealmSelectRequest } from "@/lib/federation/workspace-realm";
import type { MachineView } from "@/lib/federation/aggregate";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
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

for (const board of [false, true]) {
  test(`remote project ${board ? "Open Board opens Coordinator" : "name opens Home"} in a leaf realm`, async () => {
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
      />,
    );
    const row = screen.getByRole("button", { name: project.name });
    if (board) {
      fireEvent.contextMenu(row);
      fireEvent.click(screen.getByText("Open Board"));
    } else fireEvent.click(row);
    const request = useRemoteWorkspaceStore.getState().requests[nodeId]!.request;
    expect(request).toEqual({
      type: "select",
      projectId: project.id,
      ...(board ? { boardTab: "coordinator" } : {}),
    });
    tree.unmount();
    openRealm(request);
    await act(async () => resolveProjects([project]));
    await waitFor(() => expect(useUIStore.getState().selectedEnvironmentId).toBe(home.id));
    expect(screen.getByLabelText("Visible workspace").textContent).toBe(
      board ? "coordinator" : home.name,
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
