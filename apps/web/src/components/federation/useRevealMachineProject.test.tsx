import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { mockToastInfo, resetSonnerMocks } from "../../../../../tests/mocks/sonner";
import { projectFolderKey } from "@/lib/project-folders";
import { portalStore } from "@/lib/portal/portal-store";
import {
  SELF_NODE_ID,
  connectionList,
  installDesktopFake,
  remoteConnection,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { sidebarFolderKey, useMachineViewStore } from "@/stores/machineViewStore";
import { useUIStore } from "@/stores/uiStore";
import { MergedProjectList, RemoteMachineSection } from "./FederatedSidebarSections";
import { isMachineShown } from "@/lib/federation/sidebar-layout";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { FederationEffects } from "./FederationEffects";
import { FederationProvider } from "./FederationProvider";
import { useMachineViews } from "./useMachineViews";
import { useRevealMachineProject } from "./useRevealMachineProject";

const INITIAL_REMOTE_STATE = useRemoteWorkspaceStore.getState();
const INITIAL_MACHINE_VIEW_STATE = useMachineViewStore.getState();
const MBP3 = remoteConnection("mbp3", "mbp3", "teal");
const key = projectKey(projectRef("bk_mbp3" as BackendId, "tg"));

/** What the harness last rendered with, captured after each commit. */
const captured: {
  reveal: ReturnType<typeof useRevealMachineProject> | null;
  machines: ReturnType<typeof useMachineViews>;
} = { reveal: null, machines: [] };

function projectRow() {
  return Array.from(document.querySelectorAll("[data-project]")).find(
    (row) => row.getAttribute("data-project") === key,
  );
}

function Harness() {
  const reveal = useRevealMachineProject();
  const machines = useMachineViews();
  const grouping = useMachineViewStore((state) => state.grouping);
  const sort = useUIStore((state) => state.environmentSortMode);
  useEffect(() => {
    captured.reveal = reveal;
    captured.machines = machines;
  });
  if (sort === "activity") return null;
  if (grouping !== "machine") {
    return (
      <MergedProjectList
        machines={machines}
        shownIds={new Set(machines.filter(isMachineShown).map((m) => m.connectionId))}
        mode={grouping}
        renderBoundProject={() => null}
        onBoundEnvironmentDragEnd={() => {}}
      />
    );
  }
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

describe("useRevealMachineProject", () => {
  beforeEach(() => {
    if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
    localStorage.removeItem("machine-view-storage");
    useRemoteWorkspaceStore.setState(INITIAL_REMOTE_STATE, true);
    useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
    useUIStore.setState({ environmentSortMode: "project" });
    resetSonnerMocks();
    installDesktopFake({
      list: connectionList([MBP3]),
      datasets: {
        mbp3: {
          projects: [{ id: "tg", name: "telegram-scraper", order: 0, folder: "Scrapers" }],
          environments: {},
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
    uninstallDesktopFake();
    useRemoteWorkspaceStore.setState(INITIAL_REMOTE_STATE, true);
    useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
    useUIStore.setState({ environmentSortMode: "project" });
    localStorage.removeItem("machine-view-storage");
    captured.reveal = null;
    captured.machines = [];
  });

  function renderHarness() {
    return render(
      <FederationProvider>
        <Harness />
      </FederationProvider>,
    );
  }

  async function revealIn() {
    renderHarness();
    const machine = await waitFor(() => {
      const found = captured.machines.find((candidate) => candidate.name === "mbp3");
      if (!found || found.projects.length === 0) throw new Error("mbp3 not loaded");
      return found;
    });
    act(() => captured.reveal!(machine, "tg"));
  }

  test("expands its machine, folder and project, clears a hiding filter and highlights it", async () => {
    useMachineViewStore.setState({
      machineFilter: "bk_other",
      collapsedMachines: ["bk_mbp3"],
      collapsedProjectKeys: [key],
      collapsedFolderKeys: [sidebarFolderKey("bk_mbp3", projectFolderKey("Scrapers"))],
    });
    await revealIn();
    const views = useMachineViewStore.getState();
    expect(views.machineFilter).toBe("all");
    expect(views.collapsedMachines).not.toContain("bk_mbp3");
    expect(views.collapsedProjectKeys).not.toContain(key);
    expect(views.collapsedFolderKeys).toEqual([]);
    expect(views.recentKeys[0]).toBe(key);
    expect(views.revealedProject?.key).toBe(key);
    const row = await waitFor(() => {
      const found = Array.from(document.querySelectorAll("[data-project]")).find(
        (candidate) => candidate.getAttribute("data-project") === key,
      );
      if (!found) throw new Error("project row not rendered");
      return found;
    });
    expect(row.getAttribute("data-revealed")).toBe("true");
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  test("this window's own selections are recorded as recent and end the highlight", async () => {
    render(
      <FederationProvider>
        <FederationEffects />
      </FederationProvider>,
    );
    await waitFor(() => expect(portalStore.getState().selfId).toBe(SELF_NODE_ID));
    act(() => useMachineViewStore.getState().revealProject(key));
    act(() => useUIStore.getState().selectProjectAndEnvironment("p-local", "e-local"));
    await waitFor(() =>
      expect(useMachineViewStore.getState().recentKeys.slice(0, 2)).toEqual([
        environmentKey(environmentRef(SELF_NODE_ID, "e-local")),
        projectKey(projectRef(SELF_NODE_ID, "p-local")),
      ]),
    );
    expect(useMachineViewStore.getState().revealedProject).toBeNull();
  });

  test("immediately shows an environment-less project when sorted by activity", async () => {
    useUIStore.setState({ environmentSortMode: "activity" });
    await revealIn();
    expect(useUIStore.getState().environmentSortMode).toBe("project");
    expect(useMachineViewStore.getState().grouping).toBe("machine");
    expect(projectRow()?.querySelector("[aria-current]")?.getAttribute("aria-current")).toBe(
      "true",
    );
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  for (const grouping of ["project", "repository"] as const) {
    test(`reveals a connected project inside collapsed merged ${grouping} folders`, async () => {
      uninstallDesktopFake();
      installDesktopFake({
        list: connectionList([MBP3]),
        layout: { projectFolders: { [key]: "Merged scrapers" } },
        datasets: {
          mbp3: {
            projects: [
              {
                id: "tg",
                name: "telegram-scraper",
                folder: "Scrapers",
                gitUrl: "https://github.com/acme/telegram-scraper.git",
              },
            ],
            environments: {},
          },
        },
      });
      const machineFolder = sidebarFolderKey("bk_mbp3", projectFolderKey("Scrapers"));
      const mergedFolder = sidebarFolderKey("project", projectFolderKey("Merged scrapers"));
      const repositoryFolder = sidebarFolderKey("repository", "github.com/acme/telegram-scraper");
      const unrelatedFolder = sidebarFolderKey(grouping, "unrelated");
      useMachineViewStore.setState({
        grouping,
        collapsedMachines: ["bk_mbp3"],
        collapsedProjectKeys: [key],
        collapsedFolderKeys: [machineFolder, mergedFolder, repositoryFolder, unrelatedFolder],
      });
      renderHarness();
      const machine = await waitFor(() => {
        const found = captured.machines.find((candidate) => candidate.name === "mbp3");
        if (!found || found.projects.length === 0) throw new Error("mbp3 not loaded");
        return found;
      });
      expect(machine.transport).toBe("connected");
      expectDomAbsent(projectRow() ?? null, "project hidden inside collapsed merged folder");
      act(() => captured.reveal!(machine, "tg"));
      const views = useMachineViewStore.getState();
      expect(views.grouping).toBe(grouping);
      expect(views.collapsedMachines).not.toContain("bk_mbp3");
      expect(views.collapsedProjectKeys).not.toContain(key);
      expect(views.collapsedFolderKeys).toEqual([unrelatedFolder]);
      expect(views.recentKeys[0]).toBe(key);
      await waitFor(() => expect(projectRow()?.getAttribute("data-revealed")).toBe("true"));
      expect(projectRow()?.querySelector("[aria-current]")?.getAttribute("aria-current")).toBe(
        "true",
      );
      expect(useUIStore.getState().environmentSortMode).toBe("project");
      expect(mockToastInfo).not.toHaveBeenCalled();
    });

    test(`immediately shows an offline project from ${grouping} grouping`, async () => {
      uninstallDesktopFake();
      installDesktopFake({
        list: connectionList([{ ...MBP3, transport: "unreachable" }]),
        datasets: {
          mbp3: {
            projects: [{ id: "tg", name: "telegram-scraper", folder: "Scrapers" }],
            environments: {},
          },
        },
      });
      useMachineViewStore.setState({
        grouping,
        collapsedMachines: ["bk_mbp3"],
        collapsedProjectKeys: [key],
      });
      await revealIn();
      expect(useMachineViewStore.getState().grouping).toBe("machine");
      const row = projectRow();
      expect(row?.getAttribute("data-revealed")).toBe("true");
      expect(row?.querySelector("[aria-current]")?.getAttribute("aria-current")).toBe("true");
    });
  }

  test("another remote selection removes the row highlight with no local selection", async () => {
    useUIStore.setState({ selectedProjectId: null, selectedEnvironmentId: null });
    openMachineWorkspace({ connectionId: "bk_other", projectId: "other", title: "Other" });
    await revealIn();
    const row = projectRow()!;
    expect(row.querySelector("[aria-current]")?.getAttribute("aria-current")).toBe("true");
    act(() =>
      openMachineWorkspace({
        connectionId: "bk_other",
        projectId: "other",
        environmentId: "env",
        title: "Other",
      }),
    );
    expect(useMachineViewStore.getState().revealedProject).toBeNull();
    expect(row.getAttribute("data-revealed")).not.toBe("true");
    expectDomAbsent(row.querySelector("[aria-current]"), "revealed project current marker");
  });
});
