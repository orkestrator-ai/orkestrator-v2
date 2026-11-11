import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import { pipelineWorkerTabId } from "@orkestrator/protocol/pipeline-worker-mail";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { ControlMcpServer } from "./control-mcp/server.js";
import { coordinatorRoleCapabilities, type CoordinatorControlScope } from "./control-mcp/tools.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

// A coordinator restarting a build pipeline step, here and on a connected
// node: real MCP dispatch, scope checks, receipts and controller commands on
// both nodes. Only the node transport (which can lose one answer after the
// node ran the command, or be an older node) and the pipeline service (whose
// step resolution has its own tests) are simulated.

let world: MailWorld;
let mcp: ControlMcpServer;
let leaf: StorageService;
let scope: CoordinatorControlScope;
let leafProjectId: string;
let restarts: Array<{ node: string; pipelineId: string; stageId?: string; selection?: unknown }>;
let resumes: Array<{ node: string; pipelineId: string }>;
let olderNode: boolean;
const loseAnswer = new Set<string>();

const tool = (name: string, input: Record<string, unknown>) =>
  mcp.callCoordinatorTool(scope, name, input);

function fakePipelines(node: string, storage: () => StorageService) {
  return {
    resume: async (pipelineId: string) => {
      const record = (await storage().getBuildPipeline(pipelineId))!;
      resumes.push({ node, pipelineId });
      return { ...(record.snapshot as Record<string, unknown>), phase: "fixing" };
    },
    restartForCoordinator: async (
      pipelineId: string,
      stageId?: string,
      selection?: unknown,
      requestId?: string,
    ) => {
      const record = (await storage().getBuildPipeline(pipelineId))!;
      const snapshot = record.snapshot as Record<string, unknown>;
      const saved = snapshot.restartIdentity as { requestId: string; result: unknown } | undefined;
      if (saved && saved.requestId === requestId) return saved.result;
      if (stageId === "missing") {
        throw new Error('This build pipeline has no step "missing".');
      }
      restarts.push({ node, pipelineId, stageId, selection });
      // The restarted pipeline is running its step again, as the service leaves it.
      const result = {
        pipeline: { id: pipelineId, phase: "fixing" },
        step: { phase: "fix", round: 2, sessionKey: stageId ?? "fix-key" },
        alreadyRestarted: false,
      };
      await storage().saveBuildPipeline(pipelineId, record.projectId, "", 1, {
        ...(record.snapshot as Record<string, unknown>),
        phase: "fixing",
        restartIdentity: { requestId, result },
      });
      return result;
    },
  };
}

async function savePipeline(
  storage: StorageService,
  projectId: string,
  id: string,
  snapshot: Record<string, unknown> = {},
) {
  // A real environment lets origin, project and receipt checks run together.
  const environmentId = `${projectId}-pipeline-env`;
  if (!(await storage.getEnvironment(environmentId))) {
    const environment = createEnvironment(projectId, {
      name: "pipeline worker",
      environmentType: "local",
    });
    environment.id = environmentId;
    await storage.addEnvironment(environment);
  }
  await storage.saveBuildPipeline(id, projectId, environmentId, 1, {
    id,
    projectId,
    environmentId,
    phase: "failed",
    error: "Claude usage limit reached",
    sessions: [],
    ...snapshot,
  });
}

beforeEach(async () => {
  world = await MailWorld.create({ statusWakes: { coalesceMs: 0 } });
  await world.storage.updateProject(world.projectId, {
    gitUrl: "https://github.com/acme/site.git",
  });
  leaf = new StorageService(path.join(world.root, "leaf"));
  await leaf.init();
  const project = await leaf.addProject(
    createProject("https://github.com/acme/site.git", path.join(world.root, "checkout")),
  );
  leafProjectId = project.id;
  restarts = [];
  resumes = [];
  olderNode = false;
  loseAnswer.clear();
  await savePipeline(world.storage, world.projectId, "pipe-local");
  await savePipeline(leaf, leafProjectId, "pipe-remote");
  const commands = createCommandRegistry();
  const leafContext = {
    storage: leaf,
    emit: () => undefined,
    runtime: new BackendRuntime({ emit: () => undefined }),
    buildPipelines: fakePipelines("leaf", () => leaf),
  } as unknown as CommandContext;
  const rootContext = {
    storage: world.storage,
    coordinators: world.coordinator,
    buildPipelines: fakePipelines("local", () => world.storage),
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
        if (olderNode && command === "restart_controller_build_pipeline_step") {
          throw new Error(unknownBackendCommandMessage(command));
        }
        const handler = commands.get(command) as CommandHandler;
        const result = await handler(args, leafContext);
        if (loseAnswer.delete(command)) return { outcome: "unknown" };
        return { outcome: "ok", result };
      },
    },
    runtime: new BackendRuntime({ emit: () => undefined }),
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
  await mcp?.stop();
  await world.close();
});

