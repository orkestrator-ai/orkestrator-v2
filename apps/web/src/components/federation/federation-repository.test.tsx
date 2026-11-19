import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { portalStore } from "@/lib/portal/portal-store";
import { useAppDialogStore } from "@/stores/appDialogStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { uiStore } from "@/stores/uiStore";
import {
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import {
  NO_BOUND_ROWS,
  firstEnvironment,
  machineView,
  renderWithFederation,
} from "./federation-ui-test-fixture";
import { RepositoryEnvironmentList } from "./RepositoryEnvironmentList";
import { appCommandStore } from "@/test/app-command-store";

const INITIAL_MACHINE_VIEW_STATE = useMachineViewStore.getState();
const INITIAL_REMOTE_WORKSPACE_STATE = useRemoteWorkspaceStore.getState();
const INITIAL_UI_STATE = appCommandStore(uiStore).getState();

function installTwoMachines() {
  return installDesktopFake({
    list: connectionList([
      remoteConnection("a", "Machine A", "teal"),
      remoteConnection("b", "Machine B", "rose"),
    ]),
    datasets: { a: sharedIdDataset("working"), b: sharedIdDataset("waiting") },
  });
}

beforeEach(() => {
  localStorage.removeItem("machine-view-storage");
  sessionStorage.clear();
  useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE_WORKSPACE_STATE, true);
  appCommandStore(uiStore).setState(INITIAL_UI_STATE, true);
});

afterEach(() => {
  cleanup();
  useAppDialogStore.getState().close();
  uninstallDesktopFake();
  useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE_WORKSPACE_STATE, true);
  appCommandStore(uiStore).setState(INITIAL_UI_STATE, true);
  localStorage.removeItem("machine-view-storage");
});

async function renderRepositoryMenu({
  bound,
  leaf = false,
  repository = "github.com/acme/app",
}: {
  bound: boolean;
  leaf?: boolean;
  repository?: string;
}) {
  const fake = installDesktopFake({
    list: connectionList([remoteConnection("a", "Machine A", "teal")]),
    datasets: { a: sharedIdDataset("idle") },
    respondPortal: (command) =>
      command === "get_node_status"
        ? {
            nodeId: "bk_self",
            mode: leaf ? "leaf" : "command",
            registrationEnabled: true,
            controllers: [],
            detachedControllers: [],
            suspendedSubordinateCount: 0,
          }
        : undefined,
  });
  await portalStore.refresh();
  const remote = machineView();
  remote.projects[0]!.repositoryHint = repository;
  const ref = projectRef("bk_self" as BackendId, "local-project");
  const local = machineView({
    connectionId: "bk_self",
    backendId: ref.backendId,
    name: "Command",
    bound: true,
    projects: [
      { ref, key: projectKey(ref), name: "local app", order: 0, repositoryHint: repository },
    ],
    environmentsByProject: new Map(),
  });
  const target = bound ? local : remote;
  // This window's New Environment dialog, as the sidebar opens it.
  const created: string[] = [];
  renderWithFederation(
    <RepositoryEnvironmentList
      // Prefer the command node's member even when the remote member is first.
      machines={[remote, local]}
      shownIds={new Set(bound ? ["a", "bk_self"] : ["a"])}
      ordering="machine"
      bound={{ ...NO_BOUND_ROWS, onCreate: (projectId) => created.push(projectId) }}
    />,
  );
  const heading = screen.getByRole("button", { name: `Open acme/app on ${target.name}` });
  await act(async () => {
    fireEvent.contextMenu(heading);
  });
  return { fake, target, created, menu: await screen.findByRole("menu") };
}

