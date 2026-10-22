import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
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
import {
  OUTCOME_UNKNOWN,
  connectionList,
  installDesktopFake,
  remoteConnection,
  sharedIdDataset,
  uninstallDesktopFake,
} from "@/test/federation-desktop-fake";
import { mockToastWarning } from "../../../../../tests/mocks/sonner";
import {
  FederatedActivityList,
  MergedProjectList,
  RemoteMachineSection,
} from "./FederatedSidebarSections";
import { RemoteEnvironmentItem } from "./RemoteMachineTree";
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
  return <MachinesFilter machines={machines} />;
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
  const row = screen.getByRole("button", { name: new RegExp(`^feature, on ${machineName},`) });
  await act(async () => {
    fireEvent.contextMenu(row);
  });
  return screen.findByRole("menu");
}

function machineView(overrides: Partial<MachineView> = {}): MachineView {
  const backendId = "bk_a" as BackendId;
  const project = { ref: projectRef(backendId, "project-1"), name: "app", order: 0 };
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

test("a repository group names each member by its machine and shows a machine dot, not a count", async () => {
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
  const heading = screen.getByRole("button", { name: "Open acme/app on Machine A" });
  expect(heading.getAttribute("aria-expanded")).toBeNull();
  expect(heading.getAttribute("title")).toBe(`Open ${hint} on Machine A`);
  expect(within(heading).getByTestId("machine-dot").getAttribute("data-machine-color")).toBe(
    "teal",
  );
  expect(within(heading).queryByText("2") === null).toBe(true);
  const members = screen.getAllByTestId("federated-project");
  expect(members.map((member) => member.querySelector(".truncate")?.textContent)).toEqual([
    "Machine A",
    "Machine B",
  ]);
});

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

  test("CL-05: an unavailable machine's row is dimmed and says connection lost, never stopped", () => {
    const machine = machineView({ transport: "unreachable", freshness: "stale" });
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
  test("UI-01: each machine gets its own section, dot and rows for the same IDs", async () => {
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
      headers.map((header) => [
        header.getAttribute("data-machine"),
        within(header).getByTestId("machine-dot").getAttribute("data-machine-color"),
      ]),
    ).toEqual([
      ["bk_a", "teal"],
      ["bk_b", "rose"],
    ]);
    for (const section of sections) {
      expect(within(section).getByText("app")).toBeTruthy();
    }
    expect(
      within(rowOf("bk_a")).getByRole("button", { name: /^feature, on Machine A, Working/ }),
    ).toBeTruthy();
    expect(
      within(rowOf("bk_b")).getByRole("button", { name: /^feature, on Machine B, Awaiting input/ }),
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
    expect(
      within(projects[0]!).getAllByTestId("machine-dot")[0]!.getAttribute("data-machine-color"),
    ).toBe("teal");
    expect(
      within(projects[1]!).getAllByTestId("machine-dot")[0]!.getAttribute("data-machine-color"),
    ).toBe("rose");
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
              { id: "e-1", projectId: "p-zeta", name: "first", status: "running", order: 2 },
              { id: "e-2", projectId: "p-zeta", name: "second", status: "running", order: 0 },
              { id: "e-3", projectId: "p-zeta", name: "third", status: "running", order: 1 },
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
    expect(fake.callsTo("a", "delete_environment")[0]!.args).toEqual({ environmentId: "env-1" });
    expect(fake.calls.filter((call) => call.command === "delete_environment")).toHaveLength(1);
    expect(fake.callsTo("b", "delete_environment")).toHaveLength(0);
  });
});

describe("UI-04: creating inside a project instance", () => {
  test("UI-04: New environment in a project on a machine opens that machine's dialog", async () => {
    const fake = installTwoMachines();
    renderWithFederation(<RemoteSections />);
    await waitForRows(2);

    fireEvent.click(screen.getByRole("button", { name: "New environment in app on Machine B" }));
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
      fireEvent.pointerDown(screen.getByTestId("machines-filter"), { button: 0, ctrlKey: false });
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
  test("names the command node below the filters and switches it only through its switch", async () => {
    const fake = installTwoMachines();
    renderWithFederation(<FilterOnly />);
    await waitFor(() =>
      expect(screen.getByTestId("machines-connectivity").textContent).toBe("3/3"),
    );

    await act(async () => {
      fireEvent.pointerDown(screen.getByTestId("machines-filter"), { button: 0, ctrlKey: false });
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
      within(switcher).getByRole("menuitem", { name: /^Local, current command node/ }),
    ).toBeTruthy();
    fireEvent.click(within(switcher).getByRole("menuitem", { name: /^Machine B/ }));

    await waitFor(() => expect(fake.connections.use).toHaveBeenCalledWith(MACHINE_B.id));
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(fake.workspaceViews.open).not.toHaveBeenCalled();
  });
});

describe("The command node in a browser tab", () => {
  test("switching opens another machine's own address", async () => {
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
      await waitFor(() => expect(assign).toHaveBeenCalledWith(MACHINE_B.address!));
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
      within(rowOf("bk_a")).getByRole("button", { name: /^feature, on Machine A, Working/ }),
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
        within(rowOf("bk_a")).getByRole("button", { name: /^feature, on Machine A, Working/ }),
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
    fireEvent.change(within(dialog).getByLabelText("Passphrase"), { target: { value: "s3cret" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));

    expect(fake.connections.answerSshPrompt).toHaveBeenCalledTimes(1);
    expect(fake.connections.answerSshPrompt).toHaveBeenCalledWith("prompt-1", "s3cret");
    await waitFor(() => expect(screen.queryByRole("dialog") === null).toBe(true));
  });

  test("SH-03: cancelling a prompt answers null exactly once", async () => {
    const fake = installTwoMachines();
    render(<SshPromptDialog />);
    act(() =>
      fake.emit("ssh-auth-prompt", { promptId: "prompt-2", kind: "password", message: "" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Password"), { target: { value: "typed" } });
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
      within(rowOf("bk_a")).getByRole("button", { name: /^feature, on Machine A/ }),
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
    window.orkestratorWorkspaceTarget = { nodeId: "bk_a", nodeName: "Machine A", path: "direct" };
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
        remoteConnection("b", "Machine B", "rose", { transport: "unreachable" }),
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
        a: { projects: [{ id: "p", name: "App", order: 0, folder: "Work" }], environments: {} },
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
