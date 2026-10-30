import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import path from "node:path";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { coordinatorRoleCapabilities, type CoordinatorControlScope } from "./control-mcp-tools.js";
import { ControlMcpServer } from "./control-mcp-server.js";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { BackendRuntime } from "./backend-runtime.js";
import { cleanReview } from "./build-pipeline-service-test-support.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

// Real MCP dispatch, scope checks, receipts, controller commands and tab
// persistence on both nodes; only the node transport is simulated, and it can
// lose the answer to one command after the node has run it.

let world: MailWorld;
let mcp: ControlMcpServer;
let leaf: StorageService;
let leafContext: CommandContext;
let commands: Map<string, CommandHandler>;
let scope: CoordinatorControlScope;
let leafProjectId: string;
let workerId: string;
let routed: string[];
const loseAnswer = new Set<string>();

const tool = (name: string, input: Record<string, unknown>) =>
  mcp.callCoordinatorTool(scope, name, { nodeId: "bk_leaf", ...input });

async function leafTabs(): Promise<Array<Record<string, unknown>>> {
  const root = (await leaf.getPaneLayout(workerId))?.root as
    { tabs?: Array<Record<string, unknown>> } | undefined;
  return root?.tabs ?? [];
}

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
        const result = await commands.get(command)!(args, leafContext);
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

test("a terminal on another node runs once, across a lost answer and a replay", async () => {
  const launch = mock(async (args: Record<string, unknown>) => ({
    environmentId: args.environmentId,
    tabId: "terminal-job-x",
    status: "started",
  }));
  commands.set("launch_terminal_job", launch as unknown as CommandHandler);
  const input = { requestId: "tests", environmentId: workerId, command: "bun test" };
  loseAnswer.add("launch_controller_terminal");
  const lost = await tool("launch_terminal", input);
  expect(lost.isError).toBe(true);
  expect(lost.text).toContain("outcome is unknown");
  expect(lost.text).toContain("same requestId");
  const retried = await tool("launch_terminal", input);
  expect(retried.isError).toBe(false);
  expect(retried.structuredContent).toMatchObject({
    nodeId: "bk_leaf",
    environmentId: workerId,
    tabId: "terminal-job-x",
    tabType: "plain",
  });
  expect((await tool("launch_terminal", input)).structuredContent).toMatchObject({
    replayed: true,
  });
  // The node saw the same job both times, so it reattached rather than ran twice.
  expect(launch).toHaveBeenCalledTimes(2);
  expect(launch.mock.calls[0]![0].requestId).toBe(launch.mock.calls[1]![0].requestId);
  expect(String(launch.mock.calls[0]![0].requestId)).toStartWith("controller:");
  expect(launch.mock.calls[0]![0]).toMatchObject({ data: "bun test\n", activateTab: true });
  // A changed payload under the same request is refused before the node runs it.
  expect((await tool("launch_terminal", { ...input, command: "rm -rf ." })).text).toContain(
    "different payload",
  );
  expect(routed.filter((command) => command === "launch_controller_terminal")).toHaveLength(2);
});

test("a browser preview on another node opens one tab there and none here", async () => {
  const input = { requestId: "preview", environmentId: workerId, url: "http://localhost:3000/" };
  expect(
    (await tool("open_worker_browser", { ...input, requestId: "web", url: "https://example.com" }))
      .isError,
  ).toBe(true);
  loseAnswer.add("open_controller_browser");
  expect((await tool("open_worker_browser", input)).isError).toBe(true);
  const opened = await tool("open_worker_browser", input);
  expect(opened.structuredContent).toMatchObject({
    nodeId: "bk_leaf",
    url: "http://localhost:3000/",
    ui: { status: "opened" },
  });
  const tabs = await leafTabs();
  expect(tabs).toHaveLength(1);
  expect(tabs[0]).toMatchObject({ type: "browser" });
  expect(String((tabs[0]!.browserData as Record<string, unknown>).url)).toContain("agent-link");
  expect(await world.storage.getPaneLayout(workerId)).toBeNull();
});

