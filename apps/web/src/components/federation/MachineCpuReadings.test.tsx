import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import {
  installFakeReadCoordinator,
  type FakeReadEnvironment,
} from "@/lib/testing/read-coordinator";
import { portalLayoutStore } from "@/lib/portal/portal-layout";
import { portalStore } from "@/lib/portal/portal-store";
import { emptyPortalLayout } from "@orkestrator/protocol/portal-layout";
import { FederationProvider } from "./FederationProvider";
import { MachineCpuReadings } from "./MachineCpuReadings";

const invokeMock = nativeInvoke as ReturnType<typeof mock>;

function summary(id: string, colorToken: string, state = "connected") {
  return {
    nodeId: id,
    view: {
      nodeId: id,
      displayName: id,
      colorToken,
      connection: { state, epoch: 1 },
    },
    projects: [],
    environments: [],
    truncated: false,
    freshness: "current",
    loadedAt: 1,
  };
}

let reads: FakeReadEnvironment;
let nodes: ReturnType<typeof summary>[];
let machineOrder: string[];
let usageCalls: string[];
let unreachable: Set<string>;

function sample(cpuPercent: number) {
  return {
    cpuPercent,
    ramPercent: 10,
    gpuPercent: null,
    diskPercent: 10,
    sampledAt: "2026-11-02T10:00:00.000Z",
  };
}

beforeEach(() => {
  reads = installFakeReadCoordinator();
  nodes = [summary("bk_a", "blue"), summary("bk_b", "rose")];
  machineOrder = [];
  usageCalls = [];
  unreachable = new Set();
  portalStore.store.setState({ selfId: null, status: null, nodes: [], self: null, loaded: false });
  portalLayoutStore.setState({ layout: emptyPortalLayout(), loaded: false, error: null });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "get_node_status":
        return { nodeId: "bk_self", mode: "command", controllers: [] };
      case "get_node_summaries":
        return { selfId: "bk_self", nodes };
      case "get_backend_profile":
        return { revision: 1, displayName: "Desk", colorToken: "violet", updatedAt: "t" };
      case "get_portal_layout":
        return { revision: 1, machineOrder };
      case "get_system_usage":
        usageCalls.push("bk_self");
        return sample(41.6);
      case "invoke_on_node": {
        const nodeId = String(args.nodeId);
        usageCalls.push(nodeId);
        if (unreachable.has(nodeId)) throw new Error("node-unavailable");
        return { outcome: "ok", result: sample(nodeId === "bk_a" ? 7 : 93) };
      }
      default:
        return undefined;
    }
  });
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
  portalStore.store.setState({ selfId: null, status: null, nodes: [], self: null, loaded: false });
});

function labels() {
  return screen.getAllByRole("img").map((reading) => reading.getAttribute("aria-label"));
}

const renderReadings = () =>
  render(
    <FederationProvider>
      <MachineCpuReadings />
    </FederationProvider>,
  );

test("shows each machine's CPU in its colour, the command node first, then the stored order", async () => {
  machineOrder = ["bk_b", "bk_self", "bk_a"];
  renderReadings();
  await waitFor(() =>
    expect(labels()).toEqual(["Desk CPU usage: 42%", "bk_b CPU usage: 93%", "bk_a CPU usage: 7%"]),
  );
  const [desk, rose] = screen.getAllByRole("img");
  expect(desk!.textContent).toBe("42%");
  expect(desk!.className).toContain("text-violet-500");
  expect(rose!.className).toContain("text-rose-500");
});

test("a machine that is not connected is never read and shows no figure", async () => {
  nodes = [summary("bk_a", "blue"), summary("bk_b", "rose", "unavailable")];
  renderReadings();
  await waitFor(() =>
    expect(labels()).toEqual([
      "Desk CPU usage: 42%",
      "bk_a CPU usage: 7%",
      "bk_b CPU usage: unavailable",
    ]),
  );
  expect(usageCalls).not.toContain("bk_b");
  expect(screen.getAllByRole("img")[2]!.textContent).toBe("—");
});

test("a machine that stops answering ages out alone, without holding up the others", async () => {
  renderReadings();
  await waitFor(() => expect(labels()).toContain("bk_b CPU usage: 93%"));
  unreachable.add("bk_b");
  await act(async () => {
    await reads.clock.advance(11_000);
  });
  expect(labels()).toEqual([
    "Desk CPU usage: 42%",
    "bk_a CPU usage: 7%",
    "bk_b CPU usage: unavailable",
  ]);
});

test("nothing shows, and nothing is read, with one machine", async () => {
  nodes = [];
  renderReadings();
  await waitFor(() => expect(portalStore.getState().loaded).toBe(true));
  expect(screen.queryByTestId("machine-cpu-readings")).toBeNull();
  expect(usageCalls).toEqual([]);
});

test("a connected machine loses its figure and polling when it disconnects while mounted", async () => {
  renderReadings();
  await waitFor(() => expect(labels()).toContain("bk_b CPU usage: 93%"));
  act(() =>
    portalStore.store.setState((state) => ({
      nodes: state.nodes.map((node) =>
        node.nodeId === "bk_b"
          ? {
              ...node,
              view: { ...node.view, connection: { ...node.view.connection, state: "unavailable" } },
            }
          : node,
      ),
    })),
  );
  expect(labels()).toContain("bk_b CPU usage: unavailable");
  const before = usageCalls.filter((id) => id === "bk_b").length;
  await act(async () => {
    await reads.clock.advance(10_000);
  });
  expect(usageCalls.filter((id) => id === "bk_b")).toHaveLength(before);
  expect(labels()).toContain("Desk CPU usage: 42%");
  expect(labels()).toContain("bk_a CPU usage: 7%");
});

test("CPU readings merge a new first registry machine like Settings", async () => {
  nodes.unshift(summary("bk_new", "teal"));
  machineOrder = ["bk_a", "bk_self", "bk_b"];
  renderReadings();
  await waitFor(() =>
    expect(labels()).toEqual([
      "Desk CPU usage: 42%",
      "bk_a CPU usage: 7%",
      "bk_new CPU usage: 93%",
      "bk_b CPU usage: 93%",
    ]),
  );
});
