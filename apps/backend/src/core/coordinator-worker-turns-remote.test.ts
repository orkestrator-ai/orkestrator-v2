import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import path from "node:path";
import type { NativeAgentSlashCommand } from "@orkestrator/protocol/native-agent";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { ControlMcpServer } from "./control-mcp-server.js";
import { coordinatorRoleCapabilities, type CoordinatorControlScope } from "./control-mcp-tools.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

// A command node's coordinator stopping a turn and running a slash command in
// a worker on a connected node: real MCP dispatch, scope checks, receipts,
// delegations and controller commands on both nodes. Only the node transport
// (which can lose one answer after the node ran the command), the leaf's
// native agent and the leaf's record of where a worker reports are simulated.

let world: MailWorld;
let mcp: ControlMcpServer;
let leaf: StorageService;
let scope: CoordinatorControlScope;
let workerId: string;
let routed: string[];
let activity: "idle" | "working";
let dispatches: Array<Record<string, unknown>>;
let stops: number;
const loseAnswer = new Set<string>();

const tool = (name: string, input: Record<string, unknown>) =>
  mcp.callCoordinatorTool(scope, name, { nodeId: "bk_leaf", ...input });

const COMMANDS: NativeAgentSlashCommand[] = [
  {
    name: "/review",
    source: "project",
    id: "codex:/review",
    executionKind: "structured-skill",
    bindingRevision: "rev-review",
  },
];

beforeEach(async () => {
  world = await MailWorld.create();
  await world.storage.updateProject(world.projectId, {
    gitUrl: "https://github.com/acme/site.git",
  });
  leaf = new StorageService(path.join(world.root, "leaf"));
  await leaf.init();
  const project = await leaf.addProject(
    createProject("https://github.com/acme/site.git", path.join(world.root, "checkout")),
  );
  const worker = createEnvironment(project.id, { name: "remote-worker", environmentType: "local" });
  Object.assign(worker, {
    status: "running",
    setupPhase: "ready",
    setupScriptsComplete: true,
    worktreePath: world.root,
  });
  await leaf.addEnvironment(worker);
  workerId = worker.id;
  await leaf.savePaneLayout(
    workerId,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "pane",
      root: {
        kind: "leaf",
        id: "pane",
        tabs: [
          { id: "agent", type: "agent-native", nativeAgentData: { platform: "codex" } },
          { id: "shell", type: "plain" },
        ],
        activeTabId: "agent",
      },
    },
    0,
  );
  // The leaf's session record; its native agent is scripted below.
  spyOn(leaf, "getNativeAgentSession").mockImplementation(
    async (key: string) =>
      ({
        key,
        environmentId: workerId,
        agent: "codex",
        logicalSessionKey: `env-${workerId}:agent`,
        providerSessionId: "thread-1",
      }) as never,
  );
  activity = "working";
  dispatches = [];
  stops = 0;
  const leafContext = {
    storage: leaf,
    emit: () => undefined,
    appRoot: "",
    resourceRoot: "",
    environmentLifecycleTasks: {},
    runtime: new BackendRuntime({ emit: () => undefined }),
    nativeAgents: {
      sessionTurnActivitySnapshot: () => activity,
      cachedProjectionSnapshot: () => ({
        slashCommands: COMMANDS,
        slashCommandCatalogue: { status: "ready", revision: 1 },
      }),
      stopProjectionSession: async () => {
        stops += 1;
        activity = "idle";
        return { turn: { phase: "idle" } };
      },
      dispatchIntent: async (input: Record<string, unknown>) => {
        dispatches.push(input);
        return { outcome: "accepted", requestId: input.requestId };
      },
    },
  } as unknown as CommandContext;
  const commands = createCommandRegistry();
  routed = [];
  loseAnswer.clear();
  const rootContext = {
    storage: world.storage,
    coordinators: world.coordinator,
    nodes: { status: async () => ({ nodeId: "bk_command", mode: "command" }) },
    nodePortal: {
      summaries: async () => ({
        selfId: "bk_command",
        nodes: [
          {
            nodeId: "bk_leaf",
            available: true,
            view: { displayName: "Build node" },
            projects: [{ ref: { projectId: project.id }, repositoryHint: "github.com/acme/site" }],
          },
        ],
      }),
      invokeOnNode: async ({
        command,
        args,
      }: {
        command: string;
        args: Record<string, unknown>;
      }) => {
        routed.push(command);
        // The leaf's node coordination (where the worker reports) is not under test.
        if (command === "record_node_environment_origin") return { outcome: "ok", result: {} };
        const handler = commands.get(command) as CommandHandler;
        const result = await handler(args, leafContext);
        if (loseAnswer.delete(command)) return { outcome: "unknown" };
        return { outcome: "ok", result };
      },
    },
  } as unknown as CommandContext;
  mcp = new ControlMcpServer(
    world.root,
    async <T>(command: string, args = {}) => (await commands.get(command)!(args, rootContext)) as T,
  );
  const snapshot = await world.coordinator.ensure(world.projectId);
  const conversation = snapshot.workspace.conversations[0]!;
  scope = {
    role: "coordinator",
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: conversation.id,
    mailboxIncarnationId: conversation.mailboxIncarnationId!,
    capabilities: coordinatorRoleCapabilities("main"),
  };
});

