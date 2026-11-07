import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { BackendId } from "@orkestrator/protocol/federation";
import { listAgentAccounts } from "@/lib/backend/agent-accounts";
import { getMcpManagementSnapshot } from "@/lib/backend/mcp-management";
import { getWindowScope, resetWindowScopeForTests } from "@/lib/node-scope/app-window-scope";
import { invoke } from "@/lib/native/backend";
import { FakeNodeClient } from "@/test/render-in-node-scope";
import { machineInvoke } from "@/components/settings/machines/machine-access";
import { hydratedMachineScope, invokeOnMachine, isWorkspaceGrantCommand } from "./machine-scope";
import { portalStore } from "./portal-store";

const invokeMock = invoke as unknown as ReturnType<typeof mock>;
const LEAF = "bk_leaf" as BackendId;
const accounts = { platforms: [], accounts: [] };
const initialPortal = portalStore.getState();

/** The command scope's answer: another node's commands come back through `invoke_on_node`. */
function routed(result: unknown) {
  invokeMock.mockImplementation(async (command: string) =>
    command === "invoke_on_node" ? { outcome: "ok", result } : undefined,
  );
}

function routedCommands(): string[] {
  return invokeMock.mock.calls
    .filter(([command]) => command === "invoke_on_node")
    .map(([, args]) => (args as { command: string }).command);
}

/** A warm or live scope for the leaf, open in the app window (as an in-tree node's is). */
function openLeaf() {
  const client = new FakeNodeClient({
    nodeId: LEAF,
    invoke: {
      list_agent_accounts: accounts,
      get_mcp_management_snapshot: { targetId: "backend", servers: [] },
      get_backend_profile: { name: "Leaf" },
      set_active_agent_account: {},
    },
  });
  const scope = getWindowScope().open({ role: "leaf", client });
  return { client, scope };
}

beforeEach(() => {
  resetWindowScopeForTests();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  resetWindowScopeForTests();
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
  portalStore.store.setState(initialPortal);
});

describe("machineInvoke per tier (plan item 5004)", () => {
  test("a summary-tier node (no scope) is asked through the command scope with invoke_on_node", async () => {
    routed(accounts);
    expect(hydratedMachineScope(LEAF)).toBeNull();
    expect(await listAgentAccounts(LEAF)).toEqual(accounts as never);
    expect(routedCommands()).toEqual(["list_agent_accounts"]);
    expect(invokeMock.mock.calls[0]?.[1]).toMatchObject({ nodeId: LEAF, args: {} });
  });

  test("a live node's agent accounts and MCP are read on its own scope", async () => {
    const { client, scope } = openLeaf();
    expect(hydratedMachineScope(LEAF)).toBe(scope);
    expect(await listAgentAccounts(LEAF)).toEqual(accounts as never);
    await getMcpManagementSnapshot("backend", LEAF);
    expect(client.calls("list_agent_accounts")).toHaveLength(1);
    expect(client.calls("get_mcp_management_snapshot")[0]?.args).toEqual({ targetId: "backend" });
    expect(routedCommands()).toEqual([]);
  });

  test("a warm node is called on its scope too", async () => {
    const { client, scope } = openLeaf();
    scope.setTier("warm");
    await invokeOnMachine(LEAF, "list_agent_accounts", {});
    expect(client.calls("list_agent_accounts")).toHaveLength(1);
    expect(routedCommands()).toEqual([]);
  });

  for (const tier of ["summary", "suspended"] as const) {
    test(`a ${tier} scope goes back to invoke_on_node`, async () => {
      const { client, scope } = openLeaf();
      scope.setTier(tier);
      routed(accounts);
      expect(hydratedMachineScope(LEAF)).toBeNull();
      await listAgentAccounts(LEAF);
      expect(client.calls("list_agent_accounts")).toHaveLength(0);
      expect(routedCommands()).toEqual(["list_agent_accounts"]);
    });
  }

  test("the route is chosen per call: a scope disposed between calls is not used", async () => {
    const { client, scope } = openLeaf();
    await invokeOnMachine(LEAF, "list_agent_accounts", {});
    scope.dispose();
    routed(accounts);
    await invokeOnMachine(LEAF, "list_agent_accounts", {});
    expect(client.calls("list_agent_accounts")).toHaveLength(1);
    expect(routedCommands()).toEqual(["list_agent_accounts"]);
  });

  test("a command a workspace grant refuses keeps the command scope route on a live node", async () => {
    const { client } = openLeaf();
    expect(isWorkspaceGrantCommand("list_agent_accounts")).toBe(true);
    expect(isWorkspaceGrantCommand("update_backend_profile")).toBe(false);
    expect(isWorkspaceGrantCommand("request_host_update")).toBe(false);
    expect(isWorkspaceGrantCommand("not_a_defined_command")).toBe(false);
    routed({});
    await invokeOnMachine(LEAF, "update_backend_profile", { name: "Leaf" });
    await invokeOnMachine(LEAF, "not_a_defined_command", {});
    expect(client.invocations).toEqual([]);
    expect(routedCommands()).toEqual(["update_backend_profile", "not_a_defined_command"]);
  });

  test("a write on a scope refreshes the portal's summaries, a read does not", async () => {
    openLeaf();
    const schedule = mock(() => undefined);
    const original = portalStore.scheduleRefresh;
    portalStore.scheduleRefresh = schedule;
    try {
      await invokeOnMachine(LEAF, "list_agent_accounts", {});
      expect(schedule).not.toHaveBeenCalled();
      await invokeOnMachine(LEAF, "set_active_agent_account", {
        platform: "claude",
        accountId: "work",
      });
      expect(schedule).toHaveBeenCalledTimes(1);
    } finally {
      portalStore.scheduleRefresh = original;
    }
  });

  test("Settings' machine call follows the same route", async () => {
    const { client } = openLeaf();
    const call = machineInvoke({ role: "node", nodeId: LEAF })!;
    await call("get_backend_profile");
    expect(client.calls("get_backend_profile")).toHaveLength(1);
    // The command node itself is the command scope's own command.
    await machineInvoke({ role: "self", nodeId: null })!("get_backend_profile");
    expect(invokeMock).toHaveBeenCalledWith("get_backend_profile", {});
  });
});
