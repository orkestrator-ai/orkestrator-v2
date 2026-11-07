import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { NodeListResult, NodeStatus, NodeView } from "@orkestrator/protocol/command-nodes";
import { DEFAULT_FLEET_UPDATE_POLICY } from "@orkestrator/protocol/fleet-currency";
import type { HostRestartImpact } from "@orkestrator/protocol/host-maintenance";
import {
  hostMaintenanceSnapshotFixture,
  hostUpdateJobFixture,
} from "@orkestrator/protocol/testing/host-maintenance-fixtures";
import { invoke } from "@/lib/native/backend";
import { requestMachineUpdate, takeMachineUpdateRequest } from "@/lib/settings-navigation";
import { useMachineBulkUpdateStore } from "@/stores/machineBulkUpdateStore";
import { resetSonnerMocks } from "../../../../../../tests/mocks/sonner";
import { MachinesSettings } from "./MachinesSettings";

/**
 * Plan item 5006: a skewed machine's header and a typed incompatibility
 * error ask for one machine's update (`requestMachineUpdate`); Settings →
 * Machines opens "Update to the latest" for exactly that machine. The
 * command node's opt-in update policy is set here too.
 */

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  resetSonnerMocks();
  takeMachineUpdateRequest();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
  useMachineBulkUpdateStore.setState({ outcomes: {}, snapshots: {}, running: false });
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
  nodeView("old", "Old box"),
  nodeView("zed", "Zed", {
    connection: { state: "unavailable", epoch: 1, lastError: { code: "x", message: "No route" } },
  }),
];

const impact = {
  workingAgents: 0,
  waitingAgents: 0,
  activePipelines: 0,
  terminals: 0,
  hostServers: 0,
  measuredAt: "t",
} as HostRestartImpact;

function updater(overrides: Record<string, unknown> = {}) {
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

function install() {
  const calls: Array<{ machine: string; command: string; args: Record<string, unknown> }> = [];
  let policy = DEFAULT_FLEET_UPDATE_POLICY;
  const snapshot = (machine: string) =>
    hostMaintenanceSnapshotFixture({
      version: machine === "self" ? "2.40.0" : "2.38.0",
      updater: updater(
        machine === "bk_old" ? { available: false, reason: "Installed by hand" } : {},
      ),
    });
  const answer = (machine: string, command: string, args: Record<string, unknown>) => {
    calls.push({ machine, command, args });
    switch (command) {
      case "get_host_maintenance":
        return snapshot(machine);
      case "get_host_restart_impact":
        return impact;
      case "request_host_update_check":
        return {
          ...snapshot(machine),
          revision: 2,
          updater: updater({ latestVersion: "2.40.0", updateAvailable: true, checkedAt: "t" }),
        };
      case "request_host_update": {
        const job = hostUpdateJobFixture({ fromVersion: "2.38.0", requestedVersion: "2.40.0" });
        return { job, snapshot: { ...snapshot(machine), revision: 3, job } };
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
    if (command === "get_fleet_update_policy") return policy;
    if (command === "set_fleet_update_policy") {
      calls.push({ machine: "self", command, args });
      policy = {
        version: 1,
        channels: { ...policy.channels, [String(args.channel)]: args.enabled === true },
      };
      return policy;
    }
    if (command === "invoke_on_node") {
      const nodeId = String(args.nodeId);
      if (nodeId !== "bk_build" && nodeId !== "bk_old") throw new Error("not reachable");
      return {
        outcome: "ok",
        result: answer(nodeId, String(args.command), (args.args as Record<string, unknown>) ?? {}),
      };
    }
    return answer("self", command, args);
  });
  return { calls };
}

test("a request for one machine opens its update, and confirming updates only that machine", async () => {
  const backend = install();
  requestMachineUpdate("bk_build");
  render(<MachinesSettings />);
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByText("Update Build box to the latest Orkestrator?")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Update" }));
  await waitFor(() =>
    expect(
      backend.calls.filter((call) => call.command === "request_host_update").map((c) => c.machine),
    ).toEqual(["bk_build"]),
  );
});

test("a request while Settings is open, for a machine that cannot update from here, opens its updates", async () => {
  install();
  render(<MachinesSettings />);
  await waitFor(() => expect(screen.getAllByTestId("machine-row")).toHaveLength(4));
  // Wait for Old box's maintenance to say it cannot update itself.
  await waitFor(() =>
    expect(
      within(
        screen.getAllByTestId("machine-row").find((row) => row.textContent?.includes("Old box"))!,
      )
        .getByRole("checkbox", { name: "Select Old box" })
        .hasAttribute("disabled"),
    ).toBe(true),
  );
  act(() => requestMachineUpdate("bk_old"));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByText("Updates for Old box")).toBeTruthy();
});

test("the update policy is off by default and turns on per channel", async () => {
  const backend = install();
  render(<MachinesSettings />);
  const section = await screen.findByTestId("fleet-update-policy");
  const stable = within(section).getByRole("switch", {
    name: "Keep machines on the Stable channel on this version",
  });
  await waitFor(() => expect(stable.hasAttribute("disabled")).toBe(false));
  for (const name of ["Stable", "Beta", "Unstable"]) {
    expect(
      within(section)
        .getByRole("switch", { name: `Keep machines on the ${name} channel on this version` })
        .getAttribute("aria-checked"),
    ).toBe("false");
  }
  fireEvent.click(stable);
  await waitFor(() => expect(stable.getAttribute("aria-checked")).toBe("true"));
  expect(backend.calls.find((call) => call.command === "set_fleet_update_policy")?.args).toEqual({
    channel: "stable",
    enabled: true,
  });
});
