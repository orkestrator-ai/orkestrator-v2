import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import path from "node:path";
import {
  COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL,
  COORDINATOR_OTHER_ENVIRONMENTS_SETTING_LABEL,
} from "@orkestrator/protocol/coordinator";
import { renderAgentMailCarrier } from "@orkestrator/protocol/agent-mail";
import { unknownBackendCommandMessage } from "@orkestrator/protocol/unknown-command";
import { MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS } from "./coordinator-workflow-retention.js";
import { seedStore, readStoredValue } from "./storage-test-support.js";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { BuildPipelineService } from "./build-pipeline-service.js";
import {
  coordinatorCreatedEnvironment,
  assertCoordinatorMayActOnEnvironment,
  MAX_REMOTE_RECEIPT_LOOKUPS,
} from "./coordinator-environment-scope.js";
import {
  selectCoordinatorWorkflowsToClear,
  COORDINATOR_WORKFLOW_REPLAY_WINDOW_MS,
} from "./coordinator-workflow-retention.js";
import { BackendRuntime } from "./backend-runtime.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext, CommandHandler } from "./commands-context.js";
import {
  COORDINATOR_ENVIRONMENT_ACTIONS,
  COORDINATOR_ENVIRONMENT_CHECKED_BY_COMMAND,
  COORDINATOR_ENVIRONMENT_READS,
  COORDINATOR_ENVIRONMENT_USER_APPROVED,
} from "./control-mcp/coordinator-environment-scope.js";
import { ControlMcpServer, readControlMcpDescriptor } from "./control-mcp/server.js";
import { rpc } from "./control-mcp/server-test-support.js";
import { coordinatorRoleCapabilities, type CoordinatorControlScope } from "./control-mcp/tools.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";
import { graphRunFixture } from "./graph-run-test-support.js";
import { coordinatorEnvironmentRefusals } from "./coordinator-environment-refusals.js";

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
      link: () => ({ hello: { capabilities: { "node-coordinator-build-origin": 1 } } }),
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
  await world.storage.saveBuildPipeline("pipeline-target", world.projectId, handMade, 1, {
    id: "pipeline-target",
    projectId: world.projectId,
    environmentId: handMade,
    phase: "paused",
  } as never);
  await world.storage.saveMultiReviewWorkflow("review-target", handMade, 1, {
    id: "review-target",
    projectId: world.projectId,
    environmentId: handMade,
    phase: "reviewing",
  });
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

for (const provisionBeforeCompletion of [false, true]) {
  test(`a reclaimed pipeline keeps creation authority with provisioning ${provisionBeforeCompletion ? "before" : "after"} receipt completion`, async () => {
    const ticket = await world.storage.kanban.addKanbanTask(world.projectId, "Build", "");
    const input = {
      projectId: world.projectId,
      taskId: ticket.id,
      taskTitle: "Build",
      taskSnapshot: {
        title: "Build",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      environmentType: "local",
      agentType: "codex",
      delegationBaseBranch: "main",
      delegationBaseCommit: BASE,
    };
    let attempts = 0;
    const pipelineId = "reclaimed-build";
    const snapshot = {
      id: pipelineId,
      projectId: world.projectId,
      environmentId: "",
      phase: "preparing",
      coordinatorLaunchId: "",
    };
    rootContext.buildPipelines = {
      start: async (_input: unknown, launchId: string) => {
        snapshot.coordinatorLaunchId = launchId;
        if (++attempts === 1) {
          await world.storage.saveBuildPipeline(pipelineId, world.projectId, "", 1, snapshot);
          throw new Error("lost admission answer");
        }
        if (provisionBeforeCompletion)
          await world.storage.saveBuildPipeline(pipelineId, world.projectId, handMade, 1, {
            ...snapshot,
            environmentId: handMade,
          });
        return snapshot;
      },
    } as unknown as CommandContext["buildPipelines"];
    const start = () =>
      commands.get("start_coordinator_build_pipeline")!(
        { scope, requestId: "reclaim", input },
        rootContext,
      );
    await expect(start()).rejects.toThrow("lost admission answer");
    expect(await start()).toMatchObject({ environmentId: "" });
    if (!provisionBeforeCompletion)
      await world.storage.saveBuildPipeline(pipelineId, world.projectId, handMade, 1, {
        ...snapshot,
        environmentId: handMade,
      });
    // Authority is a stored receipt and survives deletion of disposable history.
    expect(
      await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId),
    ).toContainEqual(
      expect.objectContaining({
        resourceId: pipelineId,
        pending: false,
        createdEnvironmentId: handMade,
      }),
    );
    await world.storage.deleteBuildPipeline(pipelineId);
    expect((await tool("send_message", message(handMade))).isError).toBe(false);
    expect(await world.undelivered(handMadeActor)).toHaveLength(1);
  });
}

