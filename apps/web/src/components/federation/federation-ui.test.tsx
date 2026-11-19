import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as sortable from "@dnd-kit/sortable";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { projectKey, projectRef } from "@orkestrator/protocol/federation";
import type { BackendId } from "@orkestrator/protocol/federation";
import { isMachineShown } from "@/lib/federation/sidebar-layout";
import type { FederatedEnvironment } from "@/lib/federation/summaries";
import { reorderFederatedEnvironments } from "@/lib/federation/federated-actions";
import { portalStore } from "@/lib/portal/portal-store";
import { useMachineViewStore } from "@/stores/machineViewStore";
import {
  startRemoteWorkspaceSelectionSync,
  useRemoteWorkspaceStore,
} from "@/stores/remoteWorkspaceStore";
import { uiStore } from "@/stores/uiStore";
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
import { FederatedActivityList } from "./FederatedSidebarSections";
import { EnvironmentItem } from "@/components/environments/EnvironmentItem";
import { environmentStore } from "@/stores/environmentStore";
import type { Environment } from "@/types";
import { RemoteEnvironmentItem } from "./RemoteMachineTree";
import { RepositoryEnvironmentList } from "./RepositoryEnvironmentList";
import { MachineTiles } from "./MachineTiles";
import { CommandHandoverDialog } from "./CommandHandoverDialog";
import {
  NO_BOUND_ROWS,
  firstEnvironment,
  machineView,
  renderWithFederation,
} from "./federation-ui-test-fixture";
import { MachineBadge, MachineDot } from "./MachineDot";
import { MachinesFilter } from "./MachinesFilter";
import { SshPromptDialog } from "./SshPromptDialog";
import { useMachineViews } from "./useMachineViews";
import { appCommandStore } from "@/test/app-command-store";

import { useAsyncUtilHangWatchdog } from "@/test/async-util-hang-watchdog";
/** A repository's heading, named by what it opens and the machine it opens on. */
function projectHeading(project: string, machine: string): HTMLElement {
  return screen.getByRole("button", { name: `Open ${project} on ${machine}` });
}

/** The heading's whole entry: its heading, its "+" and its rows. */
function repositoryEntry(project: string, machine: string): HTMLElement {
  return projectHeading(project, machine).closest("[data-project-folder]") as HTMLElement;
}

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

/** The repository list of every connected machine, as the sidebar draws it. */
function RepositoryList() {
  const machines = useMachineViews();
  return (
    <RepositoryEnvironmentList
      machines={machines}
      shownIds={new Set(machines.filter(isMachineShown).map((machine) => machine.connectionId))}
      listedIds={new Set(machines.map((machine) => machine.connectionId))}
      ordering="machine"
      bound={NO_BOUND_ROWS}
    />
  );
}

