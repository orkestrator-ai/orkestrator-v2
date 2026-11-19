import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { FederationEffects } from "@/components/federation/FederationEffects";
import { useProjectHomeActivation } from "@/hooks/useProjectHomeActivation";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { useMachineViewStore } from "@/stores/machineViewStore";
import {
  startRemoteWorkspaceSelectionSync,
  useRemoteWorkspaceStore,
} from "@/stores/remoteWorkspaceStore";
import { environmentStore, projectStore, uiStore } from "@/stores";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import type { Environment, Project } from "@/types";
import { HierarchicalSidebar } from "./HierarchicalSidebar";
import { selectOnNode } from "@/test/node-selection";
import { appCommandStore } from "@/test/app-command-store";

/** A repository heading of the multi-machine list, which opens the repository on a machine. */
function findRepositoryHeading(label: string, machine: string): Promise<HTMLElement> {
  return screen.findByRole("button", { name: `Open ${label} on ${machine}` });
}

/** Whether a bound environment row of the repository list is drawn selected. */
function rowDrawnSelected(name: string): boolean {
  const frame = screen
    .getByRole("button", { name: new RegExp(`^${name}, on `) })
    .closest('[data-testid="repository-environment-row"]')!;
  return frame.firstElementChild!.className.includes("from-selected");
}

const initialView = useMachineViewStore.getState();
const initialUI = appCommandStore(uiStore).getState();
const initialProjects = appCommandStore(projectStore).getState();
const initialEnvironments = appCommandStore(environmentStore).getState();
const initialRemote = useRemoteWorkspaceStore.getState();

const localProject = {
  id: "local",
  name: "local-app",
  gitUrl: "git@github.com:acme/local-app.git",
  localPath: "/local",
  order: 0,
} as Project;
const localEnvironment = (id: string, projectHome: boolean) =>
  ({
    id,
    projectId: localProject.id,
    name: projectHome ? "local-app Home" : "local-feature",
    projectHome,
    environmentType: "local",
    status: "running",
    worktreePath: localProject.localPath,
  }) as Environment;
const localHome = localEnvironment("local-home", true);
const localFeature = localEnvironment("local-feature", false);

beforeEach(() => {
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
  useRemoteWorkspaceStore.setState({ active: null });
  appCommandStore(uiStore).setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
    recentProjectIds: [],
    collapsedProjects: [],
  });
  useUIChromeStore.setState({
    environmentSortMode: "project",
  });
});

afterEach(() => {
  cleanup();
  uninstallDesktopFake();
  useMachineViewStore.setState(initialView, true);
  appCommandStore(uiStore).setState(initialUI, true);
  appCommandStore(projectStore).setState(initialProjects, true);
  appCommandStore(environmentStore).setState(initialEnvironments, true);
  useRemoteWorkspaceStore.setState(initialRemote, true);
});

test("a repository heading stays highlighted while its home is shown, on the command node and on a leaf", async () => {
  installDesktopFake({
    list: connectionList([remoteConnection("leaf", "leaf", "teal")]),
    datasets: {
      leaf: {
        projects: [{ id: "tg", name: "telegram-scraper", order: 0 }],
        environments: {
          tg: [
            { id: "tg-home", projectId: "tg", name: "Home", status: "running", projectHome: true },
            { id: "tg-feature", projectId: "tg", name: "feature", status: "running" },
          ],
        },
      },
    },
    respondPortal: (command) =>
      command === "get_projects"
        ? [localProject]
        : command === "get_environments" || command === "get_environment_snapshots"
          ? [localHome, localFeature]
          : undefined,
  });
  useMachineViewStore.setState({
    grouping: "repository",
    machineFilter: [],
    collapsedMachines: [],
    collapsedProjectKeys: [],
    collapsedFolderKeys: [],
    revealedProject: null,
    recentKeys: [],
  });
  const stopSync = startRemoteWorkspaceSelectionSync();
  try {
    renderInAppCommandScope(
      <FederationProvider>
        <HierarchicalSidebar />
      </FederationProvider>,
    );
    // The leaf's project reports no repository: it is a heading of its own.
    const leafRow = await findRepositoryHeading("telegram-scraper", "leaf");
    const localRow = await screen.findByRole("button", { name: /^Open acme\/local-app on / });
    expect(screen.getByTestId("federated-repository-list")).toBeTruthy();
    const highlighted = () => ({
      local: localRow.getAttribute("aria-current") === "page",
      leaf: leafRow.getAttribute("aria-current") === "page",
    });
    expect(highlighted()).toEqual({ local: false, leaf: false });

    // The command node's project, then its home.
    act(() => appCommandStore(uiStore).getState().selectProject(localProject.id));
    await waitFor(() => expect(highlighted()).toEqual({ local: true, leaf: false }));
    act(() => appCommandStore(uiStore).getState().selectEnvironment(localHome.id));
    expect(highlighted()).toEqual({ local: true, leaf: false });
    // One of its environments.
    act(() => appCommandStore(uiStore).getState().selectEnvironment(localFeature.id));
    expect(highlighted()).toEqual({ local: false, leaf: false });

    // The leaf's project, opened from its row, then its home as the leaf selects it.
    fireEvent.click(leafRow);
    await waitFor(() => expect(highlighted()).toEqual({ local: false, leaf: true }));
    const report = (projectId: string | null, environmentId: string | null) =>
      act(() => selectOnNode("bk_leaf", { projectId, environmentId }));
    report("tg", "tg-home");
    expect(highlighted()).toEqual({ local: false, leaf: true });
    // One of the leaf's environments, chosen in its workspace: its row is selected instead.
    report("tg", "tg-feature");
    expect(highlighted()).toEqual({ local: false, leaf: false });
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: /^feature, on leaf/ })
          .closest('[data-testid="federated-environment-row"]')
          ?.getAttribute("data-selected"),
      ).toBe("true"),
    );
    report("tg", "tg-home");
    expect(highlighted()).toEqual({ local: false, leaf: true });

    // Back to the command node's project: the leaf's row lets go.
    act(() => appCommandStore(uiStore).getState().selectProject(localProject.id));
    expect(useRemoteWorkspaceStore.getState().active).toBeNull();
    expect(highlighted()).toEqual({ local: true, leaf: false });
  } finally {
    stopSync();
  }
});