for (const remote of [false, true]) {
  for (const action of ["pause", "cancel", "resume", "restart"] as const) {
    test(`owned pipeline ${action} before environment publication (${remote ? "remote" : "local"})`, async () => {
      const storage = remote ? leaf : world.storage;
      const projectId = remote
        ? (await leaf.getEnvironment(leafWorkerId))!.projectId
        : world.projectId;
      const pipelineId = "provisioning-pipeline";
      const snapshot = {
        id: pipelineId,
        projectId,
        environmentId: "",
        phase: action === "resume" ? "paused" : action === "restart" ? "failed" : "preparing",
      };
      await storage.saveBuildPipeline(pipelineId, projectId, "", 1, snapshot);
      const effect = mock(async () => snapshot);
      const restart = mock(async () => ({
        pipeline: snapshot,
        step: { phase: "prepare", round: 1 },
        alreadyRestarted: false,
      }));
      (remote ? leafContext : rootContext).buildPipelines = {
        pause: effect,
        cancel: effect,
        resume: effect,
        restartForCoordinator: restart,
      } as unknown as CommandContext["buildPipelines"];
      const association = {
        id: "provisioning-launch",
        projectId: scope.projectId,
        coordinatorId: scope.coordinatorId,
        conversationId: "earlier-conversation",
        kind: "build-pipeline" as const,
        resourceId: pipelineId,
        requestId: "launch",
        createsEnvironment: true,
        createdAt: new Date().toISOString(),
        ...(remote ? { nodeId: LEAF } : {}),
      };
      const invoke = () =>
        tool(action === "restart" ? "restart_build_pipeline_step" : `${action}_build_pipeline`, {
          pipelineId,
          requestId: "restart",
          ...(remote ? { nodeId: LEAF } : {}),
        });
      // Opt-in cannot stand in for a missing launch when there is no environment.
      await world.storage.patchRepositorySettings(world.projectId, {
        coordinatorOtherEnvironments: true,
      });
      await world.storage.coordinators.saveCoordinatorWorkflowAssociation(association);
      for (const wrong of [
        { pending: true },
        { coordinatorId: "another-coordinator" },
        { resourceId: "another-pipeline" },
        { kind: "graph-run" as const },
        { nodeId: remote ? undefined : LEAF },
      ]) {
        await world.storage.coordinators.updateCoordinatorWorkflowAssociation(
          association.id,
          (row) => {
            Object.assign(row, { pending: false, nodeId: undefined }, association, wrong);
            return true;
          },
        );
        refused(await invoke());
      }
      expect(effect).not.toHaveBeenCalled();
      expect(restart).not.toHaveBeenCalled();
      await world.storage.patchRepositorySettings(world.projectId, {}, [
        "coordinatorOtherEnvironments",
      ]);
      await world.storage.coordinators.updateCoordinatorWorkflowAssociation(
        association.id,
        (row) => {
          Object.assign(row, { pending: false, nodeId: undefined }, association);
          return true;
        },
      );
      const allowed = await invoke();
      expect({ isError: allowed.isError, text: allowed.isError ? allowed.text : "ok" }).toEqual({
        isError: false,
        text: "ok",
      });
      if (action === "restart") {
        expect(restart).toHaveBeenCalledTimes(1);
        expect((await invoke()).isError).toBe(false);
        expect(restart).toHaveBeenCalledTimes(1);
        // Also exercise the command directly; the MCP preflight is not its authority.
        await world.storage.coordinators.updateCoordinatorWorkflowAssociation(
          association.id,
          (row) => {
            row.pending = true;
            return true;
          },
        );
        await expect(
          commands.get("restart_coordinator_build_pipeline_step")!(
            {
              scope,
              input: { pipelineId, requestId: "direct", ...(remote ? { nodeId: LEAF } : {}) },
            },
            rootContext,
          ),
        ).rejects.toThrow(COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL);
      } else {
        expect(effect).toHaveBeenCalledWith(pipelineId);
      }
      // Publication switches back to environment authority; membership cannot adopt it.
      const environmentId = remote ? leafWorkerId : handMade;
      await world.storage.coordinators.updateCoordinatorWorkflowAssociation(
        association.id,
        (row) => {
          delete row.createsEnvironment;
          return true;
        },
      );
      await storage.saveBuildPipeline(pipelineId, projectId, environmentId, 2, {
        ...snapshot,
        environmentId,
      });
      refused(await invoke());
    });
  }
}

