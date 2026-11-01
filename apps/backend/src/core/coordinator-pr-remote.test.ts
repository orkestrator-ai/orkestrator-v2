import { expect, test } from "bun:test";
import path from "node:path";
import { coordinatorRoleCapabilities, type CoordinatorControlScope } from "./control-mcp-tools.js";
import { ControlMcpServer } from "./control-mcp-server.js";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { BackendRuntime } from "./backend-runtime.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
import {
  NodeCoordinatorRemote,
  type NodeCoordinatorRemoteDeps,
} from "./nodes/node-coordinator-remote.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";

// Real MCP dispatch, scope checks, receipts, controller commands, native job
// admission and tab persistence; only the node transport and agent are simulated.
test("a reviewed remote worker gets one PR tab with its node's defaults, including after a lost acknowledgement", async () => {
  const world = await MailWorld.create();
  let mcp: ControlMcpServer | undefined;
  try {
    await world.storage.updateProject(world.projectId, {
      gitUrl: "https://github.com/acme/site.git",
    });
    const leaf = new StorageService(path.join(world.root, "leaf"));
    await leaf.init();
    const project = await leaf.addProject(
      createProject("https://github.com/acme/site.git", world.root),
    );
    await leaf.updateGlobalConfig({
      ...(await leaf.loadConfig()).global,
      agentSettings: { defaultAgent: "codex" },
    });
    await leaf.updateRepositoryConfig(project.id, {
      defaultBranch: "main",
      prBaseBranch: "develop",
    });
    const worker = createEnvironment(project.id, { name: "reviewed", environmentType: "local" });
    Object.assign(worker, { status: "running", setupPhase: "ready", worktreePath: world.root });
    await leaf.addEnvironment(worker);
    await leaf.saveMultiReviewWorkflow("reviewed", worker.id, 1, {
      id: "reviewed",
      environmentId: worker.id,
      phase: "completed",
      autoPr: false,
    });
    const dispatched: Array<Record<string, unknown>> = [];
    const leafContext = {
      storage: leaf,
      emit: () => undefined,
      appRoot: "",
      resourceRoot: "",
      environmentLifecycleTasks: {},
      runtime: new BackendRuntime({ emit: () => undefined }),
      nativeAgents: {
        ensureSession: async () => ({ providerSessionId: "pr-session" }),
        dispatchIntent: async (input: Record<string, unknown>) => {
          dispatched.push(input);
          return { outcome: "accepted" };
        },
      },
    } as unknown as CommandContext;
    const commands = createCommandRegistry();
    commands.set("pr_monitor_watch", async () => ({}));
    let loseAnswer = true;
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
              projects: [
                { ref: { projectId: project.id }, repositoryHint: "github.com/acme/site" },
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
          const result = await commands.get(command)!(args, leafContext);
          if (command === "create_controller_pr" && loseAnswer) {
            loseAnswer = false;
            return { outcome: "unknown" };
          }
          return { outcome: "ok", result };
        },
      },
      runtime: new BackendRuntime({ emit: () => undefined }),
    } as unknown as CommandContext;
    mcp = new ControlMcpServer(
      world.root,
      async <T>(command: string, args = {}) =>
        (await commands.get(command)!(args, rootContext)) as T,
    );
    const snapshot = await world.coordinator.ensure(world.projectId);
    const conversation = snapshot.workspace.conversations[0]!;
    const scope: CoordinatorControlScope = {
      role: "coordinator",
      projectId: world.projectId,
      coordinatorId: world.coordinatorId,
      conversationId: conversation.id,
      mailboxIncarnationId: conversation.mailboxIncarnationId!,
      capabilities: coordinatorRoleCapabilities("main"),
    };
    const input = { requestId: "publish", nodeId: "bk_leaf", environmentId: worker.id };
    const lost = await mcp.callCoordinatorTool(scope, "create_pr", input);
    expect(lost.isError).toBe(true);
    expect(lost.text).toContain("outcome is unknown");
    await leaf.updateEnvironment(worker.id, {
      prUrl: "https://github.com/acme/site/pull/1",
      prState: "open",
    });
    const result = await mcp.callCoordinatorTool(scope, "create_pr", input);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      nodeId: "bk_leaf",
      status: "launched",
      targetBranch: "develop",
    });
    expect(
      (await mcp.callCoordinatorTool(scope, "create_pr", input)).structuredContent,
    ).toMatchObject({ replayed: true });
    const layout = JSON.stringify((await leaf.getPaneLayout(worker.id))?.root);
    expect(layout.match(/"id":"agent-job-/g)).toHaveLength(1);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.prompt).toContain("develop");
    expect(await world.storage.getPaneLayout(worker.id)).toBeNull();

    // Both the coordinator boundary and the owning node refuse wrong projects
    // and the checkout. No extra PR jobs or tabs may be created.
    for (const changes of [
      { projectId: "other" },
      { projectHome: true },
      { deletionRequestedAt: new Date().toISOString() },
    ]) {
      const forbidden = createEnvironment(project.id, {
        name: "forbidden",
        environmentType: "local",
      });
      Object.assign(forbidden, changes);
      await leaf.addEnvironment(forbidden);
      expect(
        (
          await mcp.callCoordinatorTool(scope, "create_pr", {
            ...input,
            requestId: forbidden.id,
            environmentId: forbidden.id,
          })
        ).isError,
      ).toBe(true);
      await expect(
        commands.get("create_controller_pr")!(
          {
            projectId: project.id,
            environmentId: forbidden.id,
            requestId: forbidden.id,
          },
          leafContext,
        ),
      ).rejects.toThrow();
    }
    // A live pipeline still owns publication on the remote node.
    const pipelineWorker = createEnvironment(project.id, {
      name: "pipeline-worker",
      environmentType: "local",
      buildPipelineId: "active",
    });
    await leaf.addEnvironment(pipelineWorker);
    await leaf.saveBuildPipeline("active", project.id, pipelineWorker.id, 1, { phase: "building" });
    const refused = await mcp.callCoordinatorTool(scope, "create_pr", {
      ...input,
      requestId: "pipeline",
      environmentId: pipelineWorker.id,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("build pipeline");
    expect(dispatched).toHaveLength(1);
  } finally {
    await mcp?.stop();
    await world.close();
  }
});

// The remote Resolve Conflicts button, then the follow it records read back
// through the real node-link reads (`NodeCoordinatorRemote`): one wake when
// the Resolve tab finishes, one when the PR merges.
test("a remote worker's conflicts get one Resolve tab, and its PR is followed through the node link", async () => {
  const world = await MailWorld.create({ statusWakes: { coalesceMs: 0 } });
  let mcp: ControlMcpServer | undefined;
  try {
    await world.storage.updateProject(world.projectId, {
      gitUrl: "https://github.com/acme/site.git",
    });
    const leaf = new StorageService(path.join(world.root, "leaf"));
    await leaf.init();
    const project = await leaf.addProject(
      createProject("https://github.com/acme/site.git", world.root),
    );
    await leaf.updateRepositoryConfig(project.id, {
      defaultBranch: "main",
      prBaseBranch: "develop",
    });
    const prUrl = "https://github.com/acme/site/pull/9";
    const worker = createEnvironment(project.id, { name: "conflicted", environmentType: "local" });
    Object.assign(worker, {
      status: "running",
      setupPhase: "ready",
      worktreePath: world.root,
      prUrl,
      prState: "open",
      hasMergeConflicts: true,
      prMergeability: "dirty",
      prBaseBranch: "release/2",
    });
    await leaf.addEnvironment(worker);
    const dispatched: Array<Record<string, unknown>> = [];
    const leafContext = {
      storage: leaf,
      emit: () => undefined,
      appRoot: "",
      resourceRoot: "",
      environmentLifecycleTasks: {},
      runtime: new BackendRuntime({ emit: () => undefined }),
      nativeAgents: {
        ensureSession: async () => ({ providerSessionId: "resolve-session" }),
        dispatchIntent: async (input: Record<string, unknown>) => {
          dispatched.push(input);
          return { outcome: "accepted" };
        },
      },
    } as unknown as CommandContext;
    const commands = createCommandRegistry();
    let confirmed = false;
    const summaries = async () => ({
      selfId: "bk_command",
      nodes: [
        {
          nodeId: "bk_leaf",
          available: true,
          freshness: "current",
          view: { displayName: "Build node" },
          projects: [{ ref: { projectId: project.id }, repositoryHint: "github.com/acme/site" }],
          environments: [
            {
              ref: { environmentId: worker.id },
              ...(confirmed ? { prMonitorConfirmed: true } : {}),
            },
          ],
        },
      ],
    });
    let loseResolveAnswer = true;
    const invokeOnNode = async ({
      command,
      args,
    }: {
      command: string;
      args: Record<string, unknown>;
    }) => {
      const result = await commands.get(command)!(args, leafContext);
      if (command === "resolve_controller_conflicts" && loseResolveAnswer) {
        loseResolveAnswer = false;
        return { outcome: "unknown" };
      }
      return { outcome: "ok", result };
    };
    const rootContext = {
      storage: world.storage,
      coordinators: world.coordinator,
      nodes: { status: async () => ({ nodeId: "bk_command", mode: "command" }) },
      nodePortal: { summaries, invokeOnNode },
      runtime: new BackendRuntime({ emit: () => undefined }),
    } as unknown as CommandContext;
    mcp = new ControlMcpServer(
      world.root,
      async <T>(command: string, args = {}) =>
        (await commands.get(command)!(args, rootContext)) as T,
    );
    const remote = new NodeCoordinatorRemote({
      invokeOnNode,
      summaries: summaries as unknown as NodeCoordinatorRemoteDeps["summaries"],
    });
    // The worker tab's turn on its node; the agent registry read is simulated.
    let tab: "working" | "idle" = "working";
    remote.workerState = async () => ({ environment: "running", tab });
    world.coordinator.setRemoteAccess(remote);
    const snapshot = await world.coordinator.ensure(world.projectId);
    const conversation = snapshot.workspace.conversations[0]!;
    const scope: CoordinatorControlScope = {
      role: "coordinator",
      projectId: world.projectId,
      coordinatorId: world.coordinatorId,
      conversationId: conversation.id,
      mailboxIncarnationId: conversation.mailboxIncarnationId!,
      capabilities: coordinatorRoleCapabilities("main"),
    };
    const input = { requestId: "resolve", nodeId: "bk_leaf", environmentId: worker.id };
    expect((await mcp.callCoordinatorTool(scope, "resolve_conflicts", input)).isError).toBe(true);
    await leaf.updateEnvironment(worker.id, { hasMergeConflicts: false });
    const result = await mcp.callCoordinatorTool(scope, "resolve_conflicts", input);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      nodeId: "bk_leaf",
      status: "launched",
      targetBranch: "release/2",
      prUrl,
    });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.prompt).toContain("git merge origin/release/2");
    // The button's completion action: the leaf's monitor rechecks when it ends.
    expect(
      (await leaf.getEnvironment(worker.id))?.prRecheckAfterAgentCompletionArmedAt,
    ).toBeTruthy();
    const follows = (
      await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)
    ).filter((item) => item.kind === "pull-request");
    expect(follows).toEqual([
      expect.objectContaining({
        resourceId: worker.id,
        nodeId: "bk_leaf",
        pullRequest: expect.objectContaining({ source: "resolve-conflicts", prUrl }),
      }),
    ]);

    const main = await world.main();
    await world.coordinator.reconcileWorkflowNotifications();
    remote.workerState = async () => "unavailable";
    await world.coordinator.reconcileWorkflowNotifications();
    expect(
      (await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)).find(
        (item) => item.kind === "pull-request",
      )?.pullRequest?.resolve?.finishedAt,
    ).toBeUndefined();
    remote.workerState = async () => ({ environment: "running", tab });
    await world.coordinator.reconcileWorkflowNotifications();
    expect(
      (await world.storage.coordinators.listCoordinatorWorkflowAssociations(world.projectId)).find(
        (item) => item.kind === "pull-request",
      )?.pullRequest?.resolve?.finishedAt,
    ).toBeUndefined();
    tab = "idle";
    // The leaf's recheck: no conflicts, the refresh disarmed, its monitor vouches.
    await leaf.updateEnvironment(worker.id, {
      hasMergeConflicts: false,
      prMergeability: "clean",
      prRecheckAfterAgentCompletionArmedAt: undefined,
    });
    confirmed = true;
    await world.coordinator.reconcileWorkflowNotifications();
    await world.deliver();
    expect(
      world
        .carriers(main)
        .flat()
        .map((carrier) => carrier.notice?.state),
    ).toEqual(["resolve-finished"]);
    const [report] = world.carriers(main)[0]!;
    expect(report!.subject).toContain("conflicted on Build node");
    expect(report!.subject).toContain("ready to merge");
    expect(report!.body).toContain(
      `get_environment { "nodeId": "bk_leaf", "environmentId": "${worker.id}" }`,
    );
    await world.finishTurn(main);

    await leaf.updateEnvironment(worker.id, { prState: "merged" });
    // The owning node applies the button's precondition too.
    await expect(
      commands.get("resolve_controller_conflicts")!(
        { projectId: project.id, environmentId: worker.id, requestId: "again" },
        leafContext,
      ),
    ).rejects.toThrow("is merged");
    await leaf.removeEnvironment(worker.id);
    const restoredLeaf = new StorageService(leaf.getDataDir());
    await restoredLeaf.init();
    leafContext.storage = restoredLeaf;
    await world.restart();
    world.coordinator.setRemoteAccess(remote);
    await world.coordinator.reconcileWorkflowNotifications();
    await world.deliver();
    await world.coordinator.reconcileWorkflowNotifications();
    await world.deliver();
    expect(
      world
        .carriers(main)
        .flat()
        .map((carrier) => carrier.notice?.state),
    ).toEqual(["resolve-finished", "pr-merged"]);
  } finally {
    await mcp?.stop();
    await world.close();
  }
});
