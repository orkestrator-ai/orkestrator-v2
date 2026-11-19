import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useEffect } from "react";
import { act, cleanup, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import { mockToastInfo, resetSonnerMocks } from "../../../../../tests/mocks/sonner";
import { portalStore } from "@/lib/portal/portal-store";
import {
  SELF_NODE_ID,
  connectionList,
  installDesktopFake,
  remoteConnection,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { uiStore } from "@/stores/uiStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { isMachineShown } from "@/lib/federation/sidebar-layout";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { FederationEffects } from "./FederationEffects";
import { FederationProvider } from "./FederationProvider";
import { useMachineViews } from "./useMachineViews";
import { NO_BOUND_ROWS } from "./federation-ui-test-fixture";
import { RepositoryEnvironmentList } from "./RepositoryEnvironmentList";
import { repositoryCollapseKey, useRevealMachineProject } from "./useRevealMachineProject";
import { appCommandStore } from "@/test/app-command-store";

const INITIAL_REMOTE_STATE = useRemoteWorkspaceStore.getState();
const INITIAL_MACHINE_VIEW_STATE = useMachineViewStore.getState();
const MBP3 = remoteConnection("mbp3", "mbp3", "teal");
const key = projectKey(projectRef("bk_mbp3" as BackendId, "tg"));

/** What the harness last rendered with, captured after each commit. */
const captured: {
  reveal: ReturnType<typeof useRevealMachineProject> | null;
  machines: ReturnType<typeof useMachineViews>;
} = { reveal: null, machines: [] };

/** The project's repository entry (a project with no repository is its own). */
function projectRow(groupKey = key) {
  return Array.from(document.querySelectorAll("[data-project-folder]")).find(
    (row) => row.getAttribute("data-project-folder") === groupKey,
  );
}

/** Whether the entry's heading is highlighted as revealed. */
function isRevealed(row: Element | undefined): boolean {
  return row?.querySelector("[data-revealed]")?.getAttribute("data-revealed") === "true";
}

function Harness() {
  const reveal = useRevealMachineProject();
  const machines = useMachineViews();
  const grouping = useMachineViewStore((state) => state.grouping);
  const sort = useUIChromeStore((state) => state.environmentSortMode);
  useEffect(() => {
    captured.reveal = reveal;
    captured.machines = machines;
  });
  // The activity list and compact show no repository headings.
  if (sort === "activity" || grouping === "compact") return null;
  return (
    <RepositoryEnvironmentList
      machines={machines}
      shownIds={new Set(machines.filter(isMachineShown).map((m) => m.connectionId))}
      ordering="machine"
      bound={NO_BOUND_ROWS}
    />
  );
}

describe("useRevealMachineProject", () => {
  beforeEach(() => {
    if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
    localStorage.removeItem("machine-view-storage");
    useRemoteWorkspaceStore.setState(INITIAL_REMOTE_STATE, true);
    useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
    useUIChromeStore.setState({ environmentSortMode: "project" });
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
    useUIChromeStore.setState({ environmentSortMode: "project" });
    localStorage.removeItem("machine-view-storage");
    captured.reveal = null;
    captured.machines = [];
  });

  function renderHarness() {
    return renderInAppCommandScope(
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

  test("expands its repository, clears a filter hiding its machine and highlights it", async () => {
    useMachineViewStore.setState({
      // Only this window's machine is shown.
      machineFilter: [SELF_NODE_ID],
      collapsedFolderKeys: [repositoryCollapseKey(key)],
    });
    await revealIn();
    const views = useMachineViewStore.getState();
    expect(views.machineFilter).toEqual([]);
    expect(views.collapsedFolderKeys).toEqual([]);
    expect(views.recentKeys[0]).toBe(key);
    expect(views.revealedProject?.key).toBe(key);
    await waitFor(() => expect(isRevealed(projectRow())).toBe(true));
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  test("keeps a filter that already shows its machine", async () => {
    useMachineViewStore.setState({ machineFilter: ["bk_mbp3"] });
    await revealIn();
    expect(useMachineViewStore.getState().machineFilter).toEqual(["bk_mbp3"]);
    await waitFor(() => expect(isRevealed(projectRow())).toBe(true));
  });

  test("this window's own selections are recorded as recent and end the highlight", async () => {
    renderInAppCommandScope(
      <FederationProvider>
        <FederationEffects />
      </FederationProvider>,
    );
    await waitFor(() => expect(portalStore.getState().selfId).toBe(SELF_NODE_ID));
    act(() => useMachineViewStore.getState().revealProject(key));
    act(() =>
      appCommandStore(uiStore).getState().selectProjectAndEnvironment("p-local", "e-local"),
    );
    await waitFor(() =>
      expect(useMachineViewStore.getState().recentKeys.slice(0, 2)).toEqual([
        environmentKey(environmentRef(SELF_NODE_ID, "e-local")),
        projectKey(projectRef(SELF_NODE_ID, "p-local")),
      ]),
    );
    expect(useMachineViewStore.getState().revealedProject).toBeNull();
  });

  test("reveals a compact project paired with activity sort in the repository list", async () => {
    useUIChromeStore.setState({ environmentSortMode: "activity" });
    useMachineViewStore.setState({ grouping: "compact" });
    await revealIn();
    expect(useUIChromeStore.getState().environmentSortMode).toBe("project");
    expect(useMachineViewStore.getState().grouping).toBe("repository");
    await waitFor(() => expect(isRevealed(projectRow())).toBe(true));
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  test("reveals a connected project inside its collapsed repository", async () => {
    uninstallDesktopFake();
    installDesktopFake({
      list: connectionList([MBP3]),
      datasets: {
        mbp3: {
          projects: [
            {
              id: "tg",
              name: "telegram-scraper",
              gitUrl: "https://github.com/acme/telegram-scraper.git",
            },
          ],
          environments: {},
        },
      },
    });
    const repository = "github.com/acme/telegram-scraper";
    const unrelatedFolder = repositoryCollapseKey("unrelated");
    useMachineViewStore.setState({
      collapsedFolderKeys: [repositoryCollapseKey(repository), unrelatedFolder],
    });
    renderHarness();
    const machine = await waitFor(() => {
      const found = captured.machines.find((candidate) => candidate.name === "mbp3");
      if (!found || found.projects.length === 0) throw new Error("mbp3 not loaded");
      return found;
    });
    expect(machine.transport).toBe("connected");
    await waitFor(() => expect(projectRow(repository)).toBeDefined());
    expect(isRevealed(projectRow(repository))).toBe(false);
    act(() => captured.reveal!(machine, "tg"));
    const views = useMachineViewStore.getState();
    expect(views.grouping).toBe("repository");
    expect(views.collapsedFolderKeys).toEqual([unrelatedFolder]);
    expect(views.recentKeys[0]).toBe(key);
    await waitFor(() => expect(isRevealed(projectRow(repository))).toBe(true));
    expect(useUIChromeStore.getState().environmentSortMode).toBe("project");
    expect(mockToastInfo).not.toHaveBeenCalled();
  });

  test("another remote selection removes the row highlight with no local selection", async () => {
    appCommandStore(uiStore).setState({ selectedProjectId: null, selectedEnvironmentId: null });
    openMachineWorkspace({ connectionId: "bk_other", projectId: "other", title: "Other" });
    await revealIn();
    const row = await waitFor(() => {
      const found = projectRow();
      if (!isRevealed(found)) throw new Error("project not revealed");
      return found!;
    });
    act(() =>
      openMachineWorkspace({
        connectionId: "bk_other",
        projectId: "other",
        environmentId: "env",
        title: "Other",
      }),
    );
    expect(useMachineViewStore.getState().revealedProject).toBeNull();
    expect(isRevealed(row)).toBe(false);
    expectDomAbsent(row.querySelector("[aria-current]"), "revealed project current marker");
  });
});