for (const status of ["provisioning", "failed", "cancelled", "cancelling"] as const) {
  test(`owned graph cancellation without an environment (${status})`, async () => {
    const run = graphRunFixture({ projectId: world.projectId, status });
    delete run.environmentId;
    const cancel = mock(async () => ({ ...run, status: "cancelled" as const }));
    rootContext.graphRuns = {
      get: async () => run,
      cancel,
    } as unknown as CommandContext["graphRuns"];
    const invoke = () => tool("cancel_graph_run", { runId: run.id });
    const association = {
      id: "provisioning-graph",
      projectId: scope.projectId,
      coordinatorId: scope.coordinatorId,
      conversationId: "earlier-conversation",
      kind: "graph-run" as const,
      resourceId: run.id,
      requestId: "launch-graph",
      createdAt: new Date().toISOString(),
    };
    await world.storage.patchRepositorySettings(world.projectId, {
      coordinatorOtherEnvironments: true,
    });
    await world.storage.coordinators.saveCoordinatorWorkflowAssociation(association);
    for (const wrong of [
      { pending: true },
      { coordinatorId: "other" },
      { resourceId: "other" },
      { kind: "build-pipeline" as const },
      { nodeId: LEAF },
    ]) {
      await world.storage.coordinators.updateCoordinatorWorkflowAssociation(
        association.id,
        (row) => {
          Object.assign(row, { pending: false, nodeId: undefined }, association, wrong);
          return true;
        },
      );
      const denied = await invoke();
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain(COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL);
    }
    expect(cancel).not.toHaveBeenCalled();
    await world.storage.patchRepositorySettings(world.projectId, {}, [
      "coordinatorOtherEnvironments",
    ]);
    await world.storage.coordinators.updateCoordinatorWorkflowAssociation(association.id, (row) => {
      Object.assign(row, { pending: false, nodeId: undefined }, association);
      return true;
    });
    const allowed = await invoke();
    expect(allowed.isError).toBe(false);
    expect(allowed.structuredContent).toMatchObject({ cancelled: status === "provisioning" });
    expect(cancel).toHaveBeenCalledTimes(status === "provisioning" ? 1 : 0);
    if (status === "provisioning") {
      run.status = "cancelled";
      expect((await invoke()).structuredContent).toMatchObject({ cancelled: false });
      expect(cancel).toHaveBeenCalledTimes(1);
    }
    run.environmentId = handMade;
    expect((await invoke()).isError).toBe(true);
    delete run.environmentId;
    run.projectId = "another-project";
    expect((await invoke()).isError).toBe(true);
  });
}

for (const workflow of ["graph", "review", "remote-review"] as const) {
  for (const authority of ["none", "opt-in", "creation"] as const) {
    test(`${workflow} cancellation requires environment authority: ${authority}`, async () => {
      const remote = workflow === "remote-review";
      const storage = remote ? leaf : world.storage;
      const environmentId = remote ? leafWorkerId : handMade;
      const projectId = (await storage.getEnvironment(environmentId))!.projectId;
      const cancel = mock(async () => ({
        id: "review-target",
        projectId,
        environmentId,
        phase: "cancelled",
      }));
      if (workflow === "graph") {
        const run = graphRunFixture({ projectId, environmentId });
        const cancelGraph = mock(async () => ({ ...run, status: "cancelled" as const }));
        rootContext.graphRuns = {
          get: async () => run,
          cancel: cancelGraph,
        } as unknown as CommandContext["graphRuns"];
        if (authority === "opt-in") await allowOthers();
        if (authority === "creation") await launched(environmentId);
        const result = await tool("cancel_graph_run", { runId: run.id });
        if (authority === "none") {
          expect(result.isError).toBe(true);
          expect(result.text).toBe(`graph-error: ${COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL}`);
        } else {
          expect(result.isError).toBe(false);
          expect(cancelGraph).toHaveBeenCalledWith(run.id);
        }
        expect(cancelGraph).toHaveBeenCalledTimes(authority === "none" ? 0 : 1);
      } else {
        await storage.saveMultiReviewWorkflow("review-target", environmentId, 1, {
          id: "review-target",
          projectId,
          environmentId,
          phase: "reviewing",
        });
        (remote ? leafContext : rootContext).multiReviews = {
          cancel,
        } as unknown as CommandContext["multiReviews"];
        if (authority === "opt-in") await allowOthers();
        if (authority === "creation") await launched(environmentId, remote ? { nodeId: LEAF } : {});
        const result = await tool("cancel_multi_review", {
          workflowId: "review-target",
          ...(remote ? { nodeId: LEAF } : {}),
        });
        if (authority === "none") refused(result);
        else {
          expect(result.isError).toBe(false);
          expect(cancel).toHaveBeenCalledWith("review-target");
        }
        expect(cancel).toHaveBeenCalledTimes(authority === "none" ? 0 : 1);
      }
    });
  }
}

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
  const tab = { environmentId, tabId: "startup-agent" };
  return {
    cancel_multi_review: { workflowId: "review-target" },
    pause_build_pipeline: { pipelineId: "pipeline-target" },
    cancel_build_pipeline: { pipelineId: "pipeline-target" },
    resume_build_pipeline: { pipelineId: "pipeline-target" },
    restart_build_pipeline_step: { pipelineId: "pipeline-target", requestId: crypto.randomUUID() },
    launch_job: { ...request, prompt: "Run this" },
    send_prompt_to_tab: { ...request, tabId: "startup-agent", prompt: "Run this" },
    launch_terminal: { ...request, command: "bun test" },
    open_worker_browser: { ...request, url: "http://127.0.0.1:3000/" },
    edit_worker_tab: { ...tab, operation: "close" },
    stop_worker_turn: { ...request, tabId: "startup-agent" },
    run_worker_command: { ...request, tabId: "startup-agent", command: "/review" },
    set_worker_goal: { ...request, tabId: "startup-agent", objective: "Finish", maxIterations: 2 },
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
      ([key, value]) =>
        /(?:environmentId|pipelineId|workflowId|runId)$/i.test(key) ||
        key === "environment" ||
        names(value),
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
      tabId: "startup-agent",
      prompt: "Run this",
      nodeId: LEAF,
    }),
  );
  expect(routed).not.toContain("deliver_node_mail");
  expect(routed).not.toContain("dispatch_native_agent_intent");
});

