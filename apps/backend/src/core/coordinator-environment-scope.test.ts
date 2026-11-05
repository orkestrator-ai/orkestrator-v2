import { afterEach, beforeEach, expect, test } from "bun:test";
import path from "node:path";
import {
  COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL,
  COORDINATOR_OTHER_ENVIRONMENTS_SETTING_LABEL,
} from "@orkestrator/protocol/coordinator";
import { renderAgentMailCarrier } from "@orkestrator/protocol/agent-mail";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { BackendRuntime } from "./backend-runtime.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import {
  COORDINATOR_ENVIRONMENT_ACTIONS,
  COORDINATOR_ENVIRONMENT_CHECKED_BY_COMMAND,
  COORDINATOR_ENVIRONMENT_READS,
  COORDINATOR_ENVIRONMENT_USER_APPROVED,
} from "./control-mcp-coordinator-environment-scope.js";
import { ControlMcpServer } from "./control-mcp-server.js";
import { rpc } from "./control-mcp-server-test-support.js";
import { coordinatorRoleCapabilities, type CoordinatorControlScope } from "./control-mcp-tools.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

// Real MCP dispatch and commands over real stores. Only the node link is
// simulated. The world starts with the project's setting at its default, off.

const LEAF = "bk_leaf";
const BASE = "a".repeat(40);

let world: MailWorld;
let mcp: ControlMcpServer;
let leaf: StorageService;
let leafContext: CommandContext;
let rootContext: CommandContext;
let commands: Map<string, CommandHandler>;
let scope: CoordinatorControlScope;
let handMade: string;
let handMadeActor: Awaited<ReturnType<MailWorld["addEnvironment"]>>;
let leafWorkerId: string;
let routed: string[];

const refused = (result: { isError: boolean; text: string }) => {
  expect(result.isError).toBe(true);
  expect(result.text).toBe(COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL);
};