test("bound project icons replace machine homes on repository headings", async () => {
  const icon = "data:image/png;base64,YQ==";
  installDesktopFake({
    list: connectionList([remoteConnection("leaf", "leaf", "teal")]),
    datasets: { leaf: { projects: [], environments: {} } },
    respondPortal: (command) =>
      command === "get_projects"
        ? [{ ...localProject, icon }]
        : command === "get_environment_snapshots" || command === "get_environments"
          ? []
          : undefined,
  });
  appCommandStore(projectStore)
    .getState()
    .setProjects([{ ...localProject, icon }]);
  appCommandStore(environmentStore).getState().setEnvironments([]);
  useMachineViewStore.setState({
    grouping: "repository",
    machineFilter: [],
    collapsedMachines: [],
    collapsedProjectKeys: [],
    collapsedFolderKeys: [],
    revealedProject: null,
    recentKeys: [],
  });
  renderInAppCommandScope(
    <FederationProvider>
      <HierarchicalSidebar />
    </FederationProvider>,
  );
  const image = await screen.findByTestId("project-icon");
  expect(image.getAttribute("src")).toBe(icon);
  const row = image.closest("button")!;
  expect(row.textContent).toContain("local-app");
  expect(within(row).queryByTestId("machine-home-icon") === null).toBe(true);
});

for (const delayed of [false, true]) {
  test(`repository heading keeps bound Home selection (ensure delayed: ${delayed}) and hands back to explicit navigation`, async () => {
    let finish!: (home: Environment) => void;
    const pending = new Promise<Environment>((resolve) => {
      finish = resolve;
    });
    installDesktopFake({
      list: connectionList([remoteConnection("leaf", "leaf", "teal")]),
      datasets: { leaf: { projects: [], environments: {} } },
      respondPortal: (command) => {
        if (command === "get_projects") return [localProject];
        if (command === "get_environments" || command === "get_environment_snapshots")
          return delayed ? [localFeature] : [localHome, localFeature];
        if (command === "ensure_project_home_environment") return delayed ? pending : localHome;
        return undefined;
      },
    });
    appCommandStore(projectStore).getState().setProjects([localProject]);
    appCommandStore(environmentStore)
      .getState()
      .setEnvironments(delayed ? [localFeature] : [localHome, localFeature]);
    useMachineViewStore.setState({
      grouping: "repository",
      machineFilter: [],
      collapsedFolderKeys: [],
      collapsedProjectKeys: [],
      openedRepository: null,
    });
    function Activation() {
      useProjectHomeActivation();
      return null;
    }
    renderInAppCommandScope(
      <FederationProvider>
        <FederationEffects />
        <HierarchicalSidebar />
        <Activation />
      </FederationProvider>,
    );
    const heading = await screen.findByRole("button", { name: /Open acme\/local-app on/ });
    fireEvent.click(heading);
    if (delayed) {
      expect(heading.getAttribute("aria-current")).toBe("page");
      await act(async () => finish(localHome));
    }
    await waitFor(() =>
      expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe(localHome.id),
    );
    expect(heading.getAttribute("aria-current")).toBe("page");
    expect(appCommandStore(uiStore).getState().projectBoardTab).toBe("coordinator");
    expect(
      heading.closest("[data-project-folder]")!.querySelectorAll('[aria-current="page"]').length,
    ).toBe(1);
    // No per-machine member heading is drawn under the repository.
    expect(screen.queryByRole("button", { name: /^Open local-app/ }) === null).toBe(true);
    expect(rowDrawnSelected("local-feature")).toBe(false);
    act(() => appCommandStore(uiStore).getState().selectEnvironment(localFeature.id));
    expect(heading.getAttribute("aria-current")).toBeNull();
    expect(useMachineViewStore.getState().openedRepository).toBeNull();
    expect(rowDrawnSelected("local-feature")).toBe(true);
    fireEvent.click(heading);
    await waitFor(() => expect(heading.getAttribute("aria-current")).toBe("page"));
    expect(rowDrawnSelected("local-feature")).toBe(false);
    // Explicit navigation to an environment row hands the highlight to the row.
    fireEvent.click(screen.getByRole("button", { name: /^local-feature, on / }));
    await waitFor(() => expect(rowDrawnSelected("local-feature")).toBe(true));
    expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe(localFeature.id);
    expect(heading.getAttribute("aria-current")).toBeNull();
  });
}
