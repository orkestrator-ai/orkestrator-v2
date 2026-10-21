import { expect, test } from "bun:test";
import {
  NodeWorkspaceScopes,
  openNodeWorkspace,
  type WorkspaceBinding,
} from "../electron/node-workspaces";

const binding = (id: string, port: number): WorkspaceBinding => ({
  workspaceId: id,
  nodeId: "bk_c",
  baseUrl: `http://127.0.0.1:${port}`,
  token: `grant-${id}`,
  params: { node: "C", path: "relay" },
});

test("remote command node relay is used when C is absent from local registry", async () => {
  const calls: string[] = [];
  const opened = await openNodeWorkspace({
    nodeId: "bk_c",
    commandNodeName: "B",
    invoke: async (command) => {
      calls.push(command);
      return {
        workspaceId: "w",
        nodeId: "bk_c",
        nodeName: "C",
        grant: { token: "grant", expiresAt: Date.now() + 60_000 },
        directOrigins: [],
        relayBase: "/__orkestrator/nodes/bk_c",
      };
    },
    relay: () => ({ baseUrl: "http://127.0.0.1:45001", token: "command-b-token" }),
  });
  expect(calls).toEqual(["open_node_workspace"]);
  expect(opened.baseUrl).toBe("http://127.0.0.1:45001/__orkestrator/nodes/bk_c");
  expect(opened.nodeId).toBe("bk_c");
});

test("workspace epoch changes and failed grant renewal replace binding through captured command node", async () => {
  const calls: Array<[string, unknown]> = [];
  let epoch = 1;
  let failed = false;
  let next = 0;
  const retargeted: WorkspaceBinding[] = [];
  const invoke = async (command: string, args: Record<string, unknown>) => {
    calls.push([command, args]);
    if (failed && command === "renew_node_workspace") throw new Error("grant lost after restart");
    return {};
  };
  const scopes = new NodeWorkspaceScopes(async () => {
    throw new Error("Local A must not be used");
  });
  scopes.track("panel", "old", {
    invoke,
    epoch: () => epoch,
    reopen: async () => binding(`new-${++next}`, 45000 + next),
    retarget: (value) => {
      retargeted.push(value);
    },
  });
  epoch++;
  await scopes.reconcile("panel");
  expect(retargeted[0]!.baseUrl).toBe("http://127.0.0.1:45001");
  failed = true;
  await scopes.reconcile("panel");
  expect(retargeted[1]!.workspaceId).toBe("new-2");
  scopes.release("panel");
  await Promise.resolve();
  expect(calls).toContainEqual(["close_node_workspace", { workspaceId: "new-2" }]);
  expect(calls).toContainEqual(["close_node_workspace", { workspaceId: "old" }]);
});