beforeEach(async () => {
  world = await MailWorld.create({ coordinatorOtherEnvironments: false });
  await world.storage.updateProject(world.projectId, {
    gitUrl: "https://github.com/acme/site.git",
  });
  leaf = new StorageService(path.join(world.root, "leaf"));
  await leaf.init();
  const leafProject = await leaf.addProject(
    createProject("https://github.com/acme/site.git", world.root),
  );
  const leafWorker = createEnvironment(leafProject.id, {
    name: "leaf-worker",
    environmentType: "local",
  });
  Object.assign(leafWorker, { status: "running", setupPhase: "ready", worktreePath: world.root });
  await leaf.addEnvironment(leafWorker);
  leafWorkerId = leafWorker.id;
  leafContext = {
    storage: leaf,
    emit: () => undefined,
    appRoot: "",
    resourceRoot: "",
    environmentLifecycleTasks: {},
    runtime: new BackendRuntime({ emit: () => undefined }),
  } as unknown as CommandContext;
  commands = createCommandRegistry();
  routed = [];
  rootContext = {
    storage: world.storage,
    coordinators: world.coordinator,
    nodes: {
      status: async () => ({ nodeId: "bk_command", mode: "command" }),
      link: () => undefined,
    },
    nodePortal: {
      summaries: async () => ({
        selfId: "bk_command",
        nodes: [
          {
            nodeId: LEAF,
            available: true,
            view: { displayName: "Build node" },
            projects: [
              { ref: { projectId: leafProject.id }, repositoryHint: "github.com/acme/site" },
            ],
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
        const handler = commands.get(command);
        if (!handler) throw new Error(unknownBackendCommandMessage(command));
        return { outcome: "ok", result: await handler(args, leafContext) };
      },
    },
    runtime: new BackendRuntime({ emit: () => undefined }),
  } as unknown as CommandContext;
  mcp = new ControlMcpServer(
    world.root,
    async <T>(command: string, args = {}) => (await commands.get(command)!(args, rootContext)) as T,
    { port: 0 },
  );
  await world.storage.updateGlobalConfig({
    ...(await world.storage.loadConfig()).global,
    enabledAgentPlatforms: ["codex", "claude"],
  });
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
  handMadeActor = await world.addEnvironment("hand-made");
  handMade = handMadeActor.environmentId;
});

afterEach(async () => {
  await mcp.stop();
  await world.close();
});

const tool = (name: string, input: Record<string, unknown>) =>
  mcp.callCoordinatorTool(scope, name, input);

const message = (toEnvironmentId: string, extra: Record<string, unknown> = {}) => ({
  requestId: crypto.randomUUID(),
  toEnvironmentId,
  body: "Run this",
  ...extra,
});

const allowOthers = () =>
  world.storage.patchRepositorySettings(world.projectId, { coordinatorOtherEnvironments: true });

/** What a launch records: the record that makes the coordinator the creator. */
const launched = (environmentId: string, extra: Record<string, unknown> = {}) =>
  world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: crypto.randomUUID(),
    projectId: scope.projectId,
    coordinatorId: scope.coordinatorId,
    conversationId: scope.conversationId,
    kind: "environment",
    resourceId: environmentId,
    requestId: `launch:${environmentId}`,
    baseBranch: "main",
    baseCommit: BASE,
    createdAt: new Date().toISOString(),
    ...extra,
  });

/** Every tool the check applies to, with input its schema accepts. */
function actions(environmentId: string): Record<string, Record<string, unknown>> {
  const request = { requestId: crypto.randomUUID(), environmentId };
  const tab = { environmentId, tabId: "agent" };
  return {
    launch_job: { ...request, prompt: "Run this" },
    send_prompt_to_tab: { ...request, tabId: "agent", prompt: "Run this" },
    launch_terminal: { ...request, command: "bun test" },
    open_worker_browser: { ...request, url: "http://127.0.0.1:3000/" },
    edit_worker_tab: { ...tab, operation: "close" },
    stop_worker_turn: { ...request, tabId: "agent" },
    run_worker_command: { ...request, tabId: "agent", command: "/review" },
    set_worker_goal: { ...request, tabId: "agent", objective: "Finish", maxIterations: 2 },
    pause_worker_goal: tab,
    clear_worker_goal: tab,
    fork_worker: request,
    start_environment: { environmentId },
    stop_environment: { environmentId },
    create_pr: request,
    resolve_conflicts: request,
    launch_multi_review: request,
    start_build_pipeline: {
      requestId: crypto.randomUUID(),
      baseBranch: "main",
      baseCommit: BASE,
      taskId: "1",
      taskTitle: "Build",
      taskSnapshot: { title: "Build", description: "Build it", acceptanceCriteria: "Built" },
      existingEnvironmentId: environmentId,
    },
    launch_graph: {
      requestId: crypto.randomUUID(),
      template: { scope: "user", id: "nightly" },
      environment: { kind: "existing", environmentId },
    },
    transfer_files: {
      from: { nodeId: "bk_command", projectRoot: true },
      to: { nodeId: "bk_command", environmentId },
      files: ["x.txt"],
    },
  };
}

test("every tool that acts on an environment is covered by these cases", () => {
  expect(Object.keys(actions("e")).sort()).toEqual(
    [...COORDINATOR_ENVIRONMENT_ACTIONS.keys()].sort(),
  );
});

test("every coordinator tool that names an environment has chosen how it stands", async () => {
  await mcp.start();
  const { url, token } = mcp.issueCoordinatorCredential(scope);
  const { body } = await rpc(url, token, "tools/list");
  const names = (schema: unknown): boolean => {
    if (!schema || typeof schema !== "object") return false;
    return Object.entries(schema as Record<string, unknown>).some(
      ([key, value]) => /environmentId$/i.test(key) || key === "environment" || names(value),
    );
  };
  const unclassified = (body.result?.tools ?? [])
    .filter((listed) => names(listed.inputSchema?.properties))
    .map((listed) => listed.name)
    .filter(
      (name) =>
        !COORDINATOR_ENVIRONMENT_ACTIONS.has(name) &&
        !COORDINATOR_ENVIRONMENT_CHECKED_BY_COMMAND.has(name) &&
        !COORDINATOR_ENVIRONMENT_READS.has(name) &&
        !COORDINATOR_ENVIRONMENT_USER_APPROVED.has(name),
    );
  expect(unclassified).toEqual([]);
  // The lists do name real tools: nothing here is a leftover.
  const listed = new Set((body.result?.tools ?? []).map((item) => item.name));
  for (const name of COORDINATOR_ENVIRONMENT_READS)
    expect({ name, listed: listed.has(name) }).toEqual({ name, listed: true });
});

test("the refusal names the setting as Project Settings shows it", () => {
  expect(COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL).toContain(
    COORDINATOR_OTHER_ENVIRONMENTS_SETTING_LABEL,
  );
  expect(COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL).toContain("this project's settings");
});

test("mail to an environment this coordinator did not create is refused by default", async () => {
  refused(await tool("send_message", message(handMade)));
  expect(await world.undelivered(handMadeActor)).toHaveLength(0);
});

test("each tool that acts on an environment is refused on one it did not create", async () => {
  for (const [name, input] of Object.entries(actions(handMade))) {
    const result = await tool(name, input);
    expect({ name, text: result.text }).toEqual({
      name,
      text: COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL,
    });
  }
});

test("mail and tools to an environment on another node are refused the same way", async () => {
  refused(await tool("send_message", message(leafWorkerId, { nodeId: LEAF })));
  refused(
    await tool("send_prompt_to_tab", {
      requestId: "prompt",
      environmentId: leafWorkerId,
      tabId: "agent",
      prompt: "Run this",
      nodeId: LEAF,
    }),
  );
  expect(routed).not.toContain("deliver_node_mail");
  expect(routed).not.toContain("dispatch_native_agent_intent");
});

test("with the setting on, the same calls pass the check", async () => {
  await allowOthers();
  const sent = await tool("send_message", message(handMade));
  expect(sent.isError).toBe(false);
  for (const [name, input] of Object.entries(actions(handMade))) {
    const result = await tool(name, input);
    expect({ name, refused: result.text === COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL }).toEqual({
      name,
      refused: false,
    });
  }
  const remote = await tool("send_message", message(leafWorkerId, { nodeId: LEAF }));
  expect(remote.text).not.toBe(COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL);
});

test("turning the setting off again refuses again: nothing sticks", async () => {
  await allowOthers();
  expect((await tool("send_message", message(handMade))).isError).toBe(false);
  await world.storage.patchRepositorySettings(world.projectId, {}, [
    "coordinatorOtherEnvironments",
  ]);
  refused(await tool("send_message", message(handMade)));
});

test("an environment this coordinator launched passes", async () => {
  await launched(handMade);
  expect((await tool("send_message", message(handMade))).isError).toBe(false);
  const result = await tool("stop_environment", { environmentId: handMade });
  expect(result.text).not.toBe(COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL);
});

test("its own worker on another node passes", async () => {
  await launched(leafWorkerId, { nodeId: LEAF });
  const result = await tool("send_message", message(leafWorkerId, { nodeId: LEAF }));
  expect(result.text).not.toBe(COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL);
  expect(routed).toContain("deliver_node_mail");
});

test("an id launched on one node does not pass for another", async () => {
  await launched(handMade, { nodeId: LEAF });
  refused(await tool("send_message", message(handMade)));
});

test("a main conversation keeps its workers after takeover from a side agent", async () => {
  const side = await world.addSide();
  const conversationId = String((side as { conversationId?: string }).conversationId);
  const association = await launched(handMade, { conversationId });
  // Mail from the main passes while a side agent holds the record...
  expect((await tool("send_message", message(handMade))).isError).toBe(false);
  // ...and after the backend moves it back with `force`.
  await world.storage.coordinators.adoptCoordinatorWorkflowAssociation(
    scope.projectId,
    scope.coordinatorId,
    association.id,
    scope.conversationId,
    { force: true },
  );
  expect((await tool("send_message", message(handMade))).isError).toBe(false);
});

test("a workflow adopted from a closed conversation passes", async () => {
  const association = await launched(handMade, { conversationId: "closed-conversation" });
  const adopted = (await commands.get("adopt_coordinator_workflow")!(
    {
      projectId: scope.projectId,
      coordinatorId: scope.coordinatorId,
      conversationId: scope.conversationId,
      associationId: association.id,
    },
    rootContext,
  )) as { conversationId?: string };
  expect(adopted.conversationId).toBe(scope.conversationId);
  expect((await tool("send_message", message(handMade))).isError).toBe(false);
});

test("a build pipeline this coordinator started makes its environment its own", async () => {
  await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: crypto.randomUUID(),
    projectId: scope.projectId,
    coordinatorId: scope.coordinatorId,
    conversationId: scope.conversationId,
    kind: "build-pipeline",
    resourceId: "pipeline-1",
    requestId: "pipeline-1",
    createdAt: new Date().toISOString(),
  });
  refused(await tool("send_message", message(handMade)));
  await world.storage.saveBuildPipeline("pipeline-1", world.projectId, handMade, 1, {
    id: "pipeline-1",
    projectId: world.projectId,
    environmentId: handMade,
  } as never);
  expect((await tool("send_message", message(handMade))).isError).toBe(false);
});

