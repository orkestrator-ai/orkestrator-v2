import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { expectDomAbsent } from "../../../../../tests/bounded-test-diagnostics";
import type { ReactNode } from "react";
import * as sortable from "@dnd-kit/sortable";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
} from "@orkestrator/protocol/federation";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { MachineView } from "@/lib/federation/aggregate";
import { isMachineShown } from "@/lib/federation/sidebar-layout";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import { reorderFederatedEnvironments } from "@/lib/federation/federated-actions";
import { portalStore } from "@/lib/portal/portal-store";
import { useMachineViewStore } from "@/stores/machineViewStore";
import {
  startRemoteWorkspaceSelectionSync,
  useRemoteWorkspaceStore,
} from "@/stores/remoteWorkspaceStore";
import { useUIStore } from "@/stores/uiStore";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import {
  OUTCOME_UNKNOWN,
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { COMMAND_HANDOVER_PREVIEW_CHANGED } from "@orkestrator/protocol/command-nodes";
import { requestCommandHandover } from "@/lib/command-handover";
import { resetNodeChangeProjectionsForTests } from "@/lib/federation/node-change-projections";
import { resetNodeEventsForTests } from "@/lib/federation/node-events";
import {
  environmentProjectionFixture,
  exactCount,
} from "@/components/files-panel/change-projection-test-fixture";
import {
  mockToastError,
  mockToastSuccess,
  mockToastWarning,
} from "../../../../../tests/mocks/sonner";
import {
  FederatedActivityList,
  MergedProjectList,
  MachineSectionList,
  MachineSectionHeader,
  RemoteMachineSection,
} from "./FederatedSidebarSections";
import { EnvironmentItem } from "@/components/environments/EnvironmentItem";
import { useEnvironmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import { RemoteEnvironmentItem, RemoteProjectGroup } from "./RemoteMachineTree";
import { CommandHandoverDialog } from "./CommandHandoverDialog";
import { FederationProvider } from "./FederationProvider";
import { MachineBadge, MachineDot } from "./MachineDot";
import { MachinesFilter } from "./MachinesFilter";
import { SshPromptDialog } from "./SshPromptDialog";
import { useMachineViews } from "./useMachineViews";

const INITIAL_MACHINE_VIEW_STATE = useMachineViewStore.getState();
const INITIAL_REMOTE_WORKSPACE_STATE = useRemoteWorkspaceStore.getState();
const originalReload = window.location.reload;

const MACHINE_A = remoteConnection("a", "Machine A", "teal");
const MACHINE_B = remoteConnection("b", "Machine B", "rose");

function installTwoMachines(respond?: Parameters<typeof installDesktopFake>[0]["respond"]) {
  return installDesktopFake({
    list: connectionList([MACHINE_A, MACHINE_B]),
    datasets: { a: sharedIdDataset("working"), b: sharedIdDataset("waiting") },
    ...(respond ? { respond } : {}),
  });
}

function RemoteSections() {
  const machines = useMachineViews();
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

function AggregateList({ mode }: { mode: "project" | "activity" }) {
  const machines = useMachineViews();
  if (mode === "activity") {
    return <FederatedActivityList machines={machines} renderBoundRow={() => null} />;
  }
  return (
    <MergedProjectList
      machines={machines}
      shownIds={new Set(machines.filter(isMachineShown).map((machine) => machine.connectionId))}
      mode="project"
      renderBoundProject={() => null}
      onBoundEnvironmentDragEnd={() => undefined}
    />
  );
}

function MachineOrder() {
  const machines = useMachineViews();
  return (
    <ol>
      {machines.map((machine) => (
        <li key={machine.connectionId} data-testid="machine-order">
          {machine.connectionId}
        </li>
      ))}
    </ol>
  );
}

function FilterOnly() {
  const machines = useMachineViews();
  return (
    <>
      <MachinesFilter machines={machines} />
      <CommandHandoverDialog />
    </>
  );
}

function renderWithFederation(node: ReactNode) {
  return render(<FederationProvider>{node}</FederationProvider>);
}

async function waitForRows(count: number) {
  await waitFor(() =>
    expect(screen.getAllByTestId("federated-environment-row").length).toBe(count),
  );
  return screen.getAllByTestId("federated-environment-row");
}

function rowOf(connectionId: string): HTMLElement {
  const row = screen
    .getAllByTestId("federated-environment-row")
    .find((candidate) => candidate.getAttribute("data-machine") === connectionId);
  if (!row) throw new Error(`no row for ${connectionId}`);
  return row;
}

async function openRowActions(machineName: string) {
  const row = screen.getByRole("button", {
    name: new RegExp(`^feature, on ${machineName},`),
  });
  await act(async () => {
    fireEvent.contextMenu(row);
  });
  return screen.findByRole("menu");
}

function machineView(overrides: Partial<MachineView> = {}): MachineView {
  const backendId = "bk_a" as BackendId;
  const project = {
    ref: projectRef(backendId, "project-1"),
    name: "app",
    order: 0,
  };
  const environment: FederatedEnvironment = {
    ref: environmentRef(backendId, "env-1"),
    key: environmentKey(environmentRef(backendId, "env-1")),
    projectId: "project-1",
    name: "feature",
    order: 0,
    status: "running",
    activity: "working",
    hasUnreadWork: false,
    deleting: false,
    isProjectHome: false,
  };
  return {
    connectionId: "a",
    backendId,
    name: "Machine A",
    colorToken: "teal",
    bound: false,
    freshness: "current",
    transport: "connected",
    projects: [{ ...project, key: projectKey(project.ref) }],
    environmentsByProject: new Map([["project-1", [environment]]]),
    truncated: false,
    loadedAt: 1,
    ...overrides,
  };
}

function firstEnvironment(machine: MachineView): FederatedEnvironment {
  return machine.environmentsByProject.get("project-1")![0]!;
}

test("federated sortable wrappers preserve size when dragged over unequal items", () => {
  const useSortable = sortable.useSortable;
  const sortableSpy = spyOn(sortable, "useSortable").mockImplementation((options) => ({
    ...useSortable(options),
    transform: { x: -12, y: 40, scaleX: 0.75, scaleY: 3.5 },
    isDragging: true,
  }));
  try {
    const machine = machineView();
    // Bound sections accept their tree as children, keeping this check independent
    // of remote hydration while exercising the same sortable machine wrapper.
    const boundMachines = [
      { ...machine, bound: true },
      { ...machine, connectionId: "b", name: "Machine B", bound: true },
    ];
    renderWithFederation(
      <>
        <MachineSectionList
          machines={boundMachines}
          shown={boundMachines}
          renderBound={() => null}
        />
        <RemoteProjectGroup
          machine={machine}
          project={machine.projects[0]!}
          environments={[firstEnvironment(machine)]}
          isCollapsed={false}
          onToggleCollapse={() => {}}
          sortable
          grouping="machine"
        />
      </>,
    );

    const wrappers = [
      ...screen.getAllByTestId("bound-machine-section"),
      screen.getByTestId("federated-project"),
      screen.getByTestId("federated-environment-row"),
    ];
    expect(wrappers.length).toBe(4);
    for (const wrapper of wrappers) {
      expect(wrapper.style.transform).toBe("translate3d(-12px, 40px, 0)");
    }
  } finally {
    cleanup();
    sortableSpy.mockRestore();
  }
});

test("a machine heading is dragged by its name and puts the chevron where its status was", () => {
  try {
    const machine = machineView();
    const machines = [
      { ...machine, connectionId: "self", name: "This Mac", bound: true },
      machine,
      { ...machine, connectionId: "c", name: "Machine C", transport: "disabled" as const },
    ];
    renderWithFederation(
      <MachineSectionList machines={machines} shown={machines} renderBound={() => null} />,
    );

    const headers = screen.getAllByTestId("machine-section-header");
    for (const header of headers) {
      const name = machines.find(
        (candidate) => candidate.connectionId === header.getAttribute("data-machine"),
      )!.name;
      const handle = within(header).getByRole("button", { name: `Move ${name}` });
      expect(handle.getAttribute("aria-roledescription")).toBe("sortable");
      expect(within(handle).getByText(name)).toBeTruthy();
      expect(header.lastElementChild!.getAttribute("aria-label")).toBe(`Collapse ${name}`);
      // The name carries the machine's colour; there is no dot beside it.
      expect(within(handle).getByText(name).className).toContain("text-teal-500");
      expect(within(header).queryByTestId("machine-dot") === null).toBe(true);
    }
    // A live machine shows no connection text; an unreachable one still warns.
    expect(within(headers[0]!).queryByText("This window") === null).toBe(true);
    expect(within(headers[1]!).queryByText("Connected") === null).toBe(true);
    expect(within(headers[2]!).getByText("Not connected")).toBeTruthy();
  } finally {
    cleanup();
  }
});

test("a connected machine still shows catching-up freshness without an offline icon", () => {
  render(<MachineSectionHeader machine={machineView({ freshness: "catching-up" })} />);
  const header = screen.getByTestId("machine-section-header");
  expect(within(header).getByText("Catching up")).toBeTruthy();
  expect(header.querySelector(".lucide-wifi-off") === null).toBe(true);
});

let reload = mock(() => undefined);

beforeEach(() => {
  localStorage.removeItem("machine-view-storage");
  sessionStorage.clear();
  useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
  useRemoteWorkspaceStore.setState(INITIAL_REMOTE_WORKSPACE_STATE, true);
  reload = mock(() => undefined);
  window.location.reload = reload;
});

afterEach(() => {
  cleanup();
  uninstallDesktopFake();
  useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
  localStorage.removeItem("machine-view-storage");
  window.location.reload = originalReload;
});

test("merged lists draw this window's own projects and rows with its full controls", () => {
  const local = machineView({ bound: true });
  const remote = machineView({
    connectionId: "b",
    backendId: "bk_b" as never,
    projects: [],
    environmentsByProject: new Map(),
  });
  const view = render(
    <FederatedActivityList
      machines={[local, remote]}
      renderBoundRow={(id) => <button aria-label={`Start local ${id}`}>Start</button>}
    />,
  );
  expect(screen.getByRole("button", { name: "Start local env-1" })).toBeTruthy();
  view.unmount();
  for (const mode of ["project", "repository"] as const) {
    const list = render(
      <MergedProjectList
        machines={[local, remote]}
        shownIds={new Set(["a", "b"])}
        mode={mode}
        renderBoundProject={(id) => <button aria-label={`Open local ${id}`}>Open</button>}
        onBoundEnvironmentDragEnd={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "Open local project-1" })).toBeTruthy();
    list.unmount();
  }
});

test("a repository group names each member by its machine in its colour and summarizes machines and environments", async () => {
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
  });
  await act(async () => {
    render(
      <MergedProjectList
        machines={[first, second]}
        shownIds={new Set(["a", "b"])}
        mode="repository"
        renderBoundProject={() => null}
        onBoundEnvironmentDragEnd={() => undefined}
      />,
    );
  });
  const heading = screen.getByRole("button", {
    name: "Open acme/app on Machine A",
  });
  expect(heading.getAttribute("aria-expanded")).toBeNull();
  expect(heading.getAttribute("title")).toBe(`Open ${hint} on Machine A`);
  expect(within(heading).getByTestId("machine-dot").getAttribute("data-machine-color")).toBe(
    "teal",
  );
  expect(within(heading).queryByText("2") === null).toBe(true);
  // The heading leads with the command node's home (no command node is known
  // here) over "owner/repo" and a machine and environment count.
  expect(
    within(heading).getByTestId("command-node-home-icon").getAttribute("data-machine-color"),
  ).toBe("neutral");
  expect(within(heading).getByText("acme/").classList).toContain("text-muted-foreground");
  expect(within(heading).getByText("app").classList).toContain("text-foreground");
  expect(within(heading).getByText("2 machines · 2 environments")).toBeTruthy();
  const content = document.querySelector("[data-project-folder-content]")!;
  expect(content.className).not.toContain("ml-3");
  const members = screen.getAllByTestId("federated-project");
  const labels = members.map((member) => member.querySelector(".truncate")!);
  expect(labels.map((label) => label.textContent)).toEqual(["Machine A", "Machine B"]);
  // Members are named in their machine's colour, with no leading home and no
  // trailing dot, and put the chevron last.
  expect(labels[0]!.classList).toContain("text-teal-500");
  expect(labels[1]!.classList).toContain("text-rose-500");
  for (const member of members) {
    expect(within(member).queryByTestId("machine-home-icon") === null).toBe(true);
    const header = member.firstElementChild!.firstElementChild as HTMLElement;
    expect(within(header).queryByTestId("machine-dot") === null).toBe(true);
    expect(header.lastElementChild!.getAttribute("aria-label")).toMatch(/^Collapse project /);
  }
  // The heading itself is the drag handle; there is no separate grip.
  expect(heading.getAttribute("aria-roledescription")).toBe("sortable");
  expect(screen.queryByRole("button", { name: /^Move repository/ }) === null).toBe(true);
});