test("each refusal is counted by surface, node and tool, and no id is kept (6080 task 6)", async () => {
  coordinatorEnvironmentRefusals.reset();
  refused(await tool("send_message", message(handMade)));
  // A reply to the hand-made environment's own mail is refused too, and counted apart.
  const parent = await world.send(handMadeActor, "coordinator", "A question");
  refused(await tool("send_message", message(handMade, { replyToMessageId: parent.id })));
  refused(await tool("send_message", message(leafWorkerId, { nodeId: LEAF })));
  refused(
    await tool("send_prompt_to_tab", {
      requestId: "prompt",
      environmentId: leafWorkerId,
      tabId: "startup-agent",
      prompt: "Run this",
      nodeId: LEAF,
    }),
  );
  refused(await tool("launch_job", { ...actions(handMade).launch_job }));
  // A passing check counts nothing.
  await launched(handMade);
  expect((await tool("start_environment", { environmentId: handMade })).text).not.toBe(
    COORDINATOR_ENVIRONMENT_ORIGIN_REFUSAL,
  );
  const snapshot = coordinatorEnvironmentRefusals.snapshot();
  expect(snapshot).toEqual({
    total: 5,
    bySurface: {
      "mail:local": 1,
      "mail-reply:local": 1,
      "node-mail:remote": 1,
      "tool:remote": 1,
      "tool:local": 1,
    },
    byTool: { send_prompt_to_tab: 1, launch_job: 1 },
  });
  const serialized = JSON.stringify(snapshot);
  for (const id of [handMade, leafWorkerId, world.projectId, scope.coordinatorId, parent.id]) {
    expect(serialized).not.toContain(id);
  }
});

test("with the setting on, each action succeeds and reaches its effect", async () => {
  await world.storage.patchRepositorySettings(world.projectId, {
    coordinatorOtherEnvironments: true,
  });
  const sent = await tool("send_message", message(handMade));
  expect(sent.isError).toBe(false);
  expect(await world.undelivered(handMadeActor)).toHaveLength(1);
  // Each action has an independent downstream effect. Delegation ownership is
  // covered by its owning suites; avoid a prior action holding this test's tab.
  commands.set("assert_coordinator_delegation_available", async () => ({ available: true }));
  commands.set("open_coordinator_delegation", async () => ({ opened: true }));
  const effects: Record<string, string> = {
    cancel_multi_review: "cancel_multi_review",
    pause_build_pipeline: "pause_build_pipeline",
    cancel_build_pipeline: "cancel_build_pipeline",
    resume_build_pipeline: "resume_build_pipeline",
    restart_build_pipeline_step: "restart_coordinator_build_pipeline_step",
    launch_job: "launch_control_job",
    send_prompt_to_tab: "dispatch_native_agent_intent",
    launch_terminal: "launch_coordinator_terminal",
    open_worker_browser: "open_coordinator_browser",
    edit_worker_tab: "edit_coordinator_worker_tab",
    stop_worker_turn: "stop_coordinator_worker_turn",
    run_worker_command: "run_coordinator_worker_command",
    set_worker_goal: "set_coordinator_worker_goal",
    pause_worker_goal: "pause_coordinator_worker_goal",
    clear_worker_goal: "clear_coordinator_worker_goal",
    fork_worker: "fork_coordinator_worker",
    start_environment: "start_environment_background",
    stop_environment: "stop_environment",
    create_pr: "create_coordinator_pr",
    resolve_conflicts: "resolve_coordinator_conflicts",
    launch_multi_review: "launch_coordinator_multi_review_action",
    start_build_pipeline: "start_coordinator_build_pipeline",
    launch_graph: "start_coordinator_graph_run",
    transfer_files: "transfer_node_files",
  };
  commands.set("get_native_agent_model_catalog", async () => []);
  commands.set("verify_project_launch_base", async () => ({ contained: true }));
  commands.set("get_project_base_branch_tip", async () => ({
    branch: "main",
    commit: BASE,
    ref: "origin/main",
    fetched: true,
  }));
  for (const [name, input] of Object.entries(actions(handMade))) {
    const effect = effects[name]!;
    const handler = mock(async () => ({
      id: "pipeline-target",
      projectId: scope.projectId,
      environmentId: handMade,
      tabId: "startup-agent",
      phase: "paused",
      status: "accepted",
      outcome: "dispatched",
      restarted: true,
      launch: { runId: "graph-run" },
      workflow: {
        id: "review",
        projectId: scope.projectId,
        environmentId: handMade,
        phase: "preparing",
      },
    }));
    const previous = commands.get(effect);
    commands.set(effect, handler);
    const result = await tool(name, {
      ...input,
      ...(name === "launch_job" ? { agent: "codex" } : {}),
    });
    expect({ name, isError: result.isError, text: result.isError ? result.text : "ok" }).toEqual({
      name,
      isError: false,
      text: "ok",
    });
    expect(handler).toHaveBeenCalledTimes(1);
    if (previous) commands.set(effect, previous);
    else commands.delete(effect);
  }
  const delivered = mock(async () => ({
    messageId: "remote-mail",
    toEnvironmentId: leafWorkerId,
    toTabId: "agent",
    placement: "pending-inject",
  }));
  commands.set("deliver_node_mail", delivered);
  const remote = await tool("send_message", message(leafWorkerId, { nodeId: LEAF }));
  expect(remote.isError).toBe(false);
  expect(delivered).toHaveBeenCalledTimes(1);
  expect(remote.structuredContent).toMatchObject({ message: { messageId: "remote-mail" } });
});

