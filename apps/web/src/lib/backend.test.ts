import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AppConfig } from "@/types";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";

const invokeMock = mock<(...args: unknown[]) => Promise<unknown>>(() => Promise.resolve());

mock.module("@/lib/native/backend", () => ({
  invoke: invokeMock,
}));

afterAll(() => {
  mock.module("@/lib/native/backend", () => ({
    invoke: mock(() => Promise.resolve()),
  }));
});

const wrapperModulePath = "./backend.ts?wrapper-test";
const originalOrkestrator = window.orkestrator;
const originalGateway = window.orkestratorGateway;
const originalWindowOpen = window.open;
const backendWrappers = (await import(wrapperModulePath)) as typeof import("./backend");
const {
  connectLinear,
  createEnvironment,
  createLocalTerminalSession,
  createTerminalSession,
  bootstrapTerminalSession,
  disconnectLinear,
  ensureEnvironmentSetup,
  deletePaneLayout,
  getEnvironmentSnapshots,
  awaitEnvironmentSetupSession,
  getClaudeModelCatalog,
  getCachedOpenCodeModelCatalog,
  getPaneLayout,
  getLinearConnection,
  getLinearIssue,
  getLinearIssues,
  getGitHubIssues,
  getGitHubIssue,
  getContainerGitHubCredentialStatus,
  getTerminalOutputSnapshot,
  updateGitHubIssue,
  updateGitHubIssueStatus,
  closeGitHubIssue,
  addGitHubIssueComment,
  updateGitHubIssueComment,
  postGitHubCompletionComment,
  getAgentModelCatalogCache,
  ensureHostPiModelCatalog,
  refreshHostAgentModelCatalog,
  getNativeAgentModelCatalog,
  getGatewayTokenSettings,
  getWebClientStatus,
  postLinearCompletionComment,
  openInBrowser,
  propagateGithubCredentialsToContainers,
  runEnvironmentSetup,
  resetWebClientServe,
  savePaneLayout,
  setWebClientEnabled,
  setGatewayToken,
  setGitHubToken,
  setAnthropicApiKey,
  setCursorApiKey,
  setEnvironmentUnread,
  setEnvironmentPendingAgentLaunch,
  setEnvironmentInitialPrompt,
  setEnvironmentPr,
  cacheOpenCodeModelCatalog,
  cacheAgentModelCatalog,
  appendFeaturePlanMessage,
  appendFeatureStoryMessage,
  cancelFeaturePlanning,
  claimFeaturePlanBuild,
  createFeaturePlan,
  createProjectFromScratch,
  getFeaturePlanningSnapshot,
  getFeaturePlans,
  retryFeaturePlanning,
  startFeaturePlanning,
  updateFeaturePlan,
  updateEnvironmentAgentSettings,
  writeInitialPromptAttachments,
  applyPaneLayoutIntent,
  listAgentSkills,
  readAgentSkill,
} = backendWrappers;

afterEach(() => {
  window.orkestrator = originalOrkestrator;
  window.orkestratorGateway = originalGateway;
  window.open = originalWindowOpen;
});