for (const bound of [true, false]) {
  const destination = bound ? "bound command node" : "remote fallback";
  for (const [action, boardTab] of [
    ["Open Coordinator", "coordinator"],
    ["Open board", "kanban"],
    ["New environment", null],
  ] as const) {
    test(`${action} targets the repository member on the ${destination}`, async () => {
      appCommandStore(uiStore).setState({
        selectedProjectId: "previous-project",
        selectedEnvironmentId: "previous-environment",
        projectBoardTab: action === "Open board" ? "coordinator" : "kanban",
      });
      const { menu, target, fake, created } = await renderRepositoryMenu({ bound });
      expect(within(menu).getByText(`On ${target.name}`)).toBeTruthy();
      fireEvent.click(within(menu).getByRole("menuitem", { name: action }));
      const project = target.projects[0]!;
      await waitFor(() => {
        if (bound) {
          expect(useRemoteWorkspaceStore.getState().active).toBeNull();
          if (boardTab) {
            expect(appCommandStore(uiStore).getState().selectedProjectId).toBe(
              project.ref.projectId,
            );
            expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBeNull();
            expect(appCommandStore(uiStore).getState().projectBoardTab).toBe(boardTab);
          } else {
            expect(created).toEqual([project.ref.projectId]);
          }
        } else {
          expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe(target.connectionId);
          expect(useRemoteWorkspaceStore.getState().requests[target.connectionId]?.request).toEqual(
            {
              projectId: project.ref.projectId,
              ...(boardTab ? { boardTab } : { createEnvironmentProjectId: project.ref.projectId }),
            },
          );
          expect(appCommandStore(uiStore).getState().selectedProjectId).toBeNull();
          expect(useAppDialogStore.getState().request).toBeNull();
        }
      });
      expect(useMachineViewStore.getState().openedRepository).toEqual(
        action === "Open Coordinator"
          ? { name: "github.com/acme/app", projectKey: project.key }
          : null,
      );
      expect(fake.calls.filter((call) => call.command === "create_environment")).toEqual([]);
    });
  }

  test(`leaf mode gates Open Coordinator only for the bound member (${destination})`, async () => {
    const { menu } = await renderRepositoryMenu({ bound, leaf: true });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      ...(bound ? [] : ["Open Coordinator"]),
      "Open board",
      "Open repo on GitHub",
      "Repository settings",
      "New environment",
      // The repository's other member, on the machine it is on.
      ...(bound ? ["New environment on Machine A"] : []),
      "Copy to Machine…",
      "Collapse",
      `Delete project on ${bound ? "Command" : "Machine A"}…`,
    ]);
    for (const item of within(menu).getAllByRole("menuitem")) {
      expect(item.hasAttribute("data-disabled")).toBe(false);
    }
  });
}

test("a non-GitHub repository menu omits Open repo on GitHub", async () => {
  const { menu } = await renderRepositoryMenu({
    bound: false,
    repository: "gitlab.example/acme/app",
  });
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent),
  ).toEqual([
    "Open Coordinator",
    "Open board",
    "Repository settings",
    "New environment",
    "Copy to Machine…",
    "Collapse",
    "Delete project on Machine A…",
  ]);
});

