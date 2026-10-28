import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { useMachineViewStore } from "@/stores/machineViewStore";
import {
  startRemoteWorkspaceSelectionSync,
  useRemoteWorkspaceStore,
} from "@/stores/remoteWorkspaceStore";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import type { Environment, Project } from "@/types";
import { HierarchicalSidebar } from "./HierarchicalSidebar";

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
    environmentSortMode: "project",
    collapsedProjects: [],
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
    render(
      <FederationProvider>
        <HierarchicalSidebar />
      </FederationProvider>,
    );
    const leafRow = await screen.findByTitle("Open telegram-scraper on leaf");
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

    // The leaf's project, opened from its row, then its home as the realm reports it.
    fireEvent.click(leafRow);
    await waitFor(() => expect(highlighted()).toEqual({ local: false, leaf: true }));
    const report = (projectId: string | null, environmentId: string | null) =>
      act(() =>
        useRemoteWorkspaceStore
          .getState()
          .noteRealmSelection("bk_leaf", { projectId, environmentId }),
      );
    report("tg", "tg-home");
    expect(highlighted()).toEqual({ local: false, leaf: true });
    expect(leafRow.closest("[data-project]")?.getAttribute("data-selected")).toBe("true");
    // One of the leaf's environments, chosen in its realm.
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
