import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NodeListResult, NodeStatus, NodeView } from "@orkestrator/protocol/command-nodes";
import { invoke } from "@/lib/native/backend";
import { NodesSettings } from "./NodesSettings";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;

afterEach(() => {
  cleanup();
  invokeMock.mockReset();
  invokeMock.mockImplementation(() => Promise.resolve());
});

const leafView: NodeView = {
  nodeId: "bk_leaf" as never,
  enabled: true,
  displayName: "Build box",
  colorToken: "teal",
  fallbackName: "build",
  routes: [{ id: "https" as never, kind: "https", enabled: true, origin: "https://build.test" }],
  routeOrder: ["https" as never],
  hasCredential: true,
  attachment: { status: "attached" },
  connection: {
    state: "connected",
    epoch: 2,
    activeRouteId: "https" as never,
    activeRouteKind: "https",
  },
  addedAt: "2026-10-21T00:00:00.000Z",
  source: "desktop-migration",
};

function install(status: NodeStatus, nodes: NodeListResult) {
  invokeMock.mockImplementation(async (command: string) => {
    if (command === "get_node_status") return status;
    if (command === "list_nodes") return nodes;
    return { forgotten: true, detached: true };
  });
  return invokeMock as unknown as { mock: { calls: Array<[string, unknown?]> } };
}

const commandStatus: NodeStatus = {
  nodeId: "bk_desk" as never,
  mode: "command",
  registrationEnabled: true,
  controllers: [],
  detachedControllers: [],
  suspendedSubordinateCount: 0,
};

describe("RG-06 nodes in Connections settings", () => {
  test("lists registered nodes with dot, state and route; never shows a token", async () => {
    install(commandStatus, {
      revision: 1,
      mode: "command",
      suspended: false,
      nodes: [leafView],
      pendingDetaches: [],
    });
    render(<NodesSettings />);
    await waitFor(() => expect(screen.getByText("Build box")).toBeTruthy());
    expect(screen.getByTestId("node-mode").textContent).toBe("Command node");
    expect(screen.getByTestId("node-state").textContent).toContain("Connected");
    expect(screen.getByTestId("node-state").textContent).toContain("HTTPS build.test");
    expect(screen.getAllByTestId("machine-dot")[0]!.getAttribute("data-machine-color")).toBe(
      "teal",
    );
    expect(document.body.textContent).toContain("imported from this desktop");
  });

  test("RG-07: forgetting asks first and says nothing on the node stops", async () => {
    const invoke = install(commandStatus, {
      revision: 1,
      mode: "command",
      suspended: false,
      nodes: [leafView],
      pendingDetaches: [],
    });
    render(<NodesSettings />);
    await waitFor(() => expect(screen.getByText("Build box")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Forget Build box" }));
    expect(document.body.textContent).toContain("Nothing on Build box is stopped or deleted");
    fireEvent.click(screen.getByRole("button", { name: "Forget" }));
    await waitFor(() =>
      expect(invoke.mock.calls.some(([command]) => command === "forget_node")).toBe(true),
    );
    const call = invoke.mock.calls.find(([command]) => command === "forget_node")!;
    expect(call[1]).toEqual({ nodeId: "bk_leaf", withoutDetach: false });
  });

  test("LM: leaf mode names the controller and offers detaching here", async () => {
    const invoke = install(
      {
        ...commandStatus,
        mode: "leaf",
        controllers: [
          {
            controllerId: "bk_top" as never,
            displayName: "Office desktop",
            attachedAt: "2026-10-21T00:00:00.000Z",
            lastContactAt: "2026-10-21T00:01:00.000Z",
          },
        ],
        mostRecentControllerId: "bk_top" as never,
        suspendedSubordinateCount: 1,
      },
      { revision: 1, mode: "leaf", suspended: true, nodes: [], pendingDetaches: [] },
    );
    render(<NodesSettings />);
    await waitFor(() => expect(screen.getByTestId("leaf-mode-notice")).toBeTruthy());
    expect(screen.getByTestId("leaf-mode-notice").textContent).toContain("Office desktop");
    expect(screen.getByTestId("leaf-mode-notice").textContent).toContain("1 registered node kept");
    expect(screen.queryByRole("button", { name: "Add node" }) === null).toBe(true);
    expect(screen.getByTestId("controllers").textContent).toContain("(most recent)");
    fireEvent.click(screen.getByRole("button", { name: "Detach" }));
    await waitFor(() =>
      expect(invoke.mock.calls.some(([command]) => command === "detach_controller_here")).toBe(
        true,
      ),
    );
  });
});
