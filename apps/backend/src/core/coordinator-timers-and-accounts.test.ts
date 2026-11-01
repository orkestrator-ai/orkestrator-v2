import { afterEach, beforeEach, describe, expect, test, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentAccountAutoSwitchState } from "@orkestrator/protocol/agent-account-auto-switch";
import type {
  AgentAccountsSnapshot,
  AgentAccountSummary,
} from "@orkestrator/protocol/agent-accounts";
import {
  COORDINATOR_WORKSPACE_VERSION,
  COORDINATOR_EXECUTION_POLICY,
  coordinatorRuntimeId,
  type CoordinatorWorkspace,
} from "@orkestrator/protocol/coordinator";
import { collaborators } from "./native-agent-service-test-collaborators.js";
import { NativeAgentService } from "./native-agent-service.js";
import {
  AmbiguousPromptDispatchError,
  type NativeAgentRuntimeProvider,
} from "./native-agent-provider.js";
import type { PlanUsageSnapshot } from "@orkestrator/protocol/plan-usage";
import { SCHEDULED_JOB_LIMITS } from "@orkestrator/protocol/scheduled-jobs";
import { readProjectUsageLimits } from "./agent-usage-limits.js";
import type { CommandContext } from "./commands-context.js";
import { registerScheduledJobCommands } from "./commands-registry-scheduled-jobs.js";
import { rpc } from "./control-mcp-test-support.js";
import { ControlMcpServer, type ControlMcpInvoker } from "./control-mcp-server.js";
import { coordinatorRoleCapabilities } from "./control-mcp-tools.js";
import type { Environment, PersistedNativeAgentSession } from "./models.js";
import { executeAgentAccountSwitch } from "./nodes/node-account-switch.js";
import { NodeActionRequests, type NodeActionRequest } from "./nodes/node-action-requests.js";
import { ScheduledJobExecutor } from "./scheduled-jobs/executor.js";
import { ScheduledJobService } from "./scheduled-jobs/service.js";
import { StorageService, createProject } from "./storage.js";

/**
 * A coordinator's self-timers and provider-account tools over the real
 * Control MCP endpoint, the real scheduler and the real approval-request
 * store. Accounts, usage readings and agent sessions are fakes: nothing reads
 * or writes a real provider login, and nothing runs a model turn.
 *
 * The scenario: "Check the environments in 2 hours. See if any of them have
 * hit usage limits, then switch to another account that has usage
 * allocation left."
 */

const SELF = "bk_self";
const LEAF = "bk_leaf";
const PROJECT = "project-1";

let dataDir: string;
let storage: StorageService;
let server: ControlMcpServer;
let service: ScheduledJobService;
let actions: NodeActionRequests;
let clock: { now: number };
let currentWorkspace: CoordinatorWorkspace;
const mail: Array<{ sender: unknown; input: Record<string, unknown> }> = [];
const switches: Array<{ machine: string; platform: string; accountId: string }> = [];
const notified: NodeActionRequest[] = [];
let accounts: Record<string, AgentAccountSummary[]>;
let usage: Record<string, Record<string, PlanUsageSnapshot>>;
let environments: Environment[];
let sessions: PersistedNativeAgentSession[];
let invoke: ControlMcpInvoker;
let autoSwitch: Record<string, AgentAccountAutoSwitchState | undefined>;
const tickCalls: Array<{ machine: string; command: string; args: Record<string, unknown> }> = [];

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

function reading(usedPercent: number, resetsInMs: number): PlanUsageSnapshot {
  return {
    platform: "claude",
    status: "ok",
    windows: [
      {
        window: "five_hour",
        label: "5-hour",
        usedPercent,
        resetsAt: new Date(Date.now() + resetsInMs).toISOString(),
      },
    ],
    fetchedAt: new Date().toISOString(),
  };
}

function snapshotOf(machine: string): AgentAccountsSnapshot {
  const rows = accounts[machine]!;
  return {
    accounts: rows,
    active: {
      claude: rows.find((row) => row.isActive)?.id ?? "default",
      codex: "default",
    },
    ...(autoSwitch[machine] ? { autoSwitch: { claude: autoSwitch[machine] } } : {}),
  };
}

/** The machine-local account commands, as `commands-registry-accounts.ts` serves them. */
function accountCommand(machine: string, command: string, args: Record<string, unknown>): unknown {
  switch (command) {
    case "list_agent_accounts":
      return snapshotOf(machine);
    case "get_agent_account_usage": {
      const value = usage[machine]?.[args.accountId as string];
      if (!value) throw new Error("No usage reading");
      return value;
    }
    case "set_active_agent_account": {
      switches.push({
        machine,
        platform: args.platform as string,
        accountId: args.accountId as string,
      });
      accounts[machine] = accounts[machine]!.map((row) => ({
        ...row,
        isActive: row.id === args.accountId,
      }));
      return snapshotOf(machine);
    }
    case "set_agent_account_auto_switch":
    case "resume_agent_account_auto_switch":
      tickCalls.push({ machine, command, args });
      return snapshotOf(machine);
    default:
      throw new Error(`Unexpected account command: ${command}`);
  }
}