test("restarts the failed step here and reopens the coordinator's follow", async () => {
  await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: "follow-local",
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: scope.conversationId,
    kind: "build-pipeline",
    resourceId: "pipe-local",
    requestId: "build-local",
    createdAt: new Date().toISOString(),
  });
  // The failure was already reported, which ends the follow.
  await world.storage.coordinators.markCoordinatorWorkflowNotified("follow-local", 1);

  const restarted = await tool("restart_build_pipeline_step", {
    requestId: "restart-1",
    pipelineId: "pipe-local",
  });

  expect(restarted.isError).toBe(false);
  expect(restarted.structuredContent).toMatchObject({
    pipelineId: "pipe-local",
    restarted: true,
    step: { phase: "fix", round: 2 },
    phase: "fixing",
    followed: true,
    delivery: "async",
  });
  expect(restarted.text).toContain("Finish your turn now");
  expect(restarts).toEqual([
    { node: "local", pipelineId: "pipe-local", stageId: undefined, selection: undefined },
  ]);
  const follow = (
    await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)
  ).find((association) => association.id === "follow-local");
  expect(follow?.terminalNotifiedAt).toBeUndefined();
  expect(follow?.statusNotice).toBeUndefined();

  // The same request again replays; it never restarts twice.
  const retried = await tool("restart_build_pipeline_step", {
    requestId: "restart-1",
    pipelineId: "pipe-local",
  });
  expect(retried.structuredContent).toMatchObject({ restarted: true, replayed: true });
  expect(restarts).toHaveLength(1);
  // The same requestId with different intent is refused.
  const reused = await tool("restart_build_pipeline_step", {
    requestId: "restart-1",
    pipelineId: "pipe-local",
    stepId: "other",
  });
  expect(reused.isError).toBe(true);
  expect(reused.text).toContain("different payload");
  expect(restarts).toHaveLength(1);
});