describe("backend setup wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  test("sends the required model-catalogue scope and omits it for global providers", async () => {
    invokeMock.mockResolvedValue({ agent: "opencode", modelCount: 2 });

    await expect(refreshHostAgentModelCatalog("opencode", "project-1")).resolves.toEqual({
      agent: "opencode",
      modelCount: 2,
    });
    await refreshHostAgentModelCatalog("codex");

    expect(invokeMock.mock.calls).toEqual([
      ["refresh_host_agent_model_catalog", { agent: "opencode", projectId: "project-1" }],
      ["refresh_host_agent_model_catalog", { agent: "codex" }],
    ]);
  });

  test("forwards agent skill list and read payloads and propagates their results", async () => {
    const scan = {
      provider: "codex" as const,
      roots: [],
      skills: [],
      errors: [],
    };
    invokeMock.mockResolvedValueOnce(scan);

    await expect(listAgentSkills("codex")).resolves.toBe(scan);
    expect(invokeMock).toHaveBeenLastCalledWith("list_agent_skills", { provider: "codex" });

    const file = { path: "/skills/example/SKILL.md", content: "# Example", truncated: false };
    invokeMock.mockResolvedValueOnce(file);

    await expect(readAgentSkill("claude", file.path)).resolves.toBe(file);
    expect(invokeMock).toHaveBeenLastCalledWith("read_agent_skill", {
      provider: "claude",
      filePath: file.path,
    });

    const failure = new Error("skill read failed");
    invokeMock.mockRejectedValueOnce(failure);
    await expect(readAgentSkill("opencode", file.path)).rejects.toBe(failure);

    // The Skills pane renders the scan rejection, so swallowing it here would
    // show an empty directory list instead of the reason it is empty.
    const scanFailure = new Error("skill scan failed");
    invokeMock.mockRejectedValueOnce(scanFailure);
    await expect(listAgentSkills("claude")).rejects.toBe(scanFailure);
  });

  test("passes explicit tri-state PR metadata to the backend", async () => {
    await setEnvironmentPr("env-1", "https://github.com/acme/repo/pull/7", "open", null);

    expect(invokeMock.mock.calls).toEqual([
      [
        "set_environment_pr",
        {
          environmentId: "env-1",
          prUrl: "https://github.com/acme/repo/pull/7",
          prState: "open",
          hasMergeConflicts: null,
        },
      ],
    ]);
  });

  test("passes a scratch project target path to the backend", async () => {
    invokeMock.mockResolvedValue({ id: "project-1" });

    await createProjectFromScratch("/Users/dev/Projects/new-app");

    expect(invokeMock).toHaveBeenCalledWith("create_project_from_scratch", {
      localPath: "/Users/dev/Projects/new-app",
    });
  });

  test("persists the durable post-setup agent launch flag", async () => {
    await setEnvironmentPendingAgentLaunch("env-1", false);

    expect(invokeMock.mock.calls).toEqual([
      [
        "set_environment_pending_agent_launch",
        {
          environmentId: "env-1",
          pending: false,
        },
      ],
    ]);
  });

  test("configures an environment and its durable launch intent together", async () => {
    await updateEnvironmentAgentSettings(
      "env-1",
      { defaultAgent: "codex" },
      true,
      "gpt-5.6-sol",
      "high",
    );

    expect(invokeMock.mock.calls).toEqual([
      [
        "update_environment_agent_settings",
        {
          environmentId: "env-1",
          agentSettings: { defaultAgent: "codex" },
          pendingAgentLaunch: true,
          initialAgentModel: "gpt-5.6-sol",
          initialReasoningEffort: "high",
        },
      ],
    ]);
  });

  test("omits the one-shot option keys when they are absent or blank", async () => {
    // Key absence is meaningful on the backend: `update_environment_agent_settings`
    // leaves a stored option alone when its key is missing, so an unset option
    // must not be sent as `undefined`/`""` and quietly overwrite one.
    await updateEnvironmentAgentSettings("env-1", { defaultAgent: "codex" }, true, undefined, "");

    const payload = invokeMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("initialAgentModel");
    expect(payload).not.toHaveProperty("initialReasoningEffort");
    expect(payload.pendingAgentLaunch).toBe(true);
  });

  test("omits the launch intent key entirely when no launch is being configured", async () => {
    await updateEnvironmentAgentSettings("env-1", {
      defaultAgent: "codex",
      platforms: { codex: { mode: "native" } },
    });

    // Omission is load-bearing: the settings dialog and FeaturesView both call
    // this while an environment may still be awaiting its launch, and sending
    // `false` would clear it.
    const [[command, args]] = invokeMock.mock.calls as [[string, Record<string, unknown>]];
    expect(command).toBe("update_environment_agent_settings");
    expect(args).not.toHaveProperty("pendingAgentLaunch");
  });

  test("records a cleared launch intent when one is explicitly configured off", async () => {
    await updateEnvironmentAgentSettings("env-1", { defaultAgent: "claude" }, false);

    expect(invokeMock.mock.calls).toEqual([
      [
        "update_environment_agent_settings",
        {
          environmentId: "env-1",
          agentSettings: { defaultAgent: "claude" },
          pendingAgentLaunch: false,
        },
      ],
    ]);
  });

  test("persists a rewritten initial prompt so a recovered launch keeps its attachment references", async () => {
    await setEnvironmentInitialPrompt("env-1", "Fix it [img](/work/a.png)");

    expect(invokeMock.mock.calls).toEqual([
      [
        "set_environment_initial_prompt",
        {
          environmentId: "env-1",
          initialPrompt: "Fix it [img](/work/a.png)",
        },
      ],
    ]);
  });

  test("forwards initial prompt attachments through durable launch settings", async () => {
    const attachments = [
      {
        id: "image-1",
        name: "diagram.png",
        previewUrl: "data:image/png;base64,cHJldmlldw==",
        base64Data: "cGl4ZWxz",
      },
    ];

    await updateEnvironmentAgentSettings(
      "env-1",
      { defaultAgent: "codex" },
      true,
      "gpt-5.6-sol",
      "high",
      attachments,
    );
    await setEnvironmentInitialPrompt("env-1", "Inspect the diagram", attachments);

    expect(invokeMock.mock.calls).toEqual([
      [
        "update_environment_agent_settings",
        expect.objectContaining({
          environmentId: "env-1",
          initialPromptAttachments: attachments,
        }),
      ],
      [
        "set_environment_initial_prompt",
        {
          environmentId: "env-1",
          initialPrompt: "Inspect the diagram",
          initialPromptAttachments: attachments,
        },
      ],
    ]);
  });

  test("calls the run-environment-setup Electron command with the environment id", async () => {
    await runEnvironmentSetup("env-1");

    expect(invokeMock.mock.calls).toEqual([["run_environment_setup", { environmentId: "env-1" }]]);
  });

  test("calls the ensure-environment-setup Electron command with the environment id", async () => {
    await ensureEnvironmentSetup("env-1");

    expect(invokeMock.mock.calls).toEqual([
      ["ensure_environment_setup", { environmentId: "env-1" }],
    ]);
  });

  test("forwards terminal bootstrap and setup wait payloads exactly", async () => {
    invokeMock
      .mockResolvedValueOnce({ bootstrapped: true, delivered: true, duplicate: false })
      .mockResolvedValueOnce(null);

    await expect(bootstrapTerminalSession("pty-1", "bun run dev\n")).resolves.toEqual({
      bootstrapped: true,
      delivered: true,
      duplicate: false,
    });
    await expect(awaitEnvironmentSetupSession("env-1", 2_500)).resolves.toBeNull();
    expect(invokeMock.mock.calls).toEqual([
      ["bootstrap_terminal_session", { sessionId: "pty-1", data: "bun run dev\n" }],
      ["await_environment_setup_session", { environmentId: "env-1", timeoutMs: 2_500 }],
    ]);
  });

  test("forwards initial attachments and pane-layout intents exactly", async () => {
    const attachments = [{ id: "image-1", name: "diagram.png", base64Data: "cGl4ZWxz" }];
    invokeMock
      .mockResolvedValueOnce([{ name: "diagram.png", path: "/workspace/diagram.png" }])
      .mockResolvedValueOnce({ revision: 2 });
    const layout = {
      version: 2,
      containerId: "container-1",
      root: { kind: "leaf" as const, id: "default", tabs: [], activeTabId: "" },
      activePaneId: "default",
    };
    const selectionIntent = { activePaneId: "default", activeTabIds: { default: "tab-1" } };

    await writeInitialPromptAttachments("env-1", attachments);
    await applyPaneLayoutIntent("env-1", layout, layout, selectionIntent);

    expect(invokeMock.mock.calls).toEqual([
      ["write_initial_prompt_attachments", { environmentId: "env-1", attachments }],
      [
        "apply_pane_layout_intent",
        {
          environmentId: "env-1",
          baseLayout: layout,
          desiredLayout: layout,
          selectionIntent,
        },
      ],
    ]);
  });

  test("requests an environment-scoped Claude model catalog refresh", async () => {
    const snapshot = {
      environmentId: "env-1",
      models: [{ id: "claude-opus-5", name: "Claude Opus 5" }],
      source: "sdk" as const,
      fetchedAt: "2026-07-25T12:00:00.000Z",
      stale: false,
    };
    invokeMock.mockResolvedValue(snapshot);

    await expect(getClaudeModelCatalog("env-1", true)).resolves.toEqual(snapshot);
    expect(invokeMock).toHaveBeenCalledWith("get_claude_model_catalog", {
      environmentId: "env-1",
      forceRefresh: true,
    });
  });

  test("loads and updates the durable OpenCode model catalogue", async () => {
    const snapshot = {
      schemaVersion: 2 as const,
      projectId: "project-1",
      catalogVersion: "catalog-v1",
      updatedAt: "2026-07-27T12:00:00.000Z",
      models: [
        {
          id: "openrouter/anthropic/claude-sonnet",
          name: "Claude Sonnet",
          provider: "openrouter",
        },
      ],
    };
    invokeMock.mockResolvedValue(snapshot);

    await expect(getCachedOpenCodeModelCatalog("project-1")).resolves.toEqual(snapshot);
    await expect(cacheOpenCodeModelCatalog("project-1", snapshot.models)).resolves.toEqual(
      snapshot,
    );
    expect(invokeMock.mock.calls).toEqual([
      ["get_opencode_model_catalog_cache", { projectId: "project-1" }],
      ["cache_opencode_model_catalog", { projectId: "project-1", models: snapshot.models }],
    ]);
  });

  test("loads and updates the host-wide agent model catalogue", async () => {
    const cache = {
      schemaVersion: 1 as const,
      claude: {
        updatedAt: "2026-07-30T10:00:00.000Z",
        models: [{ id: "claude-opus-5", name: "Claude Opus 5" }],
      },
    };
    invokeMock.mockResolvedValue(cache);

    await expect(getAgentModelCatalogCache()).resolves.toEqual(cache);
    await expect(cacheAgentModelCatalog("claude", cache.claude.models)).resolves.toEqual(cache);

    expect(invokeMock.mock.calls).toEqual([
      ["get_agent_model_catalog_cache"],
      ["cache_agent_model_catalog", { agent: "claude", models: cache.claude.models }],
    ]);
  });

  test("distinguishes successful, empty, and failed ensured catalogue outcomes", async () => {
    const piModels = [
      {
        platform: "pi" as const,
        id: "openai-codex/gpt-5.4",
        label: "GPT-5.4",
        supportsSpeed: false,
        supportsMode: false,
      },
    ];
    invokeMock.mockResolvedValueOnce(piModels);
    await expect(ensureHostPiModelCatalog()).resolves.toEqual(piModels);

    invokeMock.mockResolvedValueOnce({ models: piModels, status: "ready" });
    await expect(getNativeAgentModelCatalog("env-1", "pi")).resolves.toEqual(piModels);

    invokeMock.mockResolvedValueOnce({ models: [], status: "empty" });
    await expect(getNativeAgentModelCatalog("env-1", "pi")).resolves.toEqual([]);

    invokeMock.mockResolvedValueOnce({ models: [], status: "failed" });
    await expect(getNativeAgentModelCatalog("env-1", "pi")).rejects.toThrow(
      /temporarily unavailable/,
    );

    expect(invokeMock.mock.calls).toEqual([
      ["ensure_host_pi_model_catalog"],
      ["get_native_agent_model_catalog", { environmentId: "env-1", ensureAgent: "pi" }],
      ["get_native_agent_model_catalog", { environmentId: "env-1", ensureAgent: "pi" }],
      ["get_native_agent_model_catalog", { environmentId: "env-1", ensureAgent: "pi" }],
    ]);
  });

  test("projects catalogue entries onto the fields the cache command accepts", async () => {
    invokeMock.mockResolvedValue(null);

    await cacheOpenCodeModelCatalog("project-1", [
      {
        id: "openai/gpt-5",
        name: "GPT-5",
        provider: "openai",
        variants: ["high", "  ", ""],
        inputCost: 0,
        outputCost: 1.5,
        contextWindow: 400_000,
        // A field added to `OpenCodeModel` upstream must not start failing the
        // command's strict key check.
        extra: "unexpected",
      } as never,
      {
        id: "openai/gpt-4",
        name: "GPT-4",
        provider: "openai",
        // `typeof x === "number"` lets these through upstream; the command
        // rejects them, so they are dropped rather than sent.
        inputCost: Number.NaN,
        outputCost: Number.POSITIVE_INFINITY,
        contextWindow: Number.NEGATIVE_INFINITY,
        variants: [],
      },
    ]);

    expect(invokeMock).toHaveBeenCalledWith("cache_opencode_model_catalog", {
      projectId: "project-1",
      models: [
        {
          id: "openai/gpt-5",
          name: "GPT-5",
          provider: "openai",
          variants: ["high"],
          inputCost: 0,
          outputCost: 1.5,
          contextWindow: 400_000,
        },
        { id: "openai/gpt-4", name: "GPT-4", provider: "openai" },
      ],
    });
  });

  test("keeps a non-array variants field from reaching the command", async () => {
    invokeMock.mockResolvedValue(null);

    await cacheOpenCodeModelCatalog("project-1", [
      {
        id: "openai/gpt-5",
        name: "GPT-5",
        provider: "openai",
        variants: "high" as never,
      },
    ]);

    expect(invokeMock).toHaveBeenCalledWith("cache_opencode_model_catalog", {
      projectId: "project-1",
      models: [{ id: "openai/gpt-5", name: "GPT-5", provider: "openai" }],
    });
  });

  test("calls the create-environment Electron command with naming prompt", async () => {
    await createEnvironment(
      "project-1",
      undefined,
      "restricted",
      undefined,
      [{ hostPort: 5173, containerPort: 5173, protocol: "tcp" }],
      "containerized",
      "Build task\n\nShip the feature",
    );

    expect(invokeMock.mock.calls).toEqual([
      [
        "create_environment",
        {
          projectId: "project-1",
          name: undefined,
          networkAccessMode: "restricted",
          initialPrompt: undefined,
          portMappings: [{ hostPort: 5173, containerPort: 5173, protocol: "tcp" }],
          environmentType: "containerized",
          namingPrompt: "Build task\n\nShip the feature",
        },
      ],
    ]);
  });

  test("persists a build pipeline association when creating an environment", async () => {
    await createEnvironment(
      "project-1",
      undefined,
      "full",
      undefined,
      undefined,
      "local",
      undefined,
      "pipeline-42",
    );

    expect(invokeMock.mock.calls).toEqual([
      [
        "create_environment",
        {
          projectId: "project-1",
          name: undefined,
          networkAccessMode: "full",
          initialPrompt: undefined,
          portMappings: undefined,
          environmentType: "local",
          namingPrompt: undefined,
          buildPipelineId: "pipeline-42",
        },
      ],
    ]);
  });

  test("calls the read-only environment snapshot command", async () => {
    invokeMock.mockResolvedValue([]);

    await expect(getEnvironmentSnapshots("project-1")).resolves.toEqual([]);
    expect(invokeMock.mock.calls).toEqual([
      ["get_environment_snapshots", { projectId: "project-1" }],
    ]);
  });

  test("guards unread clears with the activity token observed by the client", async () => {
    await setEnvironmentUnread("env-1", false, "2026-07-23T11:12:14.000Z");

    expect(invokeMock.mock.calls).toEqual([
      [
        "set_environment_unread",
        {
          environmentId: "env-1",
          unread: false,
          expectedLastActivityAt: "2026-07-23T11:12:14.000Z",
        },
      ],
    ]);

    invokeMock.mockClear();
    await setEnvironmentUnread("env-legacy", false, null);
    expect(invokeMock).toHaveBeenCalledWith("set_environment_unread", {
      environmentId: "env-legacy",
      unread: false,
      expectedLastActivityAt: null,
    });
  });

  test("exposes build-pipeline reads and backend-owned deletion", async () => {
    await backendWrappers.getBuildPipeline("pipeline-1");
    await backendWrappers.listBuildPipelines("project-1");
    await backendWrappers.deleteBuildPipeline("pipeline-1");

    expect(invokeMock.mock.calls).toEqual([
      ["get_build_pipeline", { pipelineId: "pipeline-1" }],
      ["list_build_pipelines", { projectId: "project-1" }],
      ["delete_build_pipeline", { pipelineId: "pipeline-1" }],
    ]);
  });

  test("forwards only explicit backend-owned pipeline controls", async () => {
    const input = {
      taskId: "task-1",
      projectId: "project-1",
      environmentType: "local" as const,
      agentType: "codex" as const,
      taskTitle: "Backend pipeline",
      taskSnapshot: {
        title: "Backend pipeline",
        description: "",
        acceptanceCriteria: "",
        comments: [],
        images: [],
      },
      featurePlanId: "feature-1",
    };

    await backendWrappers.startBuildPipeline(input);
    await backendWrappers.pauseBuildPipeline("pipeline-1");
    await backendWrappers.resumeBuildPipeline("pipeline-1");
    await backendWrappers.cancelBuildPipeline("pipeline-1");
    await backendWrappers.retryBuildPipelineCompletionComment("pipeline-1");
    await backendWrappers.sendBuildPipelineMessage("pipeline-1", "ship it");
    await backendWrappers.retryBuildPipelineReview("pipeline-1");
    await backendWrappers.retryBuildPipelineStage("pipeline-1");
    await backendWrappers.retryBuildPipelineInteractionFailure("pipeline-1");
    const legacySnapshots = [{ id: "legacy-pipeline" }];
    await backendWrappers.importLegacyBuildPipelines("project-1", legacySnapshots);

    expect(invokeMock.mock.calls).toEqual([
      ["start_build_pipeline", input],
      ["pause_build_pipeline", { pipelineId: "pipeline-1" }],
      ["resume_build_pipeline", { pipelineId: "pipeline-1" }],
      ["cancel_build_pipeline", { pipelineId: "pipeline-1" }],
      [
        "retry_build_pipeline_completion_comment",
        {
          pipelineId: "pipeline-1",
        },
      ],
      [
        "send_build_pipeline_message",
        {
          pipelineId: "pipeline-1",
          text: "ship it",
        },
      ],
      ["retry_build_pipeline_review", { pipelineId: "pipeline-1" }],
      ["retry_build_pipeline_stage", { pipelineId: "pipeline-1" }],
      [
        "retry_build_pipeline_interaction_failure",
        {
          pipelineId: "pipeline-1",
        },
      ],
      [
        "import_legacy_build_pipelines",
        {
          projectId: "project-1",
          snapshots: legacySnapshots,
        },
      ],
    ]);
  });

  test("forwards authoritative PR-monitor and completion-refresh commands exactly", async () => {
    await backendWrappers.getPrMonitorState();
    await backendWrappers.prMonitorWatch("env-1", "merge-pending");
    await backendWrappers.prMonitorRefresh("env-1");
    await backendWrappers.armPrRefreshAfterAgentCompletion("env-1");
    await backendWrappers.disarmPrRefreshAfterAgentCompletion("env-1", "armed-at-1");

    expect(invokeMock.mock.calls).toEqual([
      ["get_pr_monitor_state"],
      [
        "pr_monitor_watch",
        {
          environmentId: "env-1",
          mode: "merge-pending",
        },
      ],
      ["pr_monitor_refresh", { environmentId: "env-1" }],
      ["arm_pr_refresh_after_agent_completion", { environmentId: "env-1" }],
      [
        "disarm_pr_refresh_after_agent_completion",
        {
          environmentId: "env-1",
          armedAt: "armed-at-1",
        },
      ],
    ]);
  });

  test("forwards backend-owned prompt-queue mutations exactly", async () => {
    const message = { id: "message-1", text: "Ship it" };

    await backendWrappers.getPromptQueue("codex\u0000env-1:tab-1");
    await backendWrappers.listPromptQueues("env-1");
    await backendWrappers.enqueuePromptQueueMessage("codex\u0000env-1:tab-1", "env-1", message);
    await backendWrappers.requeuePromptQueueMessage("codex\u0000env-1:tab-1", "env-1", message);
    await backendWrappers.movePromptQueueMessage(
      "codex\u0000env-1:tab-1",
      "env-1",
      "message-1",
      "up",
    );
    await backendWrappers.removePromptQueueMessage("codex\u0000env-1:tab-1", "env-1", "message-1");
    await backendWrappers.claimPromptQueueHead("codex\u0000env-1:tab-1", "env-1", "message-1");
    await backendWrappers.acknowledgePromptQueueClaim("codex\u0000env-1:tab-1", "env-1", "claim-1");
    await backendWrappers.rejectPromptQueueClaim("codex\u0000env-1:tab-1", "env-1", "claim-2");
    await backendWrappers.transferPromptQueueMessageToComposeDraft(
      "codex\u0000env-1:tab-1",
      "env-1",
      "message-1",
      "codex:env-1:env-1%3Atab-1",
      "environment",
      "env-1",
      4,
    );
    await backendWrappers.retryPromptQueueDispatch("codex\u0000env-1:tab-1");

    expect(invokeMock.mock.calls).toEqual([
      ["get_prompt_queue", { queueKey: "codex\u0000env-1:tab-1" }],
      ["list_prompt_queues", { environmentId: "env-1" }],
      [
        "enqueue_prompt_queue_message",
        {
          queueKey: "codex\u0000env-1:tab-1",
          environmentId: "env-1",
          message,
        },
      ],
      [
        "requeue_prompt_queue_message",
        {
          queueKey: "codex\u0000env-1:tab-1",
          environmentId: "env-1",
          message,
        },
      ],
      [
        "move_prompt_queue_message",
        {
          queueKey: "codex\u0000env-1:tab-1",
          environmentId: "env-1",
          messageId: "message-1",
          direction: "up",
        },
      ],
      [
        "remove_prompt_queue_message",
        {
          queueKey: "codex\u0000env-1:tab-1",
          environmentId: "env-1",
          messageId: "message-1",
        },
      ],
      [
        "claim_prompt_queue_head",
        {
          queueKey: "codex\u0000env-1:tab-1",
          environmentId: "env-1",
          expectedMessageId: "message-1",
        },
      ],
      [
        "acknowledge_prompt_queue_claim",
        {
          queueKey: "codex\u0000env-1:tab-1",
          environmentId: "env-1",
          claimToken: "claim-1",
        },
      ],
      [
        "reject_prompt_queue_claim",
        {
          queueKey: "codex\u0000env-1:tab-1",
          environmentId: "env-1",
          claimToken: "claim-2",
        },
      ],
      [
        "transfer_prompt_queue_message_to_compose_draft",
        {
          queueKey: "codex\u0000env-1:tab-1",
          environmentId: "env-1",
          messageId: "message-1",
          draftKey: "codex:env-1:env-1%3Atab-1",
          ownerType: "environment",
          ownerId: "env-1",
          expectedDraftRevision: 4,
        },
      ],
      [
        "retry_prompt_queue_dispatch",
        {
          queueKey: "codex\u0000env-1:tab-1",
        },
      ],
    ]);
  });

  test("omits the expected draft revision entirely when the caller has none", async () => {
    /**
     * Sending `expectedDraftRevision: undefined` would be indistinguishable
     * from 0 after JSON serialization, and 0 asserts "no draft exists yet" —
     * turning an unconditional transfer into one that fails against any
     * existing draft.
     */
    await backendWrappers.transferPromptQueueMessageToComposeDraft(
      "codex\0env-1:tab-1",
      "env-1",
      "message-1",
      "codex:env-1:env-1%3Atab-1",
      "environment",
      "env-1",
    );

    const [command, payload] = invokeMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(command).toBe("transfer_prompt_queue_message_to_compose_draft");
    expect("expectedDraftRevision" in payload).toBe(false);
  });

  test("forwards draft compare-and-swap revisions exactly", async () => {
    await backendWrappers.saveComposeDraft(
      "compose:env-1:tab",
      "environment",
      "env-1",
      { text: "draft" },
      3,
    );
    await backendWrappers.deleteComposeDraft("compose:env-1:tab", 4);
    await backendWrappers.saveFileDraft(
      "file:env-1:index",
      "env-1",
      "src/index.ts",
      "edited",
      "disk",
      7,
    );
    await backendWrappers.deleteFileDraft("file:env-1:index", 8);

    expect(invokeMock.mock.calls).toEqual([
      [
        "save_compose_draft",
        {
          draftKey: "compose:env-1:tab",
          ownerType: "environment",
          ownerId: "env-1",
          value: { text: "draft" },
          expectedRevision: 3,
        },
      ],
      [
        "delete_compose_draft",
        {
          draftKey: "compose:env-1:tab",
          expectedRevision: 4,
        },
      ],
      [
        "save_file_draft",
        {
          draftKey: "file:env-1:index",
          environmentId: "env-1",
          filePath: "src/index.ts",
          content: "edited",
          originalContent: "disk",
          expectedRevision: 7,
        },
      ],
      [
        "delete_file_draft",
        {
          draftKey: "file:env-1:index",
          expectedRevision: 8,
        },
      ],
    ]);
  });

  test("creates environment-tracked local and container terminal sessions", async () => {
    const localResult = { sessionId: "local-session", created: true, bootstrapped: false };
    invokeMock.mockResolvedValueOnce(localResult);
    await expect(
      createLocalTerminalSession("env-local", 100, 30, true, "tab-local"),
    ).resolves.toEqual(localResult);

    const containerResult = { sessionId: "container-session", created: false, bootstrapped: true };
    invokeMock.mockResolvedValueOnce(containerResult);
    await expect(
      createTerminalSession(
        "container-1",
        120,
        40,
        undefined,
        true,
        "env-container",
        "tab-container",
      ),
    ).resolves.toEqual(containerResult);

    expect(invokeMock.mock.calls).toEqual([
      [
        "create_local_terminal_session",
        {
          environmentId: "env-local",
          cols: 100,
          rows: 30,
          trackEnvironmentActivity: true,
          terminalKey: "tab-local",
        },
      ],
      [
        "create_terminal_session",
        {
          containerId: "container-1",
          cols: 120,
          rows: 40,
          user: undefined,
          trackEnvironmentActivity: true,
          environmentId: "env-container",
          terminalKey: "tab-container",
        },
      ],
    ]);
  });

  test("rejects malformed terminal creation results at the native boundary", async () => {
    for (const malformed of [
      undefined,
      {},
      { sessionId: "", created: true },
      { sessionId: "terminal-1", created: "yes" },
    ]) {
      invokeMock.mockResolvedValueOnce(malformed);
      await expect(createTerminalSession("container-1", 80, 24)).rejects.toThrow(
        "invalid terminal session result",
      );
    }

    invokeMock.mockResolvedValueOnce({ sessionId: 42, created: false });
    await expect(createLocalTerminalSession("env-1", 80, 24)).rejects.toThrow(
      "invalid terminal session result",
    );
  });

  test("returns the revisioned terminal output snapshot with its generation", async () => {
    const snapshot = {
      output: "ready\r\n",
      revision: 7,
      generation: 3,
      truncated: false,
    };
    invokeMock.mockResolvedValueOnce(snapshot);

    await expect(getTerminalOutputSnapshot("terminal-1")).resolves.toEqual(snapshot);
    expect(invokeMock.mock.calls).toEqual([
      ["get_terminal_output_snapshot", { sessionId: "terminal-1" }],
    ]);
  });

  test("normalizes legacy snapshots and rejects malformed snapshot cursors", async () => {
    invokeMock.mockResolvedValueOnce({
      output: "legacy",
      revision: 1,
      generation: 2,
    });
    await expect(getTerminalOutputSnapshot("terminal-1")).resolves.toEqual({
      output: "legacy",
      revision: 1,
      generation: 2,
      truncated: false,
    });

    for (const malformed of [
      null,
      { output: 1, revision: 1, generation: 1 },
      { output: "", revision: -1, generation: 1 },
      { output: "", revision: 1.5, generation: 1 },
      { output: "", revision: 1, generation: Number.NaN },
      { output: "", revision: 1, generation: 1, truncated: "yes" },
    ]) {
      invokeMock.mockResolvedValueOnce(malformed);
      await expect(getTerminalOutputSnapshot("terminal-1")).rejects.toThrow(
        "invalid terminal output snapshot",
      );
    }
  });

  test("calls Linear Electron commands with expected payloads", async () => {
    await getLinearConnection();
    await connectLinear("lin_api_secret");
    await getLinearIssues();
    await getLinearIssue("ENG-123");
    await postLinearCompletionComment("pipeline-1", "issue-1", "Done");
    await disconnectLinear();

    expect(invokeMock.mock.calls).toEqual([
      ["get_linear_connection"],
      ["connect_linear", { apiKey: "lin_api_secret" }],
      ["get_linear_issues"],
      ["get_linear_issue", { issueId: "ENG-123" }],
      [
        "post_linear_completion_comment",
        {
          pipelineId: "pipeline-1",
          issueId: "issue-1",
          body: "Done",
        },
      ],
      ["disconnect_linear"],
    ]);
  });

  test("calls GitHub issue Electron commands with project-scoped payloads", async () => {
    await getGitHubIssues("project-1");
    await getGitHubIssue("project-1", 42);
    await updateGitHubIssue("project-1", 42, { title: "Title", body: "Body" });
    await updateGitHubIssueStatus("project-1", 42, "inprogress");
    await addGitHubIssueComment("project-1", 42, "Comment");
    await updateGitHubIssueComment("project-1", 42, 9001, "Edited");
    await closeGitHubIssue("project-1", 42);
    await postGitHubCompletionComment(
      "pipeline-1",
      "project-1",
      "acme",
      "widget",
      42,
      "Build completed",
    );

    expect(invokeMock.mock.calls).toEqual([
      ["get_github_issues", { projectId: "project-1" }],
      ["get_github_issue", { projectId: "project-1", issueNumber: 42 }],
      [
        "update_github_issue",
        {
          projectId: "project-1",
          issueNumber: 42,
          title: "Title",
          body: "Body",
        },
      ],
      [
        "update_github_issue_status",
        {
          projectId: "project-1",
          issueNumber: 42,
          status: "inprogress",
        },
      ],
      [
        "add_github_issue_comment",
        {
          projectId: "project-1",
          issueNumber: 42,
          body: "Comment",
        },
      ],
      [
        "update_github_issue_comment",
        {
          projectId: "project-1",
          issueNumber: 42,
          commentId: 9001,
          body: "Edited",
        },
      ],
      ["close_github_issue", { projectId: "project-1", issueNumber: 42 }],
      [
        "post_github_completion_comment",
        {
          pipelineId: "pipeline-1",
          projectId: "project-1",
          repositoryOwner: "acme",
          repositoryName: "widget",
          issueNumber: 42,
          body: "Build completed",
        },
      ],
    ]);
  });

  test("uses the write-only GitHub token command for replacement and clearing", async () => {
    const configured = {
      version: "1.0",
      global: { githubTokenConfigured: true },
      repositories: {},
    } as AppConfig;
    const cleared = {
      version: "1.0",
      global: { githubTokenConfigured: false },
      repositories: {},
    } as AppConfig;
    invokeMock.mockResolvedValueOnce(configured).mockResolvedValueOnce(cleared);

    await expect(setGitHubToken("ghp_replacement")).resolves.toBe(configured);
    await expect(setGitHubToken(null)).resolves.toBe(cleared);

    expect(invokeMock.mock.calls).toEqual([
      ["set_github_token", { token: "ghp_replacement" }],
      ["set_github_token", { token: null }],
    ]);
  });

  test("uses the write-only Cursor API key command for replacement and clearing", async () => {
    const configured = {
      version: "1.0",
      global: { cursorApiKeyConfigured: true },
      repositories: {},
    } as AppConfig;
    const cleared = {
      version: "1.0",
      global: { cursorApiKeyConfigured: false },
      repositories: {},
    } as AppConfig;
    invokeMock.mockResolvedValueOnce(configured).mockResolvedValueOnce(cleared);

    await expect(setCursorApiKey("cursor_replacement")).resolves.toBe(configured);
    await expect(setCursorApiKey(null)).resolves.toBe(cleared);

    expect(invokeMock.mock.calls).toEqual([
      ["set_cursor_api_key", { apiKey: "cursor_replacement" }],
      ["set_cursor_api_key", { apiKey: null }],
    ]);
  });

  test("uses the write-only Anthropic API key command for replacement and clearing", async () => {
    const configured = {
      version: "1.0",
      global: { anthropicApiKeyConfigured: true },
      repositories: {},
    } as AppConfig;
    const cleared = {
      version: "1.0",
      global: { anthropicApiKeyConfigured: false },
      repositories: {},
    } as AppConfig;
    invokeMock.mockResolvedValueOnce(configured).mockResolvedValueOnce(cleared);

    await expect(setAnthropicApiKey("anthropic_replacement")).resolves.toBe(configured);
    await expect(setAnthropicApiKey(null)).resolves.toBe(cleared);

    expect(invokeMock.mock.calls).toEqual([
      ["set_anthropic_api_key", { apiKey: "anthropic_replacement" }],
      ["set_anthropic_api_key", { apiKey: null }],
    ]);
  });

  test("refreshes running containers from the backend-selected GitHub credential source", async () => {
    const result = { updated: ["env-1"], failed: [] };
    invokeMock.mockResolvedValueOnce(result);

    await expect(propagateGithubCredentialsToContainers()).resolves.toBe(result);
    expect(invokeMock.mock.calls).toEqual([["propagate_github_token_to_containers"]]);
  });

  test("reports the backend-selected GitHub credential source and availability", async () => {
    const status = { source: "host-cli" as const, available: true };
    invokeMock.mockResolvedValueOnce(status);

    await expect(getContainerGitHubCredentialStatus()).resolves.toBe(status);
    expect(invokeMock.mock.calls).toEqual([["get_container_github_credential_status"]]);
  });

  test("forwards exact pane layout command payloads and results", async () => {
    const layout = {
      version: 1,
      environmentId: "env-1",
      containerId: "container-1",
      activePaneId: "pane-1",
      root: { kind: "leaf" as const, id: "pane-1", tabs: [], activeTabId: null },
      updatedAt: "2026-07-16T00:00:00.000Z",
      revision: 2,
    };
    invokeMock.mockResolvedValueOnce(layout);
    await expect(getPaneLayout("env-1")).resolves.toEqual(layout);

    invokeMock.mockResolvedValueOnce(layout);
    await expect(
      savePaneLayout(
        "env-1",
        {
          version: layout.version,
          containerId: layout.containerId,
          activePaneId: layout.activePaneId,
          root: layout.root,
        },
        1,
      ),
    ).resolves.toEqual(layout);
    await expect(deletePaneLayout("env-1")).resolves.toBeUndefined();
    await expect(deletePaneLayout("env-1", 2)).resolves.toBeUndefined();

    expect(invokeMock.mock.calls).toEqual([
      ["get_pane_layout", { environmentId: "env-1" }],
      [
        "save_pane_layout",
        {
          environmentId: "env-1",
          layout: {
            version: 1,
            containerId: "container-1",
            activePaneId: "pane-1",
            root: layout.root,
          },
          expectedRevision: 1,
        },
      ],
      ["delete_pane_layout", { environmentId: "env-1" }],
      ["delete_pane_layout", { environmentId: "env-1", expectedRevision: 2 }],
    ]);
  });
});