test("a repository heading uses the command node's colour even when that machine is filtered out", async () => {
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
    <MergedProjectList
      machines={[remote, commandNode]}
      shownIds={new Set([remote.connectionId])}
      mode="repository"
      renderBoundProject={() => null}
      onBoundEnvironmentDragEnd={() => undefined}
    />,
  );
  const heading = screen.getByRole("button", { name: "Open acme/app on Machine A" });
  const home = within(heading).getByTestId("command-node-home-icon");
  await waitFor(() => expect(home.getAttribute("data-machine-color")).toBe("violet"));
  expect(home.querySelector("svg")!.classList).toContain("text-violet-500");
  expect(within(heading).getByTestId("machine-dot").getAttribute("data-machine-color")).toBe(
    "teal",
  );
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
    render(
      <MergedProjectList
        machines={[machine]}
        shownIds={new Set([machine.connectionId])}
        mode="repository"
        renderBoundProject={() => null}
        onBoundEnvironmentDragEnd={() => undefined}
      />,
    );
  });
  const heading = screen.getByRole("button", { name: "Open acme/app on Machine A" });
  expect(within(heading).getByText("1 machine · 1 environment")).toBeTruthy();
});

test("repositories are separated by a rule, but projects are not", async () => {
  const first = machineView();
  first.projects[0]!.repositoryHint = "github.com/acme/app";
  const second = machineView({
    connectionId: "b",
    backendId: "bk_b" as never,
    name: "Machine B",
    colorToken: "rose",
    projects: [
      {
        ref: projectRef("bk_b" as BackendId, "project-1"),
        key: projectKey(projectRef("bk_b" as BackendId, "project-1")),
        name: "api",
        order: 0,
        repositoryHint: "github.com/acme/api",
      },
    ],
  });
  const renderList = async (mode: "project" | "repository") => {
    let result!: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <MergedProjectList
          machines={[first, second]}
          shownIds={new Set(["a", "b"])}
          mode={mode}
          renderBoundProject={() => null}
          onBoundEnvironmentDragEnd={() => undefined}
        />,
      );
    });
    return result;
  };
  const repositories = await renderList("repository");
  const separators = screen.getAllByTestId("repository-separator");
  expect(separators).toHaveLength(1);
  // The rule belongs to the following repository's measured drop target.
  const separator = separators[0]!;
  expect(separator.closest("[data-project-folder]")?.getAttribute("data-project-folder")).toBe(
    "github.com/acme/api",
  );
  repositories.unmount();

  await renderList("project");
  expect(screen.queryByTestId("repository-separator") === null).toBe(true);
});

for (const { hints, ruledRepositories } of [
  {
    hints: ["github.com/acme/app", undefined, "", "github.com/acme/api"],
    ruledRepositories: ["github.com/acme/api"],
  },
  { hints: [undefined, ""], ruledRepositories: [] },
  { hints: [undefined, "", "github.com/acme/app"], ruledRepositories: ["github.com/acme/app"] },
]) {
  test(`repository rules only introduce repository groups in ${JSON.stringify(hints)}`, async () => {
    const machine = machineView();
    machine.projects = hints.map((repositoryHint, order) => {
      const ref = projectRef(machine.backendId!, `project-${order}`);
      return { ref, key: projectKey(ref), name: `project-${order}`, order, repositoryHint };
    });
    machine.environmentsByProject = new Map();
    await act(async () => {
      render(
        <MergedProjectList
          machines={[machine]}
          shownIds={new Set([machine.connectionId])}
          mode="repository"
          renderBoundProject={() => null}
          onBoundEnvironmentDragEnd={() => undefined}
        />,
      );
    });

    const list = screen.getByTestId("federated-repository-list");
    expect(
      within(list)
        .queryAllByTestId("repository-separator")
        .map((separator) =>
          separator.closest("[data-project-folder]")?.getAttribute("data-project-folder"),
        ),
    ).toEqual(ruledRepositories);
    for (const project of within(list).getAllByTestId("federated-project")) {
      expect(within(project).queryByTestId("repository-separator") === null).toBe(true);
    }
  });
}

