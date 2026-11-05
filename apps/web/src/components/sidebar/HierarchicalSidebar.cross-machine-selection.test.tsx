/**
 * Multi-select treats every row in the sidebar alike, whichever machine owns
 * it: Cmd/Ctrl-click and Shift-click select without opening anything, a range
 * follows the list as drawn, and bulk actions reach each row's own machine.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { environmentKey, environmentRef, type BackendId } from "@orkestrator/protocol/federation";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { portalStore } from "@/lib/portal/portal-store";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
import {
  OUTCOME_UNKNOWN,
  connectionList,
  installDesktopFake,
  remoteConnection,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import type { Environment, Project } from "@/types";
import { mockToastWarning } from "../../../../../tests/mocks/sonner";
import { HierarchicalSidebar } from "./HierarchicalSidebar";

const initialView = useMachineViewStore.getState();
const initialUI = useUIStore.getState();
const initialProjects = useProjectStore.getState();
const initialEnvironments = useEnvironmentStore.getState();
const initialRemote = useRemoteWorkspaceStore.getState();

const localProject = {
  id: "p1",
  name: "Here",
  gitUrl: "git@github.com:acme/one.git",
  localPath: "/work/p1",
  addedAt: "2026-01-01T00:00:00.000Z",
  order: 0,
} as Project;

const localEnvironment = (id: string, order: number) =>
  ({
    id,
    projectId: "p1",
    name: `Own ${id}`,
    branch: id,
    containerId: null,
    environmentType: "local",
    status: "running",
    worktreePath: `/work/p1/${id}`,
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    networkAccessMode: "restricted",
    order,
  }) as Environment;

const remoteEnvironment = (id: string, name: string, status = "running") => ({
  id,
  projectId: "rp",
  name,
  status,
  environmentType: "local",
  agentActivityState: "idle",
});

const dataset = (...environments: ReturnType<typeof remoteEnvironment>[]) => ({
  projects: [{ id: "rp", name: "remote-project", order: 0 }],
  environments: { rp: environments },
});

const keyOn = (machine: string, id: string) =>
  environmentKey(environmentRef(`bk_${machine}` as BackendId, id));

function setup({
  grouping = "project",
  sortMode = "activity",
  respond,
}: {
  grouping?: "project" | "machine";
  sortMode?: "activity" | "project";
  respond?: Parameters<typeof installDesktopFake>[0]["respond"];
} = {}) {
  const environments = [localEnvironment("b1", 0), localEnvironment("b2", 1)];
  const datasets = {
    // The same environment ID on two machines is two environments.
    a: dataset(remoteEnvironment("shared", "On A"), remoteEnvironment("a2", "Second on A")),
    b: dataset(remoteEnvironment("shared", "On B")),
    down: dataset(remoteEnvironment("d1", "On Down")),
  };
  const fake = installDesktopFake({
    list: connectionList([
      remoteConnection("a", "Machine A", "teal"),
      remoteConnection("b", "Machine B", "rose"),
      remoteConnection("down", "Machine Down", "amber", { transport: "unreachable" }),
    ]),
    datasets,
    ...(respond ? { respond } : {}),
    respondPortal: (command, args) =>
      command === "get_projects"
        ? [localProject]
        : command === "get_environments" || command === "get_environment_snapshots"
          ? environments.filter((entry) => entry.projectId === args.projectId)
          : undefined,
  });
  useProjectStore.getState().setProjects([localProject]);
  useEnvironmentStore.getState().setEnvironments(environments);
  useMachineViewStore.setState({
    grouping,
    machineFilter: "all",
    collapsedMachines: [],
    collapsedProjectKeys: [],
    collapsedFolderKeys: [],
    revealedProject: null,
    recentKeys: [],
  });
  useUIStore.setState({ environmentSortMode: sortMode });
  render(
    <FederationProvider>
      <HierarchicalSidebar />
    </FederationProvider>,
  );
  return { fake, datasets };
}

const row = (name: string) => screen.findByRole("button", { name: new RegExp(`^${name}, on `) });
const selected = () => useUIStore.getState().selectedEnvironmentIds;

/** Every selectable row's id, top to bottom. */
function rowIdsOnScreen(): string[] {
  return Array.from(document.querySelectorAll("[data-environment-selection-id]"), (element) =>
    element.getAttribute("data-environment-selection-id")!,
  );
}