describe("backend web client wrappers", () => {
  test("uses the Electron preload API for status and transitions", async () => {
    const status = { enabled: true, running: true, url: "http://100.88.12.3:34121/", error: null };
    const getStatus = mock(async () => status);
    const setEnabled = mock(async (enabled: boolean) => ({
      ...status,
      enabled,
      running: enabled,
      url: enabled ? status.url : null,
    }));
    const resetServe = mock(async () => status);
    const tokenSettings = { token: "test-token-123456", editable: true, source: "file" as const };
    const getTokenSettings = mock(async () => tokenSettings);
    const setToken = mock(async (token: string) => ({ ...tokenSettings, token }));
    window.orkestrator = {
      ...originalOrkestrator!,
      webClient: { getStatus, setEnabled, resetServe, getTokenSettings, setToken },
    };

    await expect(getWebClientStatus()).resolves.toEqual(status);
    await expect(setWebClientEnabled(false)).resolves.toMatchObject({
      enabled: false,
      running: false,
    });
    await expect(resetWebClientServe()).resolves.toEqual(status);
    await expect(getGatewayTokenSettings()).resolves.toEqual(tokenSettings);
    await expect(setGatewayToken("replacement-token-123456")).resolves.toMatchObject({
      token: "replacement-token-123456",
    });
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(resetServe).toHaveBeenCalledTimes(1);
    expect(setToken).toHaveBeenCalledWith("replacement-token-123456");
  });

  test("reports the current browser origin as running in authenticated gateway mode", async () => {
    window.orkestrator = undefined;
    window.orkestratorGateway = { enabled: true };

    await expect(getWebClientStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      url: `${window.location.origin}/`,
      error: null,
    });
  });

  test("reports the configured direct backend origin in public-client mode", async () => {
    window.orkestrator = undefined;
    window.orkestratorGateway = {
      enabled: true,
      baseUrl: "https://workstation.tailnet.ts.net/",
    };

    await expect(getWebClientStatus()).resolves.toEqual({
      enabled: true,
      running: true,
      url: "https://workstation.tailnet.ts.net/",
      error: null,
    });
  });

  test("rejects status and mutations outside Electron or gateway mode", async () => {
    window.orkestrator = undefined;
    window.orkestratorGateway = undefined;

    await expect(getWebClientStatus()).rejects.toThrow("only available in the desktop app");
    await expect(setWebClientEnabled(true)).rejects.toThrow("only available in the desktop app");
    await expect(resetWebClientServe()).rejects.toThrow("only available for the local desktop app");
    await expect(getGatewayTokenSettings()).rejects.toThrow("unavailable");
    await expect(setGatewayToken("replacement-token-123456")).rejects.toThrow("unavailable");
  });
});