describe("CL-05: machine identity visual rules", () => {
  test("CL-05: a decorative MachineDot is hidden from assistive technology", () => {
    render(<MachineDot colorToken="teal" machineName="Machine A" />);
    const dot = screen.getByTestId("machine-dot");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.getAttribute("role")).toBeNull();
    expect(dot.getAttribute("data-machine-color")).toBe("teal");
  });

  test("CL-05: a non-decorative MachineDot is an image named by machine and colour", () => {
    render(<MachineDot colorToken="teal" machineName="Machine A" decorative={false} />);
    const dot = screen.getByRole("img", { name: "Machine A (Teal)" });
    expect(dot.getAttribute("aria-hidden")).toBeNull();
  });

  test("CL-05: a compact MachineBadge keeps the machine name in a screen-reader-only element", () => {
    render(<MachineBadge colorToken="rose" machineName="Machine B" compact />);
    const badge = screen.getByTestId("machine-badge");
    const name = within(badge).getByText("Machine B");
    expect(name.className).toContain("sr-only");
    expect(within(badge).getByRole("img", { name: "Machine B (Rose)" })).toBeTruthy();
  });

  test("CL-05: an unknown colour token renders the neutral fallback without rewriting the token", () => {
    render(<MachineDot colorToken="plum-2030" machineName="Future" decorative={false} />);
    const dot = screen.getByRole("img", { name: "Future (Unknown colour)" });
    expect(dot.getAttribute("data-machine-color")).toBe("plum-2030");
    expect(dot.className).toContain("border-dashed");
    expect(dot.className).not.toContain("bg-violet-500");
  });

  test("CL-05: an environment row is named by environment, machine and activity", () => {
    const machine = machineView();
    render(
      <RemoteEnvironmentItem
        machine={machine}
        environment={firstEnvironment(machine)}
        subtitle="app"
      />,
    );
    expect(screen.getByRole("button", { name: /^feature, on Machine A, Working/ })).toBeTruthy();
    expect(screen.getByText("app")).toBeTruthy();
  });

  for (const environmentType of ["local", "containerized"] as const) {
    for (const transport of ["connected", "unreachable"] as const) {
      for (const status of ["running", "stopped"] as const) {
        for (const activity of ["idle", "working", "waiting"] as const) {
          test(`remote ${environmentType} ${status} on ${transport} machine maps ${activity} to its marker`, () => {
            const machine = machineView({ transport });
            const environment = { ...firstEnvironment(machine), environmentType, status, activity };
            render(<RemoteEnvironmentItem machine={machine} environment={environment} />);
            const row = screen.getByRole("button", { name: /^feature, on Machine A,/ });
            const marker = within(row).getByTestId("environment-status-marker");
            const active =
              transport === "connected" && (environmentType === "local" || status === "running");
            expect(marker.getAttribute("data-state")).toBe(active ? activity : "inactive");
            expect(marker.getAttribute("data-shape")).toBe(
              environmentType === "local" ? "circle" : "square",
            );
            const ring = within(marker).getByTestId("environment-status-ring");
            const color = !active
              ? "border-muted-foreground/40"
              : activity === "idle"
                ? "opacity-0"
                : activity === "working"
                  ? "bg-red-500/50"
                  : "bg-yellow-400/50";
            expect(ring.classList).toContain(color);
            expect(ring.classList.contains("animate-pulse")).toBe(active && activity !== "idle");
            expect(within(row).getAllByTestId("machine-dot")).toHaveLength(1);
            expect(within(row).getByTestId("machine-dot").getAttribute("data-machine-color")).toBe(
              "teal",
            );
          });
        }
      }
    }
  }

  for (const state of ["creating", "stopping", "deleting"] as const) {
    test(`remote ${state} row keeps the machine colour beside its name`, () => {
      const machine = machineView();
      const environment = {
        ...firstEnvironment(machine),
        environmentType: "containerized" as const,
        ...(state === "deleting" ? { deleting: true } : { status: state }),
      };
      const { rerender } = render(
        <RemoteEnvironmentItem machine={machine} environment={environment} />,
      );
      const row = screen.getByRole("button", { name: /^feature, on Machine A,/ });
      expect(row.querySelector("svg.animate-spin") !== null).toBe(true);
      expect(within(row).queryByTestId("environment-status-marker") === null).toBe(true);
      expect(within(row).getAllByTestId("machine-dot")).toHaveLength(1);
      expect(within(row).getByTestId("machine-dot").getAttribute("data-machine-color")).toBe(
        "teal",
      );
      rerender(
        <RemoteEnvironmentItem
          machine={machine}
          environment={{ ...environment, status: "running", deleting: false }}
        />,
      );
      expect(row.querySelector("svg.animate-spin") === null).toBe(true);
      expect(within(row).getAllByTestId("machine-dot")).toHaveLength(1);
      expect(within(row).getByTestId("environment-status-marker").getAttribute("data-state")).toBe(
        "working",
      );
    });
  }

  test("a busy remote action keeps its machine colour until the action settles", async () => {
    let finish: (() => void) | undefined;
    installTwoMachines((call) =>
      call.command === "stop_environment"
        ? new Promise<void>((resolve) => {
            finish = resolve;
          })
        : undefined,
    );
    renderWithFederation(<AggregateList mode="activity" />);
    await waitForRows(2);
    const menu = await openRowActions("Machine A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Stop" }));
    const row = screen.getByRole("button", { name: /^feature, on Machine A,/ });
    await waitFor(() => expect(row.querySelector("svg.animate-spin") !== null).toBe(true));
    expect(within(row).getAllByTestId("machine-dot")).toHaveLength(1);
    expect(within(row).getByTestId("machine-dot").getAttribute("data-machine-color")).toBe("teal");
    await waitFor(() => expect(finish).toBeDefined());
    await act(async () => finish!());
    await waitFor(() => expect(row.querySelector("svg.animate-spin") === null).toBe(true));
    expect(within(row).getAllByTestId("machine-dot")).toHaveLength(1);
  });

  for (const state of ["creating", "stopping", "deleting", "selecting"] as const) {
    test(`this window's ${state} row keeps its bound machine colour`, async () => {
      installTwoMachines();
      const environment: Environment = {
        id: "bound-env",
        projectId: "project-1",
        name: "Bound environment",
        branch: "main",
        containerId: "container-1",
        status: state === "creating" || state === "stopping" ? state : "running",
        environmentType: "containerized",
        prUrl: null,
        prState: null,
        hasMergeConflicts: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        networkAccessMode: "restricted",
        order: 0,
      };
      if (state === "deleting") useEnvironmentStore.getState().setDeleting(environment.id, true);
      try {
        renderWithFederation(
          <EnvironmentItem
            environment={environment}
            isSelected={false}
            isMultiSelectMode={state === "selecting"}
            onSelect={() => {}}
            onDelete={() => {}}
            onStart={() => {}}
            onStop={() => {}}
            onRestart={() => {}}
          />,
        );
        const row = screen.getByRole("button", { name: /Bound environment/ });
        await waitFor(() =>
          expect(within(row).getByTestId("machine-dot").getAttribute("data-machine-color")).toBe(
            "violet",
          ),
        );
        expect(within(row).getAllByTestId("machine-dot")).toHaveLength(1);
        expect(within(row).queryByTestId("environment-status-marker") === null).toBe(true);
        if (state === "selecting") expect(screen.getByRole("checkbox")).toBeTruthy();
        else expect(row.querySelector("svg.animate-spin") !== null).toBe(true);
      } finally {
        useEnvironmentStore.getState().setDeleting(environment.id, false);
      }
    });
  }

  test("another machine's row shows its change counts and a hover card naming the machine", async () => {
    const invokeMock = nativeInvoke as unknown as ReturnType<typeof mock>;
    const inner: string[] = [];
    invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
      if (command === "watch_node_events") {
        return { watchId: args.watchId, expiresAt: 0, renewed: true };
      }
      if (command !== "invoke_on_node") return undefined;
      expect(args.nodeId).toBe("bk_a");
      const routed = String(args.command);
      inner.push(routed);
      if (routed === "changes_get_view") {
        return {
          outcome: "ok",
          result: {
            kind: "projection",
            projection: environmentProjectionFixture("env-1", {
              counters: {
                additions: exactCount(12),
                deletions: exactCount(3),
                changedFiles: 2,
              },
            }),
          },
        };
      }
      if (routed === "get_environment") {
        return {
          outcome: "ok",
          result: {
            id: "env-1",
            name: "feature",
            createdAt: "2026-10-20T12:00:00.000Z",
            environmentType: "containerized",
            networkAccessMode: "full",
            prUrl: "https://github.com/acme/app/pull/7",
          },
        };
      }
      return { outcome: "ok", result: { environments: [] } };
    });
    try {
      const machine = machineView();
      render(<RemoteEnvironmentItem machine={machine} environment={firstEnvironment(machine)} />);
      const badge = await screen.findByTestId("environment-change-badge");
      expect(badge.textContent).toContain("+12");
      expect(badge.textContent).toContain("3");

      await act(async () => {
        fireEvent.focus(screen.getByRole("button", { name: /^feature, on Machine A/ }));
      });
      const machineLine = await screen.findByTestId("environment-tooltip-machine", undefined, {
        timeout: 2000,
      });
      expect(machineLine.textContent).toBe("On Machine A");
      expect(await screen.findByText("Full network access")).toBeTruthy();
      expect(screen.getByText("PR: https://github.com/acme/app/pull/7")).toBeTruthy();
      expect(inner).toContain("get_environment");
      expect(inner).toContain("get_agent_registry");
    } finally {
      cleanup();
      resetNodeChangeProjectionsForTests();
      resetNodeEventsForTests();
      invokeMock.mockImplementation(() => Promise.resolve());
    }
  });

  test("CL-05: an unavailable machine's row is dimmed and says connection lost, never stopped", () => {
    const machine = machineView({
      transport: "unreachable",
      freshness: "stale",
    });
    render(<FederatedActivityList machines={[machine]} renderBoundRow={() => null} />);
    const row = screen.getByTestId("federated-environment-row");
    expect(row.className).toContain("opacity-60");
    const label = within(row).getAllByRole("button")[0]!.getAttribute("aria-label") ?? "";
    expect(label).toContain("Machine A");
    expect(label).toMatch(/connection lost/i);
    expect(row.textContent ?? "").not.toMatch(/stopped/i);
    expect(label).not.toMatch(/stopped/i);
  });
});

