import { eventSink } from "./backend-emit.js";
import { registrarFrom } from "./commands-registry-contracts.js";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentAccountsSnapshot,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import type { CoordinatorWorkspace } from "@orkestrator/protocol/coordinator";
import {
  COORDINATOR_ACCOUNT_SWITCH_LIMIT,
  COORDINATOR_ACCOUNT_SWITCHED_EVENT,
  type CoordinatorAccountSwitchGrantState,
} from "@orkestrator/protocol/coordinator-account-switch-grant";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import type { CommandContext } from "./commands-context.js";
import { registerAgentAccountCommands } from "./commands-registry-accounts.js";
import { registerNodeCommands } from "./commands-registry-nodes.js";
import type { RegistryDependencies } from "./commands-registry-types.js";
import { rpc } from "./control-mcp-test-support.js";
import { ControlMcpServer, type ControlMcpInvoker } from "./control-mcp-server.js";
import { coordinatorRoleCapabilities } from "./control-mcp-tools.js";
import { executeAgentAccountSwitch } from "./nodes/node-account-switch.js";
import { NodeActionRequests, type NodeActionRequest } from "./nodes/node-action-requests.js";
import { NodeCoordination } from "./nodes/node-coordination.js";
import { StorageService, createProject } from "./storage.js";

/**
 * `switch_provider_account` under the user's standing permission (Settings →
 * "Let coordinators switch accounts without asking"), over the real Control
 * MCP endpoint, the real grant commands, the real config store and the real
 * approval-request store. Accounts and usage readings are fakes: nothing
 * reads or writes a real provider login, and nothing runs a model turn.
 */

const SELF = "bk_self";
const LEAF = "bk_leaf";
const PROJECT = "project-1";

let dataDir: string;
let storage: StorageService;
let server: ControlMcpServer;
let actions: NodeActionRequests;
let clock: { now: number };
let accounts: Record<string, AgentAccountSummary[]>;
let usage: Record<string, Record<string, PlanUsageSnapshot>>;
let commandContext: CommandContext;
let switchFailure: "failed" | "outcome-unknown" | null;
let durable: NodeActionRequest[];
let actionOptions: ConstructorParameters<typeof NodeActionRequests>[0];
const switches: Array<{ machine: string; accountId: string }> = [];
const events: Array<{ event: string; payload: unknown }> = [];
const notified: NodeActionRequest[] = [];
const commands = new Map<
  string,
  (args: Record<string, unknown>, context: CommandContext) => unknown
>();

registerAgentAccountCommands(
  registrarFrom((name, handler) => {
    commands.set(name, handler as never);
  }),
  {} as RegistryDependencies,
);
registerNodeCommands(
  registrarFrom((name, handler) => {
    commands.set(name, handler as never);
  }),
);

function account(
  id: string,
  label: string,
  options: { active?: boolean; signedIn?: boolean; email?: string } = {},
): AgentAccountSummary {
  return {
    id,
    platform: "claude",
    label,
    isDefault: id === "default",
    isActive: options.active === true,
    signedIn: options.signedIn !== false,
    identity: options.email ? { email: options.email } : {},
  };
}