function ActivityList() {
  const machines = useMachineViews();
  return <FederatedActivityList machines={machines} renderBoundRow={() => null} />;
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

test("federated sortable wrappers preserve size when dragged over unequal items", () => {
  const useSortable = sortable.useSortable;
  const sortableSpy = spyOn(sortable, "useSortable").mockImplementation((options) => ({
    ...useSortable(options),
    transform: { x: -12, y: 40, scaleX: 0.75, scaleY: 3.5 },
    isDragging: true,
  }));
  try {
    const machine = machineView();
    renderWithFederation(
      <>
        <MachineTiles machines={[machine]} />
        <RepositoryEnvironmentList
          machines={[machine]}
          shownIds={new Set([machine.connectionId])}
          ordering="machine"
          bound={NO_BOUND_ROWS}
        />
      </>,
    );

    const wrappers = [
      screen.getByTestId("machine-tile"),
      document.querySelector("[data-project-folder]") as HTMLElement,
      screen.getByTestId("federated-environment-row"),
    ];
    expect(wrappers.length).toBe(3);
    for (const wrapper of wrappers) {
      expect(wrapper.style.transform).toBe("translate3d(-12px, 40px, 0)");
    }
  } finally {
    cleanup();
    sortableSpy.mockRestore();
  }
});

test("a connected machine still shows catching-up freshness on its tile", () => {
  renderWithFederation(<MachineTiles machines={[machineView({ freshness: "catching-up" })]} />);
  const tile = screen.getByTestId("machine-tile");
  expect(tile.getAttribute("title")).toContain("Machine A · Catching up");
  // Connected: the tile's name does not call it offline.
  expect(tile.getAttribute("aria-label")).not.toContain("Catching up");
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

test("the activity and repository lists draw this window's own rows with its full controls", () => {
  const local = machineView({ bound: true });
  const remote = machineView({
    connectionId: "b",
    backendId: "bk_b" as never,
    projects: [],
    environmentsByProject: new Map(),
  });
  const view = renderInAppCommandScope(
    <FederatedActivityList
      machines={[local, remote]}
      renderBoundRow={(id) => <button aria-label={`Start local ${id}`}>Start</button>}
    />,
  );
  expect(screen.getByRole("button", { name: "Start local env-1" })).toBeTruthy();
  view.unmount();
  renderWithFederation(
    <RepositoryEnvironmentList
      machines={[local, remote]}
      shownIds={new Set(["a", "b"])}
      ordering="machine"
      bound={{
        ...NO_BOUND_ROWS,
        renderEnvironment: (id) => <button aria-label={`Open local ${id}`}>Open</button>,
      }}
    />,
  );
  expect(screen.getByRole("button", { name: "Open local env-1" })).toBeTruthy();
});

useAsyncUtilHangWatchdog();

describe("CL-05: machine identity visual rules", () => {
  test("CL-05: a decorative MachineDot is hidden from assistive technology", () => {
    renderInAppCommandScope(<MachineDot colorToken="teal" machineName="Machine A" />);
    const dot = screen.getByTestId("machine-dot");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.getAttribute("role")).toBeNull();
    expect(dot.getAttribute("data-machine-color")).toBe("teal");
  });

  test("CL-05: a non-decorative MachineDot is an image named by machine and colour", () => {
    renderInAppCommandScope(
      <MachineDot colorToken="teal" machineName="Machine A" decorative={false} />,
    );
    const dot = screen.getByRole("img", { name: "Machine A (Teal)" });
    expect(dot.getAttribute("aria-hidden")).toBeNull();
  });

  test("CL-05: a compact MachineBadge keeps the machine name in a screen-reader-only element", () => {
    renderInAppCommandScope(<MachineBadge colorToken="rose" machineName="Machine B" compact />);
    const badge = screen.getByTestId("machine-badge");
    const name = within(badge).getByText("Machine B");
    expect(name.className).toContain("sr-only");
    expect(within(badge).getByRole("img", { name: "Machine B (Rose)" })).toBeTruthy();
  });

  test("CL-05: an unknown colour token renders the neutral fallback without rewriting the token", () => {
    renderInAppCommandScope(
      <MachineDot colorToken="plum-2030" machineName="Future" decorative={false} />,
    );
    const dot = screen.getByRole("img", { name: "Future (Unknown color)" });
    expect(dot.getAttribute("data-machine-color")).toBe("plum-2030");
    expect(dot.className).toContain("border-dashed");
    expect(dot.className).not.toContain("bg-violet-500");
  });

  test("CL-05: an environment row is named by environment, machine and activity", () => {
    const machine = machineView();
    renderInAppCommandScope(
      <RemoteEnvironmentItem
        machine={machine}
        environment={firstEnvironment(machine)}
        subtitle="app"
      />,
    );
    const row = screen.getByRole("button", { name: /^feature, on Machine A, Working/ });
    expect(within(row).getByText("app")).toBeTruthy();
  });

  test("another machine's build pipeline and auto-merge rows carry their markers", () => {
    const machine = machineView();
    const plain = firstEnvironment(machine);
    const { rerender } = renderInAppCommandScope(
      <RemoteEnvironmentItem machine={machine} environment={plain} />,
    );
    const row = screen.getByRole("button", { name: /^feature, on Machine A,/ });
    expect(row.querySelector("svg.lucide-pipe") === null).toBe(true);
    expect(within(row).queryByTestId("environment-auto-merge-icon") === null).toBe(true);

    rerender(
      <RemoteEnvironmentItem
        machine={machine}
        environment={{ ...plain, name: "Build: feature", buildPipeline: true, autoMerge: true }}
      />,
    );
    const built = screen.getByRole("button", { name: /^Build: feature, on Machine A,/ });
    expect(built.querySelector("svg.lucide-pipe")).not.toBeNull();
    expect(within(built).getByTestId("environment-auto-merge-icon")).toBeTruthy();
    expect(within(built).getByText("feature")).toBeTruthy();
  });

  test("another machine's merged PR shows the merged icon, as the machine's own row does", () => {
    const machine = machineView();
    const plain = firstEnvironment(machine);
    const { rerender } = renderInAppCommandScope(
      <RemoteEnvironmentItem machine={machine} environment={{ ...plain, prState: "open" }} />,
    );
    expect(screen.queryByRole("img", { name: "Merged" }) === null).toBe(true);

    rerender(
      <RemoteEnvironmentItem
        machine={machine}
        environment={{ ...plain, prState: "merged", autoMerge: true }}
      />,
    );
    const row = screen.getByRole("button", { name: /^feature, on Machine A,/ });
    const icon = within(row).getByRole("img", { name: "Merged" });
    expect(icon.getAttribute("data-state")).toBe("merged");
    // The merged icon replaces the auto-merge icon rather than doubling it.
    expect(within(row).queryByTestId("environment-auto-merge-icon") === null).toBe(true);
  });

  test("another machine's clean PR stays plain without leaf monitor health", () => {
    const machine = machineView();
    const ready: FederatedEnvironment = {
      ...firstEnvironment(machine),
      prState: "open",
      prHasMergeConflicts: false,
      prMergeability: "clean",
    };
    const { rerender } = renderInAppCommandScope(
      <RemoteEnvironmentItem machine={machine} environment={ready} />,
    );
    const row = screen.getByRole("button", { name: /^feature, on Machine A, Working/ });
    const name = within(row).getByText("feature");
    expect(name.classList).not.toContain("text-shimmer");
    expect(name.classList).not.toContain("merge-ready-name");
    const description = () =>
      (row.getAttribute("aria-describedby") ?? "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
    expect(description()).not.toMatch(/ready to merge/i);

    // A failing check makes GitHub report the merge state as unstable.
    rerender(
      <RemoteEnvironmentItem
        machine={machine}
        environment={{ ...ready, prMergeability: "unstable" }}
      />,
    );
    expect(within(row).getByText("feature").classList).not.toContain("text-shimmer");
    expect(description()).not.toMatch(/ready to merge/i);

    // A machine whose summaries are not current cannot vouch for the reading.
    rerender(
      <RemoteEnvironmentItem
        machine={machineView({ transport: "unreachable" })}
        environment={ready}
      />,
    );
    expect(
      within(screen.getByRole("button", { name: /^feature, on Machine A,/ })).getByText("feature")
        .classList,
    ).not.toContain("text-shimmer");
  });

  for (const environmentType of ["local", "containerized"] as const) {
    for (const transport of ["connected", "unreachable"] as const) {
      for (const status of ["running", "stopped"] as const) {
        for (const activity of ["idle", "working", "waiting"] as const) {
          test(`remote ${environmentType} ${status} on ${transport} machine maps ${activity} to its marker`, () => {
            const machine = machineView({ transport });
            const environment = { ...firstEnvironment(machine), environmentType, status, activity };
            renderInAppCommandScope(
              <RemoteEnvironmentItem machine={machine} environment={environment} />,
            );
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
                  ? "environment-working-spinner"
                  : "bg-yellow-400/50";
            expect(ring.classList).toContain(color);
            expect(ring.classList.contains("animate-pulse")).toBe(active && activity === "waiting");
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
      const { rerender } = renderInAppCommandScope(
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
    renderWithFederation(<ActivityList />);
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
      if (state === "deleting")
        appCommandStore(environmentStore).getState().setDeleting(environment.id, true);
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
        appCommandStore(environmentStore).getState().setDeleting(environment.id, false);
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
      renderInAppCommandScope(
        <RemoteEnvironmentItem machine={machine} environment={firstEnvironment(machine)} />,
      );
      const badge = await screen.findByTestId("environment-change-badge");
      expect(badge.textContent).toContain("+12");
      expect(badge.textContent).toContain("3");

      await act(async () => {
        fireEvent.focus(screen.getByRole("button", { name: /^feature, on Machine A/ }));
      });
      const machineLine = await screen.findByTestId("environment-tooltip-machine");
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
    renderInAppCommandScope(
      <FederatedActivityList machines={[machine]} renderBoundRow={() => null} />,
    );
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
  test("UI-01: each machine gets its own heading, colour and rows for the same IDs", async () => {
    installTwoMachines();
    renderWithFederation(<RepositoryList />);
    await waitForRows(2);

    for (const [name, color] of [
      ["Machine A", "teal"],
      ["Machine B", "rose"],
    ] as const) {
      const heading = projectHeading("app", name);
      expect(
        within(heading).getByTestId("command-node-home-icon").getAttribute("data-machine-color"),
      ).toBe(color);
      expect(within(heading).getByText("1 machine · 1 environment")).toBeTruthy();
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
    // Each row sits under its own machine's heading.
    expect(
      within(repositoryEntry("app", "Machine A")).getByTestId("federated-environment-row"),
    ).toBe(rowOf("bk_a"));
    expect(
      within(repositoryEntry("app", "Machine B")).getByTestId("federated-environment-row"),
    ).toBe(rowOf("bk_b"));
    expect(
      within(rowOf("bk_a")).getByTestId("machine-dot").getAttribute("data-machine-color"),
    ).toBe("teal");
    expect(
      within(rowOf("bk_b")).getByTestId("machine-dot").getAttribute("data-machine-color"),
    ).toBe("rose");
  });

  test("UI-01: the repository list keeps same-named projects as separate instances", async () => {
    installTwoMachines();
    renderWithFederation(<RepositoryList />);
    await waitForRows(2);

    const headings = [...document.querySelectorAll("[data-project-folder]")];
    // The command node's registry order until the user moves them.
    expect(headings.map((heading) => heading.getAttribute("data-project-folder"))).toEqual([
      projectKey(projectRef("bk_a" as BackendId, "project-1")),
      projectKey(projectRef("bk_b" as BackendId, "project-1")),
    ]);
    // No trailing dot and no chevron: the "+" comes last.
    for (const [index, name] of ["Machine A", "Machine B"].entries()) {
      const heading = projectHeading("app", name);
      expect(heading.closest("[data-project-folder]")).toBe(headings[index]!);
      expect(within(heading).queryByTestId("machine-dot") === null).toBe(true);
      const add = within(headings[index] as HTMLElement).getByTestId("repository-new-environment");
      expect(add.getAttribute("aria-label")).toBe("New environment in app");
      expect(add.parentElement!.lastElementChild).toBe(add);
    }
  });
});

describe("repository headings lead with their machine", () => {
  const ICON = "data:image/png;base64,iVBORw0KGgo=";

  test("each heading leads with a home in the colour of the machine it opens on", async () => {
    installTwoMachines();
    renderWithFederation(<RepositoryList />);
    await waitForRows(2);

    expect(
      [...document.querySelectorAll("[data-project-folder]")].map((heading) =>
        within(heading as HTMLElement)
          .getByTestId("command-node-home-icon")
          .getAttribute("data-machine-color"),
      ),
    ).toEqual(["teal", "rose"]);
    const heading = projectHeading("app", "Machine A");
    // The home leads the heading, before the name.
    expect(heading.firstElementChild?.getAttribute("data-testid")).toBe("command-node-home-icon");
  });

  test("a project's own icon replaces the home and keeps the machine's colour", async () => {
    installDesktopFake({
      list: connectionList([MACHINE_A, MACHINE_B]),
      datasets: {
        a: {
          ...sharedIdDataset("working"),
          projects: [{ id: "project-1", name: "app", order: 0, icon: ICON }],
        },
        b: {
          ...sharedIdDataset("waiting"),
          projects: [
            { id: "project-1", name: "app", order: 0, icon: "data:image/svg+xml;base64,PHN2Zz4=" },
          ],
        },
      },
    });
    renderWithFederation(<RepositoryList />);
    await waitForRows(2);
    const withIcon = within(projectHeading("app", "Machine A")).getByTestId(
      "command-node-home-icon",
    );
    expect(withIcon.getAttribute("data-machine-color")).toBe("teal");
    expect(within(withIcon).getByTestId("project-icon").getAttribute("src")).toBe(ICON);
    // An icon that is not a raster data URL never reaches the heading.
    const withoutIcon = within(projectHeading("app", "Machine B")).getByTestId(
      "command-node-home-icon",
    );
    expect(within(withoutIcon).queryByTestId("project-icon") === null).toBe(true);
    expect(withoutIcon.getAttribute("data-machine-color")).toBe("rose");
  });
});

describe("another machine's rows follow the owner's sidebar", () => {
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

  test("environments keep the owner's order", async () => {
    installOrderedMachine();
    renderWithFederation(<RepositoryList />);
    const rows = await waitForRows(3);

    expect(
      rows.map((row) => within(row).getAllByRole("button")[1]!.getAttribute("aria-label")),
    ).toEqual([
      "second, on Machine A, Idle",
      "third, on Machine A, Idle",
      "first, on Machine A, Idle",
    ]);
    for (const row of rows) {
      expect(row.closest("[data-project-folder]")?.getAttribute("data-project-folder")).toBe(
        projectKey(projectRef("bk_a" as BackendId, "p-zeta")),
      );
    }
  });

  test("environments of a connected machine can be dragged; an unavailable one is not listed", async () => {
    installOrderedMachine();
    const view = renderWithFederation(<RepositoryList />);
    await waitForRows(3);
    expect(screen.getAllByRole("button", { name: /^Reorder / })).toHaveLength(3);
    view.unmount();
    uninstallDesktopFake();

    installOrderedMachine({ transport: "unreachable" });
    renderWithFederation(<RepositoryList />);
    // Its last known environments are loaded, but the list waits for it to reconnect.
    await waitFor(() =>
      expect(portalStore.node("bk_a" as BackendId)?.environments).toHaveLength(3),
    );
    expect(screen.queryAllByTestId("federated-environment-row")).toHaveLength(0);
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
    renderWithFederation(<ActivityList />);
    await waitForRows(2);

    const menu = await openRowActions("Machine A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Delete/ }));
    const dialog = await screen.findByRole("alertdialog");
    // The same confirmation this window's rows use, naming the owner.
    const question = () => within(dialog).getByText(/Are you sure you want to delete/).textContent;
    expect(within(dialog).getByRole("heading").textContent).toBe("Delete environment");
    expect(question()).toContain("delete feature on Machine A?");

    // The user's focus moves to machine B while the confirmation is open.
    act(() => {
      useMachineViewStore.getState().setMachineFilter(["bk_b"]);
    });
    expect(question()).toContain("delete feature on Machine A?");

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
  test("UI-04: a project's \"+\" on a machine opens that machine's dialog", async () => {
    const fake = installTwoMachines();
    renderWithFederation(<RepositoryList />);
    await waitForRows(2);

    fireEvent.click(
      within(repositoryEntry("app", "Machine B")).getByRole("button", {
        name: "New environment in app",
      }),
    );
    // The central region shows Machine B's workspace, which opens its own New
    // Environment dialog; the window stays where it is and nothing is created
    // until the user submits it.
    await waitFor(() => expect(useRemoteWorkspaceStore.getState().active?.nodeId).toBe("bk_b"));
    expect(useRemoteWorkspaceStore.getState().requests.bk_b?.request).toEqual({
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
      fireEvent.contextMenu(projectHeading("acme/app", "Machine A"));
    });
    return screen.findByRole("menu");
  }

  test("a repository's menu has the local actions, and its dialogs open in that machine's workspace", async () => {
    const fake = installMachineA();
    const open = spyOn(window, "open").mockImplementation(() => null);
    try {
      renderWithFederation(<RepositoryList />);
      await waitForRows(1);

      const menu = await openProjectMenu();
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

      for (const [name, dialog] of [
        ["Repository settings", "repository-settings"],
        ["Delete project on Machine A…", "delete-project"],
      ] as const) {
        fireEvent.click(within(await openProjectMenu()).getByRole("menuitem", { name }));
        await waitFor(() =>
          expect(useRemoteWorkspaceStore.getState().requests.bk_a?.request).toEqual({
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
    renderWithFederation(<RepositoryList />);
    await waitForRows(1);

    let menu = await openRowActions("Machine A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Settings" }));
    await waitFor(() =>
      expect(useRemoteWorkspaceStore.getState().requests.bk_a?.request).toEqual({
        projectId: "project-1",
        environmentId: "env-1",
        dialog: "environment-settings",
      }),
    );

    menu = await openRowActions("Machine A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Fork container" }));
    await waitFor(() =>
      expect(useRemoteWorkspaceStore.getState().requests.bk_a?.request).toEqual({
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
    fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: /^Machine B, / }));

    await waitFor(() => expect(useMachineViewStore.getState().machineFilter).toEqual(["bk_b"]));
    expect(screen.getByTestId("machines-filter").getAttribute("aria-label")).toMatch(
      /^Machines: Machine B, 1 of 3 shown\./,
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
    renderWithFederation(<RepositoryList />);
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
    renderWithFederation(<RepositoryList />);
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
      expect(appCommandStore(uiStore).getState().selectedEnvironmentId).toBeNull();
      act(() =>
        appCommandStore(uiStore)
          .getState()
          .selectProjectAndEnvironment("local-project", "local-env"),
      );
      expect(useRemoteWorkspaceStore.getState().active).toBeNull();
      // Machine A stays held behind it, so going back is instant.
      expect(useRemoteWorkspaceStore.getState().openNodes).toEqual(["bk_a"]);
    } finally {
      stop();
    }
  });
});

describe("SH-03: SSH prompts", () => {
  test("SH-03: a passphrase prompt answers its own prompt ID with the typed value", async () => {
    const fake = installTwoMachines();
    renderInAppCommandScope(<SshPromptDialog />);
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
    renderInAppCommandScope(<SshPromptDialog />);
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
    renderWithFederation(<RepositoryList />);
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
    // Shown above the list, against Machine A only.
    expect(screen.getAllByTestId("unknown-outcomes")).toEqual([notice]);
    expect(notice.closest("[data-machine]")?.getAttribute("data-machine")).toBe("bk_a");
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
    renderWithFederation(<MachineOrder />);
    await waitFor(() =>
      expect(screen.getAllByTestId("machine-order").map((item) => item.textContent)).toEqual([
        "bk_b",
        "bk_self",
        "bk_a",
      ]),
    );
  });

  test("the repository list hides a machine that is not connected", async () => {
    installDesktopFake({
      list: connectionList([
        MACHINE_A,
        remoteConnection("b", "Machine B", "rose", {
          transport: "unreachable",
        }),
      ]),
      datasets: { a: sharedIdDataset("idle"), b: sharedIdDataset("idle") },
    });
    renderWithFederation(<RepositoryList />);
    await waitForRows(1);
    expect(
      [...document.querySelectorAll("[data-project-folder]")].map((heading) =>
        heading.getAttribute("data-project-folder"),
      ),
    ).toEqual([projectKey(projectRef("bk_a" as BackendId, "project-1"))]);
  });

  test("the repository list follows a stored order across machines", async () => {
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
    renderWithFederation(<RepositoryList />);
    await waitFor(() =>
      expect(
        [...document.querySelectorAll("[data-project-folder]")].map((heading) =>
          heading.getAttribute("data-project-folder"),
        ),
      ).toEqual([
        projectKey(projectRef("bk_b" as BackendId, "project-1")),
        projectKey(projectRef("bk_a" as BackendId, "project-1")),
      ]),
    );
  });
});

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
    renderInAppCommandScope(<CommandHandoverDialog />);
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
    renderInAppCommandScope(<CommandHandoverDialog />);
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
    renderInAppCommandScope(<CommandHandoverDialog />);
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
      renderInAppCommandScope(<CommandHandoverDialog />);
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
      renderInAppCommandScope(<CommandHandoverDialog />);
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
    renderInAppCommandScope(<CommandHandoverDialog />);
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
    renderInAppCommandScope(<CommandHandoverDialog />);
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
    renderWithFederation(<RepositoryList />);
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
  renderWithFederation(<RepositoryList />);
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
  renderWithFederation(<RepositoryList />);
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
  renderWithFederation(<RepositoryList />);
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