function initialWorkspace(): CoordinatorWorkspace {
  return {
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
        lastTurnStartedAt: "2026-10-30T09:00:00.000Z",
      },
      { id: "side-1", tabId: "side-tab", role: "side", mailboxIncarnationId: "inc-side" },
    ],
  } as unknown as CoordinatorWorkspace;
}

function session(
  environmentId: string,
  tabId: string,
  outcomes: PersistedNativeAgentSession["turnOutcomes"],
): PersistedNativeAgentSession {
  return {
    key: `${environmentId}:${tabId}`,
    environmentId,
    agent: "claude",
    logicalSessionKey: `env-${environmentId}:${tabId}`,
    turnOutcomes: outcomes,
  } as unknown as PersistedNativeAgentSession;
}

function buildService(store = storage): ScheduledJobService {
  return new ScheduledJobService({
    store: store.scheduledJobStore(),
    now: () => clock.now,
    defaultTimeZone: () => "Europe/London",
    executor: new ScheduledJobExecutor({
      invoke,
      storage: {
        async sendAgentMail(sender, input) {
          mail.push({ sender, input });
          return {
            id: `message-${mail.length}`,
            toEnvironmentId: input.toEnvironmentId,
            toTabId: input.toTabId,
          };
        },
        coordinators: { getCoordinatorWorkspace: async () => currentWorkspace },
      },
      controlMcp: {
        credentialPolicy: (id) => server.credentialPolicy(id),
        callCoordinatorTool: (scope, tool, args) => server.callCoordinatorTool(scope, tool, args),
        listCoordinatorTools: (scope) => server.listCoordinatorTools(scope),
      },
    }),
  });
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "ork-coordinator-timers-"));
  storage = new StorageService(dataDir);
  await storage.init();
  await storage.updateGlobalConfig({
    ...(await storage.loadConfig()).global,
    experimentalScheduling: true,
  });
  currentWorkspace = initialWorkspace();
  // Real time: a timer's permission is checked against the wall clock.
  clock = { now: Date.now() };
  mail.length = 0;
  switches.length = 0;
  notified.length = 0;
  autoSwitch = {};
  accounts = {
    [SELF]: [
      account("default", "Host login", { active: true, email: "me@example.com" }),
      account("acct-work", "Work", { email: "work@example.com" }),
      account("acct-old", "Old", { signedIn: false }),
    ],
    [LEAF]: [
      account("default", "Host login", { active: true }),
      account("acct-leaf", "Leaf spare"),
    ],
  };
  usage = {
    [SELF]: { default: reading(100, 3 * 3_600_000), "acct-work": reading(20, 4 * 3_600_000) },
    [LEAF]: { default: reading(100, 3_600_000), "acct-leaf": reading(5, 3_600_000) },
  };
  environments = [
    { id: "env-a", projectId: PROJECT, name: "Feature A" },
    { id: "env-b", projectId: PROJECT, name: "Feature B" },
  ] as unknown as Environment[];
  sessions = [
    session("env-a", "tab-a", [
      { requestId: "r1", outcome: "completed", observedAt: "2026-10-30T09:00:00.000Z" },
      {
        requestId: "r2",
        outcome: "failed",
        error: "Claude AI usage limit reached · resets 3pm (Europe/London)",
        observedAt: "2026-10-30T10:00:00.000Z",
      },
    ]),
    session("env-b", "tab-b", [
      { requestId: "r3", outcome: "completed", observedAt: "2026-10-30T10:00:00.000Z" },
    ]),
  ];
  actions = new NodeActionRequests({
    load: async () => [],
    save: async () => {},
    emit: () => undefined,
    executors: {
      "switch-agent-account": (request) =>
        executeAgentAccountSwitch(request, {
          selfId: () => SELF,
          invoke: async (command, args) => accountCommand(SELF, command, args),
          invokeOnNode: async ({ nodeId, command, args }) => ({
            outcome: "ok",
            result: accountCommand(nodeId, command, args),
          }),
        }),
    },
    notify: async (request) => {
      notified.push(request);
    },
  });
  const commands = new Map<
    string,
    (args: Record<string, unknown>, context: CommandContext) => unknown
  >();
  registerScheduledJobCommands((name, handler) => {
    commands.set(name, handler as never);
  });
  const context = { storage } as CommandContext;
  invoke = async <T>(command: string, args: Record<string, unknown> = {}) => {
    const own = commands.get(command);
    if (own) return (await own(args, context)) as T;
    switch (command) {
      case "get_project_coordinator":
        return { workspace: currentWorkspace } as T;
      case "get_config":
        return {
          global: {
            agentMessaging: { enabled: true },
            enabledAgentPlatforms: ["claude"],
            experimentalScheduling: true,
          },
        } as T;
      case "get_node_status":
        return { nodeId: SELF, mode: "command", controllers: [] } as T;
      case "get_node_summaries":
        return {
          selfId: SELF,
          nodes: (args.nodeIds as string[])
            .filter((nodeId) => nodeId === LEAF)
            .map((nodeId) => ({
              nodeId,
              available: true,
              view: { displayName: "Leaf" },
              projects: [],
            })),
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
      case "set_agent_account_auto_switch":
      case "resume_agent_account_auto_switch":
        return accountCommand(SELF, command, args) as T;
      case "get_project_usage_limits":
        return (await readProjectUsageLimits(
          {
            storage: {
              getEnvironmentsByProject: async (projectId) =>
                environments.filter((environment) => environment.projectId === projectId),
              listNativeAgentSessions: async () => sessions,
            },
            planUsage: () => usage[SELF]![snapshotOf(SELF).active.claude],
          },
          args.projectId as string,
        )) as T;
      case "create_node_action_request":
        return (await actions.create(args as Parameters<typeof actions.create>[0])) as T;
      default:
        throw new Error(`Unexpected command: ${command}`);
    }
  };
  server = new ControlMcpServer(dataDir, invoke, { port: 0 });
  await server.start();
  service = buildService();
  context.scheduledJobs = service;
});

