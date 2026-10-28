import { expect, test } from "bun:test";
import path from "node:path";
import { coordinatorRoleCapabilities, type CoordinatorControlScope } from "./control-mcp-tools.js";
import { ControlMcpServer } from "./control-mcp-server.js";
import { MailWorld } from "./agent-mail-world-test-support.js";
import { BackendRuntime } from "./backend-runtime.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
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
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]!.requestId).toBe(dispatched[1]!.requestId);
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
    expect(dispatched).toHaveLength(2);
  } finally {
    await mcp?.stop();
    await world.close();
  }
});
