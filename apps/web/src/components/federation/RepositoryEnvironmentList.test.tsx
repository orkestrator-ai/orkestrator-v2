import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { emptyPortalLayout } from "@orkestrator/protocol/portal-layout";
import type { MachineView } from "@/lib/federation/aggregate";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import { portalLayoutStore } from "@/lib/portal/portal-layout";
import { portalStore } from "@/lib/portal/portal-store";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { machineView, renderWithFederation } from "./federation-ui-test-fixture";
import {
  RepositoryEnvironmentList,
  repositorySubtitle,
  type BoundEnvironmentRendering,
} from "./RepositoryEnvironmentList";
import { repositoryCollapseKey } from "./useRevealMachineProject";

const REPO = "github.com/acme/app";
const INITIAL_MACHINE_VIEW_STATE = useMachineViewStore.getState();
const INITIAL_REMOTE_WORKSPACE_STATE = useRemoteWorkspaceStore.getState();

function environment(node: string, projectId: string, id: string, order: number) {
  const ref = environmentRef(node as BackendId, id);
  return {
    ref,
    key: environmentKey(ref),
    projectId,
    name: id,
    order,
    status: "running",
    activity: "idle",
    hasUnreadWork: false,
    deleting: false,
    isProjectHome: false,
  } satisfies FederatedEnvironment;
}

function remote(
  id: string,
  name: string,
  colorToken: string,
  environments: FederatedEnvironment[],
  repositoryHint: string | null = REPO,
): MachineView {
  const ref = projectRef(id as BackendId, "project-1");
  return machineView({
    connectionId: id,
    backendId: id as BackendId,
    name,
    colorToken,
    projects: [
      {
        ref,
        key: projectKey(ref),
        name: `${name} app`,
        order: 0,
        ...(repositoryHint ? { repositoryHint } : {}),
      },
    ],
    environmentsByProject: new Map([["project-1", environments]]),
  });
}

function bound(overrides: Partial<BoundEnvironmentRendering> = {}): BoundEnvironmentRendering {
  return {
    renderEnvironment: (id) => <span>{id}</span>,
    selectedEnvironmentId: null,
    onDragEnd: () => undefined,
    onCreate: () => undefined,
    ...overrides,
  };
}

beforeEach(async () => {
  localStorage.removeItem("machine-view-storage");
  useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE_WORKSPACE_STATE, true);
  installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: sharedIdDataset("idle") },
  });
  await portalStore.refresh();
  portalLayoutStore.setState({ layout: emptyPortalLayout(), loaded: true, error: null });
});

afterEach(() => {
  cleanup();
  uninstallDesktopFake();
  useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE_WORKSPACE_STATE, true);
  portalLayoutStore.setState({ layout: emptyPortalLayout(), loaded: false, error: null });
});

function fleet() {
  const beelink = remote("bk_bee", "beelink", "blue", [
    environment("bk_bee", "project-1", "b1", 0),
    environment("bk_bee", "project-1", "b2", 1),
  ]);
  const mini = remote("bk_mini", "mini", "violet", [environment("bk_mini", "project-1", "m1", 0)]);
  return [mini, beelink];
}

const rowNames = () =>
  screen
    .getAllByTestId("federated-environment-row")
    .map((row) => within(row).getByText(/^[bm]\d$/).textContent);

test("a repository lists every machine's environments directly under its heading", () => {
  const machines = fleet();
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={machines}
      shownIds={new Set(["bk_mini", "bk_bee"])}
      ordering="machine"
      bound={bound()}
    />,
  );
  // No member headings, machine sections or project rows between heading and rows.
  expect(screen.queryByTestId("federated-project") === null).toBe(true);
  expect(screen.queryByTestId("machine-section-header") === null).toBe(true);
  expect(screen.getByText("2 machines · 3 environments")).toBeTruthy();
  expect(rowNames()).toEqual(["m1", "b1", "b2"]);
  // Each row's marker carries its own machine's colour.
  const rows = screen.getAllByTestId("federated-environment-row");
  expect(rows.map((row) => row.getAttribute("data-machine"))).toEqual([
    "bk_mini",
    "bk_bee",
    "bk_bee",
  ]);
});

test("a repository with no environments shows only its machine count", () => {
  expect(repositorySubtitle(2, 0)).toBe("2 machines");
  expect(repositorySubtitle(1, 0)).toBe("1 machine");
  expect(repositorySubtitle(1, 1)).toBe("1 machine · 1 environment");
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={[remote("bk_mini", "mini", "violet", [])]}
      shownIds={new Set(["bk_mini"])}
      ordering="machine"
      bound={bound()}
    />,
  );
  expect(screen.getByText("1 machine")).toBeTruthy();
  expect(screen.queryByText(/0 environments/) === null).toBe(true);
});

