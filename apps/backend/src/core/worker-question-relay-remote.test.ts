import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import path from "node:path";
import type { AgentInteractionRequest } from "@orkestrator/protocol/agent-interactions";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { coordinatorRoleCapabilities, type CoordinatorControlScope } from "./control-mcp-tools.js";
import { ControlMcpServer } from "./control-mcp-server.js";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { BackendRuntime } from "./backend-runtime.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { NodeCoordination } from "./nodes/node-coordination.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

// A worker on another node: real MCP dispatch, scope checks, receipts, the
// request and its executor on the command node, and the controller command on
// the leaf; only the node transport is simulated, and it can lose an answer.

let world: MailWorld;
let mcp: ControlMcpServer;
let leaf: StorageService;
let leafContext: CommandContext;
let rootContext: CommandContext;
let coordination: NodeCoordination;
let commands: Map<string, CommandHandler>;
let scope: CoordinatorControlScope;
let leafProjectId: string;
let workerId: string;
let routed: string[];
let pending: AgentInteractionRequest[];
let resolve: ReturnType<typeof mock>;
const loseAnswer = new Set<string>();

const question = (): AgentInteractionRequest => ({
  version: 1,
  id: "q-remote",
  provider: "codex",
  kind: "question",
  origin: "interactive-native",
  sessionId: "leaf-session",
  state: "pending",
  revision: 4,
  createdAt: 1,
  updatedAt: 1,
  presentation: {
    title: "Release channel",
    questions: [
      {
        id: "channel",
        prompt: "Ship to which channel?",
        required: true,
        multiple: false,
        secret: false,
        allowFreeText: false,
        options: [
          { id: "beta", label: "Beta", providerValue: "beta" },
          { id: "stable", label: "Stable", providerValue: "stable" },
        ],
      },
    ],
  },
});

beforeEach(async () => {
  world = await MailWorld.create();
  await world.storage.updateProject(world.projectId, {
    gitUrl: "https://github.com/acme/site.git",
  });
  leaf = new StorageService(path.join(world.root, "leaf"));
  await leaf.init();
  const project = await leaf.addProject(
    createProject("https://github.com/acme/site.git", world.root),
  );
  leafProjectId = project.id;
  const worker = createEnvironment(project.id, { name: "remote-worker", environmentType: "local" });
  Object.assign(worker, { status: "running", setupPhase: "ready", worktreePath: world.root });
  await leaf.addEnvironment(worker);
  workerId = worker.id;
  await leaf.savePaneLayout(
    workerId,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "left",
      root: {
        kind: "leaf",
        id: "left",
        activeTabId: "agent-1",
        tabs: [
          {
            id: "agent-1",
            type: "agent-native",
            displayTitle: "Codex 1",
            nativeAgentData: { platform: "codex" },
          },
        ],
      },
    } as never,
    0,
  );
  pending = [question()];
  resolve = mock(async () => ({ result: "applied" }));
  leafContext = {
    storage: leaf,
    emit: () => undefined,
    appRoot: "",
    resourceRoot: "",
    environmentLifecycleTasks: {},
    runtime: new BackendRuntime({ emit: () => undefined }),
    nativeAgents: { sessionPendingInteractions: async () => pending },
  } as unknown as CommandContext;
  commands = createCommandRegistry();
  commands.set("get_native_agent_projection", (async () => ({
    interactions: pending,
  })) as CommandHandler);
  commands.set("resolve_native_agent_interaction", resolve as unknown as CommandHandler);
  routed = [];
  loseAnswer.clear();
  const nodePortal = {
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
    readModel: { onNodeEvent: () => () => undefined },
    invokeOnNode: async ({ command, args }: { command: string; args: Record<string, unknown> }) => {
      routed.push(command);
      const result = await commands.get(command)!(args, leafContext);
      if (loseAnswer.delete(command)) return { outcome: "unknown" };
      return { outcome: "ok", result };
    },
  };
  rootContext = {
    storage: world.storage,
    coordinators: world.coordinator,
    nodes: { status: async () => ({ nodeId: "bk_command", mode: "command" }) },
    nodePortal,
  } as unknown as CommandContext;
  coordination = new NodeCoordination({
    storage: world.storage,
    nodes: {
      listControllers: () => [],
      mostRecentControllerId: () => undefined,
      selfIdentity: async () => "bk_command",
      link: () => null,
      getNode: async () => ({ displayName: "node" }),
      subscribe: () => () => undefined,
      listNodes: async () => ({ nodes: [] }),
    } as never,
    portal: nodePortal as never,
    invoke: (async (command: string, args: Record<string, unknown>) =>
      commands.get(command)!(args, rootContext)) as never,
    emit: () => undefined,
  });
  rootContext.nodeCoordination = coordination;
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
  coordination.collector.dispose();
  await mcp.stop();
  await world.close();
});

const propose = (requestId: string) =>
  mcp.callCoordinatorTool(scope, "answer_worker_question", {
    requestId,
    nodeId: "bk_leaf",
    environmentId: workerId,
    tabId: "agent-1",
    interactionId: "q-remote",
    answers: [{ questionId: "channel", optionIds: ["beta"] }],
    reason: "The user said beta first",
  });

const approve = (requestId: string) =>
  commands.get("resolve_node_action_request")!(
    { requestId, decision: "approve" },
    rootContext,
  ) as Promise<Record<string, unknown>>;

test("a worker on another node gets the approved answer once, through its controller command", async () => {
  const proposed = await propose("remote-answer");
  expect(proposed.isError).not.toBe(true);
  const approvalRequestId = String(proposed.structuredContent?.approvalRequestId);
  // Reading the question crossed the link; answering did not.
  expect(routed).toContain("get_native_agent_projection");
  expect(routed).not.toContain("answer_controller_worker_question");
  expect(resolve).not.toHaveBeenCalled();
  const [request] = await coordination.actions.list({ pendingOnly: true });
  expect(request).toMatchObject({
    kind: "answer-worker-question",
    targets: [{ nodeId: "bk_leaf", nodeName: "Build node", projectId: leafProjectId }],
    workerQuestion: { tabName: "Codex 1", revision: 4 },
  });
  const resolved = await approve(approvalRequestId);
  expect(resolved).toMatchObject({ state: "executed", result: { code: "answered" } });
  expect(String((resolved.result as { message: string }).message)).toContain("on Build node");
  expect(routed.filter((command) => command === "answer_controller_worker_question")).toHaveLength(
    1,
  );
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(resolve.mock.calls[0]![0]).toMatchObject({
    environmentId: workerId,
    agent: "codex",
    interactionId: "q-remote",
    resolution: { answer: { answers: [{ questionId: "channel", optionIds: ["beta"] }] } },
  });
});

test("an answer lost on the node link settles outcome-unknown and is never resent", async () => {
  const proposed = await propose("remote-lost");
  loseAnswer.add("answer_controller_worker_question");
  const resolved = await approve(String(proposed.structuredContent?.approvalRequestId));
  expect(resolved.state).toBe("outcome-unknown");
  expect(routed.filter((command) => command === "answer_controller_worker_question")).toHaveLength(
    1,
  );
});

test("a remote question answered meanwhile settles stale and nothing is sent", async () => {
  const proposed = await propose("remote-stale");
  pending = [];
  const resolved = await approve(String(proposed.structuredContent?.approvalRequestId));
  expect(resolved).toMatchObject({ state: "stale", result: { code: "stale" } });
  expect(resolve).not.toHaveBeenCalled();
});