test("a repository heading summarizes machines and environments and lists every machine's rows flat beneath it", async () => {
  const hint = "github.com/acme/app";
  const first = machineView();
  first.projects[0]!.repositoryHint = hint;
  const second = machineView({
    connectionId: "b",
    backendId: "bk_b" as never,
    name: "Machine B",
    colorToken: "rose",
    projects: [
      {
        ref: projectRef("bk_b" as BackendId, "project-1"),
        key: projectKey(projectRef("bk_b" as BackendId, "project-1")),
        name: "app",
        order: 0,
        repositoryHint: hint,
      },
    ],
    environmentsByProject: new Map([
      [
        "project-1",
        [
          {
            ...firstEnvironment(first),
            ref: environmentRef("bk_b" as BackendId, "env-1"),
            key: environmentKey(environmentRef("bk_b" as BackendId, "env-1")),
          },
        ],
      ],
    ]),
  });
  await act(async () => {
    renderInAppCommandScope(
      <RepositoryEnvironmentList
        machines={[first, second]}
        shownIds={new Set(["a", "b"])}
        ordering="machine"
        bound={NO_BOUND_ROWS}
      />,
    );
  });
  const heading = screen.getByRole("button", {
    name: "Open acme/app on Machine A",
  });
  // The "+" replaces the chevron, so the heading itself says it is expanded.
  expect(heading.getAttribute("aria-expanded")).toBe("true");
  expect(heading.getAttribute("title")).toBe(`Open ${hint} on Machine A`);
  // No trailing dot or member count: the leading box carries the colour.
  expect(within(heading).queryByTestId("machine-dot") === null).toBe(true);
  expect(within(heading).queryByText("2") === null).toBe(true);
  // The heading leads with the home of the machine it opens on (no command node
  // is known here) over "owner/repo" and a machine and environment count.
  expect(
    within(heading).getByTestId("command-node-home-icon").getAttribute("data-machine-color"),
  ).toBe("teal");
  expect(within(heading).getByText("acme/").classList).toContain("text-muted-foreground");
  expect(within(heading).getByText("app").classList).toContain("text-foreground");
  expect(within(heading).getByText("2 machines · 2 environments")).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "New environment in acme/app" }).getAttribute("title"),
  ).toBe("New environment on Machine A");
  const content = document.querySelector("[data-project-folder-content]")!;
  expect(content.className).not.toContain("ml-3");
  // No member headings: every machine's rows sit directly under the heading,
  // in machine order, each marked in its machine's colour.
  expect(screen.queryAllByTestId("federated-project")).toHaveLength(0);
  const rows = within(content as HTMLElement).getAllByTestId("federated-environment-row");
  expect(rows.map((row) => row.getAttribute("data-machine"))).toEqual(["a", "b"]);
  expect(
    rows.map((row) => within(row).getByTestId("machine-dot").getAttribute("data-machine-color")),
  ).toEqual(["teal", "rose"]);
  // The heading itself is the drag handle; there is no separate grip.
  expect(heading.getAttribute("aria-roledescription")).toBe("sortable");
  expect(screen.queryByRole("button", { name: /^Move repository/ }) === null).toBe(true);
});

test("a repository not on the command node has a heading in the colour of the machine it opens on", async () => {
  installTwoMachines();
  // The workspace is on a different machine from the command node.
  const remote = machineView({ bound: true });
  remote.projects[0]!.repositoryHint = "github.com/acme/app";
  const commandNode = machineView({
    connectionId: "bk_self",
    backendId: "bk_self" as BackendId,
    name: "Command node",
    colorToken: "violet",
    projects: [],
    environmentsByProject: new Map(),
  });
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={[remote, commandNode]}
      shownIds={new Set([remote.connectionId])}
      ordering="machine"
      bound={NO_BOUND_ROWS}
    />,
  );
  const heading = screen.getByRole("button", { name: "Open acme/app on Machine A" });
  const home = within(heading).getByTestId("command-node-home-icon");
  await waitFor(() => expect(home.getAttribute("data-machine-color")).toBe("teal"));
  expect(home.querySelector("svg")!.classList).toContain("text-teal-500");
  expect(home.classList).toContain("border-teal-500");
  expect(within(heading).queryByTestId("machine-dot") === null).toBe(true);
});

test("a repository heading shows the command node's own icon for the project, outlined in its colour even when that machine is filtered out", async () => {
  installTwoMachines();
  const icon = "data:image/png;base64,iVBORw0KGgo=";
  const remote = machineView({ bound: true });
  remote.projects[0]!.repositoryHint = "github.com/acme/app";
  remote.projects[0]!.icon = "data:image/png;base64,cmVtb3Rl";
  const commandNode = machineView({
    connectionId: "bk_self",
    backendId: "bk_self" as BackendId,
    name: "Command node",
    colorToken: "violet",
    projects: [
      {
        ref: projectRef("bk_self" as BackendId, "project-1"),
        key: projectKey(projectRef("bk_self" as BackendId, "project-1")),
        name: "app",
        order: 0,
        repositoryHint: "github.com/acme/app",
        icon,
      },
    ],
    environmentsByProject: new Map(),
  });
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={[remote, commandNode]}
      shownIds={new Set([remote.connectionId])}
      ordering="machine"
      bound={NO_BOUND_ROWS}
    />,
  );
  const heading = screen.getByRole("button", { name: "Open acme/app on Machine A" });
  const home = within(heading).getByTestId("command-node-home-icon");
  await waitFor(() => expect(home.getAttribute("data-machine-color")).toBe("violet"));
  expect(home.classList).toContain("border-violet-500");
  expect(home.querySelector("svg") === null).toBe(true);
  expect(within(home).getByTestId("project-icon").getAttribute("src")).toBe(icon);
});