function reading(usedPercent: number): PlanUsageSnapshot {
  return {
    platform: "claude",
    status: "ok",
    windows: [
      {
        window: "five_hour",
        label: "5-hour",
        usedPercent,
        resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
    ],
    fetchedAt: new Date().toISOString(),
  };
}

function snapshotOf(machine: string): AgentAccountsSnapshot {
  const rows = accounts[machine]!;
  return {
    accounts: rows,
    active: { claude: rows.find((row) => row.isActive)?.id ?? "default", codex: "default" },
  };
}

function accountCommand(machine: string, command: string, args: Record<string, unknown>): unknown {
  switch (command) {
    case "list_agent_accounts":
      return snapshotOf(machine);
    case "get_agent_account_usage": {
      const value = usage[machine]?.[args.accountId as string];
      if (!value) throw new Error("No usage reading");
      return value;
    }
    case "set_active_agent_account":
      switches.push({ machine, accountId: args.accountId as string });
      accounts[machine] = accounts[machine]!.map((row) => ({
        ...row,
        isActive: row.id === args.accountId,
      }));
      return snapshotOf(machine);
    default:
      throw new Error(`Unexpected account command: ${command}`);
  }
}

const workspace = {
  id: "coordinator-1",
  projectId: PROJECT,
  lifecycleState: "ready",
  conversations: [
    {
      id: "main-1",
      tabId: "main-tab",
      role: "main",
      mailboxIncarnationId: "inc-main",
      lastTurnOrigin: "user",
      lastTurnStartedAt: "2026-11-04T01:00:00.000Z",
    },
  ],
} as unknown as CoordinatorWorkspace;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ork-account-switch-grant-"));
  storage = new StorageService(dataDir);
  await storage.init();
  await storage.addProject({
    ...createProject("https://example.invalid/orkestrator-v2.git", dataDir),
    id: PROJECT,
  });
  clock = { now: Date.now() };
  switches.length = 0;
  switchFailure = null;
  durable = [];
  events.length = 0;
  notified.length = 0;
  accounts = {
    [SELF]: [
      account("default", "Host login", { active: true, email: "me@example.com" }),
      account("acct-work", "Work", { email: "work@example.com" }),
      account("acct-spent", "Spent"),
      account("acct-old", "Old", { signedIn: false }),
    ],
    [LEAF]: [account("default", "Host login", { active: true }), account("acct-leaf", "Spare")],
  };
  usage = {
    [SELF]: { default: reading(100), "acct-work": reading(20), "acct-spent": reading(100) },
    [LEAF]: { default: reading(100) },
  };
  actionOptions = {
    load: async () => structuredClone(durable),
    save: async (rows) => {
      durable = structuredClone(rows);
    },
    emit: eventSink((event, payload) => events.push({ event, payload })),
    now: () => clock.now,
    executors: {
      "switch-agent-account": (request) => {
        if (switchFailure === "failed") throw new Error("Switch refused");
        if (switchFailure === "outcome-unknown")
          return Promise.resolve({
            code: "unknown",
            message: "Check the target",
            outcomeUnknown: true,
          });
        return executeAgentAccountSwitch(request, {
          selfId: () => SELF,
          invoke: async (command, args) => accountCommand(SELF, command, args),
          invokeOnNode: async ({ nodeId, command, args }) => ({
            outcome: "ok",
            result: accountCommand(nodeId, command, args),
          }),
        });
      },
    },
    notify: async (request) => {
      notified.push(request);
    },
  };
  actions = new NodeActionRequests(actionOptions);
  commandContext = {
    storage,
    nodeCoordination: { actions } as unknown as NodeCoordination,
    emit: eventSink((event: string, payload: unknown) => events.push({ event, payload })),
  } as unknown as CommandContext;
  const invoke: ControlMcpInvoker = async <T>(
    command: string,
    args: Record<string, unknown> = {},
  ) => {
    if (
      command === "get_coordinator_account_switch_grant" ||
      command === "run_granted_agent_account_switch"
    ) {
      return (await commands.get(command)!(args, commandContext)) as T;
    }
    switch (command) {
      case "get_project_coordinator":
        return { workspace } as T;
      case "get_config":
        return {
          global: { agentMessaging: { enabled: true }, enabledAgentPlatforms: ["claude"] },
        } as T;
      case "get_node_status":
        return { nodeId: SELF, mode: "command", controllers: [] } as T;
      case "get_node_summaries":
        return {
          selfId: SELF,
          nodes: (args.nodeIds as string[])
            .filter((nodeId) => nodeId === LEAF)
            .map((nodeId) => ({ nodeId, available: true, view: { displayName: "beelink" } })),
        } as T;
      case "invoke_on_node":
        return {
          outcome: "ok",
          result: accountCommand(
            args.nodeId as string,
            args.command as string,
            args.args as Record<string, unknown>,
          ),
        } as T;
      case "list_agent_accounts":
      case "get_agent_account_usage":
      case "set_active_agent_account":
        return accountCommand(SELF, command, args) as T;
      case "create_node_action_request":
        return (await actions.create(args as Parameters<typeof actions.create>[0])) as T;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  };
  server = new ControlMcpServer(dataDir, invoke, { port: 0 });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  storage.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function grant(enabled: boolean): Promise<CoordinatorAccountSwitchGrantState> {
  return (await commands.get("set_coordinator_account_switch_grant")!(
    { platform: "claude", enabled },
    commandContext,
  )) as CoordinatorAccountSwitchGrantState;
}

async function grantState(): Promise<CoordinatorAccountSwitchGrantState> {
  return (await commands.get("get_coordinator_account_switch_grant")!(
    {},
    commandContext,
  )) as CoordinatorAccountSwitchGrantState;
}

async function switchTo(accountId: string, requestId: string, extra: Record<string, unknown> = {}) {
  const issued = server.issueCoordinatorCredential({
    role: "coordinator",
    projectId: PROJECT,
    coordinatorId: "coordinator-1",
    conversationId: "main-1",
    mailboxIncarnationId: "inc-main",
    capabilities: coordinatorRoleCapabilities("main"),
  });
  const { body } = await rpc(issued.url, issued.token, "tools/call", {
    name: "switch_provider_account",
    arguments: {
      requestId,
      platform: "claude",
      accountId,
      reason: "Workers are about to hit the 5-hour limit",
      ...extra,
    },
  });
  if (body.error) throw new Error(body.error.message);
  return body.result!;
}

function text(result: { content?: Array<{ text?: string }> }): string {
  return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

describe("standing permission to switch accounts", () => {
  test("is off by default, per provider, and persisted", async () => {
    expect((await grantState()).grants).toEqual({ claude: false, codex: false });
    expect((await grant(true)).grants).toEqual({ claude: true, codex: false });
    const restarted = new StorageService(dataDir);
    await restarted.init();
    expect((await restarted.loadConfig()).global.coordinatorAccountSwitchGrant).toEqual({
      claude: true,
    });
    restarted.close();
  });

  test("not granted: the switch is a request the user approves, as before", async () => {
    const result = await switchTo("acct-work", "ask");
    expect(result.structuredContent).toMatchObject({ state: "pending" });
    expect(switches).toHaveLength(0);
    const [pending] = await actions.list({ pendingOnly: true });
    expect(pending).toMatchObject({ kind: "switch-agent-account" });
    expect(pending!.authorizedBy).toBeUndefined();
    expect(pending!.askedBecause).toBeUndefined();
  });

  test("granted: switches at once on this machine, recorded and shown to the user", async () => {
    await grant(true);
    const result = await switchTo("acct-work", "now");
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      state: "switched",
      machine: { nodeId: SELF, self: true },
      previousAccountId: "default",
      accountId: "acct-work",
      authorizedBy: { setting: "standing-grant" },
      // How to bring the limited tabs back on the new account.
      resumeStep: expect.stringContaining("send_prompt_to_tab"),
    });
    expect(text(result)).toContain("nothing for them to approve");
    expect(switches).toEqual([{ machine: SELF, accountId: "acct-work" }]);
    // No approval request waits, and no mail repeats what the call returned.
    expect(await actions.list({ pendingOnly: true })).toHaveLength(0);
    expect(notified).toHaveLength(0);

    const record = {
      platform: "claude",
      nodeId: SELF,
      nodeName: "this machine",
      fromAccountId: "default",
      fromAccountLabel: "Host login (me@example.com)",
      toAccountId: "acct-work",
      toAccountLabel: "Work (work@example.com)",
      coordinatorName: "orkestrator-v2 coordinator",
      reason: "Workers are about to hit the 5-hour limit",
      state: "executed",
    };
    expect((await grantState()).recentSwitches).toMatchObject([record]);
    expect(
      events.find((entry) => entry.event === COORDINATOR_ACCOUNT_SWITCHED_EVENT)?.payload,
    ).toMatchObject(record);
  });

  test("granted: switches a controlled machine with nodeId through the node link", async () => {
    await grant(true);
    const result = await switchTo("acct-leaf", "leaf", { nodeId: LEAF });
    expect(result.structuredContent).toMatchObject({
      state: "switched",
      machine: { nodeId: LEAF, name: "beelink", self: false },
    });
    expect(switches).toEqual([{ machine: LEAF, accountId: "acct-leaf" }]);
    expect((await grantState()).recentSwitches[0]).toMatchObject({
      nodeId: LEAF,
      nodeName: "beelink",
      toAccountLabel: "Spare",
    });
  });

  test("refuses an exhausted controlled-machine account before recording or switching", async () => {
    await grant(true);
    usage[LEAF]!["acct-leaf"] = reading(100);
    const result = await switchTo("acct-leaf", "leaf-spent", { nodeId: LEAF });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("used up");
    expect(switches).toHaveLength(0);
    expect(await actions.list()).toHaveLength(0);
    expect((await grantState()).recentSwitches).toHaveLength(0);
    expect(
      events.filter((entry) => entry.event === COORDINATOR_ACCOUNT_SWITCHED_EVENT),
    ).toHaveLength(0);
    expect(accounts[LEAF]!.find((row) => row.isActive)?.id).toBe("default");
  });

  test("a retry with the same requestId does not switch twice", async () => {
    await grant(true);
    await switchTo("acct-work", "once");
    const again = await switchTo("acct-work", "once");
    // Already active now, so nothing more happens.
    expect(again.structuredContent).toMatchObject({ state: "already-active" });
    expect(switches).toHaveLength(1);
  });

  test("refuses a signed-out or known-exhausted account even with the grant", async () => {
    await grant(true);
    const signedOut = await switchTo("acct-old", "old");
    expect(signedOut.isError).toBe(true);
    expect(text(signedOut)).toContain("not signed in");
    const spent = await switchTo("acct-spent", "spent");
    expect(spent.isError).toBe(true);
    expect(text(spent)).toContain("used up");
    expect(switches).toHaveLength(0);
    expect(await actions.list()).toHaveLength(0);
  });

  test("an account with no usage reading is not treated as exhausted", async () => {
    await grant(true);
    delete usage[SELF]!["acct-work"];
    const result = await switchTo("acct-work", "unknown");
    expect(result.structuredContent).toMatchObject({ state: "switched" });
  });

  test("past the hourly limit it asks the user and says why", async () => {
    await grant(true);
    // Both accounts have usage left, so a coordinator could flip between them.
    usage[SELF]!.default = reading(10);
    const limit = COORDINATOR_ACCOUNT_SWITCH_LIMIT.switches;
    for (let index = 0; index < limit; index += 1) {
      const target = index % 2 === 0 ? "acct-work" : "default";
      const result = await switchTo(target, `flip-${index}`);
      expect(result.structuredContent).toMatchObject({ state: "switched" });
    }
    actions = new NodeActionRequests(actionOptions);
    commandContext = {
      ...commandContext,
      nodeCoordination: { actions } as unknown as NodeCoordination,
    };
    const over = await switchTo(limit % 2 === 0 ? "acct-work" : "default", "over");
    expect(over.structuredContent).toMatchObject({ state: "pending" });
    expect(over.structuredContent!.askedBecause).toContain(`${limit} times in the last 60 minutes`);
    expect(switches).toHaveLength(limit);
    const [pending] = await actions.list({ pendingOnly: true });
    expect(pending!.askedBecause).toContain("the most Settings allows without asking");

    // Another machine has its own allowance.
    const leaf = await switchTo("acct-leaf", "leaf-ok", { nodeId: LEAF });
    expect(leaf.structuredContent).toMatchObject({ state: "switched" });

    // An hour later the allowance is back.
    clock.now += COORDINATOR_ACCOUNT_SWITCH_LIMIT.windowMs;
    const later = await switchTo(limit % 2 === 0 ? "acct-work" : "default", "later");
    expect(later.structuredContent).toMatchObject({ state: "switched" });
  });

  test("turning it off makes the next call ask again", async () => {
    await grant(true);
    expect((await switchTo("acct-work", "first")).structuredContent).toMatchObject({
      state: "switched",
    });
    await grant(false);
    const asked = await switchTo("default", "second");
    expect(asked.structuredContent).toMatchObject({ state: "pending" });
    expect(switches).toHaveLength(1);
  });

  test("the grant command refuses to record a switch while the permission is off", async () => {
    const outcome = await commands.get("run_granted_agent_account_switch")!(
      {
        requestId: "direct",
        platform: "claude",
        nodeId: SELF,
        nodeName: "this machine",
        accountId: "acct-work",
        requestedBy: {
          coordinatorEnvironmentId: "coordinator:coordinator-1:main-1",
          coordinatorTabId: "main-tab",
          projectId: PROJECT,
        },
      },
      commandContext,
    );
    expect(outcome).toEqual({ outcome: "not-granted" });
    expect(await actions.list()).toHaveLength(0);
  });

  test.each(["failed", "outcome-unknown"] as const)(
    "records and warns on %s, with conservative allowance accounting",
    async (failure) => {
      await grant(true);
      switchFailure = failure;
      const result = await switchTo("acct-work", "failure");
      if (failure === "failed") expect(result.isError).toBe(true);
      else expect(result.structuredContent).toMatchObject({ state: "outcome-unknown" });
      expect((await grantState()).recentSwitches[0]?.state).toBe(failure);
      expect(
        events.find((event) => event.event === COORDINATOR_ACCOUNT_SWITCHED_EVENT)?.payload,
      ).toMatchObject({ state: failure });
      actions = new NodeActionRequests(actionOptions);
      commandContext = {
        ...commandContext,
        nodeCoordination: { actions } as unknown as NodeCoordination,
      };
      switchFailure = null;
      expect((await switchTo("acct-work", "after-failure")).structuredContent).toMatchObject({
        state: "switched",
      });
      expect(switches).toHaveLength(1);
    },
  );

  test("the tool description says when no approval is needed", async () => {
    const issued = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: PROJECT,
      coordinatorId: "coordinator-1",
      conversationId: "main-1",
      mailboxIncarnationId: "inc-main",
      capabilities: coordinatorRoleCapabilities("main"),
    });
    const { body } = await rpc(issued.url, issued.token, "tools/list");
    const tool = body.result!.tools!.find((entry) => entry.name === "switch_provider_account");
    expect(tool?.description).toContain("Let coordinators switch accounts without asking");
    expect(tool?.description).toContain("never ask the user to approve a switch that already ran");
  });
});