test("names a step by its worker address and restarts it in another model", async () => {
  const selection = { agent: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" };
  const restarted = await tool("restart_build_pipeline_step", {
    requestId: "restart-named",
    pipelineId: "pipe-local",
    stepId: pipelineWorkerTabId("pipe-local:fix:1:abc"),
    selection,
  });
  expect(restarted.isError).toBe(false);
  expect(restarted.structuredContent).toMatchObject({ followed: false, selection });
  expect(restarted.text).toContain("does not follow the pipeline");
  expect(restarts).toEqual([
    { node: "local", pipelineId: "pipe-local", stageId: "pipe-local:fix:1:abc", selection },
  ]);
});

test("refusals change nothing and leave the request retryable", async () => {
  const unknown = await tool("restart_build_pipeline_step", {
    requestId: "restart-unknown",
    pipelineId: "pipe-local",
    stepId: "missing",
  });
  expect(unknown.isError).toBe(true);
  expect(unknown.text).toContain('no step "missing"');
  const foreign = await tool("restart_build_pipeline_step", {
    requestId: "restart-foreign",
    pipelineId: "pipe-remote",
  });
  expect(foreign.isError).toBe(true);
  expect(foreign.text).toContain("not found in this project");
  expect(restarts).toEqual([]);
  // A refused request was never recorded as done, so it can be sent again.
  const again = await tool("restart_build_pipeline_step", {
    requestId: "restart-foreign",
    pipelineId: "pipe-local",
  });
  expect(again.isError).toBe(false);
});

test("restarts on a connected node and replays after a lost answer", async () => {
  const input = { requestId: "restart-remote", pipelineId: "pipe-remote", nodeId: "bk_leaf" };
  loseAnswer.add("restart_controller_build_pipeline_step");
  const lost = await tool("restart_build_pipeline_step", input);
  expect(lost.isError).toBe(true);
  expect(lost.text).toContain("outcome is unknown");
  expect(lost.text).toContain("same requestId");
  // The node did restart it.
  expect(restarts).toEqual([
    { node: "leaf", pipelineId: "pipe-remote", stageId: undefined, selection: undefined },
  ]);

  const retried = await tool("restart_build_pipeline_step", input);
  expect(retried.isError).toBe(false);
  expect(retried.structuredContent).toMatchObject({
    nodeId: "bk_leaf",
    restarted: true,
    replayed: true,
  });
  expect(restarts).toHaveLength(1);
});

test("an older node is told to update and a foreign pipeline there is refused", async () => {
  olderNode = true;
  const older = await tool("restart_build_pipeline_step", {
    requestId: "restart-older",
    pipelineId: "pipe-remote",
    nodeId: "bk_leaf",
  });
  expect(older.isError).toBe(true);
  expect(older.text).toContain("older Orkestrator");
  expect(older.text).toContain("update it");
  olderNode = false;
  const foreign = await tool("restart_build_pipeline_step", {
    requestId: "restart-foreign-node",
    pipelineId: "pipe-local",
    nodeId: "bk_leaf",
  });
  expect(foreign.isError).toBe(true);
  expect(foreign.text).toContain("not found in this project");
  expect(restarts).toEqual([]);
});

test("resume refuses a pipeline that is not paused and points at the restart tool", async () => {
  const failed = await tool("resume_build_pipeline", { pipelineId: "pipe-local" });
  expect(failed.isError).toBe(true);
  expect(failed.text).toContain("failed, not paused");
  expect(failed.text).toContain("restart_build_pipeline_step");
  await savePipeline(world.storage, world.projectId, "pipe-cancelled", {
    error: "Build cancelled",
  });
  const cancelled = await tool("resume_build_pipeline", { pipelineId: "pipe-cancelled" });
  expect(cancelled.isError).toBe(true);
  expect(cancelled.text).toContain("cancelled");
  await savePipeline(world.storage, world.projectId, "pipe-running", { phase: "fixing" });
  const running = await tool("resume_build_pipeline", { pipelineId: "pipe-running" });
  expect(running.isError).toBe(true);
  expect(running.text).toContain("fixing, not paused");
  expect(running.text).not.toContain("restart_build_pipeline_step");
});

test.each(["early-build-key", pipelineWorkerTabId("early-build-key")])(
  "preserves remote named step %s and selection",
  async (stepId) => {
    const selection = { agent: "claude", model: "sonnet" };
    const result = await tool("restart_build_pipeline_step", {
      requestId: "remote-named",
      pipelineId: "pipe-remote",
      nodeId: "bk_leaf",
      stepId,
      selection,
    });
    expect(result.isError).toBe(false);
    expect(restarts).toEqual([
      { node: "leaf", pipelineId: "pipe-remote", stageId: "early-build-key", selection },
    ]);
  },
);

test("refuses unknown remote steps", async () => {
  const result = await tool("restart_build_pipeline_step", {
    requestId: "remote-unknown",
    pipelineId: "pipe-remote",
    nodeId: "bk_leaf",
    stepId: "missing",
  });
  expect(result.isError).toBe(true);
  expect(result.text).toContain('no step "missing"');
  expect(restarts).toEqual([]);
});

test("a follow update failure after restart remains safe to retry", async () => {
  await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: "retry-follow",
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: scope.conversationId,
    kind: "build-pipeline",
    resourceId: "pipe-local",
    requestId: "build",
    createdAt: new Date().toISOString(),
  });
  await world.storage.coordinators.markCoordinatorWorkflowNotified("retry-follow", 1);
  const spy = spyOn(
    world.storage.coordinators,
    "updateCoordinatorWorkflowAssociation",
  ).mockRejectedValueOnce(new Error("follow storage failed"));
  try {
    const input = { pipelineId: "pipe-local", requestId: "follow-retry" };
    expect((await tool("restart_build_pipeline_step", input)).isError).toBe(true);
    expect(restarts).toHaveLength(1);
    expect((await tool("restart_build_pipeline_step", input)).isError).toBe(false);
    expect(restarts).toHaveLength(1);
  } finally {
    spy.mockRestore();
  }
});

test("a restarted follow delivers a distinct second failure and retry/reconciliation do not duplicate it", async () => {
  const main = await world.main();
  await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: "failure-follow",
    projectId: world.projectId,
    coordinatorId: world.coordinatorId,
    conversationId: scope.conversationId,
    kind: "build-pipeline",
    resourceId: "pipe-local",
    requestId: "build",
    createdAt: new Date().toISOString(),
  });
  const reconcile = async () => {
    await world.coordinator.reconcileWorkflowNotifications();
    await world.coordinator.statusWakes.settled();
    await world.deliver();
  };
  await reconcile();
  expect(world.wakes(main)).toBe(1);
  await world.finishTurn(main);
  const first = (await world.storage.getAgentMailMailbox(main.environmentId, main.tabId)).messages;
  const input = { pipelineId: "pipe-local", requestId: "restart-failure" };
  // Simulate a crash window after the episode was persisted but before receipt completion.
  const update = world.storage.coordinators.updateCoordinatorWorkflowAssociation.bind(
    world.storage.coordinators,
  );
  const publication = spyOn(
    world.storage.coordinators,
    "updateCoordinatorWorkflowAssociation",
  ).mockImplementationOnce(async (...args) => {
    await update(...args);
    throw new Error("lost answer after episode publication");
  });
  try {
    expect((await tool("restart_build_pipeline_step", input)).isError).toBe(true);
  } finally {
    publication.mockRestore();
  }
  const episode = (
    await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)
  )[0]!.statusWakeEpisode;
  expect(episode).toBeTruthy();
  await savePipeline(world.storage, world.projectId, "pipe-local");
  await reconcile();
  expect(world.wakes(main)).toBe(2);
  await world.finishTurn(main);
  expect((await tool("restart_build_pipeline_step", input)).isError).toBe(false);
  await reconcile();
  expect(world.wakes(main)).toBe(2);
  const messages = (await world.storage.getAgentMailMailbox(main.environmentId, main.tabId))
    .messages;
  expect(messages).toHaveLength(first.length + 1);
  expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
});