test.each([false, true])(
  "a repository heading ignores an unrelated command-node project's icon (matching project on the command node: %s)",
  async (hasMatchingProject) => {
    installTwoMachines();
    const remote = machineView({ bound: true });
    remote.projects[0]!.repositoryHint = "github.com/acme/app";
    remote.projects[0]!.icon = "data:image/png;base64,cmVtb3Rl";
    const commandBackendId = "bk_self" as BackendId;
    const unrelatedProject = {
      ref: projectRef(commandBackendId, "unrelated"),
      key: projectKey(projectRef(commandBackendId, "unrelated")),
      name: "app",
      order: 0,
      repositoryHint: "github.com/other/app",
      icon: "data:image/png;base64,iVBORw0KGgo=",
    };
    const commandNode = machineView({
      connectionId: "bk_self",
      backendId: commandBackendId,
      name: "Command node",
      colorToken: "violet",
      projects: [
        unrelatedProject,
        ...(hasMatchingProject
          ? [
              {
                ref: projectRef(commandBackendId, "matching"),
                key: projectKey(projectRef(commandBackendId, "matching")),
                name: "app",
                order: 1,
                repositoryHint: "github.com/acme/app",
              },
            ]
          : []),
      ],
      environmentsByProject: new Map(),
    });
    renderWithFederation(
      <RepositoryEnvironmentList
        machines={[remote, commandNode]}
        shownIds={new Set([remote.connectionId])}
        ordering="machine"
        bound={NO_BOUND_ROWS}
      />,
    );
    const heading = screen.getByRole("button", { name: "Open acme/app on Machine A" });
    const home = within(heading).getByTestId("command-node-home-icon");
    const color = hasMatchingProject ? "violet" : "teal";
    await waitFor(() => expect(home.getAttribute("data-machine-color")).toBe(color));
    expect(home.classList).toContain(`border-${color}-500`);
    if (hasMatchingProject) {
      // The command node's copy has no icon: its house, not another machine's icon.
      expect(home.querySelector("svg.lucide-house") === null).toBe(false);
      expect(home.querySelector("svg")!.classList).toContain(`text-${color}-500`);
      expect(within(home).queryByTestId("project-icon") === null).toBe(true);
    } else {
      // Not on the command node: the first machine with an icon for it.
      expect(within(home).getByTestId("project-icon").getAttribute("src")).toBe(
        "data:image/png;base64,cmVtb3Rl",
      );
    }
  },
);

test("a repository not on the command node takes the first icon in machine order", async () => {
  installTwoMachines();
  const hint = "github.com/acme/app";
  const withoutIcon = machineView();
  withoutIcon.projects[0]!.repositoryHint = hint;
  const memberOf = (backendId: BackendId, icon: string) => ({
    ref: projectRef(backendId, "project-1"),
    key: projectKey(projectRef(backendId, "project-1")),
    name: "app",
    order: 0,
    repositoryHint: hint,
    icon,
  });
  const second = machineView({
    connectionId: "b",
    backendId: "bk_b" as BackendId,
    name: "Machine B",
    colorToken: "rose",
    projects: [memberOf("bk_b" as BackendId, "data:image/png;base64,c2Vjb25k")],
  });
  const third = machineView({
    connectionId: "c",
    backendId: "bk_c" as BackendId,
    name: "Machine C",
    colorToken: "amber",
    projects: [memberOf("bk_c" as BackendId, "data:image/png;base64,dGhpcmQ=")],
  });
  const commandNode = machineView({
    connectionId: "bk_self",
    backendId: "bk_self" as BackendId,
    name: "Command node",
    colorToken: "violet",
    projects: [],
    environmentsByProject: new Map(),
  });
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={[withoutIcon, second, third, commandNode]}
      shownIds={new Set(["a", "b", "c"])}
      ordering="machine"
      bound={NO_BOUND_ROWS}
    />,
  );
  const heading = screen.getByRole("button", { name: "Open acme/app on Machine A" });
  const home = within(heading).getByTestId("command-node-home-icon");
  await waitFor(() =>
    expect(within(home).getByTestId("project-icon").getAttribute("src")).toBe(
      "data:image/png;base64,c2Vjb25k",
    ),
  );
  // The outline still names the machine the heading opens on.
  expect(home.getAttribute("data-machine-color")).toBe("teal");
});