describe("backend native agent and looped review wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue(undefined);
  });

  test("acknowledges a startup session with its durable identity", async () => {
    const environment = {
      id: "env-1",
    } as Awaited<ReturnType<typeof backendWrappers.acknowledgeStartupAgentSession>>;
    invokeMock.mockResolvedValueOnce(environment);

    await expect(
      backendWrappers.acknowledgeStartupAgentSession("env-1", {
        providerSessionId: "provider-1",
        startedAt: "2026-07-29T12:00:00.000Z",
      }),
    ).resolves.toBe(environment);

    expect(invokeMock).toHaveBeenCalledWith("acknowledge_startup_agent_session", {
      environmentId: "env-1",
      providerSessionId: "provider-1",
      startedAt: "2026-07-29T12:00:00.000Z",
    });
  });

  test("omits absent startup session identity fields", async () => {
    await backendWrappers.acknowledgeStartupAgentSession("env-1", {
      providerSessionId: "",
      startedAt: undefined,
    });

    const [[command, payload]] = invokeMock.mock.calls as [[string, Record<string, unknown>]];
    expect(command).toBe("acknowledge_startup_agent_session");
    expect(payload).toEqual({ environmentId: "env-1" });
    expect(payload).not.toHaveProperty("providerSessionId");
    expect(payload).not.toHaveProperty("startedAt");
  });

  test("ensures native sessions with full and minimal payloads", async () => {
    const session = {
      version: 1 as const,
      key: "native-session-key",
      environmentId: "env-1",
      agent: "codex" as const,
      logicalSessionKey: "review-1",
      providerSessionId: "provider-1",
      origin: "interactive-native" as const,
      interactionPolicy: {
        version: 1 as const,
        mode: "interactive" as const,
        input: "await-user" as const,
        authorization: "await-user" as const,
        unknown: "deny-and-fail" as const,
      },
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
    };
    invokeMock.mockResolvedValueOnce(session);

    const fullInput = {
      environmentId: "env-1",
      agent: "codex" as const,
      logicalSessionKey: "review-1",
      origin: "looped-review" as const,
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      title: "Review",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      phase: "review" as const,
    };
    await expect(backendWrappers.ensureNativeAgentSession(fullInput)).resolves.toBe(session);
    expect(invokeMock).toHaveBeenLastCalledWith("ensure_native_agent_session", fullInput);

    const minimalInput = {
      environmentId: "env-2",
      agent: "opencode" as const,
      logicalSessionKey: "build-1",
    };
    await backendWrappers.ensureNativeAgentSession(minimalInput);
    expect(invokeMock).toHaveBeenLastCalledWith("ensure_native_agent_session", minimalInput);
    const minimalPayload = invokeMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(minimalPayload).not.toHaveProperty("title");
    expect(minimalPayload).not.toHaveProperty("origin");
    expect(minimalPayload).not.toHaveProperty("interactionPolicy");
    expect(minimalPayload).not.toHaveProperty("model");
    expect(minimalPayload).not.toHaveProperty("reasoningEffort");
    expect(minimalPayload).not.toHaveProperty("phase");
  });

  test("adopts native sessions with full and minimal payloads", async () => {
    const adopted = {
      version: 1 as const,
      key: "native-session-key",
      environmentId: "env-1",
      agent: "opencode" as const,
      logicalSessionKey: "fork-1",
      providerSessionId: "provider-new",
      origin: "interactive-native" as const,
      interactionPolicy: {
        version: 1 as const,
        mode: "interactive" as const,
        input: "await-user" as const,
        authorization: "await-user" as const,
        unknown: "deny-and-fail" as const,
      },
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:01:00.000Z",
    };
    invokeMock.mockResolvedValueOnce(adopted);

    const fullInput = {
      environmentId: "env-1",
      agent: "opencode" as const,
      logicalSessionKey: "fork-1",
      origin: "build-pipeline" as const,
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      providerSessionId: "provider-new",
      expectedProviderSessionId: "provider-old",
      model: "open-model",
      reasoningEffort: "medium",
      sessionMode: "build" as const,
      fastMode: true,
    };
    await expect(backendWrappers.adoptNativeAgentSession(fullInput)).resolves.toBe(adopted);
    expect(invokeMock).toHaveBeenLastCalledWith("adopt_native_agent_session", fullInput);

    const minimalInput = {
      environmentId: "env-2",
      agent: "claude" as const,
      logicalSessionKey: "resume-1",
      providerSessionId: "provider-2",
    };
    await backendWrappers.adoptNativeAgentSession(minimalInput);
    expect(invokeMock).toHaveBeenLastCalledWith("adopt_native_agent_session", minimalInput);
    const minimalPayload = invokeMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(minimalPayload).not.toHaveProperty("expectedProviderSessionId");
    expect(minimalPayload).not.toHaveProperty("origin");
    expect(minimalPayload).not.toHaveProperty("interactionPolicy");
    expect(minimalPayload).not.toHaveProperty("model");
    expect(minimalPayload).not.toHaveProperty("reasoningEffort");
    expect(minimalPayload).not.toHaveProperty("sessionMode");
    expect(minimalPayload).not.toHaveProperty("fastMode");
  });

  test("reads native sessions", async () => {
    invokeMock.mockResolvedValueOnce(null);
    const identity = {
      environmentId: "env-1",
      agent: "opencode" as const,
      logicalSessionKey: "tab-1",
    };
    await expect(backendWrappers.getNativeAgentSession(identity)).resolves.toBeNull();
    expect(invokeMock).toHaveBeenLastCalledWith("get_native_agent_session", identity);
  });

  test("dispatches native prompts with full and minimal payloads", async () => {
    const dispatched = {
      version: 1 as const,
      key: "native-session-key",
      environmentId: "env-1",
      agent: "claude" as const,
      logicalSessionKey: "fix-1",
      providerSessionId: "provider-1",
      origin: "interactive-native" as const,
      interactionPolicy: {
        version: 1 as const,
        mode: "interactive" as const,
        input: "await-user" as const,
        authorization: "await-user" as const,
        unknown: "deny-and-fail" as const,
      },
      dispatchedRequestIds: ["request-1"],
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:01:00.000Z",
    };
    invokeMock.mockResolvedValueOnce(dispatched);

    const fullInput = {
      environmentId: "env-1",
      agent: "claude" as const,
      logicalSessionKey: "fix-1",
      origin: "looped-review" as const,
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      title: "Fix review",
      model: "claude-model",
      reasoningEffort: "high",
      phase: "fix" as const,
      prompt: "Fix the finding",
      requestId: "request-1",
      images: [{ filename: "failure.png", data: "cGl4ZWxz" }],
      schema: { type: "object" },
    };
    await expect(backendWrappers.dispatchNativeAgentPrompt(fullInput)).resolves.toBe(dispatched);
    expect(invokeMock).toHaveBeenLastCalledWith("dispatch_native_agent_prompt", fullInput);

    const minimalInput = {
      environmentId: "env-2",
      agent: "codex" as const,
      logicalSessionKey: "build-2",
      prompt: "Continue",
      requestId: "request-2",
    };
    await backendWrappers.dispatchNativeAgentPrompt(minimalInput);
    expect(invokeMock).toHaveBeenLastCalledWith("dispatch_native_agent_prompt", minimalInput);
    const minimalPayload = invokeMock.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(minimalPayload).not.toHaveProperty("title");
    expect(minimalPayload).not.toHaveProperty("origin");
    expect(minimalPayload).not.toHaveProperty("interactionPolicy");
    expect(minimalPayload).not.toHaveProperty("model");
    expect(minimalPayload).not.toHaveProperty("reasoningEffort");
    expect(minimalPayload).not.toHaveProperty("phase");
    expect(minimalPayload).not.toHaveProperty("images");
    expect(minimalPayload).not.toHaveProperty("schema");
  });

  test("dispatches shared native-agent intents with an explicit outcome", async () => {
    invokeMock.mockResolvedValueOnce({
      outcome: "unknown",
      requestId: "request-stable",
      error: "response was lost",
    });
    const input = {
      environmentId: "env-1",
      agent: "cursor" as const,
      logicalSessionKey: "env-env-1:tab-1",
      prompt: "Continue",
      requestId: "request-stable",
      mode: "build" as const,
      fastMode: true,
    };

    await expect(backendWrappers.dispatchNativeAgentIntent(input)).resolves.toEqual({
      outcome: "unknown",
      requestId: "request-stable",
      error: "response was lost",
    });
    expect(invokeMock).toHaveBeenLastCalledWith("dispatch_native_agent_intent", input);
  });

  test("carries an optional controller fence on workflow saves", async () => {
    const snapshot = {
      id: "workflow-1",
      environmentId: "env-1",
      phase: "fixing",
    };

    await backendWrappers.saveLoopedReviewWorkflow("workflow-1", "env-1", 1, snapshot, 7, {
      ownerId: "owner-1",
      token: "lease-token",
    });
    expect(invokeMock).toHaveBeenLastCalledWith("save_looped_review_workflow", {
      workflowId: "workflow-1",
      environmentId: "env-1",
      version: 1,
      snapshot,
      expectedRevision: 7,
      controllerOwnerId: "owner-1",
      controllerToken: "lease-token",
    });

    await backendWrappers.saveLoopedReviewWorkflow("workflow-1", "env-1", 1, snapshot);
    expect(invokeMock).toHaveBeenLastCalledWith("save_looped_review_workflow", {
      workflowId: "workflow-1",
      environmentId: "env-1",
      version: 1,
      snapshot,
    });
  });

  test("maps looped-review lifecycle commands and exact payloads", async () => {
    const input = {
      environmentId: "env-1",
      projectId: "project-1",
      agent: "codex" as const,
      model: "gpt-5.6-sol",
      targetBranch: "main",
      allowance: 6,
    };
    const workflow = { id: "workflow-1" } as unknown as Awaited<
      ReturnType<typeof backendWrappers.startLoopedReview>
    >;
    invokeMock.mockResolvedValue(workflow);

    await expect(backendWrappers.startLoopedReview(input)).resolves.toBe(workflow);
    expect(invokeMock).toHaveBeenLastCalledWith("start_looped_review", input);

    for (const [method, command] of [
      [backendWrappers.pauseLoopedReview, "pause_looped_review"],
      [backendWrappers.resumeLoopedReview, "resume_looped_review"],
      [backendWrappers.retryLoopedReview, "retry_looped_review"],
      [backendWrappers.cancelLoopedReview, "cancel_looped_review"],
    ] as const) {
      await expect(method("workflow-1")).resolves.toBe(workflow);
      expect(invokeMock).toHaveBeenLastCalledWith(command, { workflowId: "workflow-1" });
    }
  });

  test("maps every multi review command and spreads the launch intent", async () => {
    const input = {
      environmentId: "env-1",
      projectId: "project-1",
      targetBranch: "main",
      reviewInstruction: "Focus on correctness",
      reviewers: [
        { agent: "claude" as const, model: "opus" },
        { agent: "codex" as const, model: "gpt-5.6", reasoningEffort: "high" },
      ],
      fixModel: { agent: "codex" as const, model: "gpt-5.6" },
    };
    const workflow = { id: "multi-1" } as unknown as Awaited<
      ReturnType<typeof backendWrappers.startMultiReview>
    >;
    invokeMock.mockResolvedValue(workflow);

    await expect(backendWrappers.startMultiReview(input)).resolves.toBe(workflow);
    // Spread, not nested: the backend validates the launch intent at the top
    // level and rejects any key it does not recognise.
    expect(invokeMock).toHaveBeenLastCalledWith("start_multi_review", { ...input });

    for (const [method, command] of [
      [backendWrappers.addressMultiReview, "address_multi_review"],
      [backendWrappers.retryMultiReview, "retry_multi_review"],
      [backendWrappers.cancelMultiReview, "cancel_multi_review"],
    ] as const) {
      await expect(method("multi-1")).resolves.toBe(workflow);
      expect(invokeMock).toHaveBeenLastCalledWith(command, { workflowId: "multi-1" });
    }

    // Stopping is reviewer-scoped: the workflow keeps running without it.
    await expect(backendWrappers.stopMultiReviewReviewer("multi-1", "reviewer-1")).resolves.toBe(
      workflow,
    );
    expect(invokeMock).toHaveBeenLastCalledWith("stop_multi_review_reviewer", {
      workflowId: "multi-1",
      reviewerId: "reviewer-1",
    });

    await backendWrappers.getMultiReviewWorkflow("multi-1");
    expect(invokeMock).toHaveBeenLastCalledWith("get_multi_review_workflow", {
      workflowId: "multi-1",
    });
    await backendWrappers.listMultiReviewWorkflows("env-1");
    expect(invokeMock).toHaveBeenLastCalledWith("list_multi_review_workflows", {
      environmentId: "env-1",
    });
    await backendWrappers.deleteMultiReviewWorkflow("multi-1");
    expect(invokeMock).toHaveBeenLastCalledWith("delete_multi_review_workflow", {
      workflowId: "multi-1",
    });
  });

  test("omits an absent provider session id and maps workflow reads and deletion", async () => {
    invokeMock.mockResolvedValueOnce({ providerSessionId: "provider-1" });
    await backendWrappers.getLoopedReviewProviderSession("workflow-1");
    expect(invokeMock).toHaveBeenLastCalledWith("get_looped_review_provider_session", {
      workflowId: "workflow-1",
    });

    await backendWrappers.getLoopedReviewProviderSession("workflow-1", "session-1");
    expect(invokeMock).toHaveBeenLastCalledWith("get_looped_review_provider_session", {
      workflowId: "workflow-1",
      sessionId: "session-1",
    });

    await backendWrappers.getLoopedReviewWorkflow("workflow-1");
    expect(invokeMock).toHaveBeenLastCalledWith("get_looped_review_workflow", {
      workflowId: "workflow-1",
    });
    await backendWrappers.listLoopedReviewWorkflows("env-1");
    expect(invokeMock).toHaveBeenLastCalledWith("list_looped_review_workflows", {
      environmentId: "env-1",
    });
    await backendWrappers.deleteLoopedReviewWorkflow("workflow-1");
    expect(invokeMock).toHaveBeenLastCalledWith("delete_looped_review_workflow", {
      workflowId: "workflow-1",
    });
  });

  test("forwards a blank provider session id instead of falling back to the active one", async () => {
    // A blank id is a caller bug. Substituting the active session would open
    // the wrong provider transcript; forwarding it lets the backend reject it.
    invokeMock.mockResolvedValueOnce(null);
    await backendWrappers.getLoopedReviewProviderSession("workflow-1", "");
    expect(invokeMock).toHaveBeenLastCalledWith("get_looped_review_provider_session", {
      workflowId: "workflow-1",
      sessionId: "",
    });
  });

  test("propagates a null provider session and a null workflow read", async () => {
    invokeMock.mockResolvedValueOnce(null);
    await expect(backendWrappers.getLoopedReviewProviderSession("workflow-1")).resolves.toBeNull();
    invokeMock.mockResolvedValueOnce(null);
    await expect(backendWrappers.getLoopedReviewWorkflow("workflow-1")).resolves.toBeNull();
  });

  test("propagates native dispatch and controller errors unchanged", async () => {
    const dispatchError = new Error("dispatch denied");
    invokeMock.mockRejectedValueOnce(dispatchError);
    await expect(
      backendWrappers.dispatchNativeAgentPrompt({
        environmentId: "env-1",
        agent: "codex",
        logicalSessionKey: "review-1",
        prompt: "Review",
        requestId: "request-1",
      }),
    ).rejects.toBe(dispatchError);
  });
});

