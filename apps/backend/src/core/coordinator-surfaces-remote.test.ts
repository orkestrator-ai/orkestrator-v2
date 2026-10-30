import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import path from "node:path";
import type { MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import { coordinatorRoleCapabilities, type CoordinatorControlScope } from "./control-mcp-tools.js";
import { ControlMcpServer } from "./control-mcp-server.js";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { MultiReviewService } from "./multi-review-service.js";
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
let rootContext: CommandContext;
let beforeLeafCommand: ((command: string) => Promise<void>) | undefined;
let reviewService: MultiReviewService | undefined;
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
  beforeLeafCommand = undefined;
  reviewService = undefined;
  rootContext = {
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
        await beforeLeafCommand?.(command);
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
  await reviewService?.shutdown();
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

for (const [tabType, options, expected] of [
  [
    "claude",
    { prompt: "Inspect tests", model: "sonnet", reasoningEffort: "high" },
    {
      data: 'claude --dangerously-skip-permissions --model "sonnet" --effort "high" "Inspect tests"\n',
    },
  ],
  [
    "claude-tmux",
    { prompt: "Inspect tests", model: "sonnet", reasoningEffort: "high" },
    { initialPrompt: "Inspect tests", model: "sonnet", reasoningEffort: "high" },
  ],
  [
    "codex",
    { prompt: "Inspect tests", model: "gpt-5.4", reasoningEffort: "high" },
    {
      data: 'codex --model "gpt-5.4" --config "model_reasoning_effort=\\"high\\"" "Inspect tests"\n',
    },
  ],
  ["grok", {}, { data: "grok\n" }],
  [
    "opencode",
    { prompt: "Inspect tests", model: "openai/gpt-5.4" },
    {
      data: 'OPENCODE_DISABLE_AUTOUPDATE=1 opencode --model "openai/gpt-5.4" --prompt "Inspect tests"\n',
    },
  ],
  [
    "pi",
    { prompt: "Inspect tests", model: "openai/gpt-5.4", reasoningEffort: "high" },
    { data: 'pi --provider "openai" --model "gpt-5.4" --thinking "high" "Inspect tests"\n' },
  ],
] as const) {
  test(`a remote ${tabType} terminal preserves its launch options and retry identity`, async () => {
    const launch = mock(async (_args: Record<string, unknown>) => ({
      tabId: "agent-terminal",
      status: "started",
    }));
    commands.set("launch_terminal_job", launch);
    const input = {
      requestId: "agent",
      environmentId: workerId,
      tabType,
      title: "Inspection",
      ...options,
    };
    loseAnswer.add("launch_controller_terminal");
    expect((await tool("launch_terminal", input)).isError).toBe(true);
    const retried = await tool("launch_terminal", input);
    expect(retried.isError).toBe(false);
    expect(retried.structuredContent).toMatchObject({ nodeId: "bk_leaf", tabType });
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[0]).toEqual(launch.mock.calls[1]);
    expect(launch.mock.calls[0]![0]).toMatchObject({
      environmentId: workerId,
      tabType,
      title: "Inspection",
      activateTab: true,
      ...expected,
    });
    if (tabType === "claude-tmux") expect(launch.mock.calls[0]![0]).not.toHaveProperty("data");
    expect((await tool("launch_terminal", input)).structuredContent).toMatchObject({
      replayed: true,
    });
    expect(launch).toHaveBeenCalledTimes(2);
  });
}

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

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function idleRemoteTab() {
  await leaf.savePaneLayout(
    workerId,
    {
      version: PANE_LAYOUT_VERSION,
      containerId: null,
      activePaneId: "left",
      root: { kind: "leaf", id: "left", tabs: [{ id: "idle", type: "file" }], activeTabId: "idle" },
    },
    0,
  );
  return world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: "racing-delegation",
    projectId: scope.projectId,
    coordinatorId: scope.coordinatorId,
    conversationId: scope.conversationId,
    kind: "environment",
    resourceId: workerId,
    nodeId: "bk_leaf",
    requestId: "delegation:race",
    createdAt: new Date().toISOString(),
  });
}

test("remote close holds delegation admission across its check and leaf RPC", async () => {
  const association = await idleRemoteTab();
  const entered = barrier();
  const resume = barrier();
  beforeLeafCommand = async (command) => {
    if (command === "edit_controller_worker_tab") {
      entered.release();
      await resume.promise;
    }
  };
  const closing = tool("edit_worker_tab", {
    environmentId: workerId,
    tabId: "idle",
    operation: "close",
  });
  try {
    await entered.promise;
    await expect(
      world.storage.coordinators.openCoordinatorDelegation(association.id, "idle"),
    ).rejects.toThrow("being closed");
    for (const explicitTab of [true, false]) {
      await expect(
        commands.get("send_coordinator_node_mail")!(
          {
            scope,
            nodeId: "bk_leaf",
            toEnvironmentId: workerId,
            ...(explicitTab ? { toTabId: "idle" } : {}),
            requestId: "during-close",
            body: "Please inspect",
          },
          rootContext,
        ),
      ).rejects.toThrow("being closed");
    }
    expect(routed).not.toContain("deliver_node_mail");
    expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toEqual([]);
    expect((await leafTabs()).map((tab) => tab.id)).toEqual(["idle"]);
  } finally {
    resume.release();
  }
  expect((await closing).isError).toBe(false);
  expect(await leafTabs()).toEqual([]);
  expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toEqual([]);
});