test("a review this coordinator holds makes its environment its own", async () => {
  await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: crypto.randomUUID(),
    projectId: scope.projectId,
    coordinatorId: scope.coordinatorId,
    conversationId: "closed-conversation",
    kind: "multi-review",
    resourceId: "review-1",
    requestId: "review-1",
    createdAt: new Date().toISOString(),
  });
  refused(await tool("send_message", message(handMade)));
  await world.storage.saveMultiReviewWorkflow("review-1", handMade, 1, {
    id: "review-1",
    environmentId: handMade,
    projectId: world.projectId,
  } as never);
  expect((await tool("send_message", message(handMade))).isError).toBe(false);
});

test("an older environment with no stored origin is treated as not this coordinator's", async () => {
  // No record at all.
  refused(await tool("send_message", message(handMade)));
  // Only a delegation: asking an environment something does not make it yours,
  // and a user's own environment looks exactly the same.
  await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: crypto.randomUUID(),
    projectId: scope.projectId,
    coordinatorId: scope.coordinatorId,
    conversationId: scope.conversationId,
    kind: "environment",
    resourceId: handMade,
    requestId: "delegation:older",
    createdAt: new Date().toISOString(),
  });
  refused(await tool("send_message", message(handMade)));
  // A launch of another project's coordinator proves nothing here either.
  await launched(handMade, { coordinatorId: "another-coordinator" });
  refused(await tool("send_message", message(handMade)));
  // The way out the refusal names.
  await allowOthers();
  expect((await tool("send_message", message(handMade))).isError).toBe(false);
});