describe("backend command wrapper coverage", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (command: unknown) => {
      if (command === "read_file_base64") return btoa("binary");
      if (command === "await_bridge_ready") {
        return { status: "ready", port: 4321, authToken: "token" };
      }
      if (command === "get_build_pipeline") return null;
      if (
        command === "list_build_pipelines" ||
        command === "get_git_status" ||
        command === "get_file_tree" ||
        command === "get_local_git_status" ||
        command === "get_local_file_tree"
      ) {
        return [];
      }
      return undefined;
    });
    window.orkestrator = originalOrkestrator;
    window.orkestratorGateway = originalGateway;
  });

  test("prefers the native browser opener when Electron also exposes gateway metadata", async () => {
    window.orkestratorGateway = {
      enabled: true,
      desktop: true,
      baseUrl: "https://workstation.tailnet.ts.net",
    };

    await openInBrowser("https://example.com/docs");

    expect(invokeMock).toHaveBeenCalledWith("open_in_browser", {
      url: "https://example.com/docs",
    });
  });

  test("submits backend-owned environment starts with the expected command payload", async () => {
    await backendWrappers.startEnvironmentInBackground("env-background");

    expect(invokeMock).toHaveBeenCalledWith("start_environment_background", {
      environmentId: "env-background",
    });
  });

  test("validates and returns backend bridge readiness snapshots", async () => {
    await expect(backendWrappers.awaitBridgeReady("env-ready", "codex", 12_345)).resolves.toEqual({
      status: "ready",
      port: 4321,
      authToken: "token",
    });
    expect(invokeMock).toHaveBeenLastCalledWith("await_bridge_ready", {
      environmentId: "env-ready",
      agent: "codex",
      timeoutMs: 12_345,
    });

    const failed = {
      status: "failed",
      error: { message: "bridge failed", retryable: false },
    } as const;
    invokeMock.mockResolvedValueOnce(failed);
    await expect(backendWrappers.awaitBridgeReady("env-ready", "claude")).resolves.toEqual(failed);

    const timedOut = {
      status: "timed-out",
      error: { message: "bridge timed out", retryable: true, retryAfterMs: 500 },
    } as const;
    invokeMock.mockResolvedValueOnce(timedOut);
    await expect(backendWrappers.awaitBridgeReady("env-ready", "opencode")).resolves.toEqual(
      timedOut,
    );
  });

  test("rejects empty and malformed readiness payloads", async () => {
    for (const malformed of [
      undefined,
      null,
      { status: "ready", port: 0, authToken: "token" },
      { status: "ready", port: 4321, authToken: "" },
      { status: "timed-out", error: { message: "timeout" } },
      { status: "unknown" },
    ]) {
      invokeMock.mockResolvedValueOnce(malformed);
      await expect(backendWrappers.awaitBridgeReady("env-invalid", "codex")).rejects.toThrow(
        "invalid bridge readiness result",
      );
    }
  });

  test("opens browser-gateway links in a client-side tab", async () => {
    const windowOpen = mock(() => null);
    window.open = windowOpen as typeof window.open;
    window.orkestratorGateway = {
      enabled: true,
      baseUrl: "https://workstation.tailnet.ts.net",
    };

    await openInBrowser("https://example.com/docs");

    expect(windowOpen).toHaveBeenCalledWith(
      "https://example.com/docs",
      "_blank",
      "noopener,noreferrer",
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  test("forwards PR verification and deterministic package-generation inputs", async () => {
    invokeMock.mockResolvedValueOnce({
      url: "https://github.com/acme/repo/pull/42",
      headRefName: "feature/review",
      baseRefName: "main",
      state: "OPEN",
    });
    await backendWrappers.verifyEnvironmentPr(
      "env-1",
      "https://github.com/acme/repo/pull/42",
      "main",
    );
    expect(invokeMock).toHaveBeenLastCalledWith("verify_environment_pr", {
      environmentId: "env-1",
      prUrl: "https://github.com/acme/repo/pull/42",
      targetBranch: "main",
    });

    const preparation = {
      validation: [
        {
          command: "bun test",
          status: "passed" as const,
          exitCode: 0,
          stdoutPath: ".orkestrator/review-artifacts/package-1/validation-01.stdout.txt",
          stderrPath: ".orkestrator/review-artifacts/package-1/validation-01.stderr.txt",
          durationMs: 42,
          limitation: null,
        },
      ],
      uncommittedFiles: [],
      limitations: [],
    };
    // generate_looped_review_package is invoked by the backend service, never
    // by the renderer, so there is no wrapper here to exercise.
    void preparation;
  });

  test("forwards backend-owned merge and cleanup intent as one command", async () => {
    const result = {
      outcome: "pending" as const,
      cleanupOutcome: "pending" as const,
    };
    invokeMock.mockResolvedValueOnce(result);

    await expect(
      backendWrappers.mergeEnvironmentPr("env-1", "rebase", true, true),
    ).resolves.toEqual(result);

    expect(invokeMock).toHaveBeenLastCalledWith("merge_environment_pr", {
      environmentId: "env-1",
      method: "rebase",
      deleteBranch: true,
      cleanupAfterMerge: true,
    });
  });

  test("forwards explicit committed-only Git status requests", async () => {
    await backendWrappers.getGitStatus("container-1", "base-sha", false);
    expect(invokeMock).toHaveBeenLastCalledWith("get_git_status", {
      containerId: "container-1",
      targetBranch: "base-sha",
      includeUncommitted: false,
    });

    await backendWrappers.getLocalGitStatus("/tmp/worktree", "base-sha", false);
    expect(invokeMock).toHaveBeenLastCalledWith("get_local_git_status", {
      worktreePath: "/tmp/worktree",
      targetBranch: "base-sha",
      includeUncommitted: false,
    });
  });

  test("includes uncommitted changes in Git status requests by default", async () => {
    await backendWrappers.getGitStatus("container-1", "main");
    expect(invokeMock).toHaveBeenLastCalledWith("get_git_status", {
      containerId: "container-1",
      targetBranch: "main",
      includeUncommitted: true,
    });

    await backendWrappers.getLocalGitStatus("/tmp/worktree", "main");
    expect(invokeMock).toHaveBeenLastCalledWith("get_local_git_status", {
      worktreePath: "/tmp/worktree",
      targetBranch: "main",
      includeUncommitted: true,
    });
  });

  test("every exported command wrapper reaches the native invoke boundary", async () => {
    const specialWrappers = new Set([
      "getWebClientStatus",
      "setWebClientEnabled",
      "resetWebClientServe",
      "getGatewayTokenSettings",
      "setGatewayToken",
      "readBinaryFile",
      "createLocalTerminalSession",
      "createTerminalSession",
      "getTerminalOutputSnapshot",
      "getResourceRevisionManifest",
      "getNativeAgentModelCatalog",
    ]);
    const commandWrappers = Object.entries(backendWrappers).flatMap(([name, value]) =>
      typeof value === "function" && !specialWrappers.has(name)
        ? [[name, value as (...args: unknown[]) => Promise<unknown>] as const]
        : [],
    );

    expect(commandWrappers.length).toBeGreaterThan(150);
    for (const [name, wrapper] of commandWrappers) {
      invokeMock.mockClear();
      const args = Array.from({ length: wrapper.length }, () => "value");
      await wrapper(...args);
      expect(invokeMock.mock.calls.length, `${name} must call invoke`).toBeGreaterThan(0);
    }
  });

  test("validates and forwards resource revision manifest knowledge", async () => {
    const response = {
      generation: "a".repeat(32),
      reset: false,
      revisions: { config: "b".repeat(32) },
    };
    invokeMock.mockResolvedValueOnce(response);

    await expect(
      backendWrappers.getResourceRevisionManifest("a".repeat(32), { config: "c".repeat(32) }),
    ).resolves.toEqual(response);
    expect(invokeMock).toHaveBeenLastCalledWith("get_resource_revision_manifest", {
      knownGeneration: "a".repeat(32),
      knownRevisions: { config: "c".repeat(32) },
    });

    invokeMock.mockResolvedValueOnce({ generation: "invalid" });
    await expect(backendWrappers.getResourceRevisionManifest()).rejects.toThrow(
      "Invalid resource revision manifest response",
    );
  });

  test("getEnvironmentExtensions defaults to the cached backend result", async () => {
    await backendWrappers.getEnvironmentExtensions("env-1");

    expect(invokeMock).toHaveBeenCalledWith("get_environment_extensions", {
      environmentId: "env-1",
      refresh: false,
    });
  });

  test("uses the local Electron directory dialog and normalizes non-string results", async () => {
    const open = mock(async () => "/tmp/project" as string | string[] | null);
    window.orkestrator = {
      ...originalOrkestrator!,
      dialog: { open },
    };
    window.orkestratorGateway = undefined;

    await expect(backendWrappers.browseForDirectory()).resolves.toBe("/tmp/project");
    expect(open).toHaveBeenCalledWith({ directory: true });
    expect(invokeMock).not.toHaveBeenCalled();

    open.mockResolvedValue(["/tmp/one", "/tmp/two"]);
    await expect(backendWrappers.browseForDirectory()).resolves.toBeNull();
  });

  test("getEnvironmentExtensions forwards an explicit refresh", async () => {
    await backendWrappers.getEnvironmentExtensions("env-1", { refresh: true });

    expect(invokeMock).toHaveBeenCalledWith("get_environment_extensions", {
      environmentId: "env-1",
      refresh: true,
    });
  });

  test("lists and reads skills through environment-scoped commands", async () => {
    await backendWrappers.listEnvironmentAgentSkills("env-1", "codex");
    expect(invokeMock).toHaveBeenLastCalledWith("list_environment_agent_skills", {
      environmentId: "env-1",
      provider: "codex",
    });

    await backendWrappers.readEnvironmentAgentSkill(
      "env-1",
      "codex",
      "/workspace/.agents/skills/review/SKILL.md",
    );
    expect(invokeMock).toHaveBeenLastCalledWith("read_environment_agent_skill", {
      environmentId: "env-1",
      provider: "codex",
      filePath: "/workspace/.agents/skills/review/SKILL.md",
    });
  });

  test("deletes an agent handoff through its environment-scoped command", async () => {
    invokeMock.mockResolvedValueOnce(true);

    await expect(backendWrappers.deleteAgentHandoff("handoff-1", "env-1")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("delete_agent_handoff", {
      handoffId: "handoff-1",
      environmentId: "env-1",
    });
  });

  test("reads and writes agent handoff snapshots through their commands", async () => {
    const snapshot = { messages: [{ id: "m1" }] };
    const stored = {
      id: "handoff-1",
      environmentId: "env-1",
      version: 1,
      snapshot,
      createdAt: "2026-07-27T11:00:00.000Z",
    };

    invokeMock.mockResolvedValueOnce(stored);
    await expect(backendWrappers.getAgentHandoff("handoff-1")).resolves.toEqual(stored);
    expect(invokeMock).toHaveBeenCalledWith("get_agent_handoff", {
      handoffId: "handoff-1",
    });

    invokeMock.mockResolvedValueOnce(stored);
    await expect(
      backendWrappers.saveAgentHandoff("handoff-1", "env-1", 1, snapshot),
    ).resolves.toEqual(stored);
    expect(invokeMock).toHaveBeenCalledWith("save_agent_handoff", {
      handoffId: "handoff-1",
      environmentId: "env-1",
      version: 1,
      snapshot,
    });
  });

  test("prunes agent handoffs against the layout's reference set", async () => {
    invokeMock.mockResolvedValueOnce(["orphan"]);

    await expect(backendWrappers.pruneAgentHandoffs("env-1", ["kept"])).resolves.toEqual([
      "orphan",
    ]);
    expect(invokeMock).toHaveBeenCalledWith("prune_agent_handoffs", {
      environmentId: "env-1",
      referencedHandoffIds: ["kept"],
    });
  });

  test("claims a feature build with both ownership identifiers", async () => {
    await claimFeaturePlanBuild("feature-1", "task-1");

    expect(invokeMock).toHaveBeenCalledWith("claim_feature_plan_build", {
      featureId: "feature-1",
      taskId: "task-1",
    });
  });

  test("forwards feature planning lifecycle command payloads", async () => {
    await startFeaturePlanning("feature-1", "feature", "Plan search");
    expect(invokeMock).toHaveBeenLastCalledWith("start_feature_planning", {
      featureId: "feature-1",
      kind: "feature",
      userMessage: "Plan search",
    });

    await startFeaturePlanning("feature-1", "story", "Tighten criteria", "story-2");
    expect(invokeMock).toHaveBeenLastCalledWith("start_feature_planning", {
      featureId: "feature-1",
      kind: "story",
      userMessage: "Tighten criteria",
      storyId: "story-2",
    });

    await getFeaturePlanningSnapshot("project-1");
    expect(invokeMock).toHaveBeenLastCalledWith("get_feature_planning_snapshot", {
      projectId: "project-1",
    });

    await retryFeaturePlanning("feature-1");
    expect(invokeMock).toHaveBeenLastCalledWith("retry_feature_planning", {
      featureId: "feature-1",
    });

    await cancelFeaturePlanning("feature-1");
    expect(invokeMock).toHaveBeenLastCalledWith("cancel_feature_planning", {
      featureId: "feature-1",
    });
  });

  test("forwards feature plan CRUD and message command payloads", async () => {
    await getFeaturePlans("project-1");
    expect(invokeMock).toHaveBeenLastCalledWith("get_feature_plans", {
      projectId: "project-1",
    });

    await createFeaturePlan("project-1");
    expect(invokeMock).toHaveBeenLastCalledWith("create_feature_plan", {
      projectId: "project-1",
    });

    const updates = { title: "Saved search", status: "stories" as const };
    await updateFeaturePlan("feature-1", updates);
    expect(invokeMock).toHaveBeenLastCalledWith("update_feature_plan", {
      featureId: "feature-1",
      updates,
    });

    await appendFeaturePlanMessage("feature-1", "assistant", "Ready", "applied", "gpt-5.3-codex");
    expect(invokeMock).toHaveBeenLastCalledWith("append_feature_plan_message", {
      featureId: "feature-1",
      role: "assistant",
      content: "Ready",
      stateApplication: "applied",
      modelId: "gpt-5.3-codex",
    });

    await appendFeatureStoryMessage(
      "feature-1",
      "story-2",
      "user",
      "Add keyboard support",
      undefined,
      undefined,
    );
    expect(invokeMock).toHaveBeenLastCalledWith("append_feature_story_message", {
      featureId: "feature-1",
      storyId: "story-2",
      role: "user",
      content: "Add keyboard support",
      stateApplication: undefined,
      modelId: undefined,
    });
  });

  test("readBinaryFile decodes the base64 wrapper result", async () => {
    await expect(backendWrappers.readBinaryFile("/tmp/image.bin")).resolves.toEqual(
      Uint8Array.from(new TextEncoder().encode("binary")),
    );
    expect(invokeMock).toHaveBeenCalledWith("read_file_base64", { filePath: "/tmp/image.bin" });
  });
});