test("remote delegation reserves admission before asynchronous validation and persistence", async () => {
  await idleRemoteTab();
  commands.set("record_node_environment_origin", async () => ({}));
  const entered = barrier();
  const resume = barrier();
  let pauseNextEnvironment = true;
  beforeLeafCommand = async (command) => {
    if (command === "get_environment" && pauseNextEnvironment) {
      pauseNextEnvironment = false;
      entered.release();
      await resume.promise;
    }
  };
  const admitting = commands.get("open_coordinator_node_delegation")!(
    {
      scope,
      nodeId: "bk_leaf",
      environmentId: workerId,
      tabId: "idle",
      requestId: "race",
    },
    rootContext,
  );
  try {
    await entered.promise;
    const refused = await tool("edit_worker_tab", {
      environmentId: workerId,
      tabId: "idle",
      operation: "close",
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("work being admitted");
    expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toEqual([]);
  } finally {
    resume.release();
  }
  expect(await admitting).toMatchObject({ opened: true });
  expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(1);
  expect((await leafTabs()).map((tab) => tab.id)).toEqual(["idle"]);
});

for (const explicitTab of [true, false]) {
  test(`queued remote mail fences close of an idle tab (${explicitTab ? "explicit" : "leaf-selected"} recipient)`, async () => {
    await idleRemoteTab();
    const entered = barrier();
    const resume = barrier();
    commands.set("deliver_node_mail", async () => {
      entered.release();
      await resume.promise;
      return { messageId: "queued-mail", toTabId: "idle", placement: "pending-inject" };
    });
    const sending = commands.get("send_coordinator_node_mail")!(
      {
        scope,
        nodeId: "bk_leaf",
        toEnvironmentId: workerId,
        ...(explicitTab ? { toTabId: "idle" } : {}),
        requestId: "queued",
        body: "Please inspect",
      },
      rootContext,
    );
    try {
      await entered.promise;
      const refused = await tool("edit_worker_tab", {
        environmentId: workerId,
        tabId: "idle",
        operation: "close",
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain("work being admitted");
      expect(routed).not.toContain("edit_controller_worker_tab");
    } finally {
      resume.release();
    }
    expect(await sending).toMatchObject({ coordinatorDelegationOpened: true });
    expect(await world.storage.coordinators.listOpenCoordinatorDelegations()).toHaveLength(1);
    expect((await leafTabs()).map((tab) => tab.id)).toEqual(["idle"]);
  });
}

test("failed remote close releases admission for a later delegation", async () => {
  const association = await idleRemoteTab();
  beforeLeafCommand = async (command) => {
    if (command === "edit_controller_worker_tab") throw new Error("node unavailable");
  };
  expect(
    (await tool("edit_worker_tab", { environmentId: workerId, tabId: "idle", operation: "close" }))
      .isError,
  ).toBe(true);
  expect(
    await world.storage.coordinators.openCoordinatorDelegation(association.id, "idle"),
  ).toMatchObject({ delegation: { state: "running" } });
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

function realReviewSupervisor() {
  reviewService = new MultiReviewService(leaf, async <T>() => ({}) as T, {
    autoAdvance: false,
  });
  leafContext.multiReviews = reviewService;
  return reviewService;
}

test("a delivered custom fix replays only the complete explicit model selection", async () => {
  const workflow = await readyReview();
  const model = { agent: "codex" as const, model: "default", reasoningEffort: "low" };
  await leaf.saveMultiReviewWorkflow(workflow.id, workerId, workflow.version, {
    ...workflow,
    phase: "interactive",
    addressPromptPending: false,
    fixModel: model,
    fixSession: {
      ...model,
      sessionKey: "fix-session",
      providerSessionId: "fix-provider",
      requestIds: [],
      status: "running",
      startedAt: new Date().toISOString(),
    },
    fixTabId: "delivered-fix",
    fixLaunch: { kind: "custom", instruction: "Only the tests", model },
  });
  realReviewSupervisor();
  const input = {
    requestId: "identical",
    workflowId: workflow.id,
    instruction: "Only the tests",
    fixModel: model,
  };
  expect((await tool("custom_fix_multi_review", input)).structuredContent).toMatchObject({
    outcome: "opened",
    ui: { tabId: "delivered-fix" },
  });
  const changed = {
    ...input,
    requestId: "changed",
    fixModel: { ...model, reasoningEffort: "high" },
  };
  const refused = await tool("custom_fix_multi_review", changed);
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("not ready for a custom fix");
  // Failed receipts remain retryable errors, never a completed replay of the old Fix.
  expect((await tool("custom_fix_multi_review", changed)).isError).toBe(true);
  expect((await tool("custom_fix_multi_review", input)).structuredContent).toMatchObject({
    replayed: true,
  });
  expect((await leaf.getMultiReviewWorkflow(workflow.id))!.snapshot).toMatchObject({
    fixLaunch: { model },
    fixTabId: "delivered-fix",
  });
});

test("a pending remote custom fix retains its handoff through a lost answer and dispatch failure", async () => {
  const workflow = await readyReview();
  const entered = barrier();
  const resume = barrier();
  const dispatch = mock(async (pending: MultiReviewWorkflow) => {
    entered.release();
    await resume.promise;
    throw new Error(`dispatch unavailable for ${pending.id}`);
  });
  reviewService = new MultiReviewService(leaf, async <T>() => ({}) as T, {
    autoAdvance: false,
    addressDispatchRetryMs: 60_000,
    dispatchAddressPrompt: dispatch,
  });
  leafContext.multiReviews = reviewService;
  const input = {
    requestId: "pending-fix",
    workflowId: workflow.id,
    instruction: "Only the tests",
    fixModel: { agent: "codex", model: "default", reasoningEffort: "low" },
  };
  loseAnswer.add("controller_multi_review_surface");
  const lost = await tool("custom_fix_multi_review", input);
  expect(lost.isError).toBe(true);
  await entered.promise;
  const pending = (await leaf.getMultiReviewWorkflow(workflow.id))!.snapshot as MultiReviewWorkflow;
  try {
    expect(pending).toMatchObject({
      phase: "interactive",
      addressPromptPending: true,
      customFixModel: input.fixModel,
    });
    // A queued handoff can be read without waiting for its blocked dispatcher.
    expect(
      (await tool("get_multi_review", { workflowId: workflow.id })).structuredContent,
    ).toMatchObject({ workflow: { addressPromptPending: true } });
  } finally {
    resume.release();
  }
  await reviewService.advanceNow(workflow.id);
  const failed = (await leaf.getMultiReviewWorkflow(workflow.id))!.snapshot as MultiReviewWorkflow;
  expect(failed).toMatchObject({
    addressPromptPending: true,
    addressPromptAttempts: 1,
    error: expect.stringContaining("dispatch unavailable"),
    addressRequestId: pending.addressRequestId,
    addressSessionKey: pending.addressSessionKey,
    addressTabId: pending.addressTabId,
  });
  const retried = await tool("custom_fix_multi_review", input);
  expect(retried.isError).toBe(false);
  expect(retried.structuredContent).toMatchObject({
    outcome: "pending",
    workflow: { addressPromptPending: true },
  });
  await reviewService.advanceNow(workflow.id);
  expect(dispatch).toHaveBeenCalledTimes(2);
  for (const [snapshot] of dispatch.mock.calls) {
    expect(snapshot).toMatchObject({
      addressRequestId: pending.addressRequestId,
      addressSessionKey: pending.addressSessionKey,
      addressTabId: pending.addressTabId,
      customFixModel: input.fixModel,
    });
  }
  expect((await leaf.getMultiReviewWorkflow(workflow.id))!.snapshot).toMatchObject({
    customFixModel: input.fixModel,
    addressRequestId: pending.addressRequestId,
  });
  const changed = await tool("custom_fix_multi_review", {
    ...input,
    requestId: "different-pending-effort",
    fixModel: { ...input.fixModel, reasoningEffort: "high" },
  });
  expect(changed.isError).toBe(true);
  expect(changed.text).toContain("not ready for a custom fix");
  expect((await leafTabs()).every((tab) => tab.type === "multi-review")).toBe(true);
});

test("a remote custom fix refused before handoff can retry the same receipt", async () => {
  const workflow = await readyReview();
  const service = realReviewSupervisor();
  const realCustomFix = service.customFix.bind(service);
  const customFix = mock(realCustomFix);
  customFix.mockRejectedValueOnce(new Error("dispatch preflight unavailable"));
  service.customFix = customFix;
  const input = { requestId: "preflight", workflowId: workflow.id, instruction: "Only the tests" };
  const refused = await tool("custom_fix_multi_review", input);
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("handoff could not be queued");
  expect((await leaf.getMultiReviewWorkflow(workflow.id))!.snapshot).toMatchObject({
    phase: "ready",
  });
  const retried = await tool("custom_fix_multi_review", input);
  expect(retried.isError).toBe(false);
  expect(retried.structuredContent).toMatchObject({ outcome: "pending" });
  expect(customFix).toHaveBeenCalledTimes(2);
});