test("turning the setting off again refuses again: nothing sticks", async () => {
  await world.storage.patchRepositorySettings(world.projectId, {
    coordinatorOtherEnvironments: true,
  });
  expect((await tool("send_message", message(handMade))).isError).toBe(false);
  await world.storage.patchRepositorySettings(world.projectId, {}, [
    "coordinatorOtherEnvironments",
  ]);
  refused(await tool("send_message", message(handMade)));
});

test("an environment this coordinator launched passes", async () => {
  await launched(handMade);
  expect((await tool("send_message", message(handMade))).isError).toBe(false);
  const stop = mock(async () => ({ stopped: true }));
  commands.set("stop_environment", stop);
  const result = await tool("stop_environment", { environmentId: handMade });
  expect(result.isError).toBe(false);
  expect(stop).toHaveBeenCalledTimes(1);
});

test("its own worker on another node passes", async () => {
  await launched(leafWorkerId, { nodeId: LEAF });
  const deliver = mock(async () => ({
    messageId: "own-remote",
    toEnvironmentId: leafWorkerId,
    toTabId: "agent",
    placement: "pending-inject",
  }));
  commands.set("deliver_node_mail", deliver);
  const result = await tool("send_message", message(leafWorkerId, { nodeId: LEAF }));
  expect(result.isError).toBe(false);
  expect(deliver).toHaveBeenCalledTimes(1);
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
    createdEnvironmentId: handMade,
    resourceId: "pipeline-1",
    requestId: "pipeline-1",
    createdAt: new Date().toISOString(),
  });
  await world.storage.saveBuildPipeline("pipeline-1", world.projectId, handMade, 1, {
    id: "pipeline-1",
    projectId: world.projectId,
    environmentId: handMade,
  } as never);
  expect((await tool("send_message", message(handMade))).isError).toBe(false);
});