describe("UI-01: machines with identical IDs and project names", () => {
  test("UI-01: each machine gets its own section, colour and rows for the same IDs", async () => {
    installTwoMachines();
    renderWithFederation(<RemoteSections />);
    await waitForRows(2);

    const sections = screen.getAllByTestId("remote-machine-section");
    expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual([
      "Machine A projects",
      "Machine B projects",
    ]);
    const headers = screen.getAllByTestId("machine-section-header");
    expect(
      headers.map((header, index) => [
        header.getAttribute("data-machine"),
        within(header)
          .getByText(["Machine A", "Machine B"][index]!)
          .getAttribute("data-machine-color"),
      ]),
    ).toEqual([
      ["bk_a", "teal"],
      ["bk_b", "rose"],
    ]);
    for (const section of sections) {
      expect(within(section).getByText("app")).toBeTruthy();
    }
    expect(
      within(rowOf("bk_a")).getByRole("button", {
        name: /^feature, on Machine A, Working/,
      }),
    ).toBeTruthy();
    expect(
      within(rowOf("bk_b")).getByRole("button", {
        name: /^feature, on Machine B, Awaiting input/,
      }),
    ).toBeTruthy();
    expect(
      within(rowOf("bk_a")).getByTestId("machine-dot").getAttribute("data-machine-color"),
    ).toBe("teal");
    expect(
      within(rowOf("bk_b")).getByTestId("machine-dot").getAttribute("data-machine-color"),
    ).toBe("rose");
  });

  test("UI-01: the project projection keeps same-named projects as separate instances", async () => {
    installTwoMachines();
    renderWithFederation(<AggregateList mode="project" />);
    await waitForRows(2);

    const projects = screen.getAllByTestId("federated-project");
    expect(projects).toHaveLength(2);
    expect(new Set(projects.map((project) => project.getAttribute("data-project"))).size).toBe(2);
    // The command node's registry order until the user moves them.
    expect(projects.map((project) => project.getAttribute("data-project"))).toEqual([
      projectKey(projectRef("bk_a" as BackendId, "project-1")),
      projectKey(projectRef("bk_b" as BackendId, "project-1")),
    ]);
    // Each header leads with a home in its machine's colour instead of a
    // trailing dot, and puts the chevron last.
    expect(
      projects.map((project) =>
        within(project).getByTestId("machine-home-icon").getAttribute("data-machine-color"),
      ),
    ).toEqual(["teal", "rose"]);
    for (const project of projects) {
      const header = project.firstElementChild!.firstElementChild as HTMLElement;
      expect(within(header).queryByTestId("machine-dot") === null).toBe(true);
      expect(header.lastElementChild!.getAttribute("aria-label")).toMatch(/^Collapse project /);
    }
  });
});

describe("remote machine sections follow the owner's sidebar", () => {
  function installOrderedMachine(extra: Parameters<typeof remoteConnection>[3] = {}) {
    return installDesktopFake({
      list: connectionList([remoteConnection("a", "Machine A", "teal", extra)]),
      datasets: {
        a: {
          projects: [
            { id: "p-zeta", name: "zeta", order: 0 },
            { id: "p-alpha", name: "alpha", order: 2, folder: "Work" },
            { id: "p-mid", name: "mid", order: 1, folder: "Work" },
          ],
          // Storage (creation) order differs from the owner's sidebar order.
          environments: {
            "p-zeta": [
              {
                id: "e-1",
                projectId: "p-zeta",
                name: "first",
                status: "running",
                order: 2,
              },
              {
                id: "e-2",
                projectId: "p-zeta",
                name: "second",
                status: "running",
                order: 0,
              },
              {
                id: "e-3",
                projectId: "p-zeta",
                name: "third",
                status: "running",
                order: 1,
              },
            ],
          },
        },
      },
    });
  }

  test("projects, folders and environments keep the owner's order", async () => {
    installOrderedMachine();
    renderWithFederation(<RemoteSections />);
    const rows = await waitForRows(3);

    expect(
      rows.map((row) => within(row).getAllByRole("button")[1]!.getAttribute("aria-label")),
    ).toEqual([
      "second, on Machine A, Idle",
      "third, on Machine A, Idle",
      "first, on Machine A, Idle",
    ]);
    expect(
      screen
        .getAllByTestId("federated-project")
        .map((project) => project.getAttribute("data-project")),
    ).toEqual([
      projectKey(projectRef("bk_a" as BackendId, "p-zeta")),
      projectKey(projectRef("bk_a" as BackendId, "p-mid")),
      projectKey(projectRef("bk_a" as BackendId, "p-alpha")),
    ]);
    const folder = document.querySelector('[data-project-folder-content="Work"]') as HTMLElement;
    expect(within(folder).getByText("mid")).toBeTruthy();
    expect(within(folder).getByText("alpha")).toBeTruthy();
    expect(within(folder).queryByText("zeta") === null).toBe(true);
  });

  test("environments of a connected machine can be dragged; an unavailable one is read-only", async () => {
    installOrderedMachine();
    const view = renderWithFederation(<RemoteSections />);
    await waitForRows(3);
    expect(screen.getAllByRole("button", { name: /^Reorder / })).toHaveLength(3);
    view.unmount();
    uninstallDesktopFake();

    installOrderedMachine({ transport: "unreachable" });
    renderWithFederation(<RemoteSections />);
    await waitForRows(3);
    expect(screen.queryAllByRole("button", { name: /^Reorder / })).toHaveLength(0);
  });

  test("a reorder is routed to the project's own machine", async () => {
    const fake = installOrderedMachine();
    await reorderFederatedEnvironments(portalStore, projectRef("bk_a" as BackendId, "p-zeta"), [
      "e-3",
      "e-2",
      "e-1",
    ]);
    expect(fake.callsTo("a", "reorder_environments")).toEqual([
      {
        connectionId: "a",
        command: "reorder_environments",
        args: { projectId: "p-zeta", environmentIds: ["e-3", "e-2", "e-1"] },
      },
    ]);
  });
});