afterEach(async () => {
  await server.stop();
  storage.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function call(role: "main" | "side", name: string, args: Record<string, unknown>) {
  const issued = server.issueCoordinatorCredential({
    role: "coordinator",
    projectId: PROJECT,
    coordinatorId: "coordinator-1",
    conversationId: role === "main" ? "main-1" : "side-1",
    mailboxIncarnationId: role === "main" ? "inc-main" : "inc-side",
    capabilities: coordinatorRoleCapabilities(role),
  });
  const { body } = await rpc(issued.url, issued.token, "tools/call", { name, arguments: args });
  if (body.error) throw new Error(body.error.message);
  return body.result!;
}

function text(result: { content?: Array<{ text?: string }> }): string {
  return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}

async function fire() {
  await service.tick();
  await service.idle();
}

describe("self-timers", () => {
  test("a relative timer fires once into the main coordinator's own conversation", async () => {
    const created = await call("main", "create_schedule", {
      requestId: "in-2h",
      at: "+2h",
      action: { type: "remind_me", body: "Check the workers for usage limits." },
    });
    expect(created.isError).not.toBe(true);
    expect(created.structuredContent).toMatchObject({
      state: "active",
      timeZone: "Europe/London",
      timeZoneUsed: expect.stringContaining("local time zone"),
      name: "Self-timer: Check the workers for usage limits.",
      nextFireAt: new Date(clock.now + 2 * 3_600_000).toISOString(),
    });
    expect(String(created.structuredContent!.nextFireLocal)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d /);
    clock.now += 2 * 3_600_000 - 60_000;
    await fire();
    expect(mail).toHaveLength(0);
    clock.now += 60_000;
    await fire();
    expect(mail).toHaveLength(1);
    expect(mail[0]!.sender).toMatchObject({ kind: "system", source: "workflow" });
    expect(mail[0]!.input).toMatchObject({
      toEnvironmentId: "coordinator",
      body: expect.stringContaining("Check the workers for usage limits."),
    });
    // It fired once and is finished.
    await fire();
    expect(mail).toHaveLength(1);
    const listed = await call("main", "list_schedules", {});
    expect(listed.structuredContent!.schedules).toEqual([
      expect.objectContaining({ state: "completed" }),
    ]);
  });

  test("an absolute time is read in the user's local zone and says so", async () => {
    clock.now = Date.parse("2026-10-30T09:00:00Z");
    const created = await call("main", "create_schedule", {
      requestId: "at-1430",
      at: "14:30",
      action: { type: "remind_me", body: "Afternoon check." },
    });
    expect(created.structuredContent).toMatchObject({
      timeZone: "Europe/London",
      nextFireAt: "2026-10-30T14:30:00.000Z",
      nextFireLocal: "2026-10-30 14:30 GMT",
    });
    const zoned = await call("main", "create_schedule", {
      requestId: "at-1430-ny",
      at: "14:30",
      timeZone: "America/New_York",
      action: { type: "remind_me", body: "New York afternoon." },
    });
    expect(zoned.structuredContent).toMatchObject({
      timeZoneUsed: "America/New_York (as given)",
      nextFireAt: "2026-10-30T18:30:00.000Z",
    });
  });

  test("a side agent's timer comes back to that side conversation, not the main one", async () => {
    await call("side", "create_schedule", {
      requestId: "side-timer",
      at: "+10m",
      action: { type: "remind_me", body: "Side check." },
    });
    clock.now += 10 * 60_000;
    await fire();
    expect(mail[0]!.input.toEnvironmentId).toBe("coordinator:coordinator-1:side-1");
  });

  test("cancelling a timer stops it firing", async () => {
    const created = await call("main", "create_schedule", {
      requestId: "cancel-me",
      at: "+5m",
      action: { type: "remind_me", body: "Never delivered." },
    });
    const cancelled = await call("main", "cancel_schedule", {
      scheduleId: created.structuredContent!.scheduleId,
    });
    expect(cancelled.structuredContent).toMatchObject({ deleted: true });
    clock.now += 10 * 60_000;
    await fire();
    expect(mail).toHaveLength(0);
    expect((await call("main", "list_schedules", {})).structuredContent!.total).toBe(0);
  });

  test("a pending timer survives a backend restart and fires from the new backend", async () => {
    await call("main", "create_schedule", {
      requestId: "survive",
      at: "+30m",
      action: { type: "remind_me", body: "After the restart." },
    });
    await service.stop();
    storage.close();
    storage = new StorageService(dataDir);
    await storage.init();
    service = buildService(storage);
    clock.now += 30 * 60_000;
    await fire();
    expect(mail).toHaveLength(1);
    expect(mail[0]!.input.body).toContain("After the restart.");
  });

  test("a timer more than the maximum delay ahead is refused", async () => {
    const refused = await call("main", "create_schedule", {
      requestId: "too-far",
      at: "+8d",
      action: { type: "remind_me", body: "Too far." },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("at most 7 days ahead");
  });

  test("a coordinator holds at most the pending self-timer cap", async () => {
    for (let index = 0; index < SCHEDULED_JOB_LIMITS.maxPendingSelfTimers; index++) {
      const created = await call("main", "create_schedule", {
        requestId: `cap-${index}`,
        at: `+${index + 1}m`,
        action: { type: "remind_me", body: `Timer ${index}` },
      });
      expect(created.isError).not.toBe(true);
    }
    const refused = await call("main", "create_schedule", {
      requestId: "cap-over",
      at: "+2h",
      action: { type: "remind_me", body: "One too many." },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("pending self-timers");
  });

  test("account-switch permission is refused in a turn that mail started", async () => {
    currentWorkspace.conversations[0]!.lastTurnOrigin = "mail";
    const refused = await call("main", "create_schedule", {
      requestId: "forged",
      at: "+2h",
      action: {
        type: "remind_me",
        body: "Switch accounts.",
        authorizeAccountSwitch: { platforms: ["claude"], userInstruction: "switch" },
      },
    });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("turn the user started");
    // Nor can it be smuggled through a plain tool action.
    const smuggled = await call("main", "create_schedule", {
      requestId: "smuggled",
      at: "+2h",
      action: {
        type: "tool",
        tool: "send_message",
        arguments: {
          toEnvironmentId: "coordinator",
          body: "x",
          grant: { kind: "switch-agent-account", platforms: ["claude"] },
        },
      },
    });
    expect(smuggled.isError).toBe(true);
    expect(service.list({ kind: "operator" })).toHaveLength(0);
  });

  test("a side agent cannot carry account-switch permission", async () => {
    currentWorkspace.conversations[1]!.lastTurnOrigin = "user";
    const refused = await call("side", "create_schedule", {
      requestId: "side-grant",
      at: "+1h",
      action: {
        type: "remind_me",
        body: "Switch.",
        authorizeAccountSwitch: { platforms: ["claude"], userInstruction: "switch" },
      },
    });
    expect(refused.isError).toBe(true);
  });
});

describe("provider accounts", () => {
  test("lists accounts with usage and remaining allocation", async () => {
    const listed = await call("main", "list_provider_accounts", { platform: "claude" });
    expect(listed.isError).not.toBe(true);
    const claude = (listed.structuredContent!.providers as Record<string, Record<string, unknown>>)
      .claude!;
    expect(claude.activeAccountId).toBe("default");
    const rows = claude.accounts as Array<Record<string, unknown>>;
    expect(rows.find((row) => row.accountId === "default")).toMatchObject({
      active: true,
      hasAllocationLeft: false,
      usage: { exhausted: true, lowestRemainingPercent: 0 },
    });
    expect(rows.find((row) => row.accountId === "acct-work")).toMatchObject({
      active: false,
      email: "work@example.com",
      hasAllocationLeft: true,
      usage: { exhausted: false, lowestRemainingPercent: 80 },
    });
    expect(rows.find((row) => row.accountId === "acct-old")).toMatchObject({
      signedIn: false,
      hasAllocationLeft: false,
    });
    expect(rows.find((row) => row.accountId === "acct-old")!.usage).toBeUndefined();
  });

  test("lists another machine's accounts through the node link", async () => {
    const listed = await call("main", "list_provider_accounts", { nodeId: LEAF });
    expect(listed.structuredContent!.machine).toEqual({ nodeId: LEAF, name: "Leaf", self: false });
    const rows = (
      (listed.structuredContent!.providers as Record<string, Record<string, unknown>>).claude!
        .accounts as Array<Record<string, unknown>>
    ).map((row) => row.accountId);
    expect(rows).toEqual(["default", "acct-leaf"]);
  });

  test("without a timer's permission a switch is a request the user approves", async () => {
    const requested = await call("main", "switch_provider_account", {
      requestId: "ask",
      platform: "claude",
      accountId: "acct-work",
      reason: "Switch to the work account",
    });
    expect(requested.isError).not.toBe(true);
    expect(requested.structuredContent).toMatchObject({ state: "pending", scope: "machine" });
    expect(switches).toHaveLength(0);
    const [pending] = await actions.list({ pendingOnly: true });
    expect(pending).toMatchObject({
      kind: "switch-agent-account",
      targets: [
        {
          nodeId: SELF,
          platform: "claude",
          accountId: "acct-work",
          accountLabel: "Work (work@example.com)",
        },
      ],
      requestedBy: {
        projectId: PROJECT,
        coordinatorEnvironmentId: "coordinator:coordinator-1:main-1",
        coordinatorTabId: "main-tab",
      },
    });
    const resolved = await actions.resolve(pending!.requestId, "approve");
    expect(resolved).toMatchObject({ state: "executed", result: { code: "switched" } });
    expect(resolved.result!.message).toContain("next turn");
    expect(switches).toEqual([{ machine: SELF, platform: "claude", accountId: "acct-work" }]);
    // The coordinator is told the outcome.
    expect(notified.map((request) => request.state)).toEqual(["executed"]);
  });

  test("a rejected request switches nothing", async () => {
    await call("main", "switch_provider_account", {
      requestId: "ask-reject",
      platform: "claude",
      accountId: "acct-work",
      reason: "Switch",
    });
    const [pending] = await actions.list({ pendingOnly: true });
    await actions.resolve(pending!.requestId, "reject");
    expect(switches).toHaveLength(0);
    expect(notified.map((request) => request.state)).toEqual(["rejected"]);
  });

  test("a signed-out account and the already-active one are not switched to", async () => {
    const signedOut = await call("main", "switch_provider_account", {
      requestId: "old",
      platform: "claude",
      accountId: "acct-old",
      reason: "x",
    });
    expect(signedOut.isError).toBe(true);
    expect(text(signedOut)).toContain("not signed in");
    const active = await call("main", "switch_provider_account", {
      requestId: "same",
      platform: "claude",
      accountId: "default",
      reason: "x",
    });
    expect(active.structuredContent).toMatchObject({ state: "already-active" });
    expect(await actions.list()).toHaveLength(0);
  });

  test("side agents are not offered the account tools", async () => {
    const issued = server.issueCoordinatorCredential({
      role: "coordinator",
      projectId: PROJECT,
      coordinatorId: "coordinator-1",
      conversationId: "side-1",
      mailboxIncarnationId: "inc-side",
      capabilities: coordinatorRoleCapabilities("side"),
    });
    const { body } = await rpc(issued.url, issued.token, "tools/list");
    const names = body.result!.tools!.map((tool) => tool.name);
    expect(names).not.toContain("switch_provider_account");
    expect(names).not.toContain("list_provider_accounts");
    expect(names).not.toContain("get_usage_limits");
  });
});

describe("automatic switching", () => {
  beforeEach(() => {
    tickCalls.length = 0;
  });

  test("a main coordinator sees the state and each account's tick", async () => {
    autoSwitch[SELF] = {
      mode: "pinned",
      pinnedAccountId: "acct-work",
      includedAccountIds: ["acct-work"],
      lastSwitch: {
        fromAccountId: "default",
        toAccountId: "acct-work",
        reason: "limit",
        at: "2026-11-01T00:00:00.000Z",
      },
    };
    const listed = (await call("main", "list_provider_accounts", { platform: "claude" }))
      .structuredContent as { providers: { claude: Record<string, unknown> } };
    expect(listed.providers.claude.autoSwitch).toMatchObject({
      mode: "pinned",
      pinnedAccountId: "acct-work",
      lastSwitch: { reason: "limit" },
    });
    const rows = listed.providers.claude.accounts as Array<Record<string, unknown>>;
    expect(rows.find((row) => row.accountId === "acct-work")?.autoSwitchIncluded).toBe(true);
    expect(rows.find((row) => row.accountId !== "acct-work")?.autoSwitchIncluded).toBe(false);
  });

  test("a machine that predates it simply shows no state", async () => {
    const listed = (await call("main", "list_provider_accounts", { platform: "claude" }))
      .structuredContent as { providers: { claude: Record<string, unknown> } };
    expect(listed.providers.claude.autoSwitch).toBeUndefined();
  });

  test("changes the main tick here without asking for approval", async () => {
    autoSwitch[SELF] = { mode: "off", includedAccountIds: [] };
    const result = await call("main", "set_account_auto_switch", {
      platform: "claude",
      enabled: true,
    });
    expect(result.structuredContent).toMatchObject({ autoSwitch: { mode: "off" } });
    expect(tickCalls).toEqual([
      {
        machine: SELF,
        command: "set_agent_account_auto_switch",
        args: { platform: "claude", enabled: true },
      },
    ]);
    expect(await actions.list()).toEqual([]);
    expect(switches).toEqual([]);
  });

  test("a machine that predates it is left alone when the tick is set", async () => {
    await call("main", "set_account_auto_switch", {
      platform: "claude",
      enabled: true,
      nodeId: LEAF,
    });
    expect(tickCalls.map((entry) => entry.machine)).toEqual([SELF]);
  });

  test("ticking again here ends this machine's pin and no other's", async () => {
    autoSwitch[SELF] = { mode: "off", pinnedAccountId: "default", includedAccountIds: [] };
    autoSwitch[LEAF] = { mode: "pinned", pinnedAccountId: "default", includedAccountIds: [] };
    await call("main", "set_account_auto_switch", { platform: "claude", enabled: true });
    expect(tickCalls).toEqual([
      {
        machine: SELF,
        command: "set_agent_account_auto_switch",
        args: { platform: "claude", enabled: true },
      },
      {
        machine: SELF,
        command: "resume_agent_account_auto_switch",
        args: { platform: "claude" },
      },
    ]);
  });

  test("with the tick already on, as on a leaf, it only ends the pin", async () => {
    autoSwitch[SELF] = { mode: "pinned", pinnedAccountId: "default", includedAccountIds: [] };
    await call("main", "set_account_auto_switch", { platform: "claude", enabled: true });
    expect(tickCalls).toEqual([
      {
        machine: SELF,
        command: "resume_agent_account_auto_switch",
        args: { platform: "claude" },
      },
    ]);
  });

  test("ticking with a machine named ends that machine's pin, keeping the ticks and this machine's pin", async () => {
    autoSwitch[SELF] = { mode: "off", pinnedAccountId: "default", includedAccountIds: [] };
    autoSwitch[LEAF] = { mode: "pinned", pinnedAccountId: "default", includedAccountIds: [] };
    await call("main", "set_account_auto_switch", {
      platform: "claude",
      enabled: true,
      nodeId: LEAF,
    });
    expect(tickCalls).toEqual([
      {
        machine: SELF,
        command: "set_agent_account_auto_switch",
        args: { platform: "claude", enabled: true },
      },
      {
        machine: LEAF,
        command: "resume_agent_account_auto_switch",
        args: { platform: "claude" },
      },
    ]);
  });

  test("an account's tick travels by email; one with no email stays on its machine", async () => {
    accounts[LEAF] = [
      account("mailed", "Mailed", { active: true, email: "m@example.com" }),
      account("keyed", "API key"),
    ];
    await call("main", "set_account_auto_switch", {
      platform: "claude",
      accountId: "mailed",
      included: false,
      nodeId: LEAF,
    });
    await call("main", "set_account_auto_switch", {
      platform: "claude",
      accountId: "keyed",
      included: true,
      nodeId: LEAF,
    });
    expect(tickCalls).toEqual([
      {
        machine: SELF,
        command: "set_agent_account_auto_switch",
        args: { platform: "claude", email: "m@example.com", included: false },
      },
      {
        machine: LEAF,
        command: "set_agent_account_auto_switch",
        args: { platform: "claude", accountId: "keyed", included: true },
      },
    ]);
  });

  test("refuses an account it cannot find, and a call that changes nothing", async () => {
    const unknown = await call("main", "set_account_auto_switch", {
      platform: "claude",
      accountId: "nobody",
      included: true,
    });
    expect(unknown.isError).toBe(true);
    const nothing = await call("main", "set_account_auto_switch", { platform: "claude" });
    expect(nothing.isError).toBe(true);
    expect(tickCalls).toEqual([]);
  });

  test("a coordinator's own switch still needs the user's approval", async () => {
    autoSwitch[SELF] = { mode: "automatic", includedAccountIds: ["acct-work"] };
    const result = await call("main", "switch_provider_account", {
      requestId: "needs-approval",
      platform: "claude",
      accountId: "acct-work",
      reason: "The user asked.",
    });
    expect(result.structuredContent).toMatchObject({ state: "pending" });
    expect(switches).toEqual([]);
  });

  test("a side agent cannot reach it", async () => {
    const result = await call("side", "set_account_auto_switch", {
      platform: "claude",
      enabled: true,
    }).catch(() => ({ isError: true }));
    expect(result.isError).toBe(true);
    expect(tickCalls).toEqual([]);
  });
});

describe("usage-limit reader", () => {
  test("names the tabs whose last turn hit a usage limit and the exhausted active account", async () => {
    const limits = await call("main", "get_usage_limits", {});
    expect(limits.isError).not.toBe(true);
    expect(limits.structuredContent).toMatchObject({
      limitedTabs: [
        {
          environmentId: "env-a",
          environmentName: "Feature A",
          tabId: "tab-a",
          agent: "claude",
          resetHint: "3pm (Europe/London)",
        },
      ],
      activeAccounts: expect.arrayContaining([
        expect.objectContaining({
          platform: "claude",
          exhaustedWindows: [expect.objectContaining({ window: "five_hour", usedPercent: 100 })],
        }),
      ]),
      nextStep: expect.stringContaining("switch_provider_account"),
    });
  });
});

test("scenario: check in 2 hours, find usage limits, switch to an account with allocation left", async () => {
  // The user's turn: "Check the environments in 2 hours. See if any of them
  // have hit usage limits, then switch to another account that has usage
  // allocation left."
  const instruction =
    "Check the environments in 2 hours. See if any of them have hit usage limits, then switch to another account that has usage allocation left.";
  const timer = await call("main", "create_schedule", {
    requestId: "scenario",
    at: "+2h",
    action: {
      type: "remind_me",
      body: "Check the environments for usage-limit failures; if any, switch Claude to an account with allocation left and report.",
      authorizeAccountSwitch: { platforms: ["claude"], userInstruction: instruction },
    },
  });
  expect(timer.structuredContent).toMatchObject({ carriesAccountSwitchPermission: true });
  const scheduleId = timer.structuredContent!.scheduleId as string;

  // Before it fires its permission is worth nothing.
  const early = await call("main", "switch_provider_account", {
    requestId: "early",
    platform: "claude",
    accountId: "acct-work",
    reason: instruction,
    scheduleId,
  });
  expect(early.isError).toBe(true);
  expect(text(early)).toContain("has not fired yet");

  // Two hours later the timer wakes the coordinator with its instruction.
  clock.now += 2 * 3_600_000;
  await fire();
  expect(mail).toHaveLength(1);
  const reminder = String(mail[0]!.input.body);
  expect(mail[0]!.input.toEnvironmentId).toBe("coordinator");
  expect(reminder).toContain(instruction);
  expect(reminder).toContain(`pass scheduleId ${scheduleId} to switch_provider_account`);

  // The woken turn was started by the reminder, not the user.
  currentWorkspace.conversations[0]!.lastTurnOrigin = "mail";

  const limits = await call("main", "get_usage_limits", {});
  expect((limits.structuredContent!.limitedTabs as unknown[]).length).toBe(1);

  const listed = await call("main", "list_provider_accounts", { platform: "claude" });
  const candidates = (
    (listed.structuredContent!.providers as Record<string, Record<string, unknown>>).claude!
      .accounts as Array<Record<string, unknown>>
  ).filter((row) => row.hasAllocationLeft === true && row.active === false);
  expect(candidates.map((row) => row.accountId)).toEqual(["acct-work"]);

  const switched = await call("main", "switch_provider_account", {
    requestId: "scenario-switch",
    platform: "claude",
    accountId: candidates[0]!.accountId,
    reason: instruction,
    scheduleId,
  });
  expect(switched.isError).not.toBe(true);
  expect(switched.structuredContent).toMatchObject({
    state: "switched",
    previousAccountId: "default",
    accountId: "acct-work",
    scope: "machine",
    authorizedBy: { scheduleId, userInstruction: instruction },
    effect: expect.stringContaining("next turn"),
  });
  expect(switches).toEqual([{ machine: SELF, platform: "claude", accountId: "acct-work" }]);
  // No approval was needed, and none is left waiting.
  expect(await actions.list({ pendingOnly: true })).toHaveLength(0);

  // The permission covers the machines the user named only.
  const elsewhere = await call("main", "switch_provider_account", {
    requestId: "scenario-leaf",
    platform: "claude",
    accountId: "acct-leaf",
    nodeId: LEAF,
    reason: instruction,
    scheduleId,
  });
  expect(elsewhere.isError).toBe(true);
  expect(text(elsewhere)).toContain("may not switch accounts on Leaf");
});

test("a timer's permission lapses two hours after it fired", async () => {
  clock.now = Date.now() - 5 * 3_600_000;
  const timer = await call("main", "create_schedule", {
    requestId: "lapsed",
    at: "+1h",
    action: {
      type: "remind_me",
      body: "Switch if limited.",
      authorizeAccountSwitch: {
        platforms: ["claude"],
        nodeIds: [LEAF],
        userInstruction: "switch if limited",
      },
    },
  });
  clock.now += 3_600_000;
  await fire();
  const lapsed = await call("main", "switch_provider_account", {
    requestId: "lapsed-switch",
    platform: "claude",
    accountId: "acct-leaf",
    nodeId: LEAF,
    reason: "switch if limited",
    scheduleId: timer.structuredContent!.scheduleId,
  });
  expect(lapsed.isError).toBe(true);
  expect(text(lapsed)).toContain("lapsed");
  expect(switches).toHaveLength(0);
});

test("a timer's permission can name another machine, switched through the node link", async () => {
  const timer = await call("main", "create_schedule", {
    requestId: "leaf-timer",
    at: "+1h",
    action: {
      type: "remind_me",
      body: "Switch the leaf if limited.",
      authorizeAccountSwitch: {
        platforms: ["claude"],
        nodeIds: [LEAF],
        userInstruction: "switch the leaf",
      },
    },
  });
  clock.now += 3_600_000;
  await fire();
  const switched = await call("main", "switch_provider_account", {
    requestId: "leaf-switch",
    platform: "claude",
    accountId: "acct-leaf",
    nodeId: LEAF,
    reason: "switch the leaf",
    scheduleId: timer.structuredContent!.scheduleId,
  });
  expect(switched.structuredContent).toMatchObject({
    state: "switched",
    machine: { nodeId: LEAF, self: false },
  });
  expect(switches).toEqual([{ machine: LEAF, platform: "claude", accountId: "acct-leaf" }]);
});

test.each([{ cron: "0 * * * *" }, { everyMinutes: 60 }])(
  "recurring self-timers cannot carry account-switch permission: %j",
  async (timing) => {
    const result = await call("main", "create_schedule", {
      requestId: "recurring-grant",
      ...timing,
      action: {
        type: "remind_me",
        body: "Switch if limited",
        authorizeAccountSwitch: { platforms: ["claude"], userInstruction: "switch" },
      },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("one-shot");
    expect(service.list({ kind: "operator" })).toHaveLength(0);
  },
);

test.each([
  { stale: true, windows: [{ window: "quota", usedPercent: 20 }] },
  {
    stale: true,
    windows: [{ window: "quota", usedPercent: 100, resetsAt: "2020-01-01T00:00:00Z" }],
  },
  { status: "error" as const, windows: [] },
  { windows: [] },
  { windows: [{ window: "quota", resetsAt: "2020-01-01T00:00:00Z" }] },
])("availability stays unknown without a current measured reading: %j", async (snapshot) => {
  usage[SELF]!["acct-work"] = {
    ...reading(20, 3600000),
    ...snapshot,
    windows: snapshot.windows.map((window) => ({ ...window })),
  };
  const result = await call("main", "list_provider_accounts", { platform: "claude" });
  const providers = result.structuredContent!.providers as {
    claude: { accounts: Array<Record<string, unknown>> };
  };
  expect(providers.claude.accounts.find((row) => row.accountId === "acct-work")).toMatchObject({
    hasAllocationLeft: "unknown",
    usage: { status: snapshot.status ?? "ok" },
  });
});

test("a timer grant refuses another provider before any account change", async () => {
  accounts[SELF]!.push({ ...account("codex-spare", "Codex spare"), platform: "codex" });
  const timer = await call("main", "create_schedule", {
    requestId: "claude-only",
    at: "+1m",
    action: {
      type: "remind_me",
      body: "Switch Claude",
      authorizeAccountSwitch: { platforms: ["claude"], userInstruction: "switch Claude" },
    },
  });
  clock.now += 60000;
  await fire();
  const result = await call("main", "switch_provider_account", {
    requestId: "wrong-platform",
    platform: "codex",
    accountId: "codex-spare",
    reason: "switch",
    scheduleId: timer.structuredContent!.scheduleId,
  });
  expect(result.isError).toBe(true);
  expect(text(result)).toContain("may switch claude only");
  expect(switches).toHaveLength(0);
});

test.each(["mail", "timer", "status-wake"])(
  "%s dispatch revokes user authority before provider execution and through lost-ack reconciliation",
  async (source) => {
    await storage.addProject({ ...createProject("remote", dataDir), id: PROJECT });
    const createdAt = new Date().toISOString();
    await storage.coordinators.mutateCoordinatorWorkspace(PROJECT, () => ({
      ...initialWorkspace(),
      version: COORDINATOR_WORKSPACE_VERSION,
      executionPolicy: COORDINATOR_EXECUTION_POLICY,
      createdAt,
      updatedAt: createdAt,
      selectedConversationId: "main-1",
      repositoryContextRevision: 0,
      conversations: [
        {
          ...initialWorkspace().conversations[0]!,
          agent: "codex",
          title: "Coordinator",
          createdAt,
          logicalSessionKey: "coordinator-coordinator-1:main-1",
        },
      ],
    }));
    const base = {
      environmentId: coordinatorRuntimeId("coordinator-1", "main-1"),
      logicalSessionKey: "coordinator-coordinator-1:main-1",
      agent: "codex" as const,
    };
    let loseAck = false;
    let sends = 0;
    const refusedGrant = async () => {
      currentWorkspace = (await storage.coordinators.getCoordinatorWorkspace(PROJECT))!;
      const result = await call("main", "create_schedule", {
        requestId: `grant-${source}`,
        at: "+1h",
        action: {
          type: "remind_me",
          body: "switch",
          authorizeAccountSwitch: { platforms: ["claude"], userInstruction: "switch" },
        },
      });
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("user started");
    };
    const provider = {
      agent: "codex",
      createSession: async () => "provider-session",
      registerSession: () => {},
      send: async () => {
        sends++;
        if (loseAck) {
          await refusedGrant();
          throw new AmbiguousPromptDispatchError("Acknowledgement lost");
        }
      },
      status: async () => "idle",
      activity: async () => "idle",
      messages: async () => [],
      dispatchStatus: async () => "dispatched",
      dispose: async () => {},
    } as unknown as NativeAgentRuntimeProvider;
    const native = new NativeAgentService(storage, invoke, { provider: async () => provider });
    const mutate = storage.coordinators.mutateCoordinatorWorkspace.bind(storage.coordinators);
    try {
      const user = await native.dispatchPrompt({
        ...base,
        requestId: "user",
        prompt: "Check later",
      });
      collaborators(native).launches.recordObservedActivity(user.key, {
        providerSessionId: user.providerSessionId,
        state: "idle",
      });
      loseAck = true;
      // A delayed authority write must hold dispatch, and a failed write must
      // prevent the non-user turn from reaching the provider at all.
      let entered!: () => void;
      let release!: () => void;
      const enteredWrite = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const write = spyOn(storage.coordinators, "mutateCoordinatorWorkspace").mockImplementation(
        async () => {
          entered();
          await blocked;
          throw new Error("workspace unavailable");
        },
      );
      const failed = native.dispatchMailInject({ ...base, requestId: "failed", prompt: source });
      await enteredWrite;
      expect(sends).toBe(1);
      release();
      expect(await failed).toMatchObject({ outcome: "rejected" });
      expect(sends).toBe(1);
      write.mockRestore();
      // Retry with working storage. The provider accepts but loses the reply.
      expect(
        await native.dispatchMailInject({ ...base, requestId: "lost", prompt: source }),
      ).toMatchObject({ outcome: "unknown" });
      await refusedGrant();
      // Retrying the parked mail through the user endpoint cannot promote it.
      await expect(
        native.dispatchPrompt({ ...base, requestId: "lost", prompt: source }),
      ).rejects.toBeInstanceOf(AmbiguousPromptDispatchError);
      await refusedGrant();
      expect(await native.reconcileMailInject({ ...base, requestId: "lost" })).toBe("dispatched");
      await refusedGrant();
      expect(service.list({ kind: "operator" })).toHaveLength(0);
    } finally {
      storage.coordinators.mutateCoordinatorWorkspace = mutate;
      await native.shutdown();
    }
  },
);
