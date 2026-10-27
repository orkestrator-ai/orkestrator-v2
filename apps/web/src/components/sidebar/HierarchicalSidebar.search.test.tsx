import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { projectKey, projectRef, type BackendId } from "@orkestrator/protocol/federation";
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
import { HierarchicalSidebar } from "./HierarchicalSidebar";

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

for (const mode of ["machine", "activity", "repository"] as const) {
  test(`search reveals a remote project through the actual sidebar from ${mode} view`, async () => {
    const offline = mode === "repository";
    installDesktopFake({
      list: connectionList([
        remoteConnection("mbp3", "mbp3", "teal", {
          transport: offline ? "unreachable" : "connected",
        }),
      ]),
      datasets: {
        mbp3: {
          projects: [{ id: "tg", name: "telegram-scraper", folder: "Scrapers", order: 0 }],
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
    expectDomAbsent(screen.queryByTitle("Open telegram-scraper on mbp3"), "hidden project");
    fireEvent.click(screen.getByTestId("project-search-trigger"));
    const input = await screen.findByRole("combobox", { name: "Search projects and environments" });
    fireEvent.change(input, { target: { value: "telegram" } });
    await screen.findByRole("option", {
      name: `telegram-scraper, project on mbp3${offline ? ", offline" : ""}`,
    });
    fireEvent.keyDown(input, { key: "Enter" });

    const button = await screen.findByTitle("Open telegram-scraper on mbp3");
    await waitFor(() => expect(button.getAttribute("aria-current")).toBe("true"));
    expect(button.closest("[data-project]")?.getAttribute("data-project")).toBe(key);
    expect(button.closest("[data-project]")?.getAttribute("data-revealed")).toBe("true");
    expectDomAbsent(screen.queryByRole("dialog"), "palette after selection");
    const view = useMachineViewStore.getState();
    expect(view.machineFilter).toBe("all");
    expect(view.grouping).toBe("machine");
    expect(view.collapsedMachines).not.toContain("bk_mbp3");
    expect(view.collapsedProjectKeys).not.toContain(key);
    expect(view.collapsedFolderKeys).not.toContain(folderKey);
    expect(view.recentKeys[0]).toBe(key);
    expect(useUIStore.getState().environmentSortMode).toBe("project");
    expect(useUIStore.getState().selectedProjectId).toBeNull();
    expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
    expect(useProjectStore.getState().projects).toEqual([]);
    expect(useEnvironmentStore.getState().environments).toEqual([]);
    expect(useRemoteWorkspaceStore.getState().active).toBeNull();
  });
}