describe("RT-02/OP-05: actions keep the destination captured when they started", () => {
  test("RT-02/OP-05: a delete confirmed after focusing B still names and reaches A only", async () => {
    const fake = installTwoMachines();
    renderWithFederation(<AggregateList mode="activity" />);
    await waitForRows(2);

    const menu = await openRowActions("Machine A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByRole("heading").textContent).toBe("Delete “feature” on Machine A?");

    // The user's focus moves to machine B while the confirmation is open.
    act(() => {
      useMachineViewStore.getState().setMachineFilter("bk_b");
    });
    expect(within(dialog).getByRole("heading").textContent).toBe("Delete “feature” on Machine A?");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete on Machine A" }));
    await waitFor(() => expect(fake.callsTo("a", "delete_environment")).toHaveLength(1));
    expect(fake.callsTo("a", "delete_environment")[0]!.args).toEqual({
      environmentId: "env-1",
    });
    expect(fake.calls.filter((call) => call.command === "delete_environment")).toHaveLength(1);
    expect(fake.callsTo("b", "delete_environment")).toHaveLength(0);
  });
});

describe("UI-04: creating inside a project instance", () => {
  test("UI-04: New environment in a project on a machine opens that machine's dialog", async () => {
    const fake = installTwoMachines();
    renderWithFederation(<RemoteSections />);
    await waitForRows(2);

    fireEvent.click(
      screen.getByRole("button", {
        name: "New environment in app on Machine B",
      }),
    );
    // The central region shows Machine B's workspace, which opens its own New
    // Environment dialog; the window stays where it is and nothing is created
    // until the user submits it.
    await waitFor(() => expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe("bk_b"));
    expect(useRemoteWorkspaceStore.getState().requests.bk_b?.request).toEqual({
      type: "select",
      projectId: "project-1",
      createEnvironmentProjectId: "project-1",
    });
    expect(reload).not.toHaveBeenCalled();
    expect(fake.calls.filter((call) => call.command === "create_environment")).toEqual([]);
  });
});

describe("another machine's menus offer what this machine's do", () => {
  function installMachineA(respond?: Parameters<typeof installDesktopFake>[0]["respond"]) {
    const dataset = sharedIdDataset("idle");
    dataset.projects = [{ ...dataset.projects[0]!, gitUrl: "git@github.com:Acme/App.git" }];
    return installDesktopFake({
      list: connectionList([MACHINE_A]),
      datasets: { a: dataset },
      ...(respond ? { respond } : {}),
    });
  }

  async function openProjectMenu() {
    await act(async () => {
      fireEvent.contextMenu(screen.getByTitle("Open app on Machine A"));
    });
    return screen.findByRole("menu");
  }

  test("a project's menu has the local actions, and its dialogs open in that machine's workspace", async () => {
    const fake = installMachineA();
    const open = spyOn(window, "open").mockImplementation(() => null);
    try {
      renderWithFederation(<RemoteSections />);
      await waitForRows(1);

      const menu = await openProjectMenu();
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual([
        "Open Board",
        "Open Repo on GitHub",
        "Repository Settings",
        "New Environment",
        "Copy to Machine…",
        "Add to Folder",
        "Delete Project",
      ]);
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Open Repo on GitHub" }));
      expect(open).toHaveBeenCalledWith(
        "https://github.com/acme/app",
        "_blank",
        "noopener,noreferrer",
      );

      for (const [name, dialog] of [
        ["Repository Settings", "repository-settings"],
        ["Delete Project", "delete-project"],
      ] as const) {
        fireEvent.click(within(await openProjectMenu()).getByRole("menuitem", { name }));
        await waitFor(() =>
          expect(useRemoteWorkspaceStore.getState().requests.bk_a?.request).toEqual({
            type: "select",
            projectId: "project-1",
            dialog,
          }),
        );
      }
      // Deleting is confirmed in the machine's own dialog; nothing is sent yet.
      expect(fake.calls.filter((call) => /^(remove|delete)_/.test(call.command))).toEqual([]);
    } finally {
      open.mockRestore();
    }
  });

  test("an environment's settings, fork and restart reach its own machine", async () => {
    const fake = installMachineA((call) =>
      call.command === "fork_environment"
        ? { id: "env-fork", projectId: "project-1", name: "feature-fork" }
        : call.command === "check_docker"
          ? { available: true, reason: null }
          : undefined,
    );
    renderWithFederation(<RemoteSections />);
    await waitForRows(1);

    let menu = await openRowActions("Machine A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Settings" }));
    await waitFor(() =>
      expect(useRemoteWorkspaceStore.getState().requests.bk_a?.request).toEqual({
        type: "select",
        projectId: "project-1",
        environmentId: "env-1",
        dialog: "environment-settings",
      }),
    );

    menu = await openRowActions("Machine A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Fork container" }));
    await waitFor(() =>
      expect(useRemoteWorkspaceStore.getState().requests.bk_a?.request).toEqual({
        type: "select",
        projectId: "project-1",
        environmentId: "env-fork",
      }),
    );
    expect(fake.callsTo("a", "fork_environment")[0]!.args).toEqual({
      environmentId: "env-1",
      environmentType: "containerized",
    });
    expect(fake.callsTo("a", "start_environment_background")[0]!.args).toEqual({
      environmentId: "env-fork",
    });

    menu = await openRowActions("Machine A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Restart" }));
    await waitFor(() => expect(fake.callsTo("a", "start_environment_background")).toHaveLength(2));
    expect(
      mockToastSuccess.mock.calls.some(([message]) => message === "Environment restarted"),
    ).toBe(false);
    expect(
      fake.calls
        .filter((call) => /^(stop|start)_environment/.test(call.command))
        .slice(-2)
        .map((call) => [call.command, call.args.environmentId]),
    ).toEqual([
      ["stop_environment", "env-1"],
      ["start_environment_background", "env-1"],
    ]);
  });
});

describe("a project's entry opens on the tab its grouping calls for", () => {
  function installRepository() {
    const datasets = { a: sharedIdDataset("working"), b: sharedIdDataset("waiting") };
    for (const dataset of Object.values(datasets)) {
      dataset.projects = [{ ...dataset.projects[0]!, gitUrl: "git@github.com:Acme/App.git" }];
    }
    return installDesktopFake({ list: connectionList([MACHINE_A, MACHINE_B]), datasets });
  }

  function Merged({ mode }: { mode: "project" | "repository" }) {
    const machines = useMachineViews();
    return (
      <MergedProjectList
        machines={machines}
        shownIds={new Set(machines.filter(isMachineShown).map((machine) => machine.connectionId))}
        mode={mode}
        renderBoundProject={() => null}
        onBoundEnvironmentDragEnd={() => undefined}
      />
    );
  }

  const request = () => useRemoteWorkspaceStore.getState().requests.bk_a?.request;

  for (const [grouping, coordinator] of [
    ["machine", true],
    ["project", true],
    ["repository", false],
  ] as const) {
    test(`grouped by ${grouping}, a leaf's project opens on ${coordinator ? "Coordinator" : "Home"}; its environments open as before`, async () => {
      installRepository();
      renderWithFederation(
        grouping === "machine" ? <RemoteSections /> : <Merged mode={grouping} />,
      );
      await waitForRows(2);

      fireEvent.click(screen.getByTitle("Open app on Machine A"));
      await waitFor(() =>
        expect(request()).toEqual({
          type: "select",
          projectId: "project-1",
          ...(coordinator ? { boardTab: "coordinator" } : {}),
        }),
      );

      fireEvent.click(
        within(rowOf("bk_a")).getByRole("button", { name: /^feature, on Machine A, Working/ }),
      );
      await waitFor(() =>
        expect(request()).toEqual({
          type: "select",
          projectId: "project-1",
          environmentId: "env-1",
        }),
      );

      if (grouping === "repository") {
        // The repository's own entry opens a leaf's copy on its home, too.
        fireEvent.click(screen.getByRole("button", { name: "Open acme/app on Machine A" }));
        await waitFor(() => expect(request()).toEqual({ type: "select", projectId: "project-1" }));
      }
    });
  }
});

describe("Machine filter is presentation only", () => {
  test("filter: choosing a machine updates the store without reloading, switching or routing anything", async () => {
    const fake = installTwoMachines();
    const reload = mock(() => undefined);
    window.location.reload = reload;
    renderWithFederation(<FilterOnly />);
    await waitFor(() =>
      expect(screen.getByTestId("machines-connectivity").textContent).toBe("3/3"),
    );

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("machines-filter"), {
        button: 0,
        ctrlKey: false,
      });
    });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /^Machine B, / }));

    await waitFor(() => expect(useMachineViewStore.getState().machineFilter).toBe("bk_b"));
    expect(screen.getByTestId("machines-filter").getAttribute("aria-label")).toMatch(
      /^Machines: Machine B\./,
    );
    expect(reload).not.toHaveBeenCalled();
    expect(fake.connections.use).not.toHaveBeenCalled();
    // Nothing was routed to any node.
    expect(fake.calls).toEqual([]);
  });
});

describe("The command node in the machines menu", () => {
  test("names the command node below the filters and makes another machine the command node through its switch", async () => {
    const fake = installTwoMachines();
    renderWithFederation(<FilterOnly />);
    await waitFor(() =>
      expect(screen.getByTestId("machines-connectivity").textContent).toBe("3/3"),
    );

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("machines-filter"), {
        button: 0,
        ctrlKey: false,
      });
    });
    const row = await screen.findByTestId("command-node-row");
    expect(screen.getByTestId("command-node-switch")).toBeTruthy();
    // A "Command node" heading, then the machine, above "Manage machines…".
    const heading = screen.getByText("Command node", { exact: true });
    const manage = screen.getByRole("menuitem", { name: /Manage machines/ });
    expect(heading.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.compareDocumentPosition(manage) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(row, { key: "ArrowRight" });
    });
    const switcher = await screen.findByTestId("command-node-switcher");
    expect(
      within(switcher).getByRole("menuitem", {
        name: /^Local, current command node/,
      }),
    ).toBeTruthy();
    fireEvent.click(within(switcher).getByRole("menuitem", { name: /^Machine B/ }));

    // Machine B does not control Machine A yet: the user chooses what goes with it.
    const dialog = await screen.findByTestId("command-handover-dialog");
    expect(within(dialog).getByText("Make Machine B the command node")).toBeTruthy();
    expect(within(dialog).getByRole("checkbox", { name: "Machine A" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /Make command node/ }));

    await waitFor(() =>
      expect(fake.connections.handOverCommand).toHaveBeenCalledWith({
        targetConnectionId: MACHINE_B.id,
        confirmation: expect.objectContaining({
          sourceNodeId: "bk_self",
          targetNodeId: MACHINE_B.backendId,
        }),
        nodeIds: [MACHINE_A.backendId],
        connectionIds: [],
        includeSelf: true,
      }),
    );
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(fake.connections.use).not.toHaveBeenCalled();
    expect(fake.workspaceViews.open).not.toHaveBeenCalled();
  });
});

