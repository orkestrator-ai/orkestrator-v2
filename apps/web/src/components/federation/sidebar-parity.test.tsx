/**
 * The sidebar's empty states and drag card look the same on this window's
 * tree, another machine's section and the merged lists (to-do 2190, task 7).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
    expect(screen.queryByTestId("sidebar-drag-overlay")).toBeNull();
    await startKeyboardDrag(heading);
    const overlay = await screen.findByTestId("sidebar-drag-overlay");
    expect(overlay.textContent).toBe("Remote one");
    fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("sidebar-drag-overlay")).toBeNull());
  });
}