test("remote restart reopens only the matching node follow and preserves its episode on replay", async () => {
  for (const nodeId of ["bk_leaf", "bk_other"]) {
    await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: nodeId,
      projectId: world.projectId,
      coordinatorId: world.coordinatorId,
      conversationId: scope.conversationId,
      kind: "build-pipeline",
      resourceId: "pipe-remote",
      nodeId,
      requestId: nodeId,
      createdAt: new Date().toISOString(),
      terminalNotifiedAt: new Date().toISOString(),
      environmentCreationSettledAt: new Date().toISOString(),
    });
  }
  const input = { pipelineId: "pipe-remote", nodeId: "bk_leaf", requestId: "remote-follow" };
  expect((await tool("restart_build_pipeline_step", input)).isError).toBe(false);
  const before = await world.storage.coordinators.listCoordinatorWorkflowAssociations(
    world.projectId,
  );
  expect(before.find((entry) => entry.id === "bk_leaf")).toMatchObject({
    statusWakeEpisode: expect.any(String),
  });
  expect(before.find((entry) => entry.id === "bk_leaf")!.terminalNotifiedAt).toBeUndefined();
  expect(
    before.find((entry) => entry.id === "bk_leaf")!.environmentCreationSettledAt,
  ).toBeUndefined();
  expect(
    before.find((entry) => entry.id === "bk_other")!.environmentCreationSettledAt,
  ).toBeDefined();
  expect(before.find((entry) => entry.id === "bk_other")!.terminalNotifiedAt).toBeDefined();
  expect((await tool("restart_build_pipeline_step", input)).isError).toBe(false);
  expect(
    await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId),
  ).toEqual(before);
});

for (const remote of [false, true]) {
  test(`pipeline mutation origin checks on ${remote ? "remote" : "local"} node`, async () => {
    const pipelineId = remote ? "pipe-remote" : "pipe-local";
    const nodeId = remote ? "bk_leaf" : undefined;
    const ownerProjectId = remote ? leafProjectId : scope.projectId;
    await savePipeline(remote ? leaf : world.storage, ownerProjectId, pipelineId, {
      phase: "paused",
    });
    const optedIn = await tool("resume_build_pipeline", {
      pipelineId,
      ...(nodeId ? { nodeId } : {}),
    });
    expect(optedIn.isError).toBe(false);
    expect(resumes).toHaveLength(1);
    resumes = [];
    await world.storage.patchRepositorySettings(scope.projectId, {}, [
      "coordinatorOtherEnvironments",
    ]);
    for (const name of ["resume_build_pipeline", "restart_build_pipeline_step"]) {
      const result = await tool(name, {
        pipelineId,
        ...(nodeId ? { nodeId } : {}),
        ...(name.startsWith("restart") ? { requestId: `denied-${name}` } : {}),
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("did not create that environment");
      expect(restarts).toHaveLength(0);
      expect(resumes).toHaveLength(0);
    }
    await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: "creation",
      projectId: scope.projectId,
      coordinatorId: scope.coordinatorId,
      conversationId: scope.conversationId,
      kind: "build-pipeline",
      resourceId: pipelineId,
      requestId: "created-pipeline",
      createdEnvironmentId: `${remote ? leafProjectId : scope.projectId}-pipeline-env`,
      nodeId,
      createdAt: new Date().toISOString(),
    });
    const allowed = await tool("restart_build_pipeline_step", {
      pipelineId,
      requestId: "owned",
      ...(nodeId ? { nodeId } : {}),
    });
    expect(allowed.isError).toBe(false);
    expect(restarts).toHaveLength(1);
    const projectId = remote ? leafProjectId : scope.projectId;
    await savePipeline(remote ? leaf : world.storage, projectId, pipelineId, { phase: "paused" });
    const resumed = await tool("resume_build_pipeline", {
      pipelineId,
      ...(nodeId ? { nodeId } : {}),
    });
    expect(resumed.isError).toBe(false);
    expect(resumes).toEqual([{ node: remote ? "leaf" : "local", pipelineId }]);
  });
}
