import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NodeListResult, NodeStatus, NodeView } from "@orkestrator/protocol/command-nodes";
import type {
  HostMaintenanceSnapshot,
  HostRestartImpact,
} from "@orkestrator/protocol/host-maintenance";
import {
  hostMaintenanceSnapshotFixture,
  hostUpdateJobFixture,
} from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import { invoke } from "@/lib/native/backend";
import { expectDomAbsent } from "../../../../../../tests/bounded-test-diagnostics";
import { useMachineBulkUpdateStore } from "@/stores/machineBulkUpdateStore";
import { mockToastSuccess, resetSonnerMocks } from "../../../../../../tests/mocks/sonner";
import { MachinesSettings } from "./MachinesSettings";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  resetSonnerMocks();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  useMachineBulkUpdateStore.setState({ outcomes: {}, running: false });
});

const status: NodeStatus = {
  nodeId: "bk_self" as never,
  mode: "command",
  registrationEnabled: true,
  controllers: [],
  detachedControllers: [],
  suspendedSubordinateCount: 0,
};

function nodeView(id: string, name: string, overrides: Partial<NodeView> = {}): NodeView {
  return {
    nodeId: `bk_${id}` as never,
    enabled: true,
    displayName: name,
    colorToken: "teal",
    fallbackName: id,
    routes: [
      { id: "https" as never, kind: "https", enabled: true, origin: `https://${id}.ts.net` },
    ],
    routeOrder: ["https" as never],
    hasCredential: true,
    attachment: { status: "attached" },
    connection: {
      state: "connected",
      epoch: 1,
      activeRouteId: "https" as never,
      activeRouteKind: "https",
    },
    addedAt: "2026-10-21T00:00:00.000Z",
    lastConnectedAt: "2026-10-21T10:00:00.000Z",
    source: "portal",
    ...overrides,
  };
}

const nodes = [
  nodeView("build", "Build box"),
  nodeView("zed", "Zed", {
    connection: { state: "unavailable", epoch: 1, lastError: { code: "x", message: "No route" } },
  }),
];

const impact: HostRestartImpact = {
  workingAgents: 2,
  waitingAgents: 0,
  activePipelines: 0,
  terminals: 0,
  hostServers: 0,
  measuredAt: "t",
} as HostRestartImpact;

function updater(overrides: Partial<HostMaintenanceSnapshot["updater"]>) {
  return {
    kind: "standalone" as const,
    available: true,
    reason: null,
    latestVersion: null,
    updateAvailable: null,
    checkedAt: null,
    checkError: null,
    ...overrides,
  };
}

/**
 * Desk (this window's machine) is on the newest release; Build box is one
 * behind; Zed cannot be reached. Every machine command is recorded in order.
 */
function install() {
  const calls: string[] = [];
  const desk = hostMaintenanceSnapshotFixture({ version: "2.36.0" });
  const build = hostMaintenanceSnapshotFixture({
    version: "2.35.0",
    updater: updater({}),
  });
  const answer = (machine: "self" | "bk_build", command: string, args: Record<string, unknown>) => {
    calls.push(`${machine}:${command}`);
    const before = machine === "self" ? desk : build;
    switch (command) {
      case "get_host_maintenance":
        return before;
      case "get_host_restart_impact":
        return impact;
      case "request_host_update_check":
        return machine === "self"
          ? {
              ...desk,
              revision: 2,
              updater: updater({ latestVersion: "2.36.0", updateAvailable: false, checkedAt: "t" }),
            }
          : {
              ...build,
              revision: 2,
              updater: updater({ latestVersion: "2.36.0", updateAvailable: true, checkedAt: "t" }),
            };
      case "request_host_update": {
        const job = hostUpdateJobFixture({
          fromVersion: "2.35.0",
          requestedVersion: String(args.version),
        });
        return { job, snapshot: { ...build, revision: 3, job } };
      }
      default:
        return undefined;
    }
  };
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "get_node_status") return status;
    if (command === "list_nodes") {
      return {
        revision: 1,
        mode: "command",
        suspended: false,
        nodes,
        pendingDetaches: [],
      } satisfies NodeListResult;
    }
    if (command === "get_backend_profile") {
      return { revision: 1, displayName: "Desk", colorToken: "violet", updatedAt: "t" };
    }
    if (command === "invoke_on_node") {
      if (args.nodeId !== "bk_build") throw new Error("not reachable");
      const inner = String(args.command);
      if (inner === "get_backend_profile") {
        return {
          outcome: "ok",
          result: { revision: 3, displayName: "Build box", colorToken: "teal", updatedAt: "t" },
        };
      }
      return {
        outcome: "ok",
        result: answer("bk_build", inner, (args.args as Record<string, unknown>) ?? {}),
      };
    }
    return answer("self", command, args);
  });
  return { calls };
}

function row(name: string): HTMLElement {
  const match = screen
    .getAllByTestId("machine-row")
    .find((element) => element.textContent?.includes(name));
  if (!match) throw new Error(`No row for ${name}`);
  return match;
}

test("ticked machines update to the latest release, this window's machine last", async () => {
  const backend = install();
  render(<MachinesSettings />);
  await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(3));

  const update = screen.getByRole("button", { name: "Update app to latest" }) as HTMLButtonElement;
  expect(update.disabled).toBe(true);
  // An unreachable machine cannot be ticked.
  expect(
    within(row("Zed")).getByRole("checkbox", { name: "Select Zed" }).hasAttribute("disabled"),
  ).toBe(true);

  fireEvent.click(screen.getByRole("checkbox", { name: "Select every machine that can update" }));
  expect(screen.getByText("2 of 2 selected")).toBeTruthy();
  expect(update.disabled).toBe(false);
  fireEvent.click(update);

  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Update 2 machines to the latest Orkestrator?")).toBeTruthy();
  await waitFor(() => expect(within(dialog).getAllByText("2 agents working")).toHaveLength(2));
  expect(within(dialog).getByText(/This window's machine is asked last/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Update 2 machines" }));

  await waitFor(() =>
    expect(mockToastSuccess.mock.calls[0]?.[0]).toBe("Started on 1 machine · 1 already current"),
  );
  // Desk was current, so only Build box was asked to install.
  expect(backend.calls.filter((call) => call.endsWith(":request_host_update"))).toEqual([
    "bk_build:request_host_update",
  ]);
  expect(backend.calls.indexOf("self:request_host_update_check")).toBeGreaterThan(
    backend.calls.indexOf("bk_build:request_host_update"),
  );
  expect(within(row("Build box")).getByTestId("machine-update-status").textContent).toBe(
    "Starting the update to 2.36.0…",
  );
  expect(within(row("Desk")).getByTestId("machine-update-status").textContent).toBe(
    "Already on the newest release (2.36.0)",
  );
  // The selection is cleared once the update starts.
  expect(screen.getByText("Tick machines to update them together")).toBeTruthy();
});

test("a single ticked machine names itself in the confirmation", async () => {
  install();
  render(<MachinesSettings />);
  await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(3));
  fireEvent.click(within(row("Build box")).getByRole("checkbox", { name: "Select Build box" }));
  fireEvent.click(screen.getByRole("button", { name: "Update app to latest" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Update Build box to the latest Orkestrator?")).toBeTruthy();
  expectDomAbsent(within(dialog).queryByText(/This window's machine/));
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expectDomAbsent(screen.queryByRole("alertdialog")));
  expect(screen.getByText("1 of 2 selected")).toBeTruthy();
});
