import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { projectFolderKey } from "@/lib/project-folders";
import { sidebarFolderKey, useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
import {
  SELF_NODE_ID,
  connectionList,
  installDesktopFake,
  remoteConnection,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import type { Environment, Project } from "@/types";
import { HierarchicalSidebar } from "./HierarchicalSidebar";

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
const key = projectKey(projectRef("bk_mbp3" as BackendId, "tg"));
const folderKey = sidebarFolderKey("bk_mbp3", projectFolderKey("Scrapers"));

beforeEach(() => {
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
  useProjectStore.setState({ projects: [], hasLoaded: true });
  useEnvironmentStore.setState({ environments: [], deletingEnvironments: new Set() });
  useRemoteWorkspaceStore.setState({ active: null });
  useUIStore.setState({
    selectedProjectId: null,
    selectedEnvironmentId: null,
    recentProjectIds: [],
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

for (const { mode, offline } of [
  { mode: "machine", offline: false },
  { mode: "activity", offline: false },
  { mode: "repository", offline: true },
  { mode: "repository", offline: false },
] as const) {
  test(`search reveals and opens a ${offline ? "disconnected" : "connected"} remote project through the actual sidebar from ${mode} view`, async () => {
    installDesktopFake({
      list: connectionList([
        remoteConnection("mbp3", "mbp3", "teal", {
          transport: offline ? "unreachable" : "connected",
        }),
      ]),
      datasets: {
        mbp3: {
          projects: [
            {
              id: "tg",
              name: "telegram-scraper",
              folder: "Scrapers",
              order: 0,
              gitUrl: "https://github.com/acme/telegram-scraper.git",
            },
          ],
          environments: {},
        },
      },
      respondPortal: (command) => (command === "get_projects" ? [] : undefined),
    });
    useUIStore.setState({ environmentSortMode: mode === "activity" ? "activity" : "project" });
    useMachineViewStore.setState({
      grouping: mode === "repository" ? "repository" : "machine",
      machineFilter: SELF_NODE_ID,
      collapsedMachines: ["bk_mbp3"],
      collapsedProjectKeys: [key],
      collapsedFolderKeys: [folderKey],
      revealedProject: null,
      recentKeys: [],
    });
    render(
      <FederationProvider>
        <HierarchicalSidebar />
      </FederationProvider>,
    );
    expectDomAbsent(
      screen.queryByRole("button", { name: "New environment in telegram-scraper on mbp3" }),
      "hidden project",
    );
    fireEvent.click(screen.getByTestId("project-search-trigger"));
    const input = await screen.findByRole("combobox", { name: "Search projects and environments" });
    fireEvent.change(input, { target: { value: "telegram" } });
    await screen.findByRole("option", {
      name: `telegram-scraper, project on mbp3${offline ? ", offline" : ""}`,
    });
    fireEvent.keyDown(input, { key: "Enter" });

    const button = await findProjectHeading("telegram-scraper", "mbp3");
    // Shown in the central region, as a click on the row opens it.
    await waitFor(() => expect(button.getAttribute("aria-current")).toBe("page"));
    expect(button.closest("[data-project]")?.getAttribute("data-project")).toBe(key);
    expect(button.closest("[data-project]")?.getAttribute("data-revealed")).toBe("true");
    expectDomAbsent(screen.queryByRole("dialog"), "palette after selection");
    const view = useMachineViewStore.getState();
    expect(view.machineFilter).toBe("all");
    expect(view.grouping).toBe(mode === "repository" && !offline ? "repository" : "machine");
    expect(view.collapsedMachines).not.toContain("bk_mbp3");
    expect(view.collapsedProjectKeys).not.toContain(key);
    expect(view.collapsedFolderKeys).not.toContain(folderKey);
    expect(view.recentKeys[0]).toBe(key);
    expect(useUIStore.getState().environmentSortMode).toBe("project");
    expect(useUIStore.getState().selectedProjectId).toBeNull();
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
    expect(useProjectStore.getState().projects).toEqual([]);
    expect(useEnvironmentStore.getState().environments).toEqual([]);
    expect(useRemoteWorkspaceStore.getState().active).toEqual({
      nodeId: "bk_mbp3",
      projectId: "tg",
      environmentId: null,
    });
    const request = useRemoteWorkspaceStore.getState().requests.bk_mbp3?.request;
    expect(request).toBeDefined();
    if (mode === "repository" && !offline) {
      // Repository grouping lands on Home, so it must not send a board tab override.
      expect(request).toEqual({ type: "select", projectId: "tg" });
      expect(request).not.toHaveProperty("boardTab");
    } else {
      expect(request).toEqual({ type: "select", projectId: "tg", boardTab: "coordinator" });
    }
  });
}

for (const mode of ["machine", "project", "repository", "activity"] as const) {
  test(`search opens a hidden remote environment without changing ${mode} view or local data`, async () => {
    const localProject: Project = {
      id: "local",
      name: "local-app",
      localPath: "/local",
      gitUrl: "https://github.com/acme/local-app.git",
      addedAt: "2026-01-01T00:00:00Z",
      order: 0,
    };
    const localEnvironment: Environment = {
      id: "local-env",
      projectId: "local",
      name: "local-feature",
      environmentType: "local",
      status: "running",
      branch: "feature",
      containerId: null,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: "2026-01-01T00:00:00Z",
      lastActivityAt: "2026-01-01T00:00:00Z",
      networkAccessMode: "restricted",
      order: 0,
    };
    installDesktopFake({
      list: connectionList([remoteConnection("mbp3", "mbp3", "teal")]),
      layout: { projectFolders: { [key]: "Merged scrapers" } },
      datasets: {
        mbp3: {
          projects: [
            {
              id: "tg",
              name: "telegram-scraper",
              folder: "Scrapers",
              order: 0,
              gitUrl: "https://github.com/acme/telegram-scraper.git",
            },
          ],
          environments: {
            tg: [{ id: "run", projectId: "tg", name: "run-scraper", status: "running" }],
          },
        },
      },
      respondPortal: (command) =>
        command === "get_projects"
          ? [localProject]
          : command === "get_environments" || command === "get_environment_snapshots"
            ? [localEnvironment]
            : undefined,
    });
    useProjectStore.setState({ projects: [localProject], hasLoaded: true });
    useEnvironmentStore.setState({ environments: [localEnvironment] });
    useUIStore.setState({
      environmentSortMode: mode === "activity" ? "activity" : "project",
      activitySortOrder: "oldest",
    });
    const mergedFolder = sidebarFolderKey("project", projectFolderKey("Merged scrapers"));
    const repositoryFolder = sidebarFolderKey("repository", "github.com/acme/telegram-scraper");
    const unrelatedFolder = sidebarFolderKey("bk_other", projectFolderKey("Other"));
    useMachineViewStore.setState({
      grouping: mode === "activity" ? "repository" : mode,
      machineFilter: SELF_NODE_ID,
      collapsedMachines: ["bk_mbp3", "bk_other"],
      collapsedProjectKeys: [key, "unrelated-project"],
      collapsedFolderKeys: [folderKey, mergedFolder, repositoryFolder, unrelatedFolder],
      revealedProject: null,
      recentKeys: [],
    });
    render(
      <FederationProvider>
        <HierarchicalSidebar />
      </FederationProvider>,
    );
    expectDomAbsent(
      screen.queryByRole("button", { name: /^run-scraper, on mbp3/ }),
      "hidden environment",
    );
    fireEvent.click(screen.getByTestId("project-search-trigger"));
    const input = await screen.findByRole("combobox", { name: "Search projects and environments" });
    fireEvent.change(input, { target: { value: "run-scraper" } });
    fireEvent.click(
      await screen.findByRole("option", {
        name: "run-scraper, environment of telegram-scraper on mbp3",
      }),
    );

    const row = await screen.findByRole("button", { name: /^run-scraper, on mbp3/ });
    await waitFor(() => expect(row.getAttribute("aria-current")).toBe("true"));
    expect(useRemoteWorkspaceStore.getState().active).toEqual({
      nodeId: "bk_mbp3",
      projectId: "tg",
      environmentId: "run",
    });
    expect(useRemoteWorkspaceStore.getState().requests.bk_mbp3?.request).toEqual({
      type: "select",
      projectId: "tg",
      environmentId: "run",
    });
    const view = useMachineViewStore.getState();
    expect(view.grouping).toBe(mode === "activity" ? "repository" : mode);
    expect(view.machineFilter).toBe("all");
    expect(view.collapsedMachines).toEqual(["bk_other"]);
    expect(view.collapsedProjectKeys).toEqual(["unrelated-project"]);
    expect(view.collapsedFolderKeys).toEqual([unrelatedFolder]);
    expect(view.revealedProject).toBeNull();
    expect(view.recentKeys.slice(0, 2)).toEqual([
      environmentKey(environmentRef("bk_mbp3" as BackendId, "run")),
      key,
    ]);
    expect(useUIStore.getState().environmentSortMode).toBe(
      mode === "activity" ? "activity" : "project",
    );
    expect(useUIStore.getState().activitySortOrder).toBe("oldest");
    expect(useUIStore.getState().selectedProjectId).toBeNull();
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
    expect(useProjectStore.getState().projects).toEqual([localProject]);
    expect(useEnvironmentStore.getState().environments).toEqual([localEnvironment]);
    expectDomAbsent(screen.queryByRole("dialog"), "palette after environment selection");
  });
}