test("a review association never grants creation authority", async () => {
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
  refused(await tool("send_message", message(handMade)));
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
  await world.storage.patchRepositorySettings(world.projectId, {
    coordinatorOtherEnvironments: true,
  });
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

test("operator reads do not mark the project home", async () => {
  const home = createEnvironment(world.projectId, { name: "home", environmentType: "local" });
  Object.assign(home, { status: "running", setupPhase: "ready", projectHome: true });
  await world.storage.addEnvironment(home);
  // The default operator credential in this world's own data directory.
  await mcp.start();
  const operator = await readControlMcpDescriptor(mcp.getInfo()!.descriptorFile);
  const call = async (name: string, args: Record<string, unknown>) => {
    const { body } = await rpc(operator.url, operator.token, "tools/call", {
      name,
      arguments: args,
    });
    expect(body.result?.isError ?? false).toBe(false);
    return body.result?.structuredContent as Record<string, unknown>;
  };
  const listed = await call("list_environments", { projectId: world.projectId });
  const rows = listed.environments as Array<Record<string, unknown>>;
  const homeRow = rows.find((row) => row.id === home.id);
  expect(homeRow).toBeDefined();
  expect("projectHome" in homeRow!).toBe(false);
  const read = await call("get_environment", { environmentId: home.id });
  const environment = read.environment as Record<string, unknown>;
  expect(environment.id).toBe(home.id);
  expect("projectHome" in environment).toBe(false);
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

for (const kind of ["build-pipeline", "graph-run"] as const) {
  test(`${kind} creation remains authorized after capacity cleanup`, async () => {
    const createdAt = "2026-09-01T00:00:00Z";
    const origin = {
      id: "creation",
      projectId: scope.projectId,
      coordinatorId: scope.coordinatorId,
      conversationId: scope.conversationId,
      kind,
      resourceId: "gone-workflow",
      requestId: "created",
      createdAt,
      terminalNotifiedAt: createdAt,
      createdEnvironmentId: handMade,
    };
    const current = readStoredValue<Record<string, unknown>>(
      world.storage.getDataDir(),
      "coordinators.json",
    )!;
    seedStore(world.storage.getDataDir(), "coordinators.json", {
      ...current,
      workflows: [
        origin,
        ...Array.from({ length: MAX_COORDINATOR_WORKFLOW_ASSOCIATIONS - 1 }, (_, i) => ({
          ...origin,
          id: `old-${i}`,
          requestId: `old-${i}`,
          createdEnvironmentId: undefined,
        })),
      ],
    });
    await launched("another-environment");
    expect(
      (await world.storage.coordinators.listCoordinatorWorkflowAssociations(scope.projectId)).some(
        (row) => row.id === "creation",
      ),
    ).toBe(true);
    expect((await tool("send_message", message(handMade))).isError).toBe(false);
    const stop = mock(async () => ({ stopped: true }));
    commands.set("stop_environment", stop);
    expect((await tool("stop_environment", { environmentId: handMade })).isError).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });
}

for (const kind of ["build-pipeline", "multi-review", "graph-run"] as const) {
  for (const remote of kind === "graph-run" ? [false] : [false, true]) {
    test(`${kind} membership does not persist opt-in authority (${remote ? "remote" : "local"})`, async () => {
      const environmentId = remote ? leafWorkerId : handMade;
      await world.storage.patchRepositorySettings(world.projectId, {
        coordinatorOtherEnvironments: true,
      });
      await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
        id: "opt-in-workflow",
        projectId: scope.projectId,
        coordinatorId: scope.coordinatorId,
        conversationId: scope.conversationId,
        kind,
        resourceId: "existing-workflow",
        requestId: "existing-workflow",
        createdAt: new Date().toISOString(),
        ...(remote ? { nodeId: LEAF } : {}),
      });
      await world.storage.patchRepositorySettings(scope.projectId, {}, [
        "coordinatorOtherEnvironments",
      ]);
      refused(await tool("send_message", message(environmentId, remote ? { nodeId: LEAF } : {})));
      refused(
        await tool("send_prompt_to_tab", {
          environmentId,
          tabId: "startup-agent",
          requestId: "revoked",
          prompt: "Work",
          ...(remote ? { nodeId: LEAF } : {}),
        }),
      );
    });
    if (kind === "multi-review") continue;
    test(`${kind} creation receipt is scoped to its environment and node (${remote ? "remote" : "local"})`, async () => {
      const environmentId = remote ? leafWorkerId : handMade;
      await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
        id: "workflow-creator",
        projectId: scope.projectId,
        coordinatorId: scope.coordinatorId,
        conversationId: scope.conversationId,
        kind,
        resourceId: "workflow",
        requestId: "workflow",
        createdEnvironmentId: environmentId,
        createdAt: new Date().toISOString(),
        ...(remote ? { nodeId: LEAF } : {}),
      });
      const stop = mock(async () => ({ stopped: true }));
      commands.set("stop_environment", stop);
      const allowed = await tool("stop_environment", {
        environmentId,
        ...(remote ? { nodeId: LEAF } : {}),
      });
      expect(allowed.isError).toBe(false);
      expect(stop).toHaveBeenCalledTimes(1);
      const unowned = await (remote ? leaf : world.storage).addEnvironment(
        createEnvironment(
          remote ? (await leaf.getEnvironment(leafWorkerId))!.projectId : scope.projectId,
          {
            name: "not-created",
            environmentType: "local",
          },
        ),
      );
      refused(
        await tool("stop_environment", {
          environmentId: unowned.id,
          ...(remote ? { nodeId: LEAF } : {}),
        }),
      );
      if (remote) {
        const wrongNode = await tool("stop_environment", { environmentId });
        expect(wrongNode.isError).toBe(true);
        expect(wrongNode.text).toBe("That environment does not belong to this project.");
      }
      expect(stop).toHaveBeenCalledTimes(1);
    });
  }
}