test("a repository heading's menu acts on the project it opens, in that machine's workspace", async () => {
  installTwoMachines();
  const open = spyOn(window, "open").mockImplementation(() => null);
  try {
    const machine = machineView();
    machine.projects[0]!.repositoryHint = "github.com/acme/app";
    renderWithFederation(
      <RepositoryEnvironmentList
        machines={[machine]}
        shownIds={new Set(["a"])}
        ordering="machine"
        bound={NO_BOUND_ROWS}
      />,
    );
    const heading = screen.getByRole("button", { name: "Open acme/app on Machine A" });
    const openMenu = async () => {
      await act(async () => {
        fireEvent.contextMenu(heading);
      });
      return screen.findByRole("menu");
    };
    const menu = await openMenu();
    expect(within(menu).getByText("On Machine A")).toBeTruthy();
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Open Coordinator",
      "Open board",
      "Open repo on GitHub",
      "Repository settings",
      "New environment",
      "Copy to Machine…",
      "Collapse",
      "Delete project on Machine A…",
    ]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Open repo on GitHub" }));
    expect(open).toHaveBeenCalledWith(
      "https://github.com/acme/app",
      "_blank",
      "noopener,noreferrer",
    );

    fireEvent.click(
      within(await openMenu()).getByRole("menuitem", { name: "Repository settings" }),
    );
    await waitFor(() =>
      expect(useRemoteWorkspaceStore.getState().requests.a?.request).toEqual({
        projectId: "project-1",
        dialog: "repository-settings",
      }),
    );

    fireEvent.click(within(await openMenu()).getByRole("menuitem", { name: "Collapse" }));
    await waitFor(() =>
      expect(document.querySelector("[data-project-folder-content]") === null).toBe(true),
    );
    expect(within(await openMenu()).getByRole("menuitem", { name: "Expand" })).toBeTruthy();
  } finally {
    open.mockRestore();
  }
});

test("a repository heading's menu disables writes while its machine is unavailable", async () => {
  installTwoMachines();
  const machine = machineView({ transport: "unreachable" });
  machine.projects[0]!.repositoryHint = "github.com/acme/app";
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={[machine]}
      shownIds={new Set(["a"])}
      ordering="machine"
      bound={NO_BOUND_ROWS}
    />,
  );
  await act(async () => {
    fireEvent.contextMenu(screen.getByRole("button", { name: "Open acme/app on Machine A" }));
  });
  const menu = await screen.findByRole("menu");
  for (const name of ["Repository settings", "New environment"]) {
    expect(within(menu).getByRole("menuitem", { name }).getAttribute("data-disabled")).toBe("");
  }
  expect(
    within(menu).getByRole("menuitem", { name: "Open board" }).hasAttribute("data-disabled"),
  ).toBe(false);
});

test("a repository with one visible environment uses singular summary labels and excludes project homes", async () => {
  const machine = machineView();
  machine.projects[0]!.repositoryHint = "github.com/acme/app";
  machine.environmentsByProject = new Map([
    [
      "project-1",
      [
        firstEnvironment(machine),
        {
          ...firstEnvironment(machine),
          ref: environmentRef(machine.backendId!, "home"),
          key: environmentKey(environmentRef(machine.backendId!, "home")),
          isProjectHome: true,
        },
      ],
    ],
  ]);
  await act(async () => {
    renderInAppCommandScope(
      <RepositoryEnvironmentList
        machines={[machine]}
        shownIds={new Set([machine.connectionId])}
        ordering="machine"
        bound={NO_BOUND_ROWS}
      />,
    );
  });
  const heading = screen.getByRole("button", { name: "Open acme/app on Machine A" });
  expect(within(heading).getByText("1 machine · 1 environment")).toBeTruthy();
});