test("reads stay available: only sending work is refused", async () => {
  const environment = await tool("get_environment", { environmentId: handMade });
  expect(environment.isError).toBe(false);
  const tabs = await tool("list_tabs", { environmentId: handMade });
  expect(tabs.isError).toBe(false);
});

test("the project home keeps its own rule, not this one", async () => {
  const home = createEnvironment(world.projectId, { name: "home", environmentType: "local" });
  Object.assign(home, { status: "running", setupPhase: "ready", projectHome: true });
  await world.storage.addEnvironment(home);
  const result = await tool("send_message", message(home.id));
  expect(result.isError).toBe(true);
  expect(result.text).toContain("projectHomeReason");
  expect(result.text).not.toContain(COORDINATOR_OTHER_ENVIRONMENTS_SETTING_LABEL);
});

test("the coordinator's listing marks the project home, and only the home", async () => {
  const home = createEnvironment(world.projectId, { name: "home", environmentType: "local" });
  Object.assign(home, { status: "running", setupPhase: "ready", projectHome: true });
  await world.storage.addEnvironment(home);
  const listed = await tool("list_environments", {});
  const rows = (listed.structuredContent?.environments ?? []) as Array<Record<string, unknown>>;
  expect(rows.find((row) => row.id === home.id)?.projectHome).toBe(true);
  expect(rows.find((row) => row.id === handMade)).toBeDefined();
  expect("projectHome" in rows.find((row) => row.id === handMade)!).toBe(false);
});

test("a side agent cannot adopt a workflow; a backend takeover still moves it", async () => {
  const side = await world.addSide();
  const conversationId = String((side as { conversationId?: string }).conversationId);
  const association = await launched(handMade, { conversationId: "closed-conversation" });
  await expect(
    commands.get("adopt_coordinator_workflow")!(
      {
        projectId: scope.projectId,
        coordinatorId: scope.coordinatorId,
        conversationId,
        associationId: association.id,
      },
      rootContext,
    ),
  ).rejects.toThrow("A side agent cannot adopt workflows");
  const moved = await world.storage.coordinators.adoptCoordinatorWorkflowAssociation(
    scope.projectId,
    scope.coordinatorId,
    association.id,
    scope.conversationId,
    { force: true },
  );
  expect(moved.conversationId).toBe(scope.conversationId);
});

async function setLastTurnOrigin(origin: "user" | "mail" | undefined): Promise<void> {
  await world.storage.coordinators.mutateCoordinatorWorkspace(world.projectId, (workspace) => ({
    ...workspace!,
    conversations: workspace!.conversations.map((conversation) =>
      conversation.id === scope.conversationId
        ? { ...conversation, lastTurnOrigin: origin }
        : conversation,
    ),
  }));
}

async function deliveredFrom(requestId: string) {
  const sent = await tool("send_message", message(handMade, { requestId }));
  expect(sent.isError).toBe(false);
  return (await world.undelivered(handMadeActor)).at(-1)!;
}

test("mail from a turn the user did not start says it arose from agent mail", async () => {
  await launched(handMade);
  await setLastTurnOrigin("mail");
  const message = await deliveredFrom("from-mail");
  expect(message.from).toMatchObject({ kind: "coordinator", turnOrigin: "mail" });
  expect(renderAgentMailCarrier(message)).toContain("arose from agent mail");
  expect(renderAgentMailCarrier(message)).toContain("not from your user's instruction");
});

test("a conversation with no recorded turn origin is not the user's either", async () => {
  await launched(handMade);
  await setLastTurnOrigin(undefined);
  const message = await deliveredFrom("from-unknown");
  expect(renderAgentMailCarrier(message)).toContain("arose from agent mail");
});

test("a user-started turn's mail is unchanged", async () => {
  await launched(handMade);
  await setLastTurnOrigin("user");
  const message = await deliveredFrom("from-user");
  expect("turnOrigin" in message.from).toBe(false);
  expect(renderAgentMailCarrier(message)).not.toContain("arose from agent mail");
});