test("tab edits on another node, refused while this node's coordinator waits on the tab", async () => {
  await leaf.savePaneLayout(
    workerId,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "left",
      root: {
        kind: "leaf",
        id: "left",
        tabs: [
          { id: "notes", type: "file" },
          { id: "agent", type: "file" },
        ],
        activeTabId: "notes",
      },
    },
    0,
  );
  const edit = (input: Record<string, unknown>) =>
    tool("edit_worker_tab", { environmentId: workerId, ...input });
  expect((await edit({ tabId: "agent", operation: "focus" })).structuredContent).toMatchObject({
    nodeId: "bk_leaf",
    changed: true,
    paneId: "left",
  });
  const association = await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: "remote-delegation",
    projectId: scope.projectId,
    coordinatorId: scope.coordinatorId,
    conversationId: scope.conversationId,
    kind: "environment",
    resourceId: workerId,
    nodeId: "bk_leaf",
    requestId: "delegation:job",
    createdAt: new Date().toISOString(),
  });
  await world.storage.coordinators.openCoordinatorDelegation(association.id, "agent");
  const edits = routed.filter((command) => command === "edit_controller_worker_tab").length;
  const refused = await edit({ tabId: "agent", operation: "close" });
  expect(refused.text).toContain("waiting on this tab");
  expect(routed.filter((command) => command === "edit_controller_worker_tab")).toHaveLength(edits);
  expect((await leafTabs()).map((tab) => tab.id)).toEqual(["notes", "agent"]);
  loseAnswer.add("edit_controller_worker_tab");
  const lost = await edit({ tabId: "notes", operation: "close" });
  expect(lost.text).toContain("Retry the same edit");
  expect((await edit({ tabId: "notes", operation: "close" })).structuredContent).toMatchObject({
    changed: false,
  });
  expect((await leafTabs()).map((tab) => tab.id)).toEqual(["agent"]);
});

test("the owning node refuses another project, the checkout and a bad key", async () => {
  const run = (command: string, args: Record<string, unknown>) =>
    commands.get(command)!(args, leafContext);
  const home = createEnvironment(leafProjectId, { name: "home", environmentType: "local" });
  Object.assign(home, { status: "running", setupPhase: "ready", projectHome: true });
  await leaf.addEnvironment(home);
  const browser = { url: "http://localhost:3000/", key: "abc" };
  await expect(
    run("open_controller_browser", { projectId: "other", environmentId: workerId, ...browser }),
  ).rejects.toThrow("not found in this project");
  await expect(
    run("open_controller_browser", {
      projectId: leafProjectId,
      environmentId: home.id,
      ...browser,
    }),
  ).rejects.toThrow("project checkout");
  await expect(
    run("open_controller_browser", {
      projectId: leafProjectId,
      environmentId: workerId,
      ...browser,
      key: "../x",
    }),
  ).rejects.toThrow("surface key");
  await expect(
    run("launch_controller_terminal", {
      projectId: leafProjectId,
      environmentId: home.id,
      input: { command: "ls" },
      key: "abc",
    }),
  ).rejects.toThrow("project checkout");
  await expect(
    run("edit_controller_worker_tab", {
      projectId: leafProjectId,
      environmentId: home.id,
      tabId: "x",
      operation: "focus",
    }),
  ).rejects.toThrow("project checkout");
});

async function readyReview(): Promise<MultiReviewWorkflow> {
  const timestamp = new Date().toISOString();
  const workflow = {
    id: "review-1",
    version: 1,
    controller: "backend",
    environmentId: workerId,
    projectId: leafProjectId,
    targetBranch: "main",
    reviewers: [
      {
        id: "reviewer-a",
        agent: "codex",
        model: "default",
        status: "completed",
        providerSessionId: "s-a",
        report: cleanReview,
      },
    ],
    reviewModel: { agent: "codex", model: "default" },
    fixModel: { agent: "codex", model: "default" },
    phase: "ready",
    consolidatedReport: cleanReview,
    backendRevision: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  } as unknown as MultiReviewWorkflow;
  await leaf.createMultiReviewWorkflowIfNoActive(workflow.id, workerId, 1, workflow);
  return workflow;
}

