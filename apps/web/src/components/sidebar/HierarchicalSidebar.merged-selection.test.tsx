/**
 * The multi-machine repository list (design EL01) on the real sidebar.
 *
 * Shift-click range selection: the range is the rows between the anchor and
 * the click as they are on screen, in the command node's repository order,
 * never this window's own project tree (to-do 2190 (retired), task 7). Also
 * the machine tiles that filter the list, and the sort menu's choices.
 */
import { afterEach, beforeEach, expect, type mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { listen, NATIVE_EVENT_STREAM_CONNECTED_EVENT, type NativeEvent } from "@/lib/native/events";
import { portalLayoutStore } from "@/lib/portal/portal-layout";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { projectKey, projectRef } from "@orkestrator/protocol/federation";
import type { PortalLayout } from "@orkestrator/protocol/portal-layout";
import { FederationProvider } from "@/components/federation/FederationProvider";
import { repositoryCollapseKey } from "@/components/federation/useRevealMachineProject";
import { useMachineViewStore } from "@/stores/machineViewStore";
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
const nativeListen = listen as unknown as ReturnType<typeof mock>;
const initialListen = nativeListen.getMockImplementation()!;

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

function renderList(
  projects: Project[],
  environments: Environment[],
  layout: Partial<PortalLayout>,
  collapsedFolderKeys: string[] = [],
  remote: Parameters<typeof installDesktopFake>[0]["datasets"][string] = {
    projects: [],
    environments: {},
  },
  withPeer = true,
  readLayout?: () => Promise<Partial<PortalLayout>>,
) {
  installDesktopFake({
    list: connectionList(withPeer ? [remoteConnection("a", "Machine A", "teal")] : []),
    datasets: { a: remote },
    layout,
    respondPortal(command, args) {
      if (command === "get_portal_layout") return readLayout?.();
      if (command === "get_projects") return projects;
      if (command === "get_environments" || command === "get_environment_snapshots") {
        return environments.filter((entry) => entry.projectId === args.projectId);
      }
    },
  });
  appCommandStore(projectStore).getState().setProjects(projects);
  appCommandStore(environmentStore).getState().setEnvironments(environments);
  useMachineViewStore.setState({
    grouping: "repository",
    machineFilter: [],
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
  nativeListen.mockImplementation(initialListen);
  portalLayoutStore.setState({ error: null });
  useMachineViewStore.setState(initialView, true);
  appCommandStore(uiStore).setState(initialUI, true);
  appCommandStore(projectStore).setState(initialProjects, true);
  appCommandStore(environmentStore).setState(initialEnvironments, true);
  useRemoteWorkspaceStore.setState(initialRemote, true);
});

test("a shift-click range follows the command node's order, not this window's project order", async () => {
  // This window orders p1 before p2; the command node's project order shows p2 first,
  // which the repository list follows until repositories are arranged.
  const projects = [project("p1", 0, "one"), project("p2", 1, "two")];
  const environments = [
    environment("a1", "p1", 0),
    environment("a2", "p1", 1),
    environment("b1", "p2", 0),
  ];
  renderList(projects, environments, { projectOrder: [key("p2"), key("p1")] });
  await row("a2");
  await waitFor(() => expect(rowsOnScreen()).toEqual(["b1", "a1", "a2"]));
  appCommandStore(uiStore).setState({ selectedProjectId: "p2", selectedEnvironmentId: "b1" });

  fireEvent.click(await row("a1"), { shiftKey: true });
  expect(appCommandStore(uiStore).getState().selectedEnvironmentIds).toEqual(["b1", "a1"]);
});

test("a shift-click range skips the rows of a collapsed repository", async () => {
  const projects = [project("p1", 0, "one"), project("p2", 1, "two"), project("p3", 2, "three")];
  const environments = [
    environment("a1", "p1", 0),
    environment("b1", "p2", 0),
    environment("c1", "p3", 0),
  ];
  renderList(projects, environments, { repositoryOrder: [key("p1"), key("p2"), key("p3")] }, [
    repositoryCollapseKey("github.com/acme/two"),
  ]);
  await row("c1");
  await waitFor(() => expect(rowsOnScreen()).toEqual(["a1", "c1"]));
  appCommandStore(uiStore).setState({ selectedProjectId: "p1", selectedEnvironmentId: "a1" });

  fireEvent.click(await row("c1"), { shiftKey: true });
  expect(appCommandStore(uiStore).getState().selectedEnvironmentIds).toEqual(["a1", "c1"]);
});

test("a shift-click range follows the repository order", async () => {
  const projects = [project("p1", 0, "one"), project("p2", 1, "two"), project("p3", 2, "three")];
  const environments = [
    environment("a1", "p1", 0),
    environment("b1", "p2", 0),
    environment("c1", "p3", 0),
  ];
  renderList(projects, environments, {
    repositoryOrder: [key("p3"), key("p1"), key("p2")],
  });
  await row("c1");
  await waitFor(() => expect(rowsOnScreen()).toEqual(["c1", "a1", "b1"]));
  appCommandStore(uiStore).setState({ selectedProjectId: "p3", selectedEnvironmentId: "c1" });

  fireEvent.click(await row("a1"), { shiftKey: true });
  expect(appCommandStore(uiStore).getState().selectedEnvironmentIds).toEqual(["c1", "a1"]);
});

/** This window's machine with one environment and Machine A with one in the same repository. */
function renderTwoMachines(
  layout: Partial<PortalLayout> = { manualOrderSupported: true },
  readLayout?: () => Promise<Partial<PortalLayout>>,
) {
  renderList(
    [project("p1", 0, "one")],
    [environment("a1", "p1", 0)],
    layout,
    [],
    {
      projects: [{ id: "rp", name: "one", gitUrl: "git@github.com:acme/one.git", order: 0 }],
      environments: {
        rp: [{ id: "r1", projectId: "rp", name: "Env r1", status: "running" }],
      },
    },
    true,
    readLayout,
  );
}

const tile = (machine: string) =>
  screen
    .getAllByTestId("machine-tile")
    .find((element) => element.dataset.machine === machine) as HTMLElement;
const filter = () => useMachineViewStore.getState().machineFilter;

async function bothMachinesListed() {
  await row("a1");
  await row("r1");
  await waitFor(() => expect(screen.getAllByTestId("machine-tile")).toHaveLength(2));
}

test("a tile click shows only its machine, and a click on a faded tile adds it back", async () => {
  renderTwoMachines();
  await bothMachinesListed();
  // One repository heading, with both machines' environments flat beneath it.
  expect(
    within(screen.getByTestId("federated-repository-list")).getAllByRole("button", {
      name: /^Open acme\/one on /,
    }),
  ).toHaveLength(1);
  expect(rowsOnScreen()).toEqual(["a1", "r1"]);
  expect(tile("bk_a").getAttribute("aria-pressed")).toBe("true");
  expect(tile("bk_a").getAttribute("aria-label")).toMatch(/^Machine A, CPU .*, shown$/);
  expect(screen.queryByTestId("machines-selection") === null).toBe(true);

  fireEvent.click(tile("bk_a"));
  expect(filter()).toEqual(["bk_a"]);
  await waitFor(() => expect(rowsOnScreen()).toEqual(["r1"]));
  expect(tile("bk_a").dataset.state).toBe("selected");
  expect(tile(SELF_NODE_ID).dataset.state).toBe("faded");
  expect(tile(SELF_NODE_ID).getAttribute("aria-pressed")).toBe("false");
  expect(tile(SELF_NODE_ID).getAttribute("aria-label")).toMatch(/, hidden$/);
  // The machines menu's trigger shows the same selection.
  expect(screen.getByTestId("machines-selection").textContent).toBe("1/2");

  fireEvent.click(tile(SELF_NODE_ID));
  // Every machine is shown again, which is no filter at all.
  expect(filter()).toEqual([]);
  await waitFor(() => expect(rowsOnScreen()).toEqual(["a1", "r1"]));
  expect(tile(SELF_NODE_ID).dataset.state).toBe("all");
  expect(screen.queryByTestId("machines-selection") === null).toBe(true);
});

test("clicking the only selected tile clears the filter", async () => {
  renderTwoMachines();
  await bothMachinesListed();
  fireEvent.click(tile(SELF_NODE_ID));
  expect(filter()).toEqual([SELF_NODE_ID]);
  await waitFor(() => expect(rowsOnScreen()).toEqual(["a1"]));
  expect(screen.getByTestId("machines-selection").textContent).toBe("1/2");

  fireEvent.click(tile(SELF_NODE_ID));
  expect(filter()).toEqual([]);
  await waitFor(() => expect(rowsOnScreen()).toEqual(["a1", "r1"]));
  expect(screen.getAllByTestId("machine-tile").map((element) => element.dataset.state)).toEqual([
    "all",
    "all",
  ]);
});

test("the sort menu orders environments by machine or by hand, with no machine grouping", async () => {
  renderTwoMachines();
  await bothMachinesListed();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Sort environments: By project" }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).getByText("Order environments")).toBeTruthy();
  expect(within(menu).getByText("Sidebar view")).toBeTruthy();
  expect(within(menu).queryByText("Group machines") === null).toBe(true);
  expect(within(menu).queryByRole("menuitemradio", { name: "By repository" }) === null).toBe(true);
  const byMachine = within(menu).getByRole("menuitemradio", { name: "By machine" });
  expect(byMachine.getAttribute("aria-checked")).toBe("true");
  expect(within(menu).getByRole("menuitemradio", { name: "Full list" })).toBeTruthy();
  expect(within(menu).getByRole("menuitemradio", { name: "Compact" })).toBeTruthy();

  fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Manual" }));
  expect(useMachineViewStore.getState().environmentOrdering).toBe("manual");
  await waitFor(() =>
    expect(screen.getByTestId("federated-repository-list").dataset.ordering).toBe("manual"),
  );
});

test("an older backend's sort menu still offers the ordering, with Manual disabled and why", async () => {
  useMachineViewStore.setState({ environmentOrdering: "machine" });
  renderTwoMachines({});
  await bothMachinesListed();
  fireEvent.keyDown(screen.getByRole("button", { name: "Sort environments: By project" }), {
    key: "ArrowDown",
  });
  const menu = await screen.findByRole("menu");
  const byProject = within(menu).getByRole("menuitemradio", { name: "By project" });
  const byActivity = within(menu).getByRole("menuitemradio", { name: "By activity" });
  const byMachine = await within(menu).findByRole("menuitemradio", {
    name: "By machine",
    description: "Update the backend to order environments by hand.",
  });
  await waitFor(() => expect(document.activeElement).toBe(byProject));
  fireEvent.keyDown(byProject, { key: "ArrowDown" });
  await waitFor(() => expect(document.activeElement).toBe(byActivity));
  fireEvent.keyDown(byActivity, { key: "ArrowDown" });
  await waitFor(() => expect(document.activeElement).toBe(byMachine));
  expect(byMachine.getAttribute("aria-checked")).toBe("true");
  const manual = within(menu).getByRole("menuitemradio", { name: "Manual" });
  expect(manual.getAttribute("aria-disabled")).toBe("true");
  fireEvent.keyDown(byMachine, { key: "ArrowDown" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(menu).getByRole("menuitemradio", { name: "Full list" }),
    ),
  );

  fireEvent.click(manual);
  expect(useMachineViewStore.getState().environmentOrdering).toBe("machine");
  expect(screen.getByTestId("federated-repository-list").dataset.ordering).toBe("machine");
});

test("the menu explains pending and failed reads, and Manual resumes after reconnect", async () => {
  const reconnects = new Set<(event: NativeEvent<unknown>) => unknown>();
  nativeListen.mockImplementation(
    async (event: string, listener: (event: NativeEvent<unknown>) => unknown) => {
      if (event !== NATIVE_EVENT_STREAM_CONNECTED_EVENT) return () => {};
      reconnects.add(listener);
      return () => reconnects.delete(listener);
    },
  );
  useMachineViewStore.setState({ environmentOrdering: "manual" });
  const pending = Promise.withResolvers<Partial<PortalLayout>>();
  let response = pending.promise;
  renderTwoMachines({}, () => response);
  await bothMachinesListed();
  const trigger = screen.getByRole("button", { name: "Sort environments: By project" });
  fireEvent.pointerDown(trigger);
  const menu = await screen.findByRole("menu");
  const byMachine = within(menu).getByRole("menuitemradio", {
    name: "By machine",
    description: "Checking whether Manual ordering is available…",
  });
  expect(byMachine.getAttribute("aria-checked")).toBe("true");
  expect(
    within(menu).getByRole("menuitemradio", { name: "Manual" }).getAttribute("aria-disabled"),
  ).toBe("true");

  fireEvent.click(byMachine);
  expect(useMachineViewStore.getState().environmentOrdering).toBe("manual");
  fireEvent.pointerDown(trigger);
  const reopened = await screen.findByRole("menu");
  await act(async () => pending.reject(new Error("storage unavailable")));
  await within(reopened).findByRole("menuitemradio", {
    name: "By machine",
    description: "Could not check Manual ordering. Reconnect to retry.",
  });
  const manual = within(reopened).getByRole("menuitemradio", { name: "Manual" });
  expect(manual.getAttribute("aria-disabled")).toBe("true");

  response = Promise.resolve({ revision: 1, manualOrderSupported: true });
  await act(async () => {
    for (const reconnect of Array.from(reconnects)) reconnect({ payload: {} });
  });
  await waitFor(() => expect(manual.getAttribute("aria-checked")).toBe("true"));
  expect(manual.hasAttribute("aria-disabled")).toBe(false);
  expect(manual.hasAttribute("aria-describedby")).toBe(false);
  expect(screen.getByTestId("federated-repository-list").dataset.ordering).toBe("manual");
});

test("a backend with Manual ordering shows no update note", async () => {
  renderTwoMachines();
  await bothMachinesListed();
  fireEvent.pointerDown(screen.getByRole("button", { name: "Sort environments: By project" }));
  const menu = await screen.findByRole("menu");
  const manual = within(menu).getByRole("menuitemradio", { name: "Manual" });
  expect(manual.hasAttribute("aria-disabled")).toBe(false);
  expect(manual.hasAttribute("aria-describedby")).toBe(false);
  expect(within(menu).queryByText(/Update the backend/) === null).toBe(true);
});

test("a standalone full sidebar shows its bound CPU tile and has no Manual option", async () => {
  renderList([], [], { manualOrderSupported: true }, [], undefined, false);
  const tiles = await screen.findByRole("group", { name: "Machines shown in the list" });
  await waitFor(() => expect(within(tiles).getAllByRole("button")).toHaveLength(1));
  expect(within(tiles).getByRole("button", { name: /CPU .*shown$/ }).dataset.machine).toBe(
    SELF_NODE_ID,
  );
  fireEvent.pointerDown(screen.getByRole("button", { name: "Sort environments: By project" }));
  const menu = await screen.findByRole("menu");
  expect(within(menu).queryByRole("menuitemradio", { name: "Manual" }) === null).toBe(true);
});

test("a selected local search result opens a collapsed repository hidden by a filter", async () => {
  const collapsed = repositoryCollapseKey("github.com/acme/one");
  renderList([project("p1", 0, "one")], [environment("a1", "p1", 0)], {}, [collapsed]);
  await screen.findByRole("button", { name: /^Open acme\/one on / });
  fireEvent.click(tile("bk_a"));
  fireEvent.click(screen.getByTestId("project-search-trigger"));
  const input = await screen.findByRole("combobox");
  fireEvent.change(input, { target: { value: "Env a1" } });
  const option = await screen.findByRole("option", { name: /^Env a1,/ });
  fireEvent.click(option);
  expect(await row("a1")).toBeTruthy();
  expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBe("a1");
  expect(filter()).toEqual([]);
});
