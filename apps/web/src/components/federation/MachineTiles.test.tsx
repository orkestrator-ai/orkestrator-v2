import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderInAppCommandScope } from "@/test/render-in-node-scope";
import { invoke as nativeInvoke } from "@/lib/native/backend";
import { resetReadCoordinatorForTests } from "@/lib/read-coordinator";
import { installFakeReadCoordinator } from "@/lib/testing/read-coordinator";
import { portalLayoutStore } from "@/lib/portal/portal-layout";
import { portalStore } from "@/lib/portal/portal-store";
import { emptyPortalLayout } from "@orkestrator/protocol/portal-layout";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { FederationProvider } from "./FederationProvider";
import { MachineTiles } from "./MachineTiles";
import { useMachineViews } from "./useMachineViews";

const invokeMock = nativeInvoke as ReturnType<typeof mock>;
const INITIAL_MACHINE_VIEW_STATE = useMachineViewStore.getState();

function summary(id: string, name: string, colorToken: string, state = "connected") {
  return {
    nodeId: id,
    view: { nodeId: id, displayName: name, colorToken, connection: { state, epoch: 1 } },
    projects: [],
    environments: [],
    truncated: false,
    freshness: "current",
    loadedAt: 1,
  };
}

function sample(cpuPercent: number) {
  return {
    cpuPercent,
    ramPercent: 10,
    gpuPercent: null,
    diskPercent: 10,
    sampledAt: "2026-11-02T10:00:00.000Z",
  };
}

let nodes: ReturnType<typeof summary>[];
let layoutWrites: unknown[];

beforeEach(() => {
  installFakeReadCoordinator();
  localStorage.removeItem("machine-view-storage");
  useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
  nodes = [
    summary("bk_bee", "beelink2", "blue"),
    summary("bk_hp", "omarchy-hp", "rose"),
    summary("bk_gram", "omarchy-gram", "amber", "unavailable"),
  ];
  layoutWrites = [];
  portalStore.store.setState({ selfId: null, status: null, nodes: [], loaded: false });
  portalLayoutStore.setState({ layout: emptyPortalLayout(), loaded: false, error: null });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "get_node_status":
        return { nodeId: "bk_self", mode: "command", controllers: [] };
      case "get_node_summaries":
        return { selfId: "bk_self", nodes };
      case "get_backend_profile":
        return { revision: 1, displayName: "mini", colorToken: "violet", updatedAt: "t" };
      case "get_portal_layout":
        return { revision: 1, machineOrder: [] };
      case "update_portal_layout":
        layoutWrites.push(args);
        return { revision: 2, machineOrder: [], ...args };
      case "get_system_usage":
        return sample(41.6);
      case "invoke_on_node":
        return { outcome: "ok", result: sample(String(args.nodeId) === "bk_bee" ? 7 : 93) };
      default:
        return undefined;
    }
  });
});

afterEach(() => {
  cleanup();
  resetReadCoordinatorForTests();
  portalStore.store.setState({ selfId: null, status: null, nodes: [], loaded: false });
  useMachineViewStore.setState(INITIAL_MACHINE_VIEW_STATE, true);
  localStorage.removeItem("machine-view-storage");
});

function Tiles() {
  const machines = useMachineViews();
  return <MachineTiles machines={machines} />;
}

const renderTiles = () =>
  renderInAppCommandScope(
    <FederationProvider>
      <Tiles />
    </FederationProvider>,
  );

const tiles = () => screen.getAllByTestId("machine-tile");
const tile = (name: string) => tiles().find((entry) => entry.title.startsWith(`${name} ·`))!;

test("one tile per machine in machine order, with initials, colour and CPU", async () => {
  renderTiles();
  await waitFor(() => expect(tiles()).toHaveLength(4));
  await waitFor(() => expect(tile("beelink2").getAttribute("aria-label")).toContain("CPU 7%"));
  expect(tiles().map((entry) => entry.textContent)).toEqual(["MIN42%", "BE27%", "OHP93%", "OGR—"]);
  expect(tile("mini").getAttribute("data-machine-color")).toBe("violet");
  expect(tile("omarchy-hp").getAttribute("aria-label")).toBe("omarchy-hp, CPU 93%, shown");
  expect(tile("omarchy-hp").title).toContain("CPU 93%");
});

test("a machine that is not connected is dimmed and shows a placeholder, never a figure", async () => {
  renderTiles();
  await waitFor(() => expect(tiles()).toHaveLength(4));
  const gram = tile("omarchy-gram");
  expect(gram.getAttribute("data-dimmed")).toBe("true");
  expect(gram.querySelector('[data-testid="machine-tile-cpu"]')!.textContent).toBe("—");
  expect(gram.getAttribute("aria-label")).toContain("CPU unavailable");
});

test("clicks filter: one machine, then add and remove, and the last one clears the filter", async () => {
  renderTiles();
  await waitFor(() => expect(tiles()).toHaveLength(4));
  expect(tiles().every((entry) => entry.getAttribute("aria-pressed") === "true")).toBe(true);

  fireEvent.click(tile("beelink2"));
  expect(useMachineViewStore.getState().machineFilter).toEqual(["bk_bee"]);
  expect(tile("beelink2").getAttribute("data-state")).toBe("selected");
  expect(tile("mini").getAttribute("data-state")).toBe("faded");
  expect(tile("mini").getAttribute("aria-pressed")).toBe("false");
  expect(tile("mini").getAttribute("aria-label")).toContain("hidden");

  fireEvent.click(tile("omarchy-hp"));
  expect(useMachineViewStore.getState().machineFilter).toEqual(["bk_bee", "bk_hp"]);
  fireEvent.click(tile("beelink2"));
  expect(useMachineViewStore.getState().machineFilter).toEqual(["bk_hp"]);
  fireEvent.click(tile("omarchy-hp"));
  expect(useMachineViewStore.getState().machineFilter).toEqual([]);
  expect(tiles().every((entry) => entry.getAttribute("data-state") === "all")).toBe(true);
});

test("Enter and Space toggle a focused tile, as on any button", async () => {
  renderTiles();
  await waitFor(() => expect(tiles()).toHaveLength(4));
  const mini = tile("mini");
  // A native button turns Enter and Space into a click; the tile adds no
  // keyboard handler that could take them for a drag.
  expect(mini.tagName).toBe("BUTTON");
  expect(mini.getAttribute("aria-roledescription")).toBeNull();
  mini.focus();
  fireEvent.click(mini);
  expect(useMachineViewStore.getState().machineFilter).toEqual(["bk_self"]);
});

test("the tiles follow a filter set in the store, and clearing it shows them all", async () => {
  renderTiles();
  await waitFor(() => expect(tiles()).toHaveLength(4));
  fireEvent.click(tile("beelink2"));
  fireEvent.click(tile("omarchy-hp"));
  expect(useMachineViewStore.getState().machineFilter).toHaveLength(2);
  act(() => useMachineViewStore.getState().setMachineFilter([]));
  expect(tiles().every((entry) => entry.getAttribute("data-state") === "all")).toBe(true);
  // A filter set elsewhere (revealing a project on a hidden machine, say) is reflected in the tiles.
  act(() => useMachineViewStore.getState().setMachineFilter(["bk_gram"]));
  expect(tile("omarchy-gram").getAttribute("data-state")).toBe("selected");
  expect(tile("mini").getAttribute("data-state")).toBe("faded");
});