test("the + button opens New environment for the repository; the keyboard collapses too", () => {
  const machines = fleet();
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={machines}
      shownIds={new Set(["bk_mini", "bk_bee"])}
      ordering="machine"
      bound={bound()}
    />,
  );
  const add = screen.getByRole("button", { name: "New environment in acme/app" });
  // A repository heading's chevron is a project's, never a folder's.
  expect(screen.queryByRole("button", { name: /Collapse folder/ }) === null).toBe(true);
  fireEvent.click(add);
  // No command node copy here, so it opens on the first machine shown.
  const request = useRemoteWorkspaceStore.getState().requests.bk_mini?.request;
  expect(request).toMatchObject({ createEnvironmentProjectId: "project-1" });

  const heading = screen.getByRole("button", { name: "Open acme/app on mini" });
  const chevron = screen.getByTestId("repository-collapse-toggle");
  expect(chevron.getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(heading, { key: "ArrowLeft" });
  expect(screen.queryAllByTestId("federated-environment-row")).toHaveLength(0);
  // The keyboard and the chevron drive the same state.
  expect(chevron.getAttribute("aria-expanded")).toBe("false");
  expect(chevron.getAttribute("aria-label")).toBe("Expand project acme/app");
  fireEvent.keyDown(heading, { key: "ArrowRight" });
  expect(screen.getAllByTestId("federated-environment-row")).toHaveLength(3);
  expect(chevron.getAttribute("aria-label")).toBe("Collapse project acme/app");
});

test("the + button of the window's own copy opens this window's dialog", () => {
  const onCreate = mock((_projectId: string) => undefined);
  const ref = projectRef("bk_self" as BackendId, "local-project");
  const local = machineView({
    connectionId: "bk_self",
    backendId: ref.backendId,
    name: "Desk",
    bound: true,
    projects: [{ ref, key: projectKey(ref), name: "app", order: 0, repositoryHint: REPO }],
    environmentsByProject: new Map([
      ["local-project", [environment("bk_self", "local-project", "l1", 0)]],
    ]),
  });
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={[local, ...fleet()]}
      shownIds={new Set(["bk_self", "bk_mini", "bk_bee"])}
      ordering="machine"
      bound={bound({ onCreate })}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "New environment in acme/app" }));
  expect(onCreate).toHaveBeenCalledWith("local-project");
  expect(screen.getByTestId("repository-environment-row").textContent).toContain("l1");
});

test("Manual follows the stored order across machines; By machine keeps machine runs", () => {
  const machines = fleet();
  portalLayoutStore.setState({
    layout: {
      ...emptyPortalLayout(),
      manualOrderSupported: true,
      environmentOrder: {
        [REPO]: [
          environmentKey(environmentRef("bk_bee" as BackendId, "b2")),
          environmentKey(environmentRef("bk_mini" as BackendId, "m1")),
          environmentKey(environmentRef("bk_bee" as BackendId, "b1")),
        ],
      },
    },
    loaded: true,
    error: null,
  });
  const view = renderWithFederation(
    <RepositoryEnvironmentList
      machines={machines}
      shownIds={new Set(["bk_mini", "bk_bee"])}
      ordering="manual"
      bound={bound()}
    />,
  );
  expect(rowNames()).toEqual(["b2", "m1", "b1"]);
  view.rerender(
    <RepositoryEnvironmentList
      machines={machines}
      shownIds={new Set(["bk_mini", "bk_bee"])}
      ordering="machine"
      bound={bound()}
    />,
  );
  expect(rowNames()).toEqual(["m1", "b1", "b2"]);
});

test("a machine the filter hides takes its environments, and its heading's count, with it", () => {
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={fleet()}
      shownIds={new Set(["bk_bee"])}
      ordering="machine"
      bound={bound()}
    />,
  );
  expect(rowNames()).toEqual(["b1", "b2"]);
  expect(screen.getByText("1 machine · 2 environments")).toBeTruthy();
});

test("a project with no repository is its own heading, named by the project", () => {
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={[
        remote("bk_mini", "mini", "violet", [environment("bk_mini", "project-1", "m1", 0)], null),
      ]}
      shownIds={new Set(["bk_mini"])}
      ordering="machine"
      bound={bound()}
    />,
  );
  expect(screen.getByRole("button", { name: "Open mini app on mini" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "New environment in mini app" })).toBeTruthy();
});

test("the heading menu reaches each other machine's copy for a new environment", async () => {
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={fleet()}
      shownIds={new Set(["bk_mini", "bk_bee"])}
      ordering="machine"
      bound={bound()}
    />,
  );
  await act(async () => {
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open acme/app on mini" }));
  });
  const menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "New environment on beelink" }));
  expect(useRemoteWorkspaceStore.getState().requests.bk_bee?.request).toMatchObject({
    createEnvironmentProjectId: "project-1",
  });
});

