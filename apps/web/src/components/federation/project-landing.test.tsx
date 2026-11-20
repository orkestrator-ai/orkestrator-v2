import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
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
import { uiStore, useUIStore } from "@/stores/uiStore";
import { LeafModeCoordinatorGate } from "@/components/projects/LeafModeCoordinatorGate";
import {
  SELF_NODE_ID,
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { FederationProvider } from "./FederationProvider";
import { NO_BOUND_ROWS } from "./federation-ui-test-fixture";
import { RepositoryEnvironmentList } from "./RepositoryEnvironmentList";
import { useMachineViews } from "./useMachineViews";
import { selectOnNode } from "@/test/node-selection";
import { appCommandStore } from "@/test/app-command-store";

/** A repository's heading, named by what it opens and the machine it opens on. */
function projectHeading(project: string, machine: string): HTMLElement {
  return screen.getByRole("button", { name: `Open ${project} on ${machine}` });
}

const initialUI = appCommandStore(uiStore).getState();
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
  appCommandStore(uiStore).setState(initialUI, true);
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
  return renderInAppCommandScope(<FederationProvider>{node}</FederationProvider>);
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
      const initialUI = appCommandStore(uiStore).getState();
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
        appCommandStore(uiStore).setState({ selectedProjectId: null, projectBoardTab: "kanban" });
        renderWithFederation(
          <>
            <RepositoryEnvironmentList
              machines={[bound]}
              shownIds={new Set([SELF_NODE_ID])}
              ordering="machine"
              bound={NO_BOUND_ROWS}
            />
            <Workspace />
          </>,
        );
        await waitFor(() => expect(portalStore.getState().status?.mode).toBe(mode));
        const heading = screen.getByRole("button", { name: "Open acme/app on Machine A" });
        // A previous command-mode Coordinator memory must not reopen the leaf gate.
        if (mode === "leaf") {
          act(() =>
            appCommandStore(uiStore).setState({ projectBoardTabs: [["project-1", "coordinator"]] }),
          );
        }
        // Another project's tab is not this one's: it opens on its landing tab.
        act(() => appCommandStore(uiStore).getState().setProjectBoardTab("kanban"));
        fireEvent.click(heading);
        await waitFor(() =>
          expect(appCommandStore(uiStore).getState().projectBoardTab).toBe(
            mode === "leaf" ? "home" : "coordinator",
          ),
        );
        expect(appCommandStore(uiStore).getState().selectedProjectId).toBe("project-1");
        expect(
          screen.getByText(mode === "leaf" ? "Project Home" : "Project Coordinator"),
        ).toBeTruthy();
        expect(screen.queryByTestId("leaf-mode-coordinator-gate") === null).toBe(true);
        expect(useRemoteWorkspaceStore.getState().active).toBeNull();
        expect(heading.getAttribute("aria-current")).toBe("page");
        // Left on Kanban, the heading returns the project to Kanban.
        act(() => appCommandStore(uiStore).getState().setProjectBoardTab("kanban"));
        act(() => appCommandStore(uiStore).getState().selectProject(null));
        fireEvent.click(heading);
        await waitFor(() =>
          expect(appCommandStore(uiStore).getState().selectedProjectId).toBe("project-1"),
        );
        expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("kanban");
        expect(heading.getAttribute("aria-current")).toBe("page");
        if (mode === "command") {
          fireEvent.contextMenu(heading);
          fireEvent.click(screen.getByText("Open Coordinator"));
          await waitFor(() =>
            expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("coordinator"),
          );
        }
      } finally {
        cleanup();
        appCommandStore(uiStore).setState(initialUI, true);
      }
    });
  }

  for (const truncated of [false, true]) {
    test(`a remote project with ${truncated ? "a Home missing from its truncated summary" : "no Home"} releases its highlight when an environment is selected`, async () => {
      installTwoMachines();
      const machine = machineView({ connectionId: "bk_a", truncated });
      renderWithFederation(
        <RepositoryEnvironmentList
          machines={[machine]}
          shownIds={new Set([machine.connectionId])}
          ordering="machine"
          bound={NO_BOUND_ROWS}
        />,
      );
      await waitFor(() => expect(portalStore.getState().loaded).toBe(true));
      const project = projectHeading("app", "Machine A");
      fireEvent.click(project);
      await waitFor(() => expect(project.getAttribute("aria-current")).toBe("page"));
      const report = (environmentId: string | null) =>
        act(() =>
          selectOnNode("bk_a", {
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

  function RepositoryList() {
    const machines = useMachineViews();
    return (
      <RepositoryEnvironmentList
        machines={machines}
        shownIds={new Set(machines.filter(isMachineShown).map((machine) => machine.connectionId))}
        ordering="machine"
        bound={NO_BOUND_ROWS}
      />
    );
  }

  const request = () => useRemoteWorkspaceStore.getState().requests.bk_a?.request;

  test("a leaf's repository opens on its coordinator and is highlighted; its environments open as before", async () => {
    installRepository();
    renderWithFederation(<RepositoryList />);
    await waitForRows(2);

    // With no copy on the command node, the repository's heading opens the
    // first machine's copy on its coordinator.
    const repository = projectHeading("acme/app", "Machine A");
    act(() =>
      useMachineViewStore
        .getState()
        .revealProject(projectKey(projectRef("bk_a" as BackendId, "project-1"))),
    );
    expect(repository.closest("[data-revealed]")).not.toBeNull();
    fireEvent.click(repository);
    await waitFor(() =>
      expect(request()).toEqual({
        projectId: "project-1",
        landingTab: "coordinator",
      }),
    );
    expect(repository.getAttribute("aria-current")).toBe("page");
    expect(useMachineViewStore.getState().revealedProject).toBeNull();
    expect(useMachineViewStore.getState().openedRepository).toEqual({
      name: "github.com/acme/app",
      projectKey: projectKey(projectRef("bk_a" as BackendId, "project-1")),
    });

    // The node can ensure Home before the shell's next summary arrives.
    act(() =>
      selectOnNode("bk_a", {
        projectId: "project-1",
        environmentId: "ensured-home",
        projectHome: true,
      }),
    );
    expect(repository.getAttribute("aria-current")).toBe("page");
    expect(useRemoteWorkspaceStore.getState().requests.bk_a?.request.landingTab).toBe(
      "coordinator",
    );

    // Anything else the node selects takes the highlight.
    act(() => selectOnNode("bk_a", { projectId: "project-1", environmentId: "env-1" }));
    expect(repository.getAttribute("aria-current")).toBeNull();

    // Its rows (on both machines) open their environment on their own machine.
    fireEvent.click(
      within(rowOf("bk_a")).getByRole("button", { name: /^feature, on Machine A, Working/ }),
    );
    await waitFor(() =>
      expect(request()).toEqual({
        projectId: "project-1",
        environmentId: "env-1",
      }),
    );
  });
});