test("a reviewer's transcript tab opens on the review's node", async () => {
  const workflow = await readyReview();
  const opened = await tool("open_multi_review", {
    workflowId: workflow.id,
    reviewerId: "reviewer-a",
  });
  expect(opened.isError).toBe(false);
  expect(opened.structuredContent).toMatchObject({
    nodeId: "bk_leaf",
    outcome: "opened",
    ui: { tabId: "multi-review:review-1:reviewer:reviewer-a" },
  });
  expect((await leafTabs())[0]).toMatchObject({
    multiReviewTabData: { workflowId: workflow.id, reviewerId: "reviewer-a" },
  });
  // A node from before the reviewer surface says to update it.
  commands.set("controller_multi_review_surface", async () => {
    throw new Error("Expected surface root, fix or address.");
  });
  expect(
    (await tool("open_multi_review", { workflowId: workflow.id, reviewerId: "reviewer-a" })).text,
  ).toContain("older Orkestrator");
});

test("a custom fix on another node starts once, adopts the review, and survives a lost answer", async () => {
  const workflow = await readyReview();
  // The node's supervisor takes the handoff and delivers it before the answer is lost.
  const customFix = mock(async (input: Record<string, unknown>) => {
    const delivered = {
      ...workflow,
      phase: "interactive",
      addressPromptPending: false,
      fixSession: {
        agent: "codex",
        model: "default",
        sessionKey: "multi-review:review-1:fix",
        providerSessionId: "provider-fix",
        requestIds: [],
        status: "running",
        startedAt: new Date().toISOString(),
      },
      fixTabId: "multi-review-fix:review-1:launch",
      fixLaunch: { kind: "custom", instruction: input.instruction, model: input.fixModel },
    } as unknown as MultiReviewWorkflow;
    const saved = await leaf.getMultiReviewWorkflow(workflow.id);
    await leaf.saveMultiReviewWorkflow(workflow.id, workerId, saved!.revision, delivered);
    return delivered;
  });
  leafContext.multiReviews = { customFix } as unknown as CommandContext["multiReviews"];
  const input = { requestId: "fix-1", workflowId: workflow.id, instruction: "Only the tests" };
  loseAnswer.add("controller_multi_review_surface");
  const lost = await tool("custom_fix_multi_review", input);
  expect(lost.isError).toBe(true);
  expect(lost.text).toContain("same requestId");
  const retried = await tool("custom_fix_multi_review", input);
  expect(retried.isError).toBe(false);
  // The retry reports the fix the first attempt started and opens its tab.
  expect(retried.structuredContent).toMatchObject({
    nodeId: "bk_leaf",
    outcome: "opened",
    ui: { tabId: "multi-review-fix:review-1:launch" },
    workflow: { id: workflow.id, phase: "interactive" },
  });
  expect(customFix).toHaveBeenCalledTimes(1);
  expect(customFix.mock.calls[0]![0]).toEqual({
    workflowId: workflow.id,
    instruction: "Only the tests",
    fixModel: { agent: "codex", model: "default" },
  });
  expect((await tool("custom_fix_multi_review", input)).structuredContent).toMatchObject({
    replayed: true,
  });
  expect(customFix).toHaveBeenCalledTimes(1);
  const associations = await world.storage.coordinators.listCoordinatorWorkflowAssociations(
    world.projectId,
  );
  expect(associations).toContainEqual(
    expect.objectContaining({
      kind: "multi-review",
      resourceId: workflow.id,
      nodeId: "bk_leaf",
      conversationId: scope.conversationId,
    }),
  );
  expect(
    (await tool("custom_fix_multi_review", { ...input, instruction: "Something else" })).text,
  ).toContain("different payload");
});