afterEach(async () => {
  await mcp.stop();
  await world.close();
});

/** A delegation this command node keeps for the remote worker's tab. */
async function remoteDelegation(requestId: string) {
  const association = await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: `remote-${requestId}`,
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: scope.conversationId,
    kind: "environment",
    resourceId: workerId,
    nodeId: "bk_leaf",
    requestId: `delegation:${requestId}`,
    createdAt: new Date().toISOString(),
  });
  await world.storage.coordinators.openCoordinatorDelegation(association.id, "agent");
  return association.id;
}

async function delegation(id: string) {
  return (
    await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)
  ).find((association) => association.id === id)?.delegation;
}

test("a remote stop runs on the node, marks the open delegation, and survives a lost answer", async () => {
  const id = await remoteDelegation("job");
  const input = { requestId: "stop", environmentId: workerId, tabId: "agent" };
  loseAnswer.add("stop_controller_worker_turn");
  const lost = await tool("stop_worker_turn", input);
  expect(lost.isError).toBe(true);
  expect(lost.text).toContain("outcome is unknown");
  expect(lost.text).toContain("get_tab_state");
  // The node did stop it; the mark stays so the wake says who stopped it.
  expect(stops).toBe(1);
  expect((await delegation(id))?.stopRequestedAt).toBeString();
  // Retried: the tab is idle now, which is an answer, and nothing is unmarked
  // that the first attempt may have earned.
  const retried = await tool("stop_worker_turn", input);
  expect(retried.isError).toBe(false);
  expect(retried.structuredContent).toMatchObject({ nodeId: "bk_leaf", stopped: false });
  expect(stops).toBe(1);
  expect(routed.filter((command) => command === "stop_controller_worker_turn")).toHaveLength(2);
});

test("a confirmed remote stop reports the waiting delegation", async () => {
  const id = await remoteDelegation("job-2");
  const stopped = await tool("stop_worker_turn", {
    requestId: "stop-2",
    environmentId: workerId,
    tabId: "agent",
  });
  expect(stopped.isError).toBe(false);
  expect(stopped.structuredContent).toMatchObject({
    nodeId: "bk_leaf",
    stopped: true,
    acknowledged: true,
    delegationOpen: true,
    delivery: "async",
  });
  expect((await delegation(id))?.stopRequestedAt).toBeString();
  // An idle answer leaves a later delegation unmarked.
  await world.storage.coordinators.closeCoordinatorDelegation(id, "completed");
  const other = await remoteDelegation("job-3");
  const idle = await tool("stop_worker_turn", {
    requestId: "stop-3",
    environmentId: workerId,
    tabId: "agent",
  });
  expect(idle.structuredContent).toMatchObject({ stopped: false });
  expect((await delegation(other))?.stopRequestedAt).toBeUndefined();
});

test("remote terminal tabs and the node's project checkout are refused", async () => {
  const shell = await tool("stop_worker_turn", {
    requestId: "shell",
    environmentId: workerId,
    tabId: "shell",
  });
  expect(shell.isError).toBe(true);
  expect(shell.text).toContain("terminal tab, not a native agent tab");
  const home = createEnvironment((await leaf.getEnvironment(workerId))!.projectId, {
    name: "home",
    environmentType: "local",
  });
  Object.assign(home, { status: "running", setupPhase: "ready", projectHome: true });
  await leaf.addEnvironment(home);
  const refused = await tool("stop_worker_turn", {
    requestId: "home",
    environmentId: home.id,
    tabId: "agent",
  });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("project checkout");
  expect(stops).toBe(0);
});

test("a remote slash command runs once across a lost answer and opens a delegation here", async () => {
  activity = "idle";
  const listed = await tool("list_worker_commands", { environmentId: workerId, tabId: "agent" });
  expect(listed.isError).toBe(false);
  expect(listed.structuredContent).toMatchObject({ nodeId: "bk_leaf" });
  expect(JSON.stringify(listed.structuredContent)).toContain("codex:/review");
  const input = {
    requestId: "review",
    environmentId: workerId,
    tabId: "agent",
    command: "review",
    arguments: "the branch",
  };
  loseAnswer.add("run_controller_worker_command");
  const lost = await tool("run_worker_command", input);
  expect(lost.isError).toBe(true);
  expect(lost.text).toContain("same requestId");
  const retried = await tool("run_worker_command", input);
  expect(retried.isError).toBe(false);
  expect(retried.structuredContent).toMatchObject({
    nodeId: "bk_leaf",
    commandId: "codex:/review",
    startsTurn: true,
    delegationOpened: true,
    delivery: "async",
  });
  // Both attempts carried the same dispatch identity, so the leaf's journal replays.
  expect(dispatches).toHaveLength(2);
  expect(dispatches[0]!.requestId).toBe(dispatches[1]!.requestId);
  expect(String(dispatches[0]!.requestId)).toStartWith("coordinator-command:");
  expect(dispatches[0]).toMatchObject({
    prompt: "/review the branch",
    command: { kind: "selected", commandId: "codex:/review", bindingRevision: "rev-review" },
  });
  const open = (await world.storage.coordinators.listOpenCoordinatorDelegations()).filter(
    (association) => association.nodeId === "bk_leaf" && association.resourceId === workerId,
  );
  expect(open).toHaveLength(1);
});
