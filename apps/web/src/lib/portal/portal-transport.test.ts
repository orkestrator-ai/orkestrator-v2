import { afterEach, describe, expect, mock, test } from "bun:test";
import { invoke } from "@/lib/native/backend";
import { listen } from "@/lib/native/events";
import { portalStore } from "./portal-store";
import { portalInvoke, portalListen, workspaceTarget } from "./portal-transport";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const listenMock = listen as unknown as ReturnType<typeof mock>;

function installPortal() {
  const listeners = new Map<string, (payload: unknown) => void>();
  const portal = {
    invoke: mock(async (command: string, _args?: Record<string, unknown>) => {
      if (command === "get_node_summaries") {
        return {
          selfId: "bk_command",
          nodes: [],
          self: {
            nodeId: "bk_command",
            displayName: "Desk",
            loadedAt: 1,
            truncated: false,
            projects: [],
            environments: [],
          },
        };
      }
      if (command === "get_node_status") return { nodeId: "bk_command" };
      return { ok: command };
    }),
    listen: mock((event: string, callback: (payload: unknown) => void) => {
      listeners.set(event, callback);
      return () => listeners.delete(event);
    }),
  };
  window.orkestratorPortal = portal as never;
  window.orkestratorWorkspaceTarget = { nodeId: "bk_leaf", nodeName: "Leaf", path: "direct" };
  return { portal, listeners };
}

afterEach(() => {
  delete window.orkestratorPortal;
  delete window.orkestratorWorkspaceTarget;
  invokeMock.mockReset();
  listenMock.mockClear();
  portalStore.store.setState({ selfId: null, nodes: [], self: null, status: null });
});

describe("the portal channel", () => {
  test("on the command node's own workspace it is the window's transport", async () => {
    invokeMock.mockResolvedValue("from-workspace");
    expect(workspaceTarget()).toBeNull();
    expect(await portalInvoke("list_nodes")).toBe("from-workspace");
    await portalListen("nodes-changed", () => undefined);
    expect(listenMock).toHaveBeenCalledTimes(1);
  });

  test("while the workspace is on a leaf, portal calls never reach the leaf", async () => {
    const { portal, listeners } = installPortal();
    expect(workspaceTarget()?.nodeId).toBe("bk_leaf");
    expect(await portalInvoke("list_nodes")).toEqual({ ok: "list_nodes" });
    const seen: unknown[] = [];
    await portalListen("nodes-changed", ({ payload }) => void seen.push(payload));
    listeners.get("nodes-changed")?.({ revision: 2 });
    expect(seen).toEqual([{ revision: 2 }]);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
    expect(portal.invoke).toHaveBeenCalledTimes(1);
  });

  test("the portal asks for the command node's own summary while on a leaf", async () => {
    const { portal } = installPortal();
    await portalStore.refresh();
    expect(portal.invoke).toHaveBeenCalledWith("get_node_summaries", { includeSelf: true });
    expect(portalStore.getState().self?.displayName).toBe("Desk");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("actions on the command node's own environments are its ordinary commands", async () => {
    const { portal } = installPortal();
    await portalStore.refresh();
    await portalStore.invokeOnNode("bk_command" as never, "stop_environment", {
      environmentId: "e1",
    });
    expect(portal.invoke).toHaveBeenCalledWith("stop_environment", { environmentId: "e1" });
    expect(portal.invoke.mock.calls.some(([command]) => command === "invoke_on_node")).toBe(false);
  });
});
