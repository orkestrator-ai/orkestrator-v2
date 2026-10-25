import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
import { ProjectGitService } from "./project-git-service.js";
import { CoordinatorService } from "./coordinator-service.js";
import { createEnvironment, createProject, StorageService } from "./storage.js";
import { runCommand } from "./shell.js";
import { coordinatorRuntimeId } from "@orkestrator/protocol/coordinator";
import { nativeAgentSessionStorageKey } from "./native-agent-service.js";
import { PANE_LAYOUT_VERSION } from "@orkestrator/protocol/pane-layout";
import {
  COORDINATOR_DELEGATION_FRAME_OPEN,
  COORDINATOR_DELEGATION_PRESENTATION,
} from "@orkestrator/protocol/review-evidence-frames";
import { BackendRuntime } from "./backend-runtime.js";
import { __testing as __seedTesting } from "./host-model-catalog-seed.js";

describe("coordinator command registry", () => {
  let root: string;
  let checkout: string;
  let storage: StorageService;
  let coordinator: CoordinatorService;
  let context: CommandContext;
  let commands: ReturnType<typeof createCommandRegistry>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "ork-coordinator-commands-"));
    checkout = path.join(root, "checkout");
    await fs.mkdir(checkout);
    await runCommand("git", ["init", "-b", "main"], { cwd: checkout });
    await runCommand("git", ["config", "user.email", "test@example.invalid"], { cwd: checkout });
    await runCommand("git", ["config", "user.name", "Coordinator Test"], { cwd: checkout });
    await fs.writeFile(path.join(checkout, "README.md"), "initial\n");
    await runCommand("git", ["add", "README.md"], { cwd: checkout });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: checkout });
    storage = new StorageService(path.join(root, "data"));
    await storage.init();
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({
      ...config.global,
      agentSettings: { ...config.global.agentSettings, defaultAgent: "codex" },
    });
    coordinator = new CoordinatorService(storage, () => ({
      enabled: true,
      running: true,
      error: null,
    }));
    commands = createCommandRegistry();
    context = {
      storage,
      coordinators: coordinator,
      appRoot: root,
      resourceRoot: root,
      emit: () => undefined,
      environmentLifecycleTasks: {} as CommandContext["environmentLifecycleTasks"],
      runtime: new BackendRuntime({ emit: () => undefined }),
    };
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test.each([undefined, "", "  ", " release/next "])(
    "resolves the configured launch base branch %p with a main fallback",
    async (defaultBranch) => {
      const project = await storage.addProject(createProject("remote", checkout));
      const branch = defaultBranch?.trim() || "main";
      if (branch !== "main") await runCommand("git", ["branch", branch], { cwd: checkout });
      if (defaultBranch !== undefined)
        await storage.updateRepositoryConfig(project.id, {
          ...(await storage.getRepositoryConfig(project.id)),
          defaultBranch,
        });
      context.projectGit = new ProjectGitService(storage);
      const head = (
        await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkout })
      ).stdout.trim();
      expect(
        await commands.get("get_project_base_branch_tip")!({ projectId: project.id }, context),
      ).toMatchObject({
        branch,
        commit: head,
        ref: branch,
        fetched: false,
      });
    },
  );

  test("removes a project even when the coordinator store schema is unsupported", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    await fs.writeFile(
      path.join(storage.getDataDir(), "coordinators.json"),
      JSON.stringify({ version: 999, revision: 1, workspaces: {}, workflows: [] }),
    );

    await expect(
      commands.get("remove_project")!({ projectId: project.id }, context),
    ).resolves.toBeUndefined();
    expect(await storage.getProject(project.id)).toBeNull();
  });

  test("launches once with an attested prompt and rejects request reuse", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    const head = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const create = mock(async (args: Record<string, unknown>) => {
      const environment = createEnvironment(project.id, {
        name: "worker",
        environmentType: "local",
        initialPrompt: String(args.initialPrompt),
      });
      environment.id = "worker-1";
      environment.status = "creating";
      environment.delegationBaseBranch = "main";
      environment.delegationBaseCommit = head;
      environment.controlRequestId = String(args.controlRequestId);
      await storage.addEnvironment(environment);
      return environment;
    });
    commands.set("create_environment", create);
    const launch = commands.get("launch_coordinator_environment")!;
    const args = {
      scope: {
        projectId: project.id,
        coordinatorId: snapshot.workspace.id,
        conversationId: conversation.id,
      },
      requestId: "launch-1",
      input: {
        projectId: project.id,
        environmentType: "local",
        delegationBaseBranch: "main",
        delegationBaseCommit: head,
        initialPrompt: "Implement it",
      },
    };
    await expect(launch(args, context)).resolves.toMatchObject({ environment: { id: "worker-1" } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(String(create.mock.calls[0]![0]!.initialPrompt)).toContain(
      COORDINATOR_DELEGATION_FRAME_OPEN,
    );
    expect(await storage.getEnvironment("worker-1")).toMatchObject({
      initialPromptPresentation: {
        kind: COORDINATOR_DELEGATION_PRESENTATION,
        frame: expect.stringContaining(COORDINATOR_DELEGATION_FRAME_OPEN),
      },
    });
    await expect(launch(args, context)).resolves.toMatchObject({ environment: { id: "worker-1" } });
    expect(create).toHaveBeenCalledTimes(1);
    await expect(
      launch(
        {
          ...args,
          input: { ...args.input, initialPrompt: "Different payload" },
        },
        context,
      ),
    ).rejects.toThrow("different payload");
  });

  test("returns the Codex catalogue for a live coordinator conversation", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    const environmentId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);

    await expect(
      commands.get("get_native_agent_model_catalog")!({ environmentId }, context),
    ).resolves.toEqual([]);

    await storage.cacheAgentModelCatalog("codex", [
      {
        id: "gpt-coordinator",
        name: "GPT Coordinator",
        reasoningEfforts: ["medium", "high"],
        defaultReasoningEffort: "high",
      },
    ]);

    const models = await commands.get("get_native_agent_model_catalog")!(
      {
        environmentId,
      },
      context,
    );

    expect(models).toEqual([
      expect.objectContaining({
        platform: "codex",
        id: "gpt-coordinator",
        label: "GPT Coordinator",
        defaultReasoningId: "high",
      }),
    ]);

    await coordinator.closeConversation(project.id, conversation.id);
    await expect(
      commands.get("get_native_agent_model_catalog")!(
        {
          environmentId: coordinatorRuntimeId(snapshot.workspace.id, conversation.id),
        },
        context,
      ),
    ).rejects.toThrow("coordinator conversation is unavailable");
  });

  test("seeds a project-scoped OpenCode catalogue for an unassigned coordinator", async () => {
    __seedTesting.reset();
    const project = await storage.addProject(createProject("remote", checkout));
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({
      ...config.global,
      enabledAgentPlatforms: ["opencode"],
      coordinatorProviderTiers: "provider-configured",
      openCodeModelProviders: ["openai"],
    });
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    const environmentId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    const refresh = mock(async (_context: CommandContext, agent: string) => {
      expect(agent).toBe("opencode");
      return {
        agent: "opencode" as const,
        models: [
          {
            platform: "opencode" as const,
            id: "openai/gpt-5.4",
            label: "GPT-5.4",
            providerLabel: "OpenAI",
          },
        ],
      };
    });
    commands = createCommandRegistry({ modelCatalogRefresh: refresh as never });

    const result = (await commands.get("get_native_agent_model_catalog")!(
      { environmentId, ensureAgent: "opencode" },
      context,
    )) as { models: { id: string; platform: string }[]; status: string };

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      (await storage.getOpenCodeModelCatalog(project.id))?.models.map((model) => model.id),
    ).toEqual(["openai/gpt-5.4"]);
    expect(result).toMatchObject({ status: "ready" });
    expect(result.models).toContainEqual(
      expect.objectContaining({ id: "openai/gpt-5.4", platform: "opencode" }),
    );
  });

  test("rejects invalid coordinator model-catalogue states", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    const environmentId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    const catalogue = commands.get("get_native_agent_model_catalog")!;

    // An unassigned conversation is exactly when the composer asks for this
    // catalogue, so it must answer rather than refuse.
    await expect(catalogue({ environmentId }, context)).resolves.toBeDefined();
    await expect(
      catalogue({ environmentId: coordinatorRuntimeId(snapshot.workspace.id) }, context),
    ).rejects.toThrow("coordinator conversation is unavailable");

    await storage.mutateCoordinatorWorkspace(project.id, (workspace) => ({
      ...workspace!,
      lifecycleState: "paused",
    }));
    await expect(catalogue({ environmentId }, context)).rejects.toThrow("not ready");

    await storage.mutateCoordinatorWorkspace(project.id, (workspace) => ({
      ...workspace!,
      lifecycleState: "ready",
      conversations: workspace!.conversations.map((item) => ({
        ...item,
        agent: "claude",
      })),
    }));
    await storage.saveConfig({
      ...(await storage.loadConfig()),
      global: {
        ...(await storage.loadConfig()).global,
        enabledAgentPlatforms: ["codex"],
      },
    });
    await expect(catalogue({ environmentId }, context)).rejects.toThrow("not qualified");

    await storage.mutateCoordinatorWorkspace(project.id, (workspace) => ({
      ...workspace!,
      conversations: workspace!.conversations.map((item) => ({
        ...item,
        agent: "codex",
      })),
    }));
    await storage.updateProject(project.id, { localPath: null });
    await expect(catalogue({ environmentId }, context)).rejects.toThrow(
      "coordinator checkout is unavailable",
    );
  });

  test("rejects unpublished container commits before reserving or creating work", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    const head = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const create = mock(async () => ({}));
    commands.set("create_environment", create);
    await expect(
      commands.get("launch_coordinator_environment")!(
        {
          scope: {
            projectId: project.id,
            coordinatorId: snapshot.workspace.id,
            conversationId: conversation.id,
          },
          requestId: "container-launch",
          input: {
            projectId: project.id,
            environmentType: "containerized",
            delegationBaseBranch: "main",
            delegationBaseCommit: head,
            initialPrompt: "Implement it",
          },
        },
        context,
      ),
    ).rejects.toThrow("published to a remote branch");
    expect(create).not.toHaveBeenCalled();
    expect(await storage.listCoordinatorWorkflowAssociations(project.id)).toEqual([]);
  });

  test("requires a matching worker commit and a completed build before downstream workflows", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    const head = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const environment = createEnvironment(project.id, { name: "worker", environmentType: "local" });
    environment.id = "worker-1";
    environment.createdFromCommit = "b".repeat(40);
    await storage.addEnvironment(environment);
    context.buildPipelines = {
      start: mock(async () => ({})),
    } as unknown as CommandContext["buildPipelines"];
    const scope = {
      projectId: project.id,
      coordinatorId: snapshot.workspace.id,
      conversationId: conversation.id,
    };
    const buildInput = {
      taskId: "task-1",
      projectId: project.id,
      taskTitle: "Task",
      taskSnapshot: {
        title: "Task",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      environmentType: "local",
      agentType: "codex",
      existingEnvironmentId: environment.id,
      delegationBaseBranch: "main",
      delegationBaseCommit: head,
    };
    await expect(
      commands.get("start_coordinator_build_pipeline")!(
        { scope, requestId: "build-1", input: buildInput },
        context,
      ),
    ).rejects.toThrow("was not created from the requested delegation commit");

    context.multiReviews = {
      start: mock(async () => ({})),
    } as unknown as CommandContext["multiReviews"];
    await expect(
      commands.get("start_coordinator_multi_review")!(
        {
          scope,
          requestId: "review-1",
          buildPipelineId: "missing-build",
          input: {
            environmentId: environment.id,
            projectId: project.id,
            targetBranch: "main",
            reviewers: [{ agent: "claude", model: "opus" }],
            fixModel: { agent: "codex", model: "gpt-5.6" },
          },
        },
        context,
      ),
    ).rejects.toThrow("completed successfully");
  });

  test("deduplicates concurrent build starts", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    const head = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const scope = {
      projectId: project.id,
      coordinatorId: snapshot.workspace.id,
      conversationId: conversation.id,
    };
    const buildInput = {
      taskId: "task-1",
      projectId: project.id,
      taskTitle: "Task",
      taskSnapshot: {
        title: "Task",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      environmentType: "local",
      agentType: "codex",
      delegationBaseBranch: "main",
      delegationBaseCommit: head,
    };
    let releaseBuild!: () => void;
    const buildBarrier = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    const startBuild = mock(async () => {
      await buildBarrier;
      return { id: "pipeline-1", projectId: project.id };
    });
    context.buildPipelines = { start: startBuild } as unknown as CommandContext["buildPipelines"];
    const build = commands.get("start_coordinator_build_pipeline")!;
    const first = build({ scope, requestId: "build-deduped", input: buildInput }, context);
    const second = build({ scope, requestId: "build-deduped", input: buildInput }, context);
    const deadline = Date.now() + 2_000;
    while (startBuild.mock.calls.length === 0 && Date.now() < deadline) await Bun.sleep(5);
    expect(startBuild).toHaveBeenCalledTimes(1);
    releaseBuild();
    expect(await first).toEqual(await second);
    expect(await storage.listCoordinatorWorkflowAssociations(project.id)).toContainEqual(
      expect.objectContaining({ kind: "build-pipeline", resourceId: "pipeline-1", pending: false }),
    );
  });

  for (const phase of ["preparing", "complete"]) {
    test(`recovers a ${phase} review after receipt failure and defaults change`, async () => {
      const project = await storage.addProject(createProject("remote", checkout));
      const snapshot = await coordinator.ensure(project.id);
      const scope = {
        projectId: project.id,
        coordinatorId: snapshot.workspace.id,
        conversationId: snapshot.workspace.conversations[0]!.id,
      };
      const environment = createEnvironment(project.id, {
        name: "worker",
        environmentType: "local",
      });
      await storage.addEnvironment(environment);
      storage.getBuildPipeline = mock(async () => ({
        snapshot: {
          projectId: project.id,
          environmentId: environment.id,
          phase: "complete",
        },
      })) as unknown as typeof storage.getBuildPipeline;
      let saved: Record<string, unknown> | undefined;
      const start = mock(async (input: Record<string, unknown>, id?: string) => {
        saved = { ...input, id, phase };
        await storage.createMultiReviewWorkflowIfNoActive(id!, environment.id, 1, saved);
        return saved;
      });
      context.multiReviews = { start } as unknown as CommandContext["multiReviews"];
      const complete = storage.completeCoordinatorWorkflowAssociation.bind(storage);
      let fail = true;
      storage.completeCoordinatorWorkflowAssociation = async (...args) => {
        if (fail) {
          fail = false;
          throw new Error("receipt write failed");
        }
        return complete(...args);
      };
      const args = {
        scope,
        requestId: "crash-retry",
        buildPipelineId: "build-1",
        input: { projectId: project.id, environmentId: environment.id, targetBranch: "main" },
      };
      const launch = commands.get("start_coordinator_multi_review")!;
      await expect(launch(args, context)).rejects.toThrow("receipt write failed");
      const config = await storage.loadConfig();
      await storage.updateGlobalConfig({
        ...config.global,
        agentSettings: {
          actionDefaults: { review: { platform: "claude", model: "changed-model" } },
          multiReview: { reviewerCount: 4 },
        },
      });
      commands.set("get_native_agent_model_catalog", () => {
        throw new Error("changed catalogue unavailable");
      });
      expect(await launch(args, context)).toEqual(saved);
      expect(start).toHaveBeenCalledTimes(1);
      expect(await storage.listCoordinatorWorkflowAssociations(project.id)).toContainEqual(
        expect.objectContaining({ resourceId: saved!.id, pending: false }),
      );
    });
  }

  test("omitted build and Multi Review choices run the saved defaults", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    const head = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({
      ...config.global,
      enabledAgentPlatforms: ["claude", "codex"],
      agentSettings: {
        defaultAgent: "codex",
        actionDefaults: {
          review: { platform: "claude", model: "opus", reasoningEffort: "high" },
          review2: { platform: "codex", model: "gpt-5.6" },
          fixReviewIssues: { platform: "codex", model: "gpt-5.6", reasoningEffort: "medium" },
        },
        multiReview: { autoFix: true, reviewerCount: 2 },
      },
    });
    const scope = {
      projectId: project.id,
      coordinatorId: snapshot.workspace.id,
      conversationId: conversation.id,
    };
    const startBuild = mock(async () => ({ id: "pipeline-defaults", projectId: project.id }));
    context.buildPipelines = { start: startBuild } as unknown as CommandContext["buildPipelines"];
    await commands.get("start_coordinator_build_pipeline")!(
      {
        scope,
        requestId: "build-defaults",
        input: {
          taskId: "task-1",
          projectId: project.id,
          taskTitle: "Task",
          taskSnapshot: {
            title: "Task",
            description: "",
            acceptanceCriteria: "",
            comments: [],
            images: [],
          },
          environmentType: "local",
          delegationBaseBranch: "main",
          delegationBaseCommit: head,
        },
      },
      context,
    );
    const opus = { agent: "claude", model: "opus", reasoningEffort: "high" };
    const fix = { agent: "codex", model: "gpt-5.6", reasoningEffort: "medium" };
    expect(startBuild).toHaveBeenCalledWith(
      expect.objectContaining({
        agentType: "codex",
        reviewers: [opus, { agent: "codex", model: "gpt-5.6" }],
        reviewPreparation: opus,
        steps: expect.objectContaining({ review: opus, address: fix, verify: fix }),
      }),
    );

    // An explicit step replaces only that step; explicit reviewers replace the
    // saved rows; the rest keeps its defaults.
    await commands.get("start_coordinator_build_pipeline")!(
      {
        scope,
        requestId: "build-overrides",
        input: {
          taskId: "task-2",
          projectId: project.id,
          taskTitle: "Task",
          taskSnapshot: {
            title: "Task",
            description: "",
            acceptanceCriteria: "",
            comments: [],
            images: [],
          },
          environmentType: "local",
          delegationBaseBranch: "main",
          delegationBaseCommit: head,
          steps: { build: { agent: "claude" }, verify: { agent: "claude", model: "sonnet" } },
          reviewers: [{ agent: "codex", model: "gpt-5.6" }],
        },
      },
      context,
    );
    expect(startBuild).toHaveBeenLastCalledWith(
      expect.objectContaining({
        agentType: "claude",
        reviewers: undefined,
        reviewPreparation: undefined,
        steps: expect.objectContaining({
          build: { agent: "claude" },
          review: { agent: "codex", model: "gpt-5.6" },
          address: fix,
          verify: { agent: "claude", model: "sonnet" },
        }),
      }),
    );

    const environment = createEnvironment(project.id, { name: "worker", environmentType: "local" });
    environment.id = "worker-defaults";
    await storage.addEnvironment(environment);
    storage.getBuildPipeline = mock(async () => ({
      snapshot: {
        id: "pipeline-defaults",
        projectId: project.id,
        environmentId: environment.id,
        phase: "complete",
      },
    })) as unknown as typeof storage.getBuildPipeline;
    commands.set("get_native_agent_model_catalog", async () => [
      { platform: "claude", id: "opus", label: "Opus", reasoning: [{ id: "high", label: "High" }] },
      {
        platform: "codex",
        id: "gpt-5.6",
        label: "GPT-5.6",
        reasoning: [{ id: "medium", label: "Medium" }],
      },
    ]);
    const startReview = mock(async () => ({ id: "review-defaults" }));
    context.multiReviews = { start: startReview } as unknown as CommandContext["multiReviews"];
    await commands.get("start_coordinator_multi_review")!(
      {
        scope,
        requestId: "review-defaults",
        buildPipelineId: "pipeline-defaults",
        input: { environmentId: environment.id, projectId: project.id, targetBranch: "main" },
      },
      context,
    );
    expect(startReview).toHaveBeenCalledWith(
      {
        environmentId: environment.id,
        projectId: project.id,
        targetBranch: "main",
        reviewers: [opus, { agent: "codex", model: "gpt-5.6" }],
        reviewModel: opus,
        fixModel: fix,
        autoFix: true,
        autoPr: false,
      },
      expect.any(String),
    );
  });

  test("returns worker start errors and rejects cross-project coordinator mail", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const otherProject = await storage.addProject(createProject("other", checkout));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    const head = (await runCommand("git", ["rev-parse", "HEAD"], { cwd: checkout })).stdout.trim();
    const worker = createEnvironment(project.id, { name: "worker", environmentType: "local" });
    worker.id = "worker-stopped";
    worker.status = "stopped";
    const create = mock(async () => {
      await storage.addEnvironment(worker);
      return worker;
    });
    commands.set("create_environment", create);
    commands.set(
      "start_environment_background",
      mock(async () => Promise.reject(new Error("boot failed"))),
    );
    const scope = {
      projectId: project.id,
      coordinatorId: snapshot.workspace.id,
      conversationId: conversation.id,
    };
    await expect(
      commands.get("launch_coordinator_environment")!(
        {
          scope,
          requestId: "launch-error",
          input: {
            projectId: project.id,
            environmentType: "local",
            delegationBaseBranch: "main",
            delegationBaseCommit: head,
            initialPrompt: "Implement it",
          },
        },
        context,
      ),
    ).resolves.toMatchObject({
      environment: { id: worker.id },
      startError: "boot failed",
      coordinatorDelegationOpened: false,
    });
    expect(await storage.listOpenCoordinatorDelegations()).toEqual([]);

    const foreign = createEnvironment(otherProject.id, {
      name: "foreign",
      environmentType: "local",
    });
    await storage.addEnvironment(foreign);
    await expect(
      commands.get("send_coordinator_agent_mail")!(
        {
          ...scope,
          requestId: "foreign-mail",
          toEnvironmentId: foreign.id,
          toTabId: "tab-1",
          body: "Cross the boundary",
        },
        context,
      ),
    ).rejects.toThrow("must stay within their project");
  });

  test("opens delegations only for scheduled mail; a follow-up joins the open one", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, conversation.id, "codex");
    const worker = createEnvironment(project.id, { name: "worker", environmentType: "local" });
    worker.status = "running";
    worker.setupPhase = "ready";
    worker.setupScriptsComplete = true;
    await storage.addEnvironment(worker);
    const scope = {
      projectId: project.id,
      coordinatorId: snapshot.workspace.id,
      conversationId: conversation.id,
    };
    const send = commands.get("send_coordinator_agent_mail")!;

    await storage.savePaneLayout(
      worker.id,
      {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane",
        root: {
          kind: "leaf",
          id: "pane",
          tabs: [{ id: "plain", type: "codex" }],
          activeTabId: "plain",
        },
      },
      0,
    );
    await storage.synchronizeAgentMailboxes();
    const stored = await send(
      {
        ...scope,
        requestId: "stored-request",
        toEnvironmentId: worker.id,
        toTabId: "plain",
        body: "This tab cannot receive an agent turn.",
      },
      context,
    );
    expect(stored).toMatchObject({
      placement: "stored",
      coordinatorDelegationOpened: false,
    });
    expect(await storage.listOpenCoordinatorDelegations()).toEqual([]);

    await storage.savePaneLayout(
      worker.id,
      {
        version: PANE_LAYOUT_VERSION,
        containerId: null,
        activePaneId: "pane",
        root: {
          kind: "leaf",
          id: "pane",
          tabs: [
            {
              id: "agent",
              type: "agent-native",
              nativeAgentData: { environmentId: worker.id, platform: "codex" },
            },
          ],
          activeTabId: "agent",
        },
      },
      1,
    );
    await storage.synchronizeAgentMailboxes();
    await expect(
      send(
        {
          ...scope,
          requestId: "first-request",
          toEnvironmentId: worker.id,
          toTabId: "agent",
          body: "First request.",
        },
        context,
      ),
    ).resolves.toMatchObject({
      placement: "pending-inject",
      coordinatorDelegationOpened: true,
    });
    // Let the first request reach the worker, then pause the follow-up after
    // joining has been read. Completion must wait for durable publication.
    const mailbox = (await storage.getAgentMailMailbox(worker.id, "agent")).descriptor;
    const initial = (await storage.listPendingAgentMailInjects())[0]!.message;
    await storage.beginAgentMailInject(mailbox.mailboxId, initial.id, mailbox.incarnationId);
    await storage.finishAgentMailInject(mailbox.mailboxId, initial.id, { outcome: "accepted" });
    let entered!: () => void;
    let release!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalSend = storage.sendAgentMail.bind(storage);
    storage.sendAgentMail = async (...args) => {
      entered();
      await released;
      return originalSend(...args);
    };
    const followUp = send(
      {
        ...scope,
        requestId: "racing-follow-up",
        toEnvironmentId: worker.id,
        body: "Finish this too.",
      },
      context,
    );
    await enteredPromise;
    const completion = coordinator.settleWorkerDelegations({
      environmentId: worker.id,
      tabId: "agent",
      state: "completed",
    });
    release();
    await followUp;
    storage.sendAgentMail = originalSend;
    await completion;
    expect(await storage.listOpenCoordinatorDelegations()).toHaveLength(1);
    // A follow-up while the worker is still on the first request joins that
    // delegation: delivered, and one wake for both — never a second delegation.
    await expect(
      send(
        {
          ...scope,
          requestId: "overlapping-request",
          toEnvironmentId: worker.id,
          body: "Second request.",
        },
        context,
      ),
    ).resolves.toMatchObject({
      placement: "pending-inject",
      toTabId: "agent",
      coordinatorDelegationOpened: true,
    });
    expect(await storage.listOpenCoordinatorDelegations()).toHaveLength(1);
    for (const item of await storage.listPendingAgentMailInjects()) {
      await storage.beginAgentMailInject(
        item.mailbox.mailboxId,
        item.message.id,
        item.mailbox.incarnationId,
      );
      await storage.finishAgentMailInject(item.mailbox.mailboxId, item.message.id, {
        outcome: "accepted",
      });
    }
    await coordinator.settleWorkerDelegations({
      environmentId: worker.id,
      tabId: "agent",
      state: "completed",
    });
    await coordinator.settleWorkerDelegations({
      environmentId: worker.id,
      tabId: "agent",
      state: "completed",
    });
    expect(await storage.listOpenCoordinatorDelegations()).toHaveLength(0);
    expect(await storage.listPendingAgentMailInjects()).toHaveLength(1);
  });

  test("retires session, credential, bridge, and mailbox before closing a conversation", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, conversation.id, "codex");
    const runtimeId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    const sessionKey = nativeAgentSessionStorageKey(
      runtimeId,
      "codex",
      conversation.logicalSessionKey,
    );
    await storage.adoptNativeAgentSession({
      key: sessionKey,
      environmentId: runtimeId,
      agent: "codex",
      logicalSessionKey: conversation.logicalSessionKey,
      providerSessionId: "thread-1",
      origin: "coordinator",
      executionPolicy: "coordinator-read-only",
      owner: {
        kind: "coordinator",
        projectId: project.id,
        coordinatorId: snapshot.workspace.id,
      },
    });
    const stopProjection = mock(async () => undefined);
    const revoke = mock(() => undefined);
    const stopBridge = mock(async () => undefined);
    context.nativeAgents = {
      stopProjectionSession: stopProjection,
    } as unknown as CommandContext["nativeAgents"];
    context.controlMcp = {
      revokeCoordinatorCredentials: revoke,
    } as unknown as CommandContext["controlMcp"];
    commands.set("stop_local_codex_server_cmd", stopBridge);

    const closed = await commands.get("close_coordinator_conversation")!(
      { projectId: project.id, conversationId: conversation.id },
      context,
    );
    expect(stopProjection).toHaveBeenCalledWith({
      environmentId: runtimeId,
      agent: "codex",
      logicalSessionKey: conversation.logicalSessionKey,
    });
    expect(revoke).toHaveBeenCalledWith(snapshot.workspace.id, conversation.id);
    expect(stopBridge).toHaveBeenCalledWith({ environmentId: runtimeId }, context);
    expect(closed).toMatchObject({ workspace: { selectedConversationId: null } });
    expect(await storage.getNativeAgentSession(sessionKey)).toBeNull();
  });

  test("retires whichever platform's bridge the conversation actually belongs to", async () => {
    // Teardown named the Codex stop command literally, so a conversation on any
    // other platform left its bridge, its transcript and its scoped MCP
    // credential running after the tab closed.
    const project = await storage.addProject(createProject("remote", checkout));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    await coordinator.assignConversationAgent(project.id, conversation.id, "claude");
    const runtimeId = coordinatorRuntimeId(snapshot.workspace.id, conversation.id);
    const sessionKey = nativeAgentSessionStorageKey(
      runtimeId,
      "claude",
      conversation.logicalSessionKey,
    );
    await storage.adoptNativeAgentSession({
      key: sessionKey,
      environmentId: runtimeId,
      agent: "claude",
      logicalSessionKey: conversation.logicalSessionKey,
      providerSessionId: "sdk-session-1",
      origin: "coordinator",
      executionPolicy: "coordinator-read-only",
      owner: {
        kind: "coordinator",
        projectId: project.id,
        coordinatorId: snapshot.workspace.id,
      },
    });
    const stopProjection = mock(async () => undefined);
    const stopClaude = mock(async () => undefined);
    const stopCodex = mock(async () => undefined);
    context.nativeAgents = {
      stopProjectionSession: stopProjection,
    } as unknown as CommandContext["nativeAgents"];
    context.controlMcp = {
      revokeCoordinatorCredentials: mock(() => undefined),
    } as unknown as CommandContext["controlMcp"];
    commands.set("stop_local_claude_server_cmd", stopClaude);
    commands.set("stop_local_codex_server_cmd", stopCodex);

    await commands.get("close_coordinator_conversation")!(
      { projectId: project.id, conversationId: conversation.id },
      context,
    );
    expect(stopClaude).toHaveBeenCalledWith({ environmentId: runtimeId }, context);
    expect(stopCodex).not.toHaveBeenCalled();
    expect(stopProjection).toHaveBeenCalledWith({
      environmentId: runtimeId,
      agent: "claude",
      logicalSessionKey: conversation.logicalSessionKey,
    });
    expect(await storage.getNativeAgentSession(sessionKey)).toBeNull();
  });

  test("closing an unassigned conversation revokes its credential and stops no bridge", async () => {
    const project = await storage.addProject(createProject("remote", checkout));
    const snapshot = await coordinator.ensure(project.id);
    const conversation = snapshot.workspace.conversations[0]!;
    expect(conversation.agent).toBeUndefined();
    const revoke = mock(() => undefined);
    const stopProjection = mock(async () => undefined);
    const stopCodex = mock(async () => undefined);
    context.nativeAgents = {
      stopProjectionSession: stopProjection,
    } as unknown as CommandContext["nativeAgents"];
    context.controlMcp = {
      revokeCoordinatorCredentials: revoke,
    } as unknown as CommandContext["controlMcp"];
    commands.set("stop_local_codex_server_cmd", stopCodex);

    await commands.get("close_coordinator_conversation")!(
      { projectId: project.id, conversationId: conversation.id },
      context,
    );
    // Nothing reached a provider, so there is no session, bridge or rollout —
    // but the credential is issued up front and must still be revoked.
    expect(stopProjection).not.toHaveBeenCalled();
    expect(stopCodex).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith(snapshot.workspace.id, conversation.id);
  });
});
