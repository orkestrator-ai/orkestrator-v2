/**
 * The sidebar's empty states and drag card look the same on this window's
 * tree, another machine's section and the merged lists (to-do 2190, task 7).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  toNodeEnvironmentSummary,
  toNodeProjectSummary,
} from "@orkestrator/protocol/node-summaries";
import type { BackendId } from "@orkestrator/protocol/federation";
import { FederatedActivityList, MergedProjectList } from "./FederatedSidebarSections";
import type { MachineView } from "@/lib/federation/aggregate";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { HierarchicalSidebar } from "@/components/sidebar/HierarchicalSidebar";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  uninstallDesktopFake,
  type MachineDataset,
} from "@/test/federation-desktop-fake";

const initialView = useMachineViewStore.getState();
const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
const initialEnvironments = useEnvironmentStore.getState();
const initialRemote = useRemoteWorkspaceStore.getState();

function renderSidebar(grouping: "machine" | "project", dataset: MachineDataset) {
  installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: dataset },
    respondPortal: (command) =>
      command === "get_projects" ||
      command === "get_environments" ||
      command === "get_environment_snapshots"
        ? []
        : undefined,
  });
  useProjectStore.getState().setProjects([]);
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
  render(
    <FederationProvider>
      <HierarchicalSidebar />
    </FederationProvider>,
  );
}

/** Starts a keyboard drag on a sortable element, as the sidebar's sensors accept it. */
async function startKeyboardDrag(handle: HTMLElement): Promise<void> {
  handle.focus();
  fireEvent.keyDown(handle, { code: "Space", key: " " });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

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

test("an empty merged list offers this window's Add Project, as this window's own tree does", async () => {
  renderSidebar("project", { projects: [], environments: {} });
  const list = await screen.findByTestId("federated-project-list");
  expect(within(list).getByText("No projects yet")).toBeTruthy();
  fireEvent.click(within(list).getByRole("button", { name: "Add your first project" }));
  expect(await screen.findByRole("dialog", { name: "Add project" })).toBeTruthy();
});

test("another machine's empty section offers to add a project on that machine", async () => {
  renderSidebar("machine", { projects: [], environments: {} });
  // This window's tree and Machine A's section: one empty state each.
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Add your first project" })).toHaveLength(2),
  );
  expect(screen.getAllByText("No projects yet")).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("button", { name: "Add your first project" })[1]!);
  await waitFor(() => expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe("bk_a"));
});

for (const grouping of ["project", "machine"] as const) {
  test(`dragging another machine's project shows the drag card ${grouping === "project" ? "in a merged list" : "in its machine section"}`, async () => {
    renderSidebar(grouping, {
      projects: [
        { id: "remote-1", name: "Remote one", order: 0 },
        { id: "remote-2", name: "Remote two", order: 1 },
      ],
      environments: {},
    });
    const heading = await screen.findByRole("button", { name: "Open Remote one on Machine A" });
    expect(screen.queryByTestId("sidebar-drag-overlay") === null).toBe(true);
    await startKeyboardDrag(heading);
    const overlay = await screen.findByTestId("sidebar-drag-overlay");
    expect(overlay.textContent).toBe("Remote one");
    // The card outlives the drop for its animation; it must not take the next press.
    expect(overlay.closest(".pointer-events-none") === null).toBe(false);
    fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("sidebar-drag-overlay") === null).toBe(true));
  });
}

for (const mode of ["project", "repository"] as const) {
  for (const source of ["bound", "remote"] as const) {
    test(`${mode} empty list waits for ${source} projects before offering Add Project`, async () => {
      installDesktopFake({ list: connectionList([]), datasets: {} });
      const machine: MachineView = {
        connectionId: "a",
        backendId: "bk_a" as BackendId,
        name: "Machine A",
        colorToken: "teal",
        bound: false,
        freshness: "current",
        transport: "connected",
        projects: [],
        environmentsByProject: new Map(),
        truncated: false,
        loadedAt: null,
      };
      function List({ loading, shown = true }: { loading: boolean; shown?: boolean }) {
        return (
          <FederationProvider>
            <MergedProjectList
              mode={mode}
              machines={source === "remote" ? [{ ...machine, loadedAt: loading ? null : 1 }] : []}
              shownIds={new Set(shown ? ["a"] : [])}
              boundLoading={source === "bound" && loading}
              renderBoundProject={() => null}
              onBoundEnvironmentDragEnd={() => {}}
              onAddProject={() => {}}
            />
          </FederationProvider>
        );
      }
      const view = render(<List loading />);
      expect(screen.getByText("Loading projects...")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Add your first project" }) === null).toBe(true);
      view.rerender(<List loading={false} />);
      expect(screen.getByText("No projects yet")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Add your first project" })).toBeTruthy();
      if (source === "remote") {
        view.rerender(<List loading shown={false} />);
        expect(screen.queryByText("Loading projects...") === null).toBe(true);
        expect(screen.getByRole("button", { name: "Add your first project" })).toBeTruthy();
      }
    });
  }
}

// Exercise the actual home list and its private activitySortKey adapter, including
// build-active homes whose displayed activity differs from their agent snapshot.
for (const order of ["priority", "newest", "oldest"] as const) {
  test(`activity homes retain merged and working groups in ${order} order`, () => {
    const nodeId = "bk_bound" as BackendId;
    const states = [
      { id: "merged-working", prState: "merged", agentActivityState: "working" },
      { id: "working-unread", agentActivityState: "working", hasUnreadWork: true },
      { id: "merged-unread", prState: "merged", hasUnreadWork: true },
      { id: "idle", agentActivityState: "idle" },
      { id: "building", agentActivityState: "idle", buildActive: true },
      { id: "deleted", deletionRequestedAt: "2026-11-01" },
      { id: "ordinary", projectHome: false },
    ];
    const projects = states.map(({ id }, index) =>
      toNodeProjectSummary(nodeId, { id, name: id }, index)!,
    );
    const machine: MachineView = {
      connectionId: "bound",
      colorToken: "teal",
      backendId: nodeId,
      name: "This window",
      bound: true,
      freshness: "current",
      transport: "connected",
      loadedAt: 1,
      truncated: false,
      projects,
      environmentsByProject: new Map(
        states.map((state) => [
          state.id,
          [
            toNodeEnvironmentSummary(nodeId, {
              projectId: state.id,
              projectHome: true,
              lastActivityAt: "2026-11-01T10:00:00Z",
              ...state,
            })!,
          ],
        ]),
      ),
    };
    render(
      <FederatedActivityList
        machines={[machine]}
        order={order}
        renderBoundRow={() => null}
        renderBoundHome={(id) => <button data-testid="sorted-home">{id}</button>}
      />,
    );
    expect(screen.getAllByTestId("sorted-home").map((home) => home.textContent)).toEqual([
      "idle",
      "working-unread",
      "building",
      "merged-unread",
      "merged-working",
    ]);
  });
}
