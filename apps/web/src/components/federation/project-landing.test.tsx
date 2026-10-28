import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import type { MachineView } from "@/lib/federation/aggregate";
import { isMachineShown } from "@/lib/federation/sidebar-layout";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import { portalStore } from "@/lib/portal/portal-store";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";
import { LeafModeCoordinatorGate } from "@/components/projects/LeafModeCoordinatorGate";
import {
  SELF_NODE_ID,
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { MergedProjectList, RemoteMachineSection } from "./FederatedSidebarSections";
import { RemoteProjectGroup } from "./RemoteMachineTree";
import { FederationProvider } from "./FederationProvider";
import { useMachineViews } from "./useMachineViews";

const initialUI = useUIStore.getState();
const initialRemote = useRemoteWorkspaceStore.getState();
const initialMachines = useMachineViewStore.getState();
const MACHINE_A = remoteConnection("a", "Machine A", "teal");
const MACHINE_B = remoteConnection("b", "Machine B", "rose");

beforeEach(() => {
  sessionStorage.clear();
  useMachineViewStore.setState(initialMachines, true);
  useRemoteWorkspaceStore.setState(initialRemote, true);
});

afterEach(() => {
  cleanup();
  uninstallDesktopFake();
  useUIStore.setState(initialUI, true);
  useRemoteWorkspaceStore.setState(initialRemote, true);
  useMachineViewStore.setState(initialMachines, true);
});

function installTwoMachines() {
  return installDesktopFake({
    list: connectionList([MACHINE_A, MACHINE_B]),
    datasets: { a: sharedIdDataset("working"), b: sharedIdDataset("waiting") },
  });
}

function renderWithFederation(node: ReactNode) {
  return render(<FederationProvider>{node}</FederationProvider>);
}

function RemoteSections() {
  const machines = useMachineViews();
  return (
    <>
      {machines
        .filter((machine) => !machine.bound)
        .map((machine) => (
          <RemoteMachineSection key={machine.connectionId} machine={machine} />
        ))}
    </>
  );
}

function machineView(overrides: Partial<MachineView> = {}): MachineView {
  const backendId = "bk_a" as BackendId;
  const project = {
    ref: projectRef(backendId, "project-1"),
    name: "app",
    order: 0,
  };
  const environment: FederatedEnvironment = {
    ref: environmentRef(backendId, "env-1"),
    key: environmentKey(environmentRef(backendId, "env-1")),
    projectId: "project-1",
    name: "feature",
    order: 0,
    status: "running",
    activity: "working",
    hasUnreadWork: false,
    deleting: false,
    isProjectHome: false,
  };
  return {
    connectionId: "a",
    backendId,
    name: "Machine A",
    colorToken: "teal",
    bound: false,
    freshness: "current",
    transport: "connected",
    projects: [{ ...project, key: projectKey(project.ref) }],
    environmentsByProject: new Map([["project-1", [environment]]]),
    truncated: false,
    loadedAt: 1,
    ...overrides,
  };
}

function firstEnvironment(machine: MachineView): FederatedEnvironment {
  return machine.environmentsByProject.get("project-1")![0]!;
}

async function waitForRows(count: number) {
  await waitFor(() =>
    expect(screen.getAllByTestId("federated-environment-row").length).toBe(count),
  );
  return screen.getAllByTestId("federated-environment-row");
}

function rowOf(connectionId: string): HTMLElement {
  const row = screen
    .getAllByTestId("federated-environment-row")
    .find((candidate) => candidate.getAttribute("data-machine") === connectionId);
  if (!row) throw new Error(`no row for ${connectionId}`);
  return row;
}

describe("a project's entry opens on the tab its grouping calls for", () => {
  for (const mode of ["command", "leaf"] as const) {
    test(`a repository heading opens a bound ${mode} node on ${mode === "leaf" ? "Home" : "Coordinator"}`, async () => {
      const initialUI = useUIStore.getState();
      installDesktopFake({
        list: connectionList([]),
        datasets: {},
        respondPortal: (command) =>
          command === "get_node_status"
            ? {
                nodeId: SELF_NODE_ID,
                mode,
                registrationEnabled: true,
                controllers: [],
                detachedControllers: [],
                suspendedSubordinateCount: 0,
              }
            : undefined,
      });
      const bound = machineView({
        connectionId: SELF_NODE_ID,
        backendId: SELF_NODE_ID,
        bound: true,
      });
      bound.projects[0]!.repositoryHint = "github.com/acme/app";
      function Workspace() {
        const projectId = useUIStore((state) => state.selectedProjectId);
        const tab = useUIStore((state) => state.projectBoardTab);
        if (!projectId) return null;
        return tab === "home" ? (
          <div>Project Home</div>
        ) : (
          <LeafModeCoordinatorGate projectId={projectId}>
            <div>Project Coordinator</div>
          </LeafModeCoordinatorGate>
        );
      }
      try {
        useUIStore.setState({ selectedProjectId: null, projectBoardTab: "kanban" });
        renderWithFederation(
          <>
            <MergedProjectList
              machines={[bound]}
              shownIds={new Set([SELF_NODE_ID])}
              mode="repository"
              renderBoundProject={() => null}
              onBoundEnvironmentDragEnd={() => undefined}
            />
            <Workspace />
          </>,
        );
        await waitFor(() => expect(portalStore.getState().status?.mode).toBe(mode));
        const heading = screen.getByRole("button", { name: "Open acme/app on Machine A" });
        for (let click = 0; click < 2; click++) {
          act(() => useUIStore.getState().setProjectBoardTab("kanban"));
          fireEvent.click(heading);
          await waitFor(() =>
            expect(useUIStore.getState().projectBoardTab).toBe(
              mode === "leaf" ? "home" : "coordinator",
            ),
          );
          expect(useUIStore.getState().selectedProjectId).toBe("project-1");
          expect(
            screen.getByText(mode === "leaf" ? "Project Home" : "Project Coordinator"),
          ).toBeTruthy();
          expect(screen.queryByTestId("leaf-mode-coordinator-gate")).toBeNull();
          expect(useRemoteWorkspaceStore.getState().active).toBeNull();
        }
      } finally {
        cleanup();
        useUIStore.setState(initialUI, true);
      }
    });
  }

  for (const truncated of [false, true]) {
    test(`a remote project with ${truncated ? "a Home missing from its truncated summary" : "no Home"} releases its highlight when an environment is selected`, async () => {
      installTwoMachines();
      const machine = machineView({ connectionId: "bk_a", truncated });
      renderWithFederation(
        <RemoteProjectGroup
          machine={machine}
          project={machine.projects[0]!}
          environments={[firstEnvironment(machine)]}
          isCollapsed={false}
          onToggleCollapse={() => {}}
          sortable={false}
          grouping="machine"
        />,
      );
      await waitFor(() => expect(portalStore.getState().loaded).toBe(true));
      const project = screen.getByTitle("Open app on Machine A");
      fireEvent.click(project);
      await waitFor(() => expect(project.getAttribute("aria-current")).toBe("page"));
      const report = (environmentId: string | null) =>
        act(() =>
          useRemoteWorkspaceStore.getState().noteRealmSelection("bk_a", {
            projectId: "project-1",
            environmentId,
          }),
        );
      report("env-1");
      expect(project.getAttribute("aria-current")).toBeNull();
      if (truncated) {
        // An unlisted environment cannot be identified as Home by this summary.
        report("unlisted-home");
        expect(project.getAttribute("aria-current")).toBeNull();
      }
      report(null);
      expect(project.getAttribute("aria-current")).toBe("page");
      act(() => useRemoteWorkspaceStore.getState().showLocal());
      expect(project.getAttribute("aria-current")).toBeNull();
    });
  }

  function installRepository() {
    const datasets = { a: sharedIdDataset("working"), b: sharedIdDataset("waiting") };
    for (const dataset of Object.values(datasets)) {
      dataset.projects = [{ ...dataset.projects[0]!, gitUrl: "git@github.com:Acme/App.git" }];
    }
    return installDesktopFake({ list: connectionList([MACHINE_A, MACHINE_B]), datasets });
  }

  function Merged({ mode }: { mode: "project" | "repository" }) {
    const machines = useMachineViews();
    return (
      <MergedProjectList
        machines={machines}
        shownIds={new Set(machines.filter(isMachineShown).map((machine) => machine.connectionId))}
        mode={mode}
        renderBoundProject={() => null}
        onBoundEnvironmentDragEnd={() => undefined}
      />
    );
  }

  const request = () => useRemoteWorkspaceStore.getState().requests.bk_a?.request;

  for (const [grouping, coordinator] of [
    ["machine", true],
    ["project", true],
    ["repository", false],
  ] as const) {
    test(`grouped by ${grouping}, a leaf's project opens on ${coordinator ? "Coordinator" : "Home"}; its environments open as before`, async () => {
      installRepository();
      renderWithFederation(
        grouping === "machine" ? <RemoteSections /> : <Merged mode={grouping} />,
      );
      await waitForRows(2);

      fireEvent.click(screen.getByTitle("Open app on Machine A"));
      await waitFor(() =>
        expect(request()).toEqual({
          type: "select",
          projectId: "project-1",
          ...(coordinator ? { boardTab: "coordinator" } : {}),
        }),
      );

      fireEvent.click(
        within(rowOf("bk_a")).getByRole("button", { name: /^feature, on Machine A, Working/ }),
      );
      await waitFor(() =>
        expect(request()).toEqual({
          type: "select",
          projectId: "project-1",
          environmentId: "env-1",
        }),
      );

      if (grouping === "repository") {
        // The repository's own entry opens a leaf's copy on its home, too.
        fireEvent.click(screen.getByRole("button", { name: "Open acme/app on Machine A" }));
        await waitFor(() => expect(request()).toEqual({ type: "select", projectId: "project-1" }));
      }
    });
  }
});