for (const remote of [false, true]) {
  test(`real ${remote ? "node" : "local"} admission reuse never grants the operator environment's creation authority`, async () => {
    const storage = remote ? leaf : world.storage;
    const environmentId = remote ? leafWorkerId : handMade;
    const environment = (await storage.getEnvironment(environmentId))!;
    const ticket = await storage.kanban.addKanbanTask(environment.projectId, "Operator build", "");
    const input = {
      projectId: environment.projectId,
      taskId: ticket.id,
      taskTitle: "Operator build",
      taskSnapshot: {
        title: "Operator build",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      environmentType: "local" as const,
      agentType: "codex" as const,
      delegationBaseBranch: "main",
      delegationBaseCommit: BASE,
    };
    let creations = 0;
    const service = new BuildPipelineService(
      storage,
      async <T>(command: string) => {
        if (command === "create_environment") {
          creations++;
          return environment as T;
        }
        if (command === "update_kanban_task") return undefined as T;
        if (command === "get_kanban_tasks") return [ticket] as T;
        throw new Error(`Unexpected admission command: ${command}`);
      },
      { autoAdvance: false },
    );
    (remote ? leafContext : rootContext).buildPipelines = service;
    try {
      const previousCount = (await storage.listBuildPipelines(environment.projectId)).length;
      const operator = await service.start({
        ...input,
        source: { type: "kanban", taskId: ticket.id },
      });
      expect(operator.coordinatorLaunchId).toBeUndefined();
      const command = remote
        ? "start_coordinator_node_build_pipeline"
        : "start_coordinator_build_pipeline";
      await expect(
        commands.get(command)!(
          {
            scope,
            requestId: "same-operator-admission",
            ...(remote ? { nodeId: LEAF } : {}),
            input: { ...input, projectId: world.projectId },
          },
          rootContext,
        ),
      ).rejects.toThrow("another caller");
      expect(creations).toBe(1);
      expect(await storage.listBuildPipelines(environment.projectId)).toHaveLength(
        previousCount + 1,
      );
      expect(
        await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId),
      ).toEqual([]);
      const mail = remote ? { ...message(environmentId), nodeId: LEAF } : message(environmentId);
      refused(await tool("send_message", mail));
      refused(
        await tool("pause_build_pipeline", {
          pipelineId: operator.id,
          ...(remote ? { nodeId: LEAF } : {}),
        }),
      );
      expect((await storage.getBuildPipeline(operator.id))!.snapshot).not.toHaveProperty(
        "coordinatorLaunchId",
      );
    } finally {
      await service.shutdown();
    }
  });
}

test("remote receipt repair settles failed and missing resources, preserves transport uncertainty, and bounds repeated lookups", async () => {
  for (let index = 0; index < 40; index++) {
    await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: `repair-${index}`,
      ...scope,
      kind: "build-pipeline",
      resourceId: `pipeline-${index}`,
      requestId: `repair-${index}`,
      nodeId: LEAF,
      createsEnvironment: true,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
  }
  const calls: string[] = [];
  const node = {
    nodeId: LEAF,
    projectId: (await leaf.getEnvironment(leafWorkerId))!.projectId,
    call: async <T>(_command: string, args?: Record<string, unknown>): Promise<T> => {
      const id = String(args?.pipelineId);
      calls.push(id);
      if (id === "pipeline-0") return null as T;
      if (id === "pipeline-1")
        return {
          snapshot: { projectId: node.projectId, phase: "failed", coordinatorLaunchId: "repair-1" },
        } as T;
      if (id === "pipeline-2") throw new Error("link unavailable");
      return {
        snapshot: {
          projectId: node.projectId,
          phase: "creating-environment",
          coordinatorLaunchId: id.replace("pipeline", "repair"),
        },
      } as T;
    },
  };
  expect(await coordinatorCreatedEnvironment(rootContext, scope, leafWorkerId, node)).toBe(false);
  expect(calls).toHaveLength(MAX_REMOTE_RECEIPT_LOOKUPS);
  expect(await coordinatorCreatedEnvironment(rootContext, scope, leafWorkerId, node)).toBe(false);
  expect(calls).toHaveLength(2 * MAX_REMOTE_RECEIPT_LOOKUPS);
  expect(new Set(calls).size).toBe(calls.length);
  await coordinatorCreatedEnvironment(rootContext, scope, leafWorkerId, node);
  await coordinatorCreatedEnvironment(rootContext, scope, leafWorkerId, node);
  expect(calls).toHaveLength(40);
  expect(new Set(calls).size).toBe(40);
  const records = await world.storage.coordinators.listCoordinatorWorkflowAssociations(
    world.projectId,
  );
  const settled = records.filter((record) => record.environmentCreationSettledAt);
  expect(settled.map((record) => record.id)).toEqual(["repair-0", "repair-1"]);
  expect(
    records.find((record) => record.id === "repair-2")!.environmentCreationSettledAt,
  ).toBeUndefined();
  const selectAt = (now: number) =>
    selectCoordinatorWorkflowsToClear({
      workflows: records,
      now,
      environmentExists: () => false,
      resourceState: (record) => (record.environmentCreationSettledAt ? "finished" : "unknown"),
    });
  expect(selectAt(Date.now())).toEqual(new Set());
  expect(selectAt(Date.now() + COORDINATOR_WORKFLOW_REPLAY_WINDOW_MS + 1)).toEqual(
    new Set(["repair-0", "repair-1"]),
  );
  await world.storage.patchRepositorySettings(world.projectId, {
    coordinatorOtherEnvironments: true,
  });
  await assertCoordinatorMayActOnEnvironment(rootContext, scope, leafWorkerId, node);
  expect(calls).toHaveLength(40);
});

