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
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
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

/** A project's header button, found through its "+" button, which names project and machine. */
async function findProjectHeading(project: string, machine: string): Promise<HTMLElement> {
  const add = await screen.findByRole("button", {
    name: `New environment in ${project} on ${machine}`,
  });
  return add.parentElement!.querySelector("button")!;
}

const initialView = useMachineViewStore.getState();
const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
const initialEnvironments = useEnvironmentStore.getState();
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
  useUIStore.setState({
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
  useUIStore.setState(initialUI, true);
  useProjectStore.setState(initialProjects, true);
  useEnvironmentStore.setState(initialEnvironments, true);
  useRemoteWorkspaceStore.setState(initialRemote, true);
});

test("a project row stays highlighted while its home is shown, on the command node and on a leaf", async () => {
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
    grouping: "machine",
    machineFilter: "all",
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
    const leafRow = await findProjectHeading("telegram-scraper", "leaf");
    const localRow = await screen.findByRole("button", { name: /^local-app/ });
    const highlighted = () => ({
      local: localRow.getAttribute("aria-current") === "page",
      leaf: leafRow.getAttribute("aria-current") === "page",
    });
    expect(highlighted()).toEqual({ local: false, leaf: false });

    // The command node's project, then its home.
    act(() => useUIStore.getState().selectProject(localProject.id));
    await waitFor(() => expect(highlighted()).toEqual({ local: true, leaf: false }));
    act(() => useUIStore.getState().selectEnvironment(localHome.id));
    expect(highlighted()).toEqual({ local: true, leaf: false });
    // One of its environments.
    act(() => useUIStore.getState().selectEnvironment(localFeature.id));
    expect(highlighted()).toEqual({ local: false, leaf: false });

    // The leaf's project, opened from its row, then its home as the leaf selects it.
    fireEvent.click(leafRow);
    await waitFor(() => expect(highlighted()).toEqual({ local: false, leaf: true }));
    const report = (projectId: string | null, environmentId: string | null) =>
      act(() => selectOnNode("bk_leaf", { projectId, environmentId }));
    report("tg", "tg-home");
    expect(highlighted()).toEqual({ local: false, leaf: true });
    expect(leafRow.closest("[data-project]")?.getAttribute("data-selected")).toBe("true");
    // One of the leaf's environments, chosen in its workspace.
    report("tg", "tg-feature");
    expect(highlighted()).toEqual({ local: false, leaf: false });
    expect(leafRow.closest("[data-project]")?.getAttribute("data-selected")).toBeNull();
    report("tg", "tg-home");
    expect(highlighted()).toEqual({ local: false, leaf: true });

    // Back to the command node's project: the leaf's row lets go.
    act(() => useUIStore.getState().selectProject(localProject.id));
    expect(useRemoteWorkspaceStore.getState().active).toBeNull();
    expect(highlighted()).toEqual({ local: true, leaf: false });
  } finally {
    stopSync();
  }
});

for (const grouping of ["machine", "repository"] as const) {
  test(`bound project icons replace machine homes in ${grouping} grouping`, async () => {
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
    useProjectStore.getState().setProjects([{ ...localProject, icon }]);
    useEnvironmentStore.getState().setEnvironments([]);
    useMachineViewStore.setState({
      grouping,
      machineFilter: "all",
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
}

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
    useProjectStore.getState().setProjects([localProject]);
    useEnvironmentStore
      .getState()
      .setEnvironments(delayed ? [localFeature] : [localHome, localFeature]);
    useMachineViewStore.setState({
      grouping: "repository",
      machineFilter: "all",
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
    await waitFor(() => expect(useUIStore.getState().selectedEnvironmentId).toBe(localHome.id));
    expect(heading.getAttribute("aria-current")).toBe("page");
    expect(useUIStore.getState().projectBoardTab).toBe("coordinator");
    expect(
      heading.closest("[data-project-folder]")!.querySelectorAll('[aria-current="page"]').length,
    ).toBe(1);
    const add = screen.getByRole("button", { name: /New environment in local-app/ });
    const member = add.parentElement!.querySelector("button")!;
    expect(member.getAttribute("aria-current")).toBeNull();
    act(() => useUIStore.getState().selectEnvironment(localFeature.id));
    expect(heading.getAttribute("aria-current")).toBeNull();
    expect(useMachineViewStore.getState().openedRepository).toBeNull();
    fireEvent.click(heading);
    await waitFor(() => expect(heading.getAttribute("aria-current")).toBe("page"));
    fireEvent.click(member);
    await waitFor(() => expect(member.getAttribute("aria-current")).toBe("page"));
    expect(heading.getAttribute("aria-current")).toBeNull();
  });
}
