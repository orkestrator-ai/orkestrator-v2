import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { NodeListResult, NodeStatus, NodeView } from "@orkestrator/protocol/command-nodes";
import { invoke } from "@/lib/native/backend";
import { listen } from "@/lib/native/events";
import { NodesSettings, NodeSshPromptDialog } from "./NodesSettings";

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

describe("RG-06 editing a node's routes", () => {
  test("adds a route, reorders and saves routes and order without showing the token", async () => {
    const invoke = install(commandStatus, {
      revision: 1,
      mode: "command",
      suspended: false,
      nodes: [leafView],
      pendingDetaches: [],
    });
    render(<NodesSettings />);
    await waitFor(() => expect(screen.getByText("Build box")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit routes to Build box" }));
    fireEvent.click(screen.getByRole("button", { name: "SSH" }));
    fireEvent.change(screen.getByLabelText("New route SSH destination"), {
      target: { value: "build" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add route" }));
    fireEvent.click(screen.getByRole("button", { name: /^Move SSH build.* up$/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(invoke.mock.calls.some(([command]) => command === "update_node")).toBe(true),
    );
    const args = invoke.mock.calls.find(([command]) => command === "update_node")![1] as {
      routes: Array<{ kind: string }>;
      routeOrder: string[];
      token?: string;
    };
    expect(args.routes.map((route) => route.kind)).toEqual(["ssh", "https"]);
    expect(args.routeOrder).toHaveLength(2);
    expect(args.token).toBeUndefined();
  });
});

// Settings is a z-[60] fullscreen surface; a default z-50 dialog renders
// behind it while Radix blocks pointer events, so the app looks frozen.
describe("node dialogs open above fullscreen settings", () => {
  function expectRaised() {
    const dialog = screen.getByRole("dialog");
    const overlay = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]')!;
    expect(dialog.className).toContain("z-[80]");
    expect(dialog.className).not.toContain("z-50");
    expect(overlay.className).toContain("z-[80]");
    expect(overlay.className).not.toContain("z-50");
  }

  for (const button of ["Edit routes to Build box", "Forget Build box", "Add node"]) {
    test(button, async () => {
      install(commandStatus, {
        revision: 1,
        mode: "command",
        suspended: false,
        nodes: [leafView],
        pendingDetaches: [],
      });
      render(<NodesSettings />);
      await waitFor(() => expect(screen.getByText("Build box")).toBeTruthy());
      fireEvent.click(screen.getByRole("button", { name: button }));
      expectRaised();
    });
  }
});

test("pending SSH prompts rehydrate and overlapping prompts retain isolated answers", async () => {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const listenMock = listen as unknown as ReturnType<typeof mock>;
  listenMock.mockImplementation(
    async (event: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
  );
  const a = {
    promptId: "a",
    nodeId: "bk_a",
    kind: "password",
    message: "Password A",
    state: "open",
  };
  const b = {
    promptId: "b",
    nodeId: "bk_b",
    kind: "password",
    message: "Password B",
    state: "open",
  };
  let pending = [a];
  const answers: unknown[] = [];
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === "list_node_ssh_prompts") return pending;
    if (command === "answer_node_ssh_prompt") {
      answers.push(args);
      pending = pending.filter((entry) => entry.promptId !== args.promptId);
      return { answered: true };
    }
  });
  const mounted = render(<NodeSshPromptDialog />);
  await screen.findByText(/SSH needs your answer.*bk_a/);
  fireEvent.change(screen.getByLabelText("SSH answer"), { target: { value: "secret-a" } });
  pending = [a, b];
  await act(async () => handlers.get("node-ssh-prompt")?.({ payload: b }));
  expect(
    screen.getByLabelText("SSH answer").getAttribute("value") ??
      (screen.getByLabelText("SSH answer") as HTMLInputElement).value,
  ).toBe("secret-a");
  // Closing A changes the displayed prompt; its typed secret cannot reach B.
  await act(async () => handlers.get("node-ssh-prompt")?.({ payload: { ...a, state: "closed" } }));
  await screen.findByText(/SSH needs your answer.*bk_b/);
  expect((screen.getByLabelText("SSH answer") as HTMLInputElement).value).toBe("");
  expect(answers).toEqual([]);
  mounted.unmount();
  pending = [a];
  render(<NodeSshPromptDialog />);
  await screen.findByText(/SSH needs your answer.*bk_a/);
  pending = [b];
  await act(async () => handlers.get("native-event-stream-connected")?.({ payload: undefined }));
  await screen.findByText(/SSH needs your answer.*bk_b/);
  listenMock.mockReset();
  listenMock.mockImplementation(() => Promise.resolve(() => {}));
});