test("remote late provisioning with a foreign admission identity cannot repair a creation receipt", async () => {
  await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: "foreign-repair",
    ...scope,
    kind: "build-pipeline",
    resourceId: "foreign-pipeline",
    requestId: "foreign-repair",
    nodeId: LEAF,
    createsEnvironment: true,
    createdAt: new Date().toISOString(),
  });
  const node = {
    nodeId: LEAF,
    projectId: "leaf-project",
    call: async <T>() =>
      ({
        snapshot: {
          projectId: "leaf-project",
          environmentId: leafWorkerId,
          coordinatorLaunchId: "operator-launch",
        },
      }) as T,
  };
  expect(await coordinatorCreatedEnvironment(rootContext, scope, leafWorkerId, node)).toBe(false);
  const [receipt] = await world.storage.coordinators.listCoordinatorWorkflowAssociations(
    world.projectId,
  );
  expect(receipt!.createdEnvironmentId).toBeUndefined();
  expect(receipt!.environmentCreationSettledAt).toBeDefined();
});

test("an early remote repair match leaves the next receipt eligible immediately", async () => {
  for (const index of [1, 2]) {
    await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
      id: `early-repair-${index}`,
      ...scope,
      kind: "build-pipeline",
      resourceId: `early-pipeline-${index}`,
      requestId: `early-repair-${index}`,
      nodeId: LEAF,
      createsEnvironment: true,
      createdAt: new Date().toISOString(),
    });
  }
  const calls: string[] = [];
  const node = {
    nodeId: LEAF,
    projectId: "leaf-project",
    call: async <T>(_command: string, args?: Record<string, unknown>): Promise<T> => {
      const id = String(args?.pipelineId);
      calls.push(id);
      const index = id.endsWith("1") ? 1 : 2;
      return {
        snapshot: {
          projectId: "leaf-project",
          environmentId: `repaired-environment-${index}`,
          coordinatorLaunchId: `early-repair-${index}`,
        },
      } as T;
    },
  };
  expect(
    await coordinatorCreatedEnvironment(rootContext, scope, "repaired-environment-1", node),
  ).toBe(true);
  expect(
    await coordinatorCreatedEnvironment(rootContext, scope, "repaired-environment-2", node),
  ).toBe(true);
  expect(calls).toEqual(["early-pipeline-1", "early-pipeline-2"]);
});

test("overlapping authority checks share the remote repair and receipt publication", async () => {
  await world.storage.coordinators.saveCoordinatorWorkflowAssociation({
    id: "overlap-repair",
    ...scope,
    kind: "build-pipeline",
    resourceId: "overlap-pipeline",
    requestId: "overlap-repair",
    nodeId: LEAF,
    createsEnvironment: true,
    createdAt: new Date().toISOString(),
  });
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const lookup = mock(async () => {
    started.resolve();
    await release.promise;
    return {
      snapshot: {
        projectId: "leaf-project",
        environmentId: leafWorkerId,
        coordinatorLaunchId: "overlap-repair",
      },
    };
  });
  const node = {
    nodeId: LEAF,
    projectId: "leaf-project",
    call: async <T>(): Promise<T> => (await lookup()) as T,
  };
  const first = coordinatorCreatedEnvironment(rootContext, scope, leafWorkerId, node);
  await started.promise;
  // Observe the second store read while the first remote lookup is blocked.
  const read = world.storage.coordinators.listCoordinatorWorkflowAssociations.bind(
    world.storage.coordinators,
  );
  const secondRead = Promise.withResolvers<void>();
  world.storage.coordinators.listCoordinatorWorkflowAssociations = async (projectId) => {
    const records = await read(projectId);
    secondRead.resolve();
    return records;
  };
  const second = coordinatorCreatedEnvironment(rootContext, scope, leafWorkerId, node);
  await secondRead.promise;
  release.resolve();
  expect(await Promise.all([first, second])).toEqual([true, true]);
  expect(lookup).toHaveBeenCalledTimes(1);
  const [receipt] = await read(scope.projectId);
  expect(receipt?.createdEnvironmentId).toBe(leafWorkerId);
});

for (const remote of [false, true]) {
  for (const missing of [false, true]) {
    for (const optIn of [false, true]) {
      test(`scope preflight reports project access for ${missing ? "missing" : "foreign"} environment (${remote ? "remote" : "local"}, opt-in ${optIn})`, async () => {
        const storage = remote ? leaf : world.storage;
        let environmentId = "missing-environment";
        if (!missing) {
          const project = await storage.addProject(
            createProject("https://github.com/other/repo.git"),
          );
          const environment = await storage.addEnvironment(
            createEnvironment(project.id, {
              name: "foreign",
              environmentType: "local",
            }),
          );
          environmentId = environment.id;
        }
        if (optIn) await allowOthers();
        const result = await tool("stop_environment", {
          environmentId,
          ...(remote ? { nodeId: LEAF } : {}),
        });
        expect(result.isError).toBe(true);
        expect(result.text).toBe(
          remote
            ? "That environment does not belong to this project on that node."
            : "That environment does not belong to this project.",
        );
        expect(result.text).not.toContain(COORDINATOR_OTHER_ENVIRONMENTS_SETTING_LABEL);
        expect(routed).not.toContain("stop_environment");
      });
    }
  }
}