const rowWithId = (id: string) =>
  document.querySelector(`[data-environment-selection-id='${id}']`) as HTMLElement;

/** What was sent to a machine, without the change counts its rows keep reading. */
const writesTo = (fake: ReturnType<typeof setup>["fake"], machine: string) =>
  fake.callsTo(machine).filter((call) => call.command !== "changes_get_view");

async function everyRowDrawn() {
  await row("Own b1");
  await row("On A");
  await row("On B");
  await row("On Down");
}

beforeEach(() => {
  if (!HTMLElement.prototype.scrollIntoView) HTMLElement.prototype.scrollIntoView = () => {};
  mockToastWarning.mockClear();
  useRemoteWorkspaceStore.setState({ active: null });
  useUIStore.setState({
    selectedProjectId: "p1",
    selectedEnvironmentId: null,
    selectedEnvironmentIds: [],
    recentProjectIds: [],
    collapsedProjects: [],
    collapsedProjectFolders: [],
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

describe("selecting", () => {
  test("Cmd-click selects any row and opens nothing", async () => {
    setup();
    await everyRowDrawn();
    fireEvent.click(await row("On A"), { metaKey: true });
    fireEvent.click(await row("Own b2"), { metaKey: true });
    fireEvent.click(await row("On Down"), { metaKey: true });

    expect(selected()).toEqual([keyOn("a", "shared"), "b2", keyOn("down", "d1")]);
    expect(useRemoteWorkspaceStore.getState().active).toBeNull();
    expect(screen.getByText("3 selected")).toBeTruthy();
    // Every row in the list offers its checkbox, not only this window's.
    expect(screen.getAllByRole("checkbox").length).toBe(rowIdsOnScreen().length);
  });

  test("Ctrl-click and the keyboard work the same on another machine's row", async () => {
    setup();
    await everyRowDrawn();
    fireEvent.click(await row("On A"), { ctrlKey: true });
    fireEvent.keyDown(await row("On B"), { key: "Enter", metaKey: true });

    expect(selected()).toEqual([keyOn("a", "shared"), keyOn("b", "shared")]);
    expect(useRemoteWorkspaceStore.getState().active).toBeNull();
  });

  test("the same environment ID on two machines is selected separately", async () => {
    setup();
    await everyRowDrawn();
    fireEvent.click(await row("On A"), { metaKey: true });

    const checked = screen
      .getAllByRole("checkbox")
      .filter((box) => box.getAttribute("aria-checked") === "true");
    expect(checked.length).toBe(1);
    expect(selected()).toEqual([keyOn("a", "shared")]);

    fireEvent.click(await row("On A"), { metaKey: true });
    expect(selected()).toEqual([]);
  });

  test("Cmd-clicking a checkbox on another machine's row toggles it", async () => {
    setup();
    await everyRowDrawn();
    fireEvent.click(await row("Own b1"), { metaKey: true });
    const onA = (await row("On A")).parentElement!;
    fireEvent.click(within(onA).getByRole("checkbox"));

    expect(selected()).toEqual(["b1", keyOn("a", "shared")]);
    expect(useRemoteWorkspaceStore.getState().active).toBeNull();
  });

  test("a plain click on any row ends the selection and opens that row", async () => {
    setup();
    await everyRowDrawn();
    fireEvent.click(await row("Own b1"), { metaKey: true });
    fireEvent.click(await row("On A"), { metaKey: true });

    fireEvent.click(await row("On B"));
    expect(selected()).toEqual([]);
    expect(useRemoteWorkspaceStore.getState().active).toMatchObject({
      nodeId: "bk_b",
      environmentId: "shared",
    });
  });

  test("a plain click on this window's row also drops other machines' rows", async () => {
    setup();
    await everyRowDrawn();
    fireEvent.click(await row("On A"), { metaKey: true });

    fireEvent.click(await row("Own b1"));
    expect(selected()).toEqual([]);
    expect(useUIStore.getState().selectedEnvironmentId).toBe("b1");
  });
});

describe("ranges", () => {
  test("Shift-click runs from the shown environment over every machine's rows as drawn", async () => {
    setup();
    await everyRowDrawn();
    const onScreen = rowIdsOnScreen();

    // The list mixes machines, whatever the activity order puts first.
    expect(new Set(onScreen).size).toBe(6);
    fireEvent.click(rowWithId(onScreen[0]!));
    fireEvent.click(rowWithId(onScreen.at(-1)!), { shiftKey: true });

    expect(selected()).toEqual(onScreen);
  });

  test("a range can start at another machine's shown environment", async () => {
    setup();
    await everyRowDrawn();
    fireEvent.click(await row("On A"));
    const onScreen = rowIdsOnScreen();
    fireEvent.click(await row("Own b2"), { shiftKey: true });

    const [from, to] = [onScreen.indexOf(keyOn("a", "shared")), onScreen.indexOf("b2")];
    expect(selected()).toEqual(onScreen.slice(Math.min(from, to), Math.max(from, to) + 1));
    expect(selected().length).toBeGreaterThan(1);
  });

  test("in the merged project list a range crosses machines and skips a collapsed project", async () => {
    setup({ sortMode: "project" });
    // A merged list hides a machine that is not connected.
    await row("Own b1");
    await row("On A");
    await row("On B");
    expect(rowIdsOnScreen()).not.toContain(keyOn("down", "d1"));

    fireEvent.click(await row("Own b1"));
    act(() =>
      useMachineViewStore
        .getState()
        .setProjectKeyCollapsed(JSON.stringify(["bk_b", "project", "rp"])),
    );
    await waitFor(() => expect(rowIdsOnScreen()).not.toContain(keyOn("b", "shared")));

    const visible = rowIdsOnScreen();
    expect(visible).toContain(keyOn("a", "a2"));
    fireEvent.click(rowWithId(visible.at(-1)!), { shiftKey: true });
    expect(selected()).toEqual(visible.slice(visible.indexOf("b1")));
    expect(selected().some((id) => id !== "b1")).toBe(true);
  });

  test("grouped by machine a range crosses the machine sections", async () => {
    setup({ grouping: "machine", sortMode: "project" });
    await row("Own b1");
    await row("On A");
    await row("On B");
    const onScreen = rowIdsOnScreen();
    expect(onScreen).toContain("b1");
    expect(onScreen).toContain(keyOn("b", "shared"));

    fireEvent.click(await row("Own b1"));
    const from = onScreen.indexOf("b1");
    const to = onScreen.indexOf(keyOn("b", "shared"));
    fireEvent.click(await row("On B"), { shiftKey: true });
    expect(selected()).toEqual(onScreen.slice(Math.min(from, to), Math.max(from, to) + 1));
  });
});

describe("bulk actions", () => {
  async function selectAcrossMachines() {
    await everyRowDrawn();
    fireEvent.click(await row("Own b1"), { metaKey: true });
    fireEvent.click(await row("On A"), { metaKey: true });
    fireEvent.click(await row("On B"), { metaKey: true });
    fireEvent.click(await row("On Down"), { metaKey: true });
  }

  test("Stop reaches each environment's own machine and skips an unavailable one", async () => {
    const { fake } = setup();
    await selectAcrossMachines();

    fireEvent.click(screen.getByTitle("Stop selected"));

    await waitFor(() => {
      expect(fake.callsTo("a", "stop_environment").map((call) => call.args)).toEqual([
        { environmentId: "shared" },
      ]);
      expect(fake.callsTo("b", "stop_environment").map((call) => call.args)).toEqual([
        { environmentId: "shared" },
      ]);
    });
    expect(writesTo(fake, "down")).toEqual([]);
    // This window's own environment goes through this window's backend, not the router.
    expect(writesTo(fake, "self")).toEqual([]);
    expect(fake.invoke.mock.calls).toContainEqual(["stop_environment", { environmentId: "b1" }]);
    expect(mockToastWarning).toHaveBeenCalledWith(
      "Stop: skipped 1 environment on unavailable machines",
    );
    expect(selected().length).toBe(4);
  });

  test("Restart stops then starts on the owner", async () => {
    const { fake } = setup();
    await everyRowDrawn();
    fireEvent.click(await row("On A"), { metaKey: true });

    fireEvent.click(screen.getByTitle("Restart selected"));

    await waitFor(() =>
      expect(writesTo(fake, "a").map((call) => call.command)).toEqual([
        "stop_environment",
        "start_environment_background",
      ]),
    );
  });

  test("a stopped environment is not stopped again", async () => {
    const { fake, datasets } = setup();
    datasets.a.environments.rp[1]!.status = "stopped";
    await act(() => portalStore.refresh());
    await everyRowDrawn();
    fireEvent.click(await row("Second on A"), { metaKey: true });

    expect((screen.getByTitle("Stop selected") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle("Restart selected") as HTMLButtonElement).disabled).toBe(true);
    expect(writesTo(fake, "a")).toEqual([]);
  });

  test("only unavailable machines selected: nothing can be sent", async () => {
    setup();
    await everyRowDrawn();
    fireEvent.click(await row("On Down"), { metaKey: true });

    expect((screen.getByTitle("Stop selected") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle("Delete selected") as HTMLButtonElement).disabled).toBe(true);
  });

  test("a lost answer is reported as unknown, naming the machine", async () => {
    setup({ respond: (call) => (call.connectionId === "a" ? OUTCOME_UNKNOWN : undefined) });
    await everyRowDrawn();
    fireEvent.click(await row("On A"), { metaKey: true });

    fireEvent.click(screen.getByTitle("Stop selected"));

    await waitFor(() =>
      expect(mockToastWarning.mock.calls.map((call) => call[0])).toContain(
        "Stop: outcome unknown on Machine A",
      ),
    );
  });

  test("Delete confirms by machine, reaches each owner, and clears the selection", async () => {
    const { fake } = setup();
    await selectAcrossMachines();

    fireEvent.click(screen.getByTitle("Delete selected"));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Delete 4 Environments")).toBeTruthy();
    const items = within(dialog)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(items).toContain("Own b1 on This computer");
    expect(items).toContain("On A on Machine A");
    expect(items).toContain("On B on Machine B");
    expect(items).toContain("On Down on Machine Down (unavailable, skipped)");
    expect(writesTo(fake, "a")).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete All" }));

    await waitFor(() => expect(selected()).toEqual([]));
    expect(fake.callsTo("a", "delete_environment").map((call) => call.args)).toEqual([
      { environmentId: "shared" },
    ]);
    expect(fake.callsTo("b", "delete_environment").map((call) => call.args)).toEqual([
      { environmentId: "shared" },
    ]);
    expect(writesTo(fake, "down")).toEqual([]);
  });

  test("an environment deleted elsewhere leaves the selection", async () => {
    const { datasets } = setup();
    await everyRowDrawn();
    fireEvent.click(await row("Own b1"), { metaKey: true });
    fireEvent.click(await row("Second on A"), { metaKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();

    datasets.a.environments.rp.pop();
    await act(() => portalStore.refresh());

    await waitFor(() => expect(selected()).toEqual(["b1"]));
    expect(screen.getByText("1 selected")).toBeTruthy();
  });
});