function renderFleet() {
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={fleet()}
      shownIds={new Set(["bk_mini", "bk_bee"])}
      ordering="machine"
      bound={bound()}
    />,
  );
  const folder = document.querySelector<HTMLElement>("[data-project-folder]")!;
  return {
    folder,
    heading: () => screen.getByRole("button", { name: "Open acme/app on mini" }),
    add: () => screen.getByRole("button", { name: "New environment in acme/app" }),
    chevron: () => within(folder).getByTestId("repository-collapse-toggle"),
  };
}

test("the chevron right of the + hides and shows the project's environments", () => {
  const { folder, heading, add, chevron } = renderFleet();
  // The chevron sits immediately after the +, last in the row.
  expect(add().nextElementSibling).toBe(chevron());
  expect(chevron().parentElement!.lastElementChild).toBe(chevron());
  expect(chevron().getAttribute("aria-expanded")).toBe("true");
  expect(chevron().getAttribute("aria-label")).toBe("Collapse project acme/app");
  expect(chevron().querySelector("svg")!.getAttribute("class")).toContain("rotate-90");

  fireEvent.click(chevron());
  expect(screen.queryAllByTestId("federated-environment-row")).toHaveLength(0);
  expect(chevron().getAttribute("aria-expanded")).toBe("false");
  expect(chevron().getAttribute("aria-label")).toBe("Expand project acme/app");
  expect(chevron().querySelector("svg")!.getAttribute("class")).not.toContain("rotate-90");
  // The heading, its subtitle and its + stay.
  expect(heading()).toBeTruthy();
  expect(within(folder).getByText("2 machines · 3 environments")).toBeTruthy();
  expect(add()).toBeTruthy();

  fireEvent.click(chevron());
  expect(screen.getAllByTestId("federated-environment-row")).toHaveLength(3);
  expect(chevron().getAttribute("aria-expanded")).toBe("true");
  expect(chevron().getAttribute("aria-label")).toBe("Collapse project acme/app");
});

test("the chevron only toggles: it neither opens, drags nor creates, and they never toggle", () => {
  const { heading, add, chevron } = renderFleet();
  expect(chevron().tagName).toBe("BUTTON");
  expect(chevron().getAttribute("type")).toBe("button");
  // Not the drag handle: the heading carries the sortable attributes.
  expect(chevron().getAttribute("aria-roledescription")).toBe(null);
  fireEvent.click(chevron());
  expect(useRemoteWorkspaceStore.getState().requests).toEqual({});

  fireEvent.click(chevron());
  fireEvent.click(add());
  expect(useRemoteWorkspaceStore.getState().requests.bk_mini?.request).toMatchObject({
    createEnvironmentProjectId: "project-1",
  });
  expect(chevron().getAttribute("aria-expanded")).toBe("true");

  useRemoteWorkspaceStore.setState(INITIAL_REMOTE_WORKSPACE_STATE, true);
  fireEvent.click(heading());
  expect(useRemoteWorkspaceStore.getState().requests.bk_mini?.request).toMatchObject({
    projectId: "project-1",
  });
  expect(useRemoteWorkspaceStore.getState().requests.bk_mini?.request).not.toHaveProperty(
    "createEnvironmentProjectId",
  );
  expect(chevron().getAttribute("aria-expanded")).toBe("true");
  expect(screen.getAllByTestId("federated-environment-row")).toHaveLength(3);
});

test("the chevron, the context menu, the keyboard and the saved state agree", async () => {
  const { folder, heading, chevron } = renderFleet();
  const key = repositoryCollapseKey(folder.getAttribute("data-project-folder")!);

  fireEvent.click(chevron());
  expect(useMachineViewStore.getState().collapsedFolderKeys).toContain(key);
  expect(localStorage.getItem("machine-view-storage")).toContain(JSON.stringify(key));
  await act(async () => {
    fireEvent.contextMenu(heading());
  });
  let menu = await screen.findByRole("menu");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Expand" }));
  expect(chevron().getAttribute("aria-expanded")).toBe("true");
  expect(useMachineViewStore.getState().collapsedFolderKeys).not.toContain(key);

  // Right on an expanded heading leaves it as it is; Left collapses it.
  fireEvent.keyDown(heading(), { key: "ArrowRight" });
  expect(chevron().getAttribute("aria-expanded")).toBe("true");
  fireEvent.keyDown(heading(), { key: "ArrowLeft" });
  expect(chevron().getAttribute("aria-expanded")).toBe("false");
  await act(async () => {
    fireEvent.contextMenu(heading());
  });
  menu = await screen.findByRole("menu");
  expect(within(menu).getByRole("menuitem", { name: "Expand" })).toBeTruthy();
  expect(within(menu).queryByRole("menuitem", { name: "Collapse" }) === null).toBe(true);

  // A fresh mount (as after a reload) reads the saved state.
  cleanup();
  const again = renderFleet();
  expect(again.chevron().getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryAllByTestId("federated-environment-row")).toHaveLength(0);
});
