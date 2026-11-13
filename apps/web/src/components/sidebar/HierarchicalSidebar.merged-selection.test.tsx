/**
 * Shift-click range selection in the merged "By project" and "By repository"
 * lists: the range is the rows between the anchor and the click as they are
 * on screen, in the command node's merged order and folders, never this
 * window's own project tree (to-do 2190 (retired), task 7).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { projectKey, projectRef } from "@orkestrator/protocol/federation";
import type { PortalLayout } from "@orkestrator/protocol/portal-layout";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { projectFolderKey } from "@/lib/project-folders";
import { sidebarFolderKey, useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { environmentStore, projectStore, uiStore } from "@/stores";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  SELF_NODE_ID,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import type { Environment, Project } from "@/types";
import { HierarchicalSidebar } from "./HierarchicalSidebar";
import { appCommandStore } from "@/test/app-command-store";

const initialView = useMachineViewStore.getState();
const initialUI = appCommandStore(uiStore).getState();
const initialProjects = appCommandStore(projectStore).getState();
const initialEnvironments = appCommandStore(environmentStore).getState();
const initialRemote = useRemoteWorkspaceStore.getState();

const project = (id: string, order: number, repository: string): Project =>
  ({
    id,
    name: `Project ${id}`,
    gitUrl: `git@github.com:acme/${repository}.git`,
    localPath: `/work/${id}`,
    addedAt: "2026-01-01T00:00:00.000Z",
    order,
  }) as Project;

const environment = (id: string, projectId: string, order: number): Environment =>
  ({
    id,
    projectId,
    name: `Env ${id}`,
    branch: id,
    containerId: null,
    environmentType: "local",
    status: "running",
    worktreePath: `/work/${projectId}/${id}`,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order,
  }) as Environment;

const key = (projectId: string) => projectKey(projectRef(SELF_NODE_ID, projectId));

function renderMerged(
  grouping: "project" | "repository",
  projects: Project[],
  environments: Environment[],
  layout: Partial<PortalLayout>,
  collapsedFolderKeys: string[] = [],
) {
  installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: { projects: [], environments: {} } },
    layout,
    respondPortal: (command, args) =>
      command === "get_projects"
        ? projects
        : command === "get_environments" || command === "get_environment_snapshots"
          ? environments.filter((entry) => entry.projectId === args.projectId)
          : undefined,
  });
  appCommandStore(projectStore).getState().setProjects(projects);
  appCommandStore(environmentStore).getState().setEnvironments(environments);
  useMachineViewStore.setState({
    grouping,
    machineFilter: "all",
    collapsedMachines: [],
    collapsedProjectKeys: [],
    collapsedFolderKeys,
    revealedProject: null,
    recentKeys: [],
  });
  renderInAppCommandScope(
    <FederationProvider>
      <HierarchicalSidebar />
    </FederationProvider>,
  );
}

const row = (id: string) => screen.findByRole("button", { name: new RegExp(`^Env ${id}, on `) });

/** Every environment row's id, top to bottom. */
function rowsOnScreen(): string[] {
  return screen
    .getAllByRole("button", { name: /^Env \w+, on / })
    .map((element) => /^Env (\w+),/.exec(element.getAttribute("aria-label") ?? "")?.[1] ?? "");
}

beforeEach(() => {
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
  useRemoteWorkspaceStore.setState({ active: null });
  appCommandStore(uiStore).setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
    selectedEnvironmentIds: [],
    recentProjectIds: [],
    collapsedProjects: [],
    collapsedProjectFolders: [],
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

test("by project, a shift-click range follows the merged order, not this window's project order", async () => {
  // This window orders p1 before p2; the command node's merged list shows p2 first.
  const projects = [project("p1", 0, "one"), project("p2", 1, "two")];
  const environments = [
    environment("a1", "p1", 0),
    environment("a2", "p1", 1),
    environment("b1", "p2", 0),
  ];
  renderMerged("project", projects, environments, { projectOrder: [key("p2"), key("p1")] });
  await row("a2");
  await waitFor(() => expect(rowsOnScreen()).toEqual(["b1", "a1", "a2"]));
  appCommandStore(uiStore).setState({ selectedProjectId: "p2", selectedEnvironmentId: "b1" });

  fireEvent.click(await row("a1"), { shiftKey: true });
  expect(appCommandStore(uiStore).getState().selectedEnvironmentIds).toEqual(["b1", "a1"]);
});

test("by project, a shift-click range skips a project inside a collapsed merged folder", async () => {
  const projects = [project("p1", 0, "one"), project("p2", 1, "two"), project("p3", 2, "three")];
  const environments = [
    environment("a1", "p1", 0),
    environment("b1", "p2", 0),
    environment("c1", "p3", 0),
  ];
  // The folder exists only in the merged list; this window's own tree has none.
  renderMerged(
    "project",
    projects,
    environments,
    {
      projectOrder: [key("p1"), key("p2"), key("p3")],
      projectFolders: { [key("p2")]: "Shared" },
    },
    [sidebarFolderKey("project", projectFolderKey("Shared"))],
  );
  await row("c1");
  await waitFor(() => expect(rowsOnScreen()).toEqual(["a1", "c1"]));
  appCommandStore(uiStore).setState({ selectedProjectId: "p1", selectedEnvironmentId: "a1" });

  fireEvent.click(await row("c1"), { shiftKey: true });
  expect(appCommandStore(uiStore).getState().selectedEnvironmentIds).toEqual(["a1", "c1"]);
});

test("by repository, a shift-click range follows the repository order", async () => {
  const projects = [project("p1", 0, "one"), project("p2", 1, "two"), project("p3", 2, "three")];
  const environments = [
    environment("a1", "p1", 0),
    environment("b1", "p2", 0),
    environment("c1", "p3", 0),
  ];
  renderMerged("repository", projects, environments, {
    repositoryOrder: [key("p3"), key("p1"), key("p2")],
  });
  await row("c1");
  await waitFor(() => expect(rowsOnScreen()).toEqual(["c1", "a1", "b1"]));
  appCommandStore(uiStore).setState({ selectedProjectId: "p3", selectedEnvironmentId: "c1" });

  fireEvent.click(await row("a1"), { shiftKey: true });
  expect(appCommandStore(uiStore).getState().selectedEnvironmentIds).toEqual(["c1", "a1"]);
});