describe("The command node in a browser tab", () => {
  test("switching hands command to another machine and opens its own address", async () => {
    installTwoMachines();
    delete (window.orkestrator as { connections?: unknown }).connections;
    const assign = mock((_url: string) => undefined);
    const originalAssign = window.location.assign;
    window.location.assign = assign;
    try {
      renderWithFederation(<FilterOnly />);
      await waitFor(() =>
        expect(screen.getByTestId("machines-connectivity").textContent).toBe("3/3"),
      );
      await act(async () => {
        fireEvent.pointerDown(screen.getByTestId("machines-filter"), {
          button: 0,
          ctrlKey: false,
        });
      });
      const row = await screen.findByTestId("command-node-row");
      expect(screen.getByTestId("command-node-switch")).toBeTruthy();
      await act(async () => {
        fireEvent.keyDown(row, { key: "ArrowRight" });
      });
      const switcher = await screen.findByTestId("command-node-switcher");
      await waitFor(() =>
        expect(within(switcher).getByRole("menuitem", { name: /^Machine B/ })).toBeTruthy(),
      );
      fireEvent.click(within(switcher).getByRole("menuitem", { name: /^Machine B/ }));
      const dialog = await screen.findByTestId("command-handover-dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: /Make command node/ }));
      await waitFor(() => expect(assign).toHaveBeenCalledWith(MACHINE_B.address!));
      expect(nativeInvoke).toHaveBeenCalledWith("hand_over_command", {
        nodeId: MACHINE_B.backendId,
        nodeIds: [MACHINE_A.backendId],
        includeSelf: true,
      });
      expect(reload).not.toHaveBeenCalled();
    } finally {
      window.location.assign = originalAssign;
    }
  });
});

describe("OP-06/CR-03: opening another machine's environment", () => {
  test("OP-06/CR-03: the central region shows it; the window stays and nothing is stopped", async () => {
    const fake = installTwoMachines();
    renderWithFederation(<RemoteSections />);
    await waitForRows(2);

    fireEvent.click(
      within(rowOf("bk_a")).getByRole("button", {
        name: /^feature, on Machine A, Working/,
      }),
    );
    await waitFor(() =>
      expect(useRemoteWorkspaceStore.getState().active).toEqual({
        nodeId: "bk_a",
        projectId: "project-1",
        environmentId: "env-1",
      }),
    );
    // The row is the selected one, like this window's own rows.
    await waitFor(() => expect(rowOf("bk_a").getAttribute("data-selected")).toBe("true"));
    expect(rowOf("bk_b").getAttribute("data-selected")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(fake.calls.filter((call) => /^(stop|delete)_/.test(call.command))).toEqual([]);
  });

  test("selecting one of this window's own environments brings the central region back", async () => {
    installTwoMachines();
    renderWithFederation(<RemoteSections />);
    await waitForRows(2);
    const stop = startRemoteWorkspaceSelectionSync();
    try {
      fireEvent.click(
        within(rowOf("bk_a")).getByRole("button", {
          name: /^feature, on Machine A, Working/,
        }),
      );
      await waitFor(() => expect(useRemoteWorkspaceStore.getState().active).not.toBeNull());
      // The window's own selection was cleared for it.
      expect(useUIStore.getState().selectedEnvironmentId).toBeNull();
      act(() => useUIStore.getState().selectProjectAndEnvironment("local-project", "local-env"));
      expect(useRemoteWorkspaceStore.getState().active).toBeNull();
      // Machine A's realm stays open behind it, so going back is instant.
      expect(useRemoteWorkspaceStore.getState().realms).toEqual(["bk_a"]);
    } finally {
      stop();
    }
  });
});

describe("SH-03: SSH prompts", () => {
  test("SH-03: a passphrase prompt answers its own prompt ID with the typed value", async () => {
    const fake = installTwoMachines();
    render(<SshPromptDialog />);
    act(() =>
      fake.emit("ssh-auth-prompt", {
        promptId: "prompt-1",
        kind: "passphrase",
        message: "Enter passphrase for key id_ed25519",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("SSH key passphrase")).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("Passphrase"), {
      target: { value: "s3cret" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    expect(fake.connections.answerSshPrompt).toHaveBeenCalledTimes(1);
    expect(fake.connections.answerSshPrompt).toHaveBeenCalledWith("prompt-1", "s3cret");
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
  });

  test("SH-03: cancelling a prompt answers null exactly once", async () => {
    const fake = installTwoMachines();
    render(<SshPromptDialog />);
    act(() =>
      fake.emit("ssh-auth-prompt", {
        promptId: "prompt-2",
        kind: "password",
        message: "",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Password"), {
      target: { value: "typed" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));

    expect(fake.connections.answerSshPrompt).toHaveBeenCalledTimes(1);
    expect(fake.connections.answerSshPrompt).toHaveBeenCalledWith("prompt-2", null);
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
  });
});

describe("Unknown outcomes", () => {
  test("OP-02 (UI): UnknownOutcomesNotice: an ambiguous write is shown against its machine, not retried, and can be dismissed", async () => {
    const fake = installTwoMachines(({ command }) =>
      command === "stop_environment" ? OUTCOME_UNKNOWN : undefined,
    );
    renderWithFederation(<RemoteSections />);
    await waitForRows(2);

    // Remote rows carry the same right-click menu as this window's rows.
    fireEvent.contextMenu(
      within(rowOf("bk_a")).getByRole("button", {
        name: /^feature, on Machine A/,
      }),
    );
    const menu = await screen.findByRole("menu");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Stop" }));

    const notice = await screen.findByTestId("unknown-outcomes");
    expect(notice.textContent).toContain("Stop environment");
    const sectionA = screen.getByRole("region", { name: "Machine A projects" });
    expect(within(sectionA).getByTestId("unknown-outcomes")).toBe(notice);
    expect(
      within(screen.getByRole("region", { name: "Machine B projects" })).queryByTestId(
        "unknown-outcomes",
      ) === null,
    ).toBe(true);
    await waitFor(() => expect(mockToastWarning).toHaveBeenCalledTimes(1));
    expect(String(mockToastWarning.mock.calls[0]![0])).toContain("Machine A");
    expect(fake.callsTo("a", "stop_environment")).toHaveLength(1);
    expect(fake.callsTo("b", "stop_environment")).toHaveLength(0);

    fireEvent.click(within(notice).getByRole("button", { name: "Dismiss Stop environment" }));
    await waitFor(() => expect(screen.queryByTestId("unknown-outcomes") === null).toBe(true));
    expect(fake.callsTo("a", "stop_environment")).toHaveLength(1);
  });
});

describe("the sidebar order the command node keeps", () => {
  test("machines follow the stored order, and the window's own machine does not move to the top", async () => {
    installDesktopFake({
      list: connectionList([MACHINE_A, MACHINE_B]),
      datasets: { a: sharedIdDataset("idle"), b: sharedIdDataset("idle") },
      layout: { revision: 1, machineOrder: ["bk_b", "bk_self", "bk_a"] },
    });
    window.orkestratorWorkspaceTarget = {
      nodeId: "bk_a",
      nodeName: "Machine A",
      path: "direct",
    };
    try {
      renderWithFederation(<MachineOrder />);
      await waitFor(() =>
        // The command node's own summary is not part of this fixture.
        expect(screen.getAllByTestId("machine-order").map((item) => item.textContent)).toEqual([
          "bk_b",
          "bk_a",
        ]),
      );
    } finally {
      delete window.orkestratorWorkspaceTarget;
    }
  });

  test("by project hides a machine that is not connected", async () => {
    installDesktopFake({
      list: connectionList([
        MACHINE_A,
        remoteConnection("b", "Machine B", "rose", {
          transport: "unreachable",
        }),
      ]),
      datasets: { a: sharedIdDataset("idle"), b: sharedIdDataset("idle") },
    });
    renderWithFederation(<AggregateList mode="project" />);
    await waitForRows(1);
    expect(
      screen
        .getAllByTestId("federated-project")
        .map((project) => project.getAttribute("data-project")),
    ).toEqual([projectKey(projectRef("bk_a" as BackendId, "project-1"))]);
  });

  test("by project follows a stored order across machines", async () => {
    installDesktopFake({
      list: connectionList([MACHINE_A, MACHINE_B]),
      datasets: { a: sharedIdDataset("idle"), b: sharedIdDataset("idle") },
      layout: {
        revision: 2,
        projectOrder: [
          projectKey(projectRef("bk_b" as BackendId, "project-1")),
          projectKey(projectRef("bk_a" as BackendId, "project-1")),
        ],
      },
    });
    renderWithFederation(<AggregateList mode="project" />);
    await waitFor(() =>
      expect(
        screen
          .getAllByTestId("federated-project")
          .map((project) => project.getAttribute("data-project")),
      ).toEqual([
        projectKey(projectRef("bk_b" as BackendId, "project-1")),
        projectKey(projectRef("bk_a" as BackendId, "project-1")),
      ]),
    );
  });
});

for (const mode of ["remote", "merged"] as const) {
  test(`${mode} folder rename normalizes collapse state and clears the previous key`, async () => {
    installDesktopFake({
      list: connectionList([MACHINE_A]),
      datasets: {
        a: {
          projects: [{ id: "p", name: "App", order: 0, folder: "Work" }],
          environments: {},
        },
      },
    });
    renderWithFederation(mode === "remote" ? <RemoteSections /> : <AggregateList mode="project" />);
    fireEvent.click(await screen.findByRole("button", { name: "Collapse folder Work" }));
    fireEvent.contextMenu(screen.getByTitle("Expand folder Work"));
    fireEvent.click(await screen.findByText("Rename Folder"));
    fireEvent.change(await screen.findByLabelText("Rename folder Work"), {
      target: { value: "  New    Folder  " },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    await screen.findByRole("button", { name: "Expand folder New Folder" });
    const prefix = mode === "remote" ? "bk_a" : "project";
    expect(useMachineViewStore.getState().collapsedFolderKeys).toContain(`${prefix}/new folder`);
    expect(useMachineViewStore.getState().collapsedFolderKeys).not.toContain(`${prefix}/work`);
  });
}

describe("command handover dialog edge cases", () => {
  test("an iOS-shaped bridge switches through native use without handover methods", async () => {
    const fake = installTwoMachines();
    const api = window.orkestrator!.connections!;
    delete api.previewCommandHandover;
    delete api.handOverCommand;
    window.__orkestratorClientPlatform = "ios-wkwebview";
    try {
      renderWithFederation(<FilterOnly />);
      await waitFor(() =>
        expect(screen.getByTestId("machines-connectivity").textContent).toBe("3/3"),
      );
      await act(async () => {
        fireEvent.pointerDown(screen.getByTestId("machines-filter"), {
          button: 0,
          ctrlKey: false,
        });
      });
      const row = await screen.findByTestId("command-node-row");
      await act(async () => {
        fireEvent.keyDown(row, { key: "ArrowRight" });
      });
      const switcher = await screen.findByTestId("command-node-switcher");
      fireEvent.click(within(switcher).getByRole("menuitem", { name: /^Machine B/ }));
      await waitFor(() => expect(fake.connections.use).toHaveBeenCalledWith(MACHINE_B.id));
      expect(reload).not.toHaveBeenCalled();
      expect(mockToastError).not.toHaveBeenCalled();
    } finally {
      delete window.__orkestratorClientPlatform;
    }
  });

  test("auto-executes an empty selection and keeps a failed attempt available for retry", async () => {
    const fake = installTwoMachines();
    const original = await fake.connections.previewCommandHandover(MACHINE_B.id);
    fake.connections.previewCommandHandover.mockResolvedValue({
      ...original,
      preview: {
        ...original.preview,
        candidates: [],
        targetNodeIds: [MACHINE_A.backendId!],
      },
    });
    fake.connections.handOverCommand.mockRejectedValueOnce(new Error("temporary failure"));
    render(<CommandHandoverDialog />);
    act(() =>
      requestCommandHandover({
        name: MACHINE_B.name,
        connectionId: MACHINE_B.id,
      }),
    );
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Could not change the command node", {
        description: "temporary failure",
      }),
    );
    const dialog = await screen.findByTestId("command-handover-dialog");
    const retry = within(dialog).getByRole("button", {
      name: "Make command node",
    });
    expect(retry.hasAttribute("disabled")).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(fake.connections.handOverCommand).toHaveBeenCalledTimes(2);
    expect(fake.connections.handOverCommand).toHaveBeenLastCalledWith({
      targetConnectionId: MACHINE_B.id,
      confirmation: expect.objectContaining({
        sourceNodeId: "bk_self",
        targetNodeId: MACHINE_B.backendId,
      }),
      nodeIds: [],
      connectionIds: [],
      includeSelf: true,
    });
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  test("a loop on the target asks for confirmation even with nothing to choose", async () => {
    const fake = installTwoMachines();
    const original = await fake.connections.previewCommandHandover(MACHINE_B.id);
    fake.connections.previewCommandHandover.mockResolvedValue({
      ...original,
      preview: {
        ...original.preview,
        candidates: [],
        targetNodeIds: [MACHINE_A.backendId!],
      },
      repairs: ["forget-source-on-target", "allow-source-on-target"],
    } as never);
    render(<CommandHandoverDialog />);
    act(() =>
      requestCommandHandover({
        name: MACHINE_B.name,
        connectionId: MACHINE_B.id,
      }),
    );
    const repairs = await screen.findByTestId("command-handover-repairs");
    expect(repairs.textContent).toContain("lists This computer as one of its own machines");
    expect(repairs.textContent).toContain("was detached on");
    expect(repairs.textContent).toContain("remain on Machine B if a later handover step fails");
    expect(fake.connections.handOverCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Make command node" }));
    await waitFor(() => expect(fake.connections.handOverCommand).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  test("incomplete target inspection prevents automatic execution", async () => {
    const fake = installTwoMachines();
    const original = await fake.connections.previewCommandHandover(MACHINE_B.id);
    fake.connections.previewCommandHandover.mockResolvedValue({
      ...original,
      targetInspectionComplete: false,
      preview: {
        ...original.preview,
        candidates: [],
        targetNodeIds: [MACHINE_A.backendId!],
      },
    } as never);
    render(<CommandHandoverDialog />);
    act(() =>
      requestCommandHandover({
        name: MACHINE_B.name,
        connectionId: MACHINE_B.id,
      }),
    );
    await screen.findByText(/could not fully inspect/);
    expect(fake.connections.handOverCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Make command node" }));
    await waitFor(() =>
      expect(fake.connections.handOverCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          confirmation: expect.objectContaining({
            targetInspectionComplete: false,
          }),
        }),
      ),
    );
  });

  for (const automatic of [false, true]) {
    test(`new repairs return to confirmation after ${automatic ? "automatic" : "confirmed"} execution`, async () => {
      const fake = installTwoMachines();
      const original = await fake.connections.previewCommandHandover(MACHINE_B.id);
      const initial = {
        ...original,
        preview: {
          ...original.preview,
          candidates: automatic ? [] : original.preview.candidates,
          targetNodeIds: [MACHINE_A.backendId!],
        },
      };
      fake.connections.previewCommandHandover.mockResolvedValueOnce(initial).mockResolvedValue({
        ...initial,
        repairs: ["allow-source-on-target"],
      } as never);
      fake.connections.handOverCommand.mockRejectedValueOnce(
        new Error(COMMAND_HANDOVER_PREVIEW_CHANGED),
      );
      render(<CommandHandoverDialog />);
      act(() =>
        requestCommandHandover({
          name: MACHINE_B.name,
          connectionId: MACHINE_B.id,
        }),
      );
      if (!automatic) {
        await screen.findByRole("checkbox", { name: "Machine A" });
        fireEvent.click(screen.getByRole("button", { name: "Make command node" }));
      }
      const warning = await screen.findByTestId("command-handover-repairs");
      expect(warning.textContent).toContain("was detached");
      expect(fake.connections.handOverCommand).toHaveBeenCalledTimes(1);
      expect(reload).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Make command node" }).hasAttribute("disabled"),
        ).toBe(false),
      );
      fireEvent.click(screen.getByRole("button", { name: "Make command node" }));
      await waitFor(() => expect(fake.connections.handOverCommand).toHaveBeenCalledTimes(2));
      expect(fake.connections.handOverCommand).toHaveBeenLastCalledWith(
        expect.objectContaining({
          confirmation: expect.objectContaining({
            repairs: ["allow-source-on-target"],
          }),
        }),
      );
    });
  }

  for (const bringSaved of [true, false]) {
    test(`a device-only saved machine is ${bringSaved ? "included" : "omitted"} by choice`, async () => {
      const saved = remoteConnection("saved", "Saved machine", "teal");
      const fake = installTwoMachines();
      const original = await fake.connections.previewCommandHandover(MACHINE_B.id);
      fake.connections.list.mockResolvedValue(connectionList([MACHINE_A, MACHINE_B, saved]));
      fake.connections.previewCommandHandover.mockResolvedValue({
        ...original,
        preview: {
          ...original.preview,
          candidates: [],
          targetNodeIds: [MACHINE_A.backendId!],
        },
      });
      render(<CommandHandoverDialog />);
      act(() =>
        requestCommandHandover({
          name: MACHINE_B.name,
          connectionId: MACHINE_B.id,
        }),
      );
      const checkbox = await screen.findByRole("checkbox", {
        name: "Saved machine",
      });
      expect(checkbox.getAttribute("aria-checked")).toBe("true");
      if (!bringSaved) fireEvent.click(checkbox);
      fireEvent.click(screen.getByRole("button", { name: "Make command node" }));
      await waitFor(() =>
        expect(fake.connections.handOverCommand).toHaveBeenCalledWith(
          expect.objectContaining({
            connectionIds: bringSaved ? [saved.id] : [],
          }),
        ),
      );
    });
  }

  test("an already-command-node result only switches the native connection", async () => {
    const fake = installTwoMachines();
    window.orkestrator!.connections!.previewCommandHandover = async () => ({
      kind: "already-command-node",
    });
    render(<CommandHandoverDialog />);
    act(() =>
      requestCommandHandover({
        name: MACHINE_B.name,
        connectionId: MACHINE_B.id,
      }),
    );
    await waitFor(() => expect(fake.connections.use).toHaveBeenCalledWith(MACHINE_B.id));
    expect(fake.connections.handOverCommand).not.toHaveBeenCalled();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
  });

  test("unreachable self requires an explicit choice and stays excluded", async () => {
    const fake = installTwoMachines();
    const original = await fake.connections.previewCommandHandover(MACHINE_B.id);
    fake.connections.previewCommandHandover.mockResolvedValue({
      ...original,
      preview: {
        ...original.preview,
        candidates: [],
        targetNodeIds: [MACHINE_A.backendId!],
        self: { ...original.preview.self, reachable: false },
      },
    });
    render(<CommandHandoverDialog />);
    act(() =>
      requestCommandHandover({
        name: MACHINE_B.name,
        connectionId: MACHINE_B.id,
      }),
    );
    const warning = await screen.findByText(/has no web address/);
    expect(warning.textContent).toContain("cannot follow");
    const checkbox = screen.getByRole("checkbox", {
      name: "This computer, the current command node",
    });
    expect(checkbox.hasAttribute("disabled")).toBe(true);
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(fake.connections.handOverCommand).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Make command node" }));
    await waitFor(() =>
      expect(fake.connections.handOverCommand).toHaveBeenCalledWith({
        targetConnectionId: MACHINE_B.id,
        confirmation: expect.objectContaining({
          sourceNodeId: "bk_self",
          targetNodeId: MACHINE_B.backendId,
        }),
        nodeIds: [],
        connectionIds: [],
        includeSelf: false,
      }),
    );
  });
});

for (const lostResponse of [false, true]) {
  test(`a persisted fork opens when startup ${lostResponse ? "has an unknown outcome" : "is rejected"}`, async () => {
    const fake = installTwoMachines(({ command }) => {
      if (command === "check_docker") return { available: true, reason: null };
      if (command === "fork_environment")
        return { id: "fork-created", projectId: "project-1", name: "saved-fork" };
      if (command === "start_environment_background") {
        expect(useRemoteWorkspaceStore.getState().active?.environmentId).toBe("fork-created");
        return lostResponse ? OUTCOME_UNKNOWN : new Error("start admission rejected");
      }
    });
    renderWithFederation(<RemoteSections />);
    await waitForRows(2);
    const menu = await openRowActions("Machine A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Fork container" }));
    await waitFor(() =>
      expect(lostResponse ? mockToastWarning : mockToastError).toHaveBeenCalled(),
    );
    const toast = (lostResponse ? mockToastWarning : mockToastError).mock.calls.at(-1)!;
    expect(String(toast[0])).toContain("Start fork saved-fork");
    expect(String(toast[0])).toContain("Machine A");
    expect(useRemoteWorkspaceStore.getState().active?.environmentId).toBe("fork-created");
    expect(fake.callsTo("a", "fork_environment")).toHaveLength(1);
    expect(fake.callsTo("a", "start_environment_background")).toHaveLength(1);
    expect(fake.callsTo("b", "fork_environment")).toHaveLength(0);
    expect(fake.callsTo("b", "start_environment_background")).toHaveLength(0);
  });
}

test("a container fork checks Docker on its owner before persisting a record", async () => {
  const fake = installTwoMachines(({ command }) =>
    command === "check_docker" ? { available: false, reason: "daemon-unavailable" } : undefined,
  );
  renderWithFederation(<RemoteSections />);
  await waitForRows(2);
  const menu = await openRowActions("Machine A");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Fork container" }));
  await waitFor(() => expect(mockToastError).toHaveBeenCalled());
  expect(fake.callsTo("a", "check_docker")).toHaveLength(1);
  expect(fake.callsTo("a", "fork_environment")).toHaveLength(0);
  expect(fake.callsTo("a", "start_environment_background")).toHaveLength(0);
  expect(mockToastSuccess).not.toHaveBeenCalled();
});

test("a stop failure prevents restart admission", async () => {
  const fake = installTwoMachines(({ command }) =>
    command === "stop_environment" ? new Error("stop failed") : undefined,
  );
  renderWithFederation(<RemoteSections />);
  await waitForRows(2);
  const menu = await openRowActions("Machine A");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Restart" }));
  await waitFor(() => expect(mockToastError).toHaveBeenCalled());
  expect(fake.callsTo("a", "stop_environment")).toHaveLength(1);
  expect(fake.callsTo("a", "start_environment_background")).toHaveLength(0);
  expect(mockToastSuccess).not.toHaveBeenCalled();
});

test("background restart admission followed by lifecycle failure never reports restarted success", async () => {
  const dataset = sharedIdDataset("idle");
  const fake = installDesktopFake({ list: connectionList([MACHINE_A]), datasets: { a: dataset } });
  renderWithFederation(<RemoteSections />);
  await waitForRows(1);
  const menu = await openRowActions("Machine A");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Restart" }));
  await waitFor(() => expect(fake.callsTo("a", "start_environment_background")).toHaveLength(1));
  expect(mockToastSuccess).not.toHaveBeenCalled();
  dataset.environments["project-1"]![0]!.status = "error";
  await act(async () => {
    await portalStore.refresh();
  });
  await waitFor(() =>
    expect(portalStore.node("bk_a" as BackendId)?.environments[0]?.status).toBe("error"),
  );
  expect(mockToastSuccess).not.toHaveBeenCalled();
});

for (const rejectWrite of [false, true]) {
  test(`remote folder actions ${rejectWrite ? "roll back failed writes" : "submit owner-specific changes and expand the destination"}`, async () => {
    let finish!: (value: unknown) => void;
    const write = new Promise((resolve) => {
      finish = resolve;
    });
    const fake = installDesktopFake({
      list: connectionList([MACHINE_A, MACHINE_B]),
      datasets: {
        a: {
          projects: [
            { id: "p", name: "App A", order: 0 },
            { id: "q", name: "Other A", order: 1, folder: "Work" },
          ],
          environments: {},
        },
        b: { projects: [{ id: "p", name: "App B", order: 0 }], environments: {} },
      },
      respond: ({ command }) => (command === "arrange_projects" ? write : undefined),
    });
    useMachineViewStore.getState().setFolderKeyCollapsed("bk_a/work", true);
    renderWithFederation(<RemoteSections />);
    fireEvent.contextMenu(await screen.findByRole("button", { name: "App A" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Add to Folder" }));
    fireEvent.change(await screen.findByLabelText("Folder name"), {
      target: { value: "  Work  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to Folder" }));
    await waitFor(() => expect(fake.callsTo("a", "arrange_projects")).toHaveLength(1));
    expect(fake.callsTo("a", "arrange_projects")[0]!.args).toEqual({
      projectIds: ["q", "p"],
      folders: { p: "Work" },
    });
    expect(fake.callsTo("b", "arrange_projects")).toHaveLength(0);
    await screen.findByRole("button", { name: "Collapse folder Work" });
    await act(async () => finish(rejectWrite ? new Error("write denied") : { ok: true }));
    if (rejectWrite) {
      await waitFor(() => expect(mockToastError).toHaveBeenCalled());
      expectDomAbsent(
        screen.getByRole("button", { name: "App A" }).closest("[data-project-folder-content]"),
      );
    } else {
      fireEvent.contextMenu(screen.getByRole("button", { name: "App A" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Remove from Folder" }));
      await waitFor(() => expect(fake.callsTo("a", "arrange_projects")).toHaveLength(2));
      expect(fake.callsTo("a", "arrange_projects")[1]!.args).toEqual({
        projectIds: ["q", "p"],
        folders: { p: null },
      });
      expectDomAbsent(
        screen.getByRole("button", { name: "App A" }).closest("[data-project-folder-content]"),
      );
    }
  });
}
