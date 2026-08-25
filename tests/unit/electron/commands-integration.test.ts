import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import { createCommandFixtures } from "./command-fixtures";

const {
  APP_SLUG,
  APP_VERSION,
  ASYNC_TEST_BUDGET_MS,
  ASYNC_TEST_WAIT_TIMEOUT_MS,
  CONTAINER_UNTRACKED_STATS_SCANNER,
  CommandFailedError,
  ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES,
  EnvironmentLifecycleTaskTracker,
  LOCAL_PROJECT_FOR_CREATE,
  LOOPED_REVIEW_WORKFLOW_VERSION,
  RUNNING_CONTAINER_DOCKER_SCRIPT,
  SETUP_DONE_OSC,
  SETUP_FAILED_OSC,
  TERMINAL_ACTIVITY_SETTLE_TEST_WAIT_MS,
  UNATTENDED_AGENT_INTERACTION_POLICY,
  closeLocalServerAdmission,
  codexSlugScript,
  commandTesting,
  configuredGitPushBehaviour,
  configuredGitUpstream,
  createCommandRegistry,
  createContext,
  createDeferred,
  createEnvironment,
  createFakeChild,
  createGitRepoOnBranch,
  createGitWorktreeWithOrigin,
  createHash,
  createReviewPackageWorktree,
  createTempDir,
  currentGitBranch,
  currentGitCommit,
  dockerOwnerNamespace,
  execFile,
  execFileAsync,
  existsSync,
  expectClearsPendingAgentLaunch,
  expectLocalWorktreeRolledBack,
  expectedLocalShellPath,
  expectedManagedWorktreePath,
  framedContainerGitStatus,
  freshFetchedAt,
  fs,
  gitOutput,
  http,
  isImmutableCommitRef,
  isLoopedReviewWorkflow,
  isPaneLayoutRevisionConflict,
  isProcessRunning,
  isolateCodexBinaryLookup,
  liveDockerTest,
  loopedReviewWorkflowAround,
  os,
  paneLayoutRevisionConflictMessage,
  path,
  pathToFileURL,
  promisify,
  ptyProcesses,
  ptySpawn,
  randomUUID,
  readFileSync,
  readTestCredential,
  requestOk,
  reserveFreePort,
  resolveBrowserOpenCommand,
  resolveFileManagerRevealCommands,
  runGit,
  setAgentSkillsHomeForTesting,
  showOpenDialog,
  shutdownDiffStatsTracking,
  shutdownLocalServers,
  shutdownPrMonitorTracking,
  spawnCommand,
  spawnSync,
  startAuthenticatedContainerServer,
  startControllableHealthServer,
  tempDirs,
  terminalSessionResult,
  toClientEnvironment,
  updatesWithStatus,
  waitForCondition,
  waitForPtyProcessCount,
  withFailingGitSubcommand,
  withFakeCodex,
  withFakeDocker,
  withFakeGh,
  withFakeGitSubcommandOutput,
  withFixedDate,
  withGitArgumentStub,
  withGitSubcommandLog,
  withGnuBase64Shim,
  writeBridgeEntrypoint,
  writeBridgeServer,
} = await createCommandFixtures();

import type {
  ChildProcessWithoutNullStreams,
  CommandContext,
  Environment,
  MockPtyProcess,
  PtyExitEvent,
  RepositoryConfig,
} from "./command-fixtures";

describe("storage-backed command delegation", () => {
  test("validates and delegates project and configuration commands", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const project = { id: "project-1", name: "repo" };
    let config = {
      version: "1.0.0",
      global: {
        allowedDomains: [] as string[],
        githubToken: "github_secret_token",
        anthropicApiKey: "anthropic_secret_key",
        cursorApiKey: "cursor_secret_key",
      },
      repositories: {} as Record<string, RepositoryConfig>,
    };
    const repositoryConfig = { defaultBranch: "develop", prBaseBranch: "develop" };
    const storage = {
      loadProjects: mock(async () => [project]),
      addProject: mock(async (value: Record<string, unknown>) => value),
      removeProject: mock(async (id: string) => id),
      getProject: mock(async () => project),
      updateProject: mock(async (_id: string, updates: Record<string, unknown>) => updates),
      reorderProjects: mock(async (ids: string[]) => ids),
      loadConfig: mock(async () => config),
      saveConfig: mock(
        async (value: typeof config, options?: { preserveCredentials?: boolean }) => {
          config = options?.preserveCredentials
            ? {
                ...value,
                global: {
                  ...value.global,
                  githubToken: config.global.githubToken,
                  anthropicApiKey: config.global.anthropicApiKey,
                  cursorApiKey: config.global.cursorApiKey,
                },
              }
            : value;
        },
      ),
      updateGlobalConfig: mock(
        async (value: typeof config.global, options?: { preserveCredentials?: boolean }) => {
          config = {
            ...config,
            global: options?.preserveCredentials
              ? {
                  ...value,
                  githubToken: config.global.githubToken,
                  anthropicApiKey: config.global.anthropicApiKey,
                  cursorApiKey: config.global.cursorApiKey,
                }
              : value,
          };
          return config;
        },
      ),
      setGitHubToken: mock(async (token: string | null) => {
        const { githubToken: _removed, ...global } = config.global;
        config = {
          ...config,
          global: token === null ? global : { ...global, githubToken: token },
        };
        return config;
      }),
      setCursorApiKey: mock(async (apiKey: string | null) => {
        const { cursorApiKey: _removed, ...global } = config.global;
        config = {
          ...config,
          global: apiKey === null ? global : { ...global, cursorApiKey: apiKey },
        };
        return config;
      }),
      setAnthropicApiKey: mock(async (apiKey: string | null) => {
        const { anthropicApiKey: _removed, ...global } = config.global;
        config = {
          ...config,
          global: apiKey === null ? global : { ...global, anthropicApiKey: apiKey },
        };
        return config;
      }),
      getRepositoryConfig: mock(async () => repositoryConfig),
      updateRepositoryConfig: mock(async (id: string, value: RepositoryConfig) => {
        config = { ...config, repositories: { ...config.repositories, [id]: value } };
        return config;
      }),
      updateRepositorySettings: mock(async (id: string, value: RepositoryConfig) => {
        config = { ...config, repositories: { ...config.repositories, [id]: value } };
        return config;
      }),
    };
    const context = { storage } as unknown as CommandContext;
    const commands = createCommandRegistry();

    await expect(commands.get("get_projects")?.({}, context)).resolves.toEqual([project]);
    const added = (await commands.get("add_project")?.(
      { gitUrl: "https://github.com/acme/repo.git", localPath: "/tmp/repo" },
      context,
    )) as Record<string, unknown>;
    expect(added).toMatchObject({
      gitUrl: "https://github.com/acme/repo.git",
      localPath: "/tmp/repo",
    });
    expect(typeof added.id).toBe("string");
    await expect(
      commands.get("remove_project")?.({ projectId: "project-1" }, context),
    ).resolves.toBe("project-1");
    await expect(
      commands.get("get_project")?.({ projectId: "project-1" }, context),
    ).resolves.toEqual(project);
    await expect(
      commands.get("update_project")?.(
        { projectId: "project-1", updates: { name: "renamed" } },
        context,
      ),
    ).resolves.toEqual({ name: "renamed" });
    await expect(
      commands.get("reorder_projects")?.({ projectIds: ["project-2", "project-1"] }, context),
    ).resolves.toEqual(["project-2", "project-1"]);
    expect(
      commands.get("validate_git_url")?.({ url: " https://github.com/acme/repo.git " }, context),
    ).toBe(true);
    expect(
      commands.get("validate_git_url")?.({ url: "git@github.com:acme/repo.git" }, context),
    ).toBe(true);
    expect(commands.get("validate_git_url")?.({ url: "ssh://git@example.com/repo" }, context)).toBe(
      true,
    );
    expect(commands.get("validate_git_url")?.({ url: "file:///tmp/repo" }, context)).toBe(false);
    await expect(commands.get("get_git_remote_url")?.({ path: worktree }, context)).resolves.toBe(
      remote,
    );

    await expect(commands.get("get_config")?.({}, context)).resolves.toEqual({
      version: "1.0.0",
      global: {
        allowedDomains: [],
        githubTokenConfigured: true,
        anthropicApiKeyConfigured: true,
        anthropicApiKeySource: "config",
        cursorApiKeyConfigured: true,
        cursorApiKeySource: "config",
      },
      repositories: {},
    });
    await expect(commands.get("get_global_config")?.({}, context)).resolves.toEqual({
      allowedDomains: [],
      githubTokenConfigured: true,
      anthropicApiKeyConfigured: true,
      anthropicApiKeySource: "config",
      cursorApiKeyConfigured: true,
      cursorApiKeySource: "config",
    });

    await expect(
      commands.get("save_config")?.(
        {
          config: {
            version: "1.0.0",
            global: {
              allowedDomains: ["api.example.com"],
              githubToken: "renderer_attempted_secret",
              githubTokenConfigured: false,
              anthropicApiKey: "renderer_attempted_anthropic_secret",
              anthropicApiKeyConfigured: false,
              anthropicApiKeySource: "none",
              cursorApiKey: "renderer_attempted_cursor_secret",
              cursorApiKeyConfigured: false,
              cursorApiKeySource: "none",
            },
            repositories: {},
          },
        },
        context,
      ),
    ).resolves.toBeUndefined();
    expect(storage.saveConfig).toHaveBeenLastCalledWith(
      {
        version: "1.0.0",
        global: {
          allowedDomains: ["api.example.com"],
        },
        repositories: {},
      },
      { preserveCredentials: true },
    );

    await expect(
      commands.get("update_global_config")?.(
        {
          global: {
            allowedDomains: ["github.com"],
            githubToken: "renderer_attempted_secret",
            githubTokenConfigured: false,
            anthropicApiKey: "renderer_attempted_anthropic_secret",
            anthropicApiKeyConfigured: false,
            anthropicApiKeySource: "none",
            cursorApiKey: "renderer_attempted_cursor_secret",
            cursorApiKeyConfigured: false,
            cursorApiKeySource: "none",
          },
        },
        context,
      ),
    ).resolves.toEqual({
      version: "1.0.0",
      global: {
        allowedDomains: ["github.com"],
        githubTokenConfigured: true,
        anthropicApiKeyConfigured: true,
        anthropicApiKeySource: "config",
        cursorApiKeyConfigured: true,
        cursorApiKeySource: "config",
      },
      repositories: {},
    });
    expect(storage.updateGlobalConfig).toHaveBeenLastCalledWith(
      {
        allowedDomains: ["github.com"],
      },
      { preserveCredentials: true },
    );

    await expect(
      commands.get("set_github_token")?.({ token: " replacement_token " }, context),
    ).resolves.toMatchObject({
      global: { allowedDomains: ["github.com"], githubTokenConfigured: true },
    });
    expect(storage.setGitHubToken).toHaveBeenLastCalledWith("replacement_token");
    expect(JSON.stringify(await commands.get("get_config")?.({}, context))).not.toContain(
      "replacement_token",
    );
    await expect(
      commands.get("set_github_token")?.({ token: null }, context),
    ).resolves.toMatchObject({
      global: { githubTokenConfigured: false },
    });
    await expect(commands.get("set_github_token")?.({ token: "   " }, context)).rejects.toThrow(
      "GitHub token cannot be empty",
    );

    await expect(
      commands.get("set_cursor_api_key")?.({ apiKey: " replacement_cursor_key " }, context),
    ).resolves.toMatchObject({
      global: { cursorApiKeyConfigured: true },
    });
    expect(storage.setCursorApiKey).toHaveBeenLastCalledWith("replacement_cursor_key");
    expect(JSON.stringify(await commands.get("get_config")?.({}, context))).not.toContain(
      "replacement_cursor_key",
    );
    await expect(
      commands.get("set_cursor_api_key")?.({ apiKey: null }, context),
    ).resolves.toMatchObject({
      global: { cursorApiKeyConfigured: false },
    });
    expect(storage.setCursorApiKey).toHaveBeenLastCalledWith(null);
    await expect(commands.get("set_cursor_api_key")?.({ apiKey: "   " }, context)).rejects.toThrow(
      "Cursor API key cannot be empty",
    );

    await expect(
      commands.get("set_anthropic_api_key")?.({ apiKey: " replacement_anthropic_key " }, context),
    ).resolves.toMatchObject({
      global: { anthropicApiKeyConfigured: true, anthropicApiKeySource: "config" },
    });
    expect(storage.setAnthropicApiKey).toHaveBeenLastCalledWith("replacement_anthropic_key");
    expect(JSON.stringify(await commands.get("get_config")?.({}, context))).not.toContain(
      "replacement_anthropic_key",
    );
    await expect(
      commands.get("set_anthropic_api_key")?.({ apiKey: null }, context),
    ).resolves.toMatchObject({
      global: { anthropicApiKeyConfigured: false },
    });
    expect(storage.setAnthropicApiKey).toHaveBeenLastCalledWith(null);
    await expect(
      commands.get("set_anthropic_api_key")?.({ apiKey: "   " }, context),
    ).rejects.toThrow("Anthropic API key cannot be empty");

    await expect(
      commands.get("get_repository_config")?.({ projectId: "project-1" }, context),
    ).resolves.toEqual(repositoryConfig);
    await expect(
      commands.get("update_repository_config")?.(
        { projectId: "project-1", repoConfig: repositoryConfig },
        context,
      ),
    ).resolves.toMatchObject({
      global: { githubTokenConfigured: false },
      repositories: { "project-1": repositoryConfig },
    });

    expect(storage.removeProject).toHaveBeenCalledWith("project-1");
    expect(storage.updateProject).toHaveBeenCalledWith("project-1", { name: "renamed" });
    expect(storage.updateRepositorySettings).toHaveBeenCalledWith("project-1", repositoryConfig);
    expect(storage.updateRepositoryConfig).not.toHaveBeenCalled();
  });

  test("delegates session lifecycle, synchronization, and buffer commands", async () => {
    const session = { id: "session-1", environmentId: "env-1" };
    const sessions = [session];
    const disconnected = [{ ...session, status: "disconnected" }];
    const storage = {
      createSession: mock(async () => session),
      getSession: mock(async () => session),
      getSessionsByEnvironment: mock(async () => sessions),
      updateSession: mock(async (_id: string, update: Record<string, unknown>) => ({
        ...session,
        ...update,
      })),
      removeSession: mock(async () => undefined),
      removeSessionsByEnvironment: mock(async () => undefined),
      disconnectEnvironmentSessions: mock(async () => disconnected),
      saveSessionBuffer: mock(async () => undefined),
      loadSessionBuffer: mock(async () => "saved output"),
      reorderSessions: mock(async () => sessions),
      cleanupOrphanedBuffers: mock(async () => 3),
    };
    const context = { storage } as unknown as CommandContext;
    const commands = createCommandRegistry();

    await expect(
      commands.get("create_session")?.(
        {
          environmentId: "env-1",
          containerId: "container-1",
          tabId: "tab-1",
          sessionType: "terminal",
        },
        context,
      ),
    ).resolves.toEqual(session);
    expect(storage.createSession).toHaveBeenCalledWith("env-1", "container-1", "tab-1", "terminal");
    await expect(
      commands.get("get_session")?.({ sessionId: "session-1" }, context),
    ).resolves.toEqual(session);
    await expect(
      commands.get("get_sessions_by_environment")?.({ environmentId: "env-1" }, context),
    ).resolves.toEqual(sessions);
    await commands.get("update_session_status")?.(
      { sessionId: "session-1", status: "running" },
      context,
    );
    expect(storage.updateSession).toHaveBeenLastCalledWith("session-1", { status: "running" });
    await withFixedDate("2026-07-23T12:00:00.000Z", async () => {
      await commands.get("update_session_activity")?.({ sessionId: "session-1" }, context);
    });
    expect(storage.updateSession).toHaveBeenLastCalledWith("session-1", {
      lastActivityAt: "2026-07-23T12:00:00.000Z",
    });
    await commands.get("rename_session")?.({ sessionId: "session-1", name: "Shell" }, context);
    expect(storage.updateSession).toHaveBeenLastCalledWith("session-1", { name: "Shell" });
    await commands.get("rename_session")?.({ sessionId: "session-1", name: null }, context);
    expect(storage.updateSession).toHaveBeenLastCalledWith("session-1", { name: undefined });
    await commands.get("save_session_buffer")?.(
      { sessionId: "session-1", buffer: "saved output" },
      context,
    );
    expect(storage.saveSessionBuffer).toHaveBeenCalledWith("session-1", "saved output");
    await expect(
      commands.get("load_session_buffer")?.({ sessionId: "session-1" }, context),
    ).resolves.toBe("saved output");
    await expect(
      commands.get("sync_sessions_with_container")?.(
        { environmentId: "env-1", containerRunning: true },
        context,
      ),
    ).resolves.toEqual(sessions);
    expect(storage.disconnectEnvironmentSessions).not.toHaveBeenCalled();
    await expect(
      commands.get("sync_sessions_with_container")?.(
        { environmentId: "env-1", containerRunning: false },
        context,
      ),
    ).resolves.toEqual(disconnected);
    await expect(
      commands.get("disconnect_environment_sessions")?.({ environmentId: "env-1" }, context),
    ).resolves.toEqual(disconnected);
    await commands.get("reorder_sessions")?.(
      { environmentId: "env-1", sessionIds: ["session-2", "session-1"] },
      context,
    );
    expect(storage.reorderSessions).toHaveBeenCalledWith("env-1", ["session-2", "session-1"]);
    await expect(commands.get("cleanup_orphaned_buffers")?.({}, context)).resolves.toBe(3);
    await commands.get("delete_session")?.({ sessionId: "session-1" }, context);
    expect(storage.removeSession).toHaveBeenCalledWith("session-1");
    await commands.get("delete_sessions_by_environment")?.({ environmentId: "env-1" }, context);
    expect(storage.removeSessionsByEnvironment).toHaveBeenCalledWith("env-1");
  });

  test("delegates Kanban reads and typed updates", async () => {
    const task = { id: "task-1", title: "Investigate" };
    const storage = {
      getKanbanTasks: mock(async () => [task]),
      addKanbanTask: mock(async () => task),
      updateKanbanTask: mock(async (_id: string, update: Record<string, unknown>) => ({
        ...task,
        ...update,
      })),
    };
    const context = { storage } as unknown as CommandContext;
    const commands = createCommandRegistry();

    await expect(
      commands.get("get_kanban_tasks")?.({ projectId: "project-1" }, context),
    ).resolves.toEqual([task]);
    await expect(
      commands.get("add_kanban_task")?.(
        { projectId: "project-1", title: "Investigate", description: "Details" },
        context,
      ),
    ).resolves.toEqual(task);
    expect(storage.addKanbanTask).toHaveBeenCalledWith("project-1", "Investigate", "Details");
    await commands.get("update_kanban_task")?.(
      {
        taskId: "task-1",
        title: "Fixed",
        description: 123,
        acceptanceCriteria: "Tests pass",
        status: "done",
        environmentId: "",
        buildPipelineId: "",
        prUrl: "",
        prState: "merged",
        prMergeCommented: false,
      },
      context,
    );
    expect(storage.updateKanbanTask).toHaveBeenCalledWith("task-1", {
      title: "Fixed",
      acceptanceCriteria: "Tests pass",
      status: "done",
      environmentId: undefined,
      buildPipelineId: undefined,
      prUrl: undefined,
      prState: "merged",
      prMergeCommented: false,
    });
  });

  test("keeps the task linked when build-pipeline cleanup fails", async () => {
    const task = {
      id: "task-1",
      projectId: "project-1",
      buildPipelineId: "pipeline-linked",
    };
    const storage = {
      getKanbanTask: mock(async () => task),
      listBuildPipelines: mock(async () => [
        { id: "pipeline-linked", snapshot: { taskId: "task-1" } },
        { id: "pipeline-stale", snapshot: { taskId: "task-1" } },
      ]),
      updateKanbanTask: mock(async () => updated),
    };
    const remove = mock(async (pipelineId: string) => {
      if (pipelineId === "pipeline-stale") throw new Error("cleanup failed");
    });
    const context = {
      storage,
      buildPipelines: { remove },
    } as unknown as CommandContext;

    await expect(
      createCommandRegistry().get("clear_task_build_status")?.({ taskId: "task-1" }, context),
    ).rejects.toThrow("cleanup failed");
    expect(remove.mock.calls.map(([pipelineId]) => pipelineId)).toEqual([
      "pipeline-linked",
      "pipeline-stale",
    ]);
    expect(storage.updateKanbanTask).not.toHaveBeenCalled();
  });

  test("delegates remaining environment, Kanban, notes, and feature-plan handlers", async () => {
    const task = { id: "task-1" };
    const feature = { id: "feature-1", projectId: "project-1" };
    const storage = {
      getLogDirectory: mock(() => "/data/logs"),
      reorderEnvironments: mock(async () => [{ id: "env-2" }, { id: "env-1" }]),
      deleteKanbanTask: mock(async () => undefined),
      addKanbanComment: mock(async () => ({ ...task, comments: [{ id: "comment-1" }] })),
      deleteKanbanComment: mock(async () => ({ ...task, comments: [] })),
      addKanbanImage: mock(async () => ({ ...task, images: [{ id: "image-1" }] })),
      deleteKanbanImage: mock(async () => ({ ...task, images: [] })),
      getKanbanImageData: mock(async () => "encoded-image"),
      getProjectNotes: mock(async () => ({ projectId: "project-1", content: "notes" })),
      saveProjectNotes: mock(async () => ({ projectId: "project-1", content: "updated" })),
      getFeaturePlans: mock(async () => [feature]),
      createFeaturePlan: mock(async () => feature),
      updateFeaturePlan: mock(async () => ({ ...feature, title: "Updated" })),
    };
    const context = { storage } as unknown as CommandContext;
    const commands = createCommandRegistry();

    expect(commands.get("get_log_directory")?.({}, context)).toBe("/data/logs");
    await expect(
      commands.get("reorder_environments")?.(
        {
          projectId: "project-1",
          environmentIds: ["env-2", "env-1"],
        },
        context,
      ),
    ).resolves.toEqual([
      { id: "env-2", hasInitialPromptAttachments: false },
      { id: "env-1", hasInitialPromptAttachments: false },
    ]);
    expect(storage.reorderEnvironments).toHaveBeenCalledWith("project-1", ["env-2", "env-1"]);

    await commands.get("delete_kanban_task")?.({ taskId: "task-1" }, context);
    await commands.get("add_kanban_comment")?.({ taskId: "task-1", text: "Looks good" }, context);
    await commands.get("delete_kanban_comment")?.(
      { taskId: "task-1", commentId: "comment-1" },
      context,
    );
    await commands.get("add_kanban_image")?.(
      { taskId: "task-1", filename: "image.png", data: "encoded" },
      context,
    );
    await commands.get("delete_kanban_image")?.({ taskId: "task-1", imageId: "image-1" }, context);
    await expect(
      commands.get("get_kanban_image_data")?.({ imageId: "image-1" }, context),
    ).resolves.toBe("encoded-image");
    expect(storage.deleteKanbanTask).toHaveBeenCalledWith("task-1");
    expect(storage.addKanbanComment).toHaveBeenCalledWith("task-1", "Looks good");
    expect(storage.deleteKanbanComment).toHaveBeenCalledWith("task-1", "comment-1");
    expect(storage.addKanbanImage).toHaveBeenCalledWith("task-1", "image.png", "encoded");
    expect(storage.deleteKanbanImage).toHaveBeenCalledWith("task-1", "image-1");

    await expect(
      commands.get("get_project_notes")?.({ projectId: "project-1" }, context),
    ).resolves.toEqual({ projectId: "project-1", content: "notes" });
    await expect(
      commands.get("save_project_notes")?.({ projectId: "project-1", content: "updated" }, context),
    ).resolves.toEqual({ projectId: "project-1", content: "updated" });
    expect(storage.saveProjectNotes).toHaveBeenCalledWith("project-1", "updated");

    await expect(
      commands.get("get_feature_plans")?.({ projectId: "project-1" }, context),
    ).resolves.toEqual([feature]);
    await expect(
      commands.get("create_feature_plan")?.({ projectId: "project-1" }, context),
    ).resolves.toEqual(feature);
    await expect(
      commands.get("update_feature_plan")?.(
        { featureId: "feature-1", updates: { title: "Updated" } },
        context,
      ),
    ).resolves.toEqual({ ...feature, title: "Updated" });
    expect(storage.updateFeaturePlan).toHaveBeenCalledWith("feature-1", { title: "Updated" });
    expect(() =>
      commands.get("update_feature_plan")?.({ featureId: 1, updates: {} }, context),
    ).toThrow("Expected featureId to be a string");
  });
});

describe("Electron backend command registry", () => {
  // The `security` stub only takes effect on darwin, where `getHostClaudeCredentials`
  // consults the Keychain; elsewhere resolution starts at the on-disk credential.
  // Seeding both with the same payload keeps these tests asserting the same thing
  // on every platform instead of silently depending on the developer's OS.
  const CLAUDE_CREDENTIAL_SYNC_DOCKER_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "start" ]; then exit 0; fi
if [ "$1" = "exec" ]; then
  if [ "$2" = "--user" ]; then exit 0; fi
  cat >> "$FAKE_DOCKER_EXEC_LOG.stdin"
  printf '\\n--sync--\\n' >> "$FAKE_DOCKER_EXEC_LOG.stdin"
  exit 0
fi
exit 1
`;

  function claudeCredentialSyncContext(
    globalConfig: Record<string, unknown> = {},
  ): ReturnType<typeof createContext> {
    const environment = createEnvironment({
      id: "env-claude-cred",
      environmentType: "containerized",
      containerId: "container-1",
      status: "stopped",
    });
    const created = createContext(environment);
    created.context.storage.loadConfig = mock(async () => ({
      version: "1.0.0",
      global: { useHostGitHubCredentials: false, githubToken: "", ...globalConfig },
      repositories: {},
    }));
    return created;
  }

  test(
    "starting a stopped environment resumes backend PR polling",
    async () => {
      const worktreePath = await createGitRepoOnBranch("feature-pr-monitor");
      const environment = createEnvironment({
        id: "env-pr-monitor-resume",
        branch: "feature-pr-monitor",
        environmentType: "local",
        worktreePath,
        status: "running",
        setupScriptsComplete: true,
        prUrl: "https://github.com/acme/repo/pull/42",
        prState: "open",
        hasMergeConflicts: false,
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();

      // Rehydrate the backend-owned entry, then stop the environment to exercise
      // the same pause path used by the desktop lifecycle.
      await commands.get("get_pr_monitor_state")?.({}, context);
      await commands.get("stop_environment")?.({ environmentId: environment.id }, context);

      await withFakeGh(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "list" ]; then
  printf '%s\\n' '[{"url":"https://github.com/acme/repo/pull/42","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-01-03T00:00:00Z"}]'
  exit 0
fi
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' '{"url":"https://github.com/acme/repo/pull/42","state":"OPEN","mergeable":"MERGEABLE"}'
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
        async (logPath) => {
          await commands.get("start_environment")?.({ environmentId: environment.id }, context);
          await commands.get("pr_monitor_refresh")?.({ environmentId: environment.id }, context);
          await waitForCondition(
            () =>
              existsSync(logPath) &&
              readFileSync(logPath, "utf8").includes(
                "pr view https://github.com/acme/repo/pull/42 --json url,state,mergeable",
              ),
            "resumed PR monitor check",
          );

          expect(await fs.readFile(logPath, "utf8")).toContain(
            "pr view https://github.com/acme/repo/pull/42 --json url,state,mergeable",
          );
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("keeps detail reads authoritative while projecting renderer mutation responses", async () => {
    const environment = createEnvironment({
      status: "running",
      environmentType: "local",
      opencodePid: 40,
      claudeBridgePid: 41,
      codexBridgePid: 42,
      pendingRenamePrompt: "backend-owned rename prompt",
      pendingAgentLaunch: true,
      initialAgentModel: "launch-model",
      initialReasoningEffort: "high",
      initialPromptAttachments: [
        {
          id: "image-1",
          name: "private.png",
          base64Data: "cHJpdmF0ZQ==",
        },
      ],
      agentActivitySources: {
        frontend: {
          state: "working",
          updatedAt: new Date().toISOString(),
        },
      },
      frontendAgentActivityObservers: {
        observer: {
          state: "working",
          updatedAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      },
    });
    const { context } = createContext(environment);
    const storage = context.storage as unknown as {
      reorderEnvironments: ReturnType<typeof mock>;
      acknowledgeStartupAgentSession: ReturnType<typeof mock>;
      setEnvironmentUnread: ReturnType<typeof mock>;
    };
    storage.reorderEnvironments = mock(async () => [environment]);
    storage.acknowledgeStartupAgentSession = mock(async () => environment);
    storage.setEnvironmentUnread = mock(async () => environment);
    const commands = createCommandRegistry();
    const backendOnlyFields = [
      "opencodePid",
      "claudeBridgePid",
      "codexBridgePid",
      "claudeModelCatalog",
      "agentActivitySources",
      "frontendAgentActivityObservers",
      "pendingRenamePrompt",
      "initialPromptAttachments",
    ];
    const expectProjected = (value: unknown) => {
      for (const field of backendOnlyFields) {
        expect(value).not.toHaveProperty(field);
      }
    };

    const detail = await commands.get("get_environment")?.(
      { environmentId: environment.id },
      context,
    );
    expect(detail).toBe(environment);
    expect(detail).toHaveProperty("initialPromptAttachments");
    expect(detail).toHaveProperty("pendingRenamePrompt");

    const reordered = (await commands.get("reorder_environments")?.(
      { projectId: environment.projectId, environmentIds: [environment.id] },
      context,
    )) as unknown[];
    expectProjected(reordered[0]);

    const responses = [
      await commands.get("sync_environment_status")?.({ environmentId: environment.id }, context),
      await commands.get("rename_environment")?.(
        { environmentId: environment.id, name: "renamed" },
        context,
      ),
      await commands.get("set_environment_pr")?.(
        {
          environmentId: environment.id,
          prUrl: "https://example.invalid/pull/1",
          prState: "open",
          hasMergeConflicts: false,
        },
        context,
      ),
      await commands.get("update_port_mappings")?.(
        { environmentId: environment.id, portMappings: [] },
        context,
      ),
      await commands.get("update_environment_agent_settings")?.(
        {
          environmentId: environment.id,
          pendingAgentLaunch: true,
          initialPromptAttachments: environment.initialPromptAttachments,
        },
        context,
      ),
      await commands.get("set_environment_pending_agent_launch")?.(
        { environmentId: environment.id, pending: true },
        context,
      ),
      await commands.get("acknowledge_startup_agent_session")?.(
        { environmentId: environment.id },
        context,
      ),
      await commands.get("set_environment_initial_prompt")?.(
        {
          environmentId: environment.id,
          initialPrompt: "updated",
          initialPromptAttachments: environment.initialPromptAttachments,
        },
        context,
      ),
      await commands.get("update_environment_allowed_domains")?.(
        { environmentId: environment.id, domains: ["example.invalid"] },
        context,
      ),
      await commands.get("set_environment_unread")?.(
        { environmentId: environment.id, unread: false },
        context,
      ),
    ];
    for (const response of responses) expectProjected(response);
  });

  test(
    "closes a retry session when its container is stopped, then allows a healthy retry",
    async () => {
      const environment = createEnvironment({
        id: "env-container-stopped-retry",
        environmentType: "containerized",
        setupScriptsComplete: false,
        createdFromCommit: "8888888888888888888888888888888888888888",
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const setupSessionId = `${environment.id}:setup`;

      await withFakeDocker(
        `#!/bin/sh
if [ "$1" = "inspect" ]; then
  if [ -f "$FAKE_DOCKER_LOG.healthy" ]; then
    printf 'running\\n'
  else
    printf 'exited\\n'
  fi
  exit 0
fi
exit 0
`,
        async (logs) => {
          await expect(
            commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
          ).rejects.toThrow("Container is not running");

          expect(
            await commands.get("await_environment_setup_session")?.(
              { environmentId: environment.id },
              context,
            ),
          ).toEqual(
            expect.objectContaining({
              sessionId: setupSessionId,
              running: false,
              terminalRunning: false,
              success: false,
            }),
          );
          expect(
            commands.get("get_terminal_session")?.({ sessionId: setupSessionId }, context),
          ).toEqual({ id: setupSessionId, running: false, bootstrapped: false });
          expect(ptySpawn).not.toHaveBeenCalled();
          expect(environment).toMatchObject({
            status: "error",
            setupPhase: "failed",
          });

          await fs.writeFile(`${logs.all}.healthy`, "");
          const retry = commands.get("run_environment_setup")?.(
            { environmentId: environment.id },
            context,
          ) as Promise<Environment>;
          await waitForPtyProcessCount(1);
          expect(
            commands.get("get_terminal_session")?.({ sessionId: setupSessionId }, context),
          ).toEqual({ id: setupSessionId, running: true, bootstrapped: false });
          expect(environment).toMatchObject({
            status: "running",
            setupPhase: "running",
            lifecycleError: null,
          });
          ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
          await expect(retry).resolves.toMatchObject({
            status: "running",
            setupScriptsComplete: true,
            setupPhase: "ready",
            lifecycleError: null,
          });
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "closes a retry session when PTY spawn throws, then allows a healthy retry",
    async () => {
      const environment = createEnvironment({
        id: "env-container-pty-spawn-retry",
        environmentType: "containerized",
        setupScriptsComplete: false,
        createdFromCommit: "9999999999999999999999999999999999999999",
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const setupSessionId = `${environment.id}:setup`;

      ptySpawn.mockImplementationOnce(() => {
        throw new Error("PTY spawn unavailable");
      });
      await withFakeDocker(RUNNING_CONTAINER_DOCKER_SCRIPT, async () => {
        await expect(
          commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
        ).rejects.toThrow("PTY spawn unavailable");

        expect(
          await commands.get("await_environment_setup_session")?.(
            { environmentId: environment.id },
            context,
          ),
        ).toEqual(
          expect.objectContaining({
            sessionId: setupSessionId,
            running: false,
            terminalRunning: false,
            success: false,
          }),
        );
        expect(
          commands.get("get_terminal_session")?.({ sessionId: setupSessionId }, context),
        ).toEqual({ id: setupSessionId, running: false, bootstrapped: false });

        const retry = commands.get("run_environment_setup")?.(
          { environmentId: environment.id },
          context,
        ) as Promise<Environment>;
        await waitForPtyProcessCount(1);
        ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
        await expect(retry).resolves.toMatchObject({ setupScriptsComplete: true });
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("closes a retry session when a local worktree disappears before PTY spawn", async () => {
    const worktreePath = await createTempDir("ork-electron-setup-worktree-race-");
    const missingWorktreePath = `${worktreePath}-missing`;
    await fs.writeFile(
      path.join(worktreePath, "orkestrator-ai.json"),
      JSON.stringify({ setupLocal: "printf setup" }),
    );
    const environment = createEnvironment({
      id: "env-local-missing-worktree-retry",
      environmentType: "local",
      setupScriptsComplete: false,
      createdFromCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const setupSessionId = `${environment.id}:setup`;
    let worktreePathReads = 0;
    // Model a worktree deleted after its setup config was read but before
    // spawnSetupTerminal performs its final existence check. The setup path
    // reads this property while selecting and loading the config, then while
    // logging and validating the PTY target.
    Object.defineProperty(environment, "worktreePath", {
      configurable: true,
      get: () => {
        worktreePathReads += 1;
        return worktreePathReads <= 4 ? worktreePath : missingWorktreePath;
      },
    });

    await expect(
      commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow(`Local environment worktree does not exist: ${missingWorktreePath}`);

    expect(
      await commands.get("await_environment_setup_session")?.(
        { environmentId: environment.id },
        context,
      ),
    ).toEqual(
      expect.objectContaining({
        sessionId: setupSessionId,
        running: false,
        terminalRunning: false,
        success: false,
      }),
    );
    expect(commands.get("get_terminal_session")?.({ sessionId: setupSessionId }, context)).toEqual({
      id: setupSessionId,
      running: false,
      bootstrapped: false,
    });
    expect(ptySpawn).not.toHaveBeenCalled();
  });

  test(
    "retains the setup output buffer after the setup PTY exits",
    async () => {
      const environment = createEnvironment({
        id: "env-container-setup-buffer",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const setupSessionId = `${environment.id}:setup`;

      await withFakeDocker(RUNNING_CONTAINER_DOCKER_SCRIPT, async () => {
        const setupPromise = commands.get("run_environment_setup")?.(
          { environmentId: environment.id },
          context,
        ) as Promise<Environment>;
        await waitForPtyProcessCount(1);
        ptyProcesses[0]?.emitData("configuring workspace...\r\n");
        ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
        await setupPromise;

        const buffer = (await commands.get("get_terminal_output_buffer")?.(
          { sessionId: setupSessionId },
          context,
        )) as string;
        expect(buffer).toContain("[orkestrator] Starting environment setup");
        expect(buffer).toContain("configuring workspace...");

        // Setup buffers are intentionally retained after the PTY exits so the
        // renderer can still replay them when it reattaches.
        ptyProcesses[0]?.emitExit({ exitCode: 0 });
        const afterExit = (await commands.get("get_terminal_output_buffer")?.(
          { sessionId: setupSessionId },
          context,
        )) as string;
        expect(afterExit).toContain("configuring workspace...");
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "reports backend setup session state via await_environment_setup_session",
    async () => {
      const environment = createEnvironment({
        id: "env-container-setup-session",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();

      expect(
        await commands.get("await_environment_setup_session")?.(
          { environmentId: environment.id },
          context,
        ),
      ).toBeNull();

      await withFakeDocker(RUNNING_CONTAINER_DOCKER_SCRIPT, async () => {
        const setupPromise = commands.get("run_environment_setup")?.(
          { environmentId: environment.id },
          context,
        ) as Promise<Environment>;
        await waitForPtyProcessCount(1);

        const runningSession = await commands.get("await_environment_setup_session")?.(
          { environmentId: environment.id },
          context,
        );
        expect(runningSession).toEqual(
          expect.objectContaining({
            environmentId: environment.id,
            sessionId: `${environment.id}:setup`,
            running: true,
            terminalRunning: true,
            hasOutput: true,
          }),
        );

        ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
        await setupPromise;

        const completedSession = await commands.get("await_environment_setup_session")?.(
          { environmentId: environment.id },
          context,
        );
        // Setup is marked complete via the OSC marker while the PTY stays alive as
        // the interactive shell, so the session reports done but still running.
        expect(completedSession).toEqual(
          expect.objectContaining({
            running: false,
            success: true,
            terminalRunning: true,
            hasOutput: true,
          }),
        );

        ptyProcesses[0]?.emitExit({ exitCode: 0 });
        expect(
          await commands.get("await_environment_setup_session")?.(
            { environmentId: environment.id },
            context,
          ),
        ).toEqual(
          expect.objectContaining({
            running: false,
            success: true,
            terminalRunning: false,
            hasOutput: true,
          }),
        );
        expect(
          commands.get("get_terminal_session")?.({ sessionId: `${environment.id}:setup` }, context),
        ).toEqual({ id: `${environment.id}:setup`, running: false, bootstrapped: false });
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "clears retained setup state when the environment is deleted",
    async () => {
      const environment = createEnvironment({
        id: "env-container-setup-delete",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const setupSessionId = `${environment.id}:setup`;
      const retainedStableTerminal = terminalSessionResult(
        await commands.get("create_local_terminal_session")?.(
          {
            environmentId: environment.id,
            terminalKey: "retained-tab",
            cols: 80,
            rows: 24,
          },
          context,
        ),
      );

      await withFakeDocker(RUNNING_CONTAINER_DOCKER_SCRIPT, async () => {
        const setupPromise = commands.get("run_environment_setup")?.(
          { environmentId: environment.id },
          context,
        ) as Promise<Environment>;
        await waitForPtyProcessCount(1);
        ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
        await setupPromise;

        expect(
          await commands.get("await_environment_setup_session")?.(
            { environmentId: environment.id },
            context,
          ),
        ).not.toBeNull();

        await commands.get("delete_environment")?.({ environmentId: environment.id }, context);

        expect(context.storage.deleteLoopedReviewWorkflowsByEnvironment).toHaveBeenCalledWith(
          environment.id,
        );
        expect(context.storage.deleteMultiReviewWorkflowsByEnvironment).toHaveBeenCalledWith(
          environment.id,
        );
        expect(context.storage.deleteNativeAgentSessionsByEnvironment).toHaveBeenCalledWith(
          environment.id,
        );
        expect(context.storage.deletePaneLayout).toHaveBeenCalledWith(environment.id);

        expect(
          await commands.get("await_environment_setup_session")?.(
            { environmentId: environment.id },
            context,
          ),
        ).toBeNull();
        const buffer = (await commands.get("get_terminal_output_buffer")?.(
          { sessionId: setupSessionId },
          context,
        )) as string;
        expect(buffer).toBe("");

        expect(
          commands.get("get_terminal_output_snapshot")?.(
            { sessionId: retainedStableTerminal.sessionId },
            context,
          ),
        ).toEqual({ output: "", revision: 0, generation: 0, truncated: false });
        const recreated = terminalSessionResult(
          await commands.get("create_local_terminal_session")?.(
            {
              environmentId: environment.id,
              terminalKey: "retained-tab",
              cols: 80,
              rows: 24,
            },
            context,
          ),
        );
        expect(recreated.created).toBe(true);
        expect(recreated.sessionId).not.toBe(retainedStableTerminal.sessionId);
        commands.get("close_local_terminal_session")?.({ sessionId: recreated.sessionId }, context);
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("omits CURSOR_API_KEY from Docker argv when no key is configured or inherited", async () => {
    const previousCursorApiKey = process.env.CURSOR_API_KEY;
    delete process.env.CURSOR_API_KEY;
    const environment = createEnvironment({
      id: "env-container-cursor-absent",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: { useHostGitHubCredentials: false },
        repositories: {
          "project-1": { defaultBranch: "main", prBaseBranch: "main" },
        },
      })),
    });
    const commands = createCommandRegistry();

    try {
      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "create" ]; then
  exit 42
fi
exit 0
`,
        async (logs) => {
          await commands
            .get("provision_environment")?.({ environmentId: environment.id }, context)
            .catch(() => undefined);

          // Passing `-e CURSOR_API_KEY` with nothing to forward would hand the
          // container whatever the Docker CLI happened to inherit.
          const dockerCalls = await fs.readFile(logs.all, "utf8");
          expect(dockerCalls).toContain("create");
          expect(dockerCalls).not.toContain("-e CURSOR_API_KEY");
        },
      );

      await expect(commands.get("get_global_config")?.({}, context)).resolves.toMatchObject({
        cursorApiKeyConfigured: false,
        cursorApiKeySource: "none",
      });
    } finally {
      if (previousCursorApiKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previousCursorApiKey;
    }
  });

  test("forwards a host-inherited Cursor API key but reports its source to the renderer", async () => {
    const hostCursorApiKey = "cursor_host_env_key";
    const previousCursorApiKey = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = hostCursorApiKey;
    const environment = createEnvironment({
      id: "env-container-cursor-host-env",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    let global: Record<string, unknown> = { useHostGitHubCredentials: false };
    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global,
        repositories: {
          "project-1": { defaultBranch: "main", prBaseBranch: "main" },
        },
      })),
    });
    const commands = createCommandRegistry();

    try {
      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "create" ]; then
  exit 42
fi
exit 0
`,
        async (logs) => {
          await commands
            .get("provision_environment")?.({ environmentId: environment.id }, context)
            .catch(() => undefined);

          const dockerCalls = await fs.readFile(logs.all, "utf8");
          expect(dockerCalls).toContain("-e CURSOR_API_KEY");
          expect(dockerCalls).not.toContain(hostCursorApiKey);
        },
      );

      // Nothing is stored, so no edit in the settings pane can revoke this key.
      // The renderer has to be told, or the empty field implies no key is in play.
      await expect(commands.get("get_global_config")?.({}, context)).resolves.toMatchObject({
        cursorApiKeyConfigured: false,
        cursorApiKeySource: "host-env",
      });

      // A stored key takes precedence, and the source says so.
      global = { ...global, cursorApiKey: "cursor_configured_key" };
      await expect(commands.get("get_global_config")?.({}, context)).resolves.toMatchObject({
        cursorApiKeyConfigured: true,
        cursorApiKeySource: "config",
      });
      expect(JSON.stringify(await commands.get("get_global_config")?.({}, context))).not.toContain(
        "cursor_configured_key",
      );
    } finally {
      if (previousCursorApiKey === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = previousCursorApiKey;
    }
  });

  test("injects workspace artifact git excludes into local worktrees before status reads", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const suffix = randomUUID().slice(0, 8);
    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: `feature/artifact-excludes-${suffix}`,
      environmentType: "local",
    });
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: `Artifact Excludes ${suffix}`,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: { defaultBranch: "main", prBaseBranch: "main" },
    });
    const commands = createCommandRegistry();

    try {
      await expect(
        commands.get("start_environment")?.({ environmentId: environment.id }, context),
      ).resolves.toEqual(
        expect.objectContaining({
          setupStarted: false,
          environment: expect.objectContaining({
            id: environment.id,
            status: "running",
          }),
        }),
      );

      expect(environment.worktreePath).toBeDefined();
      const worktreePath = environment.worktreePath!;
      const gitDir = await gitOutput(worktreePath, ["rev-parse", "--git-dir"]);
      const excludePath = await gitOutput(worktreePath, [
        "rev-parse",
        "--git-path",
        "info/exclude",
      ]);
      expect(gitDir).not.toBe(".git");
      const excludeFile = path.isAbsolute(excludePath)
        ? excludePath
        : path.resolve(worktreePath, excludePath);
      await expect(fs.readFile(excludeFile, "utf8")).resolves.toContain(".orkestrator\n");

      await fs.writeFile(excludeFile, "existing-pattern");
      await fs.mkdir(path.join(worktreePath, ".orkestrator", "clipboard"), { recursive: true });
      await fs.writeFile(
        path.join(worktreePath, ".orkestrator", "clipboard", "image.png"),
        "binary",
      );
      await fs.mkdir(path.join(worktreePath, ".claude"), { recursive: true });
      await fs.writeFile(path.join(worktreePath, ".claude", "settings.local.json"), "{}\n");

      const changes = (await commands.get("get_local_git_status")?.(
        { worktreePath, targetBranch: "main" },
        context,
      )) as Array<{ path: string }>;

      expect(changes.some((change) => change.path.startsWith(".orkestrator/"))).toBe(false);
      expect(changes.some((change) => change.path === ".claude/settings.local.json")).toBe(false);
      await expect(fs.readFile(excludeFile, "utf8")).resolves.toBe(
        "existing-pattern\n.orkestrator\n.claude/settings.local.json\n",
      );
      await expect(
        execFileAsync("git", [
          "-C",
          worktreePath,
          "check-ignore",
          ".orkestrator/clipboard/image.png",
          ".claude/settings.local.json",
        ]),
      ).resolves.toBeDefined();
    } finally {
      if (environment.worktreePath)
        await fs.rm(environment.worktreePath, { recursive: true, force: true });
    }
  });

  describe("backend-owned diff statistics", () => {
    function localDiffEnvironment(worktree: string) {
      const environment = createEnvironment({
        status: "stopped",
        environmentType: "local",
        worktreePath: worktree,
      });
      return { environment, ...createContext(environment) };
    }

    test("computes counts for a tracked local environment and announces them", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      await fs.writeFile(path.join(worktree, "brand-new.txt"), "one\ntwo\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        const snapshot = (await commands.get("get_environment_diff_stats")?.({}, context)) as {
          entries: Array<{
            environmentId: string;
            comparisonRef: string;
            stats: Record<string, unknown>;
          }>;
        };

        // The first call arms tracking, so the counts arrive with the scan that
        // follows rather than in the response itself.
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "diff stats to be announced",
        );

        const change = emitted.find((entry) => entry.event === "environment-diff-stats-changed")
          ?.payload as {
          environmentId: string;
          comparisonRef: string;
          stats: Record<string, unknown>;
        };
        expect(change.environmentId).toBe(environment.id);
        expect(change.comparisonRef).toBe("main");
        expect(change.stats).toEqual({
          additions: 3,
          deletions: 0,
          filesChanged: 2,
          truncated: false,
        });
        expect(Array.isArray(snapshot.entries)).toBe(true);

        // The snapshot is the rehydration path, so it must carry the same counts
        // a client would otherwise only have learned from the event.
        const rehydrated = (await commands.get("get_environment_diff_stats")?.({}, context)) as {
          entries: Array<{ environmentId: string; stats: Record<string, unknown> }>;
        };
        expect(rehydrated.entries).toContainEqual(
          expect.objectContaining({
            environmentId: environment.id,
            stats: { additions: 3, deletions: 0, filesChanged: 2, truncated: false },
          }),
        );
      } finally {
        await commands
          .get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    // The sidebar badge and the Files panel used to ask for the same environment
    // separately; whichever arrives first now pays for the scan.
    test("serves the Files panel from the scan the badge already ran", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        await commands.get("get_environment_diff_stats")?.({}, context);
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "diff stats to be announced",
        );

        await withGitSubcommandLog("status", async (logPath) => {
          const changes = (await commands.get("get_local_git_status")?.(
            { worktreePath: worktree, targetBranch: "main" },
            context,
          )) as Array<{ path: string }>;

          expect(changes.some((change) => change.path === "tracked.txt")).toBe(true);
          await expect(fs.readFile(logPath, "utf8").catch(() => "")).resolves.toBe("");
        });
      } finally {
        await commands
          .get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    test(
      "invalidates the shared file-list cache after local revert and delete",
      async () => {
        const { worktree } = await createGitWorktreeWithOrigin();
        await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
        const { environment, context, emitted } = localDiffEnvironment(worktree);
        const commands = createCommandRegistry();

        try {
          await commands.get("get_environment_diff_stats")?.({}, context);
          await waitForCondition(
            () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
            "initial diff stats to be announced",
          );

          await commands.get("revert_local_file")?.(
            { environmentId: environment.id, filePath: "tracked.txt", targetBranch: "main" },
            context,
          );
          const immediate = (await commands.get("get_local_git_status")?.(
            { worktreePath: worktree, targetBranch: "main" },
            context,
          )) as Array<{ path: string }>;

          expect(immediate.some((change) => change.path === "tracked.txt")).toBe(false);

          // `revert_local_file` only *requests* its scan, so the reverted counts
          // are not published yet. Rewriting the file before that scan lands makes
          // it read the pre-revert counts again, and the service correctly
          // suppresses an unchanged reading - leaving `last` pinned to the
          // pre-revert value, which then suppresses every later scan too. Waiting
          // for the reverted counts is the barrier that keeps the rewrite below a
          // genuine change rather than a no-op the service is right to swallow.
          await waitForCondition(
            () =>
              emitted.some(
                (entry) =>
                  entry.event === "environment-diff-stats-changed" &&
                  (entry.payload as { stats?: { filesChanged?: number } }).stats?.filesChanged ===
                    0,
              ),
            "the revert to be announced",
          );

          const trackedPath = path.join(worktree, "tracked.txt");
          emitted.splice(0);
          await fs.writeFile(trackedPath, "base\nchanged again\n");
          await commands.get("refresh_environment_diff_stats")?.(
            { environmentId: environment.id },
            context,
          );
          // One write is enough for whichever path gets there first - the explicit
          // refresh or the watcher. Retrying the write instead would only mask an
          // arbitrarily slow announcement, and cannot escape the suppression above.
          await waitForCondition(
            () =>
              emitted.some(
                (entry) =>
                  entry.event === "environment-diff-stats-changed" &&
                  (entry.payload as { stats?: { additions?: number } }).stats?.additions === 1,
              ),
            "changed file to be cached again",
          );

          await commands.get("delete_local_file")?.(
            { environmentId: environment.id, filePath: "tracked.txt" },
            context,
          );
          const afterDelete = (await commands.get("get_local_git_status")?.(
            { worktreePath: worktree, targetBranch: "main" },
            context,
          )) as Array<{ path: string; status: string; additions: number; deletions: number }>;
          expect(afterDelete).toContainEqual(
            expect.objectContaining({
              path: "tracked.txt",
              status: "D",
              additions: 0,
              deletions: 1,
            }),
          );
        } finally {
          await commands
            .get("delete_environment")?.({ environmentId: environment.id }, context)
            .catch(() => undefined);
        }
      },
      ASYNC_TEST_BUDGET_MS,
    );

    test(
      "invalidates the shared file-list cache after container revert and delete",
      async () => {
        const environment = createEnvironment({
          id: "env-container-mutation-cache",
          environmentType: "containerized",
          worktreePath: undefined,
          containerId: "container-mutation-cache",
          status: "running",
        });
        const { context, emitted } = createContext(environment);
        const commands = createCommandRegistry();
        const responsePath = path.join(
          await createTempDir("ork-container-mutation-response-"),
          "response",
        );
        await fs.writeFile(
          responsePath,
          framedContainerGitStatus("M\0tracked.txt\0", "1\t0\ttracked.txt\0"),
        );
        const previousResponse = process.env.FAKE_CONTAINER_MUTATION_RESPONSE;
        process.env.FAKE_CONTAINER_MUTATION_RESPONSE = responsePath;

        try {
          await withFakeDocker(
            `#!/bin/sh
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_NAME_STATUS*) cat "$FAKE_CONTAINER_MUTATION_RESPONSE" ;;
  esac
  exit 0
fi
exit 1
`,
            async () => {
              await commands.get("get_environment_diff_stats")?.({}, context);
              await waitForCondition(
                () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
                "initial container diff stats to be announced",
              );
              await fs.writeFile(responsePath, framedContainerGitStatus());

              await commands.get("revert_container_file")?.(
                { environmentId: environment.id, filePath: "tracked.txt", targetBranch: "main" },
                context,
              );
              const afterRevert = (await commands.get("get_git_status")?.(
                { containerId: environment.containerId, targetBranch: "main" },
                context,
              )) as Array<{ path: string }>;
              expect(afterRevert).toEqual([]);

              // `revert_container_file` only *requests* its scan, so the reverted
              // counts are not published yet. Restoring the modified fixture before
              // that scan lands makes it read the pre-revert counts again, and the
              // service correctly suppresses an unchanged reading - leaving `last`
              // pinned to the pre-revert value, which then suppresses every later
              // scan too. Waiting for the reverted counts is the barrier that keeps
              // the rewrite below a genuine change rather than a no-op the service
              // is right to swallow. This mirrors the local-revert test above.
              await waitForCondition(
                () =>
                  emitted.some(
                    (entry) =>
                      entry.event === "environment-diff-stats-changed" &&
                      (entry.payload as { stats?: { filesChanged?: number } }).stats
                        ?.filesChanged === 0,
                  ),
                "the container revert to be announced",
              );

              await fs.writeFile(
                responsePath,
                framedContainerGitStatus("M\0tracked.txt\0", "1\t0\ttracked.txt\0"),
              );
              emitted.splice(0);
              await commands.get("refresh_environment_diff_stats")?.(
                { environmentId: environment.id },
                context,
              );
              await waitForCondition(
                () =>
                  emitted.some(
                    (entry) =>
                      entry.event === "environment-diff-stats-changed" &&
                      (entry.payload as { stats?: { additions?: number } }).stats?.additions === 1,
                  ),
                "container file to be cached again",
              );
              await fs.writeFile(responsePath, framedContainerGitStatus());

              await commands.get("delete_container_file")?.(
                { environmentId: environment.id, filePath: "tracked.txt" },
                context,
              );
              const afterDelete = (await commands.get("get_git_status")?.(
                { containerId: environment.containerId, targetBranch: "main" },
                context,
              )) as Array<{ path: string }>;
              expect(afterDelete).toEqual([]);
            },
          );
        } finally {
          if (previousResponse === undefined) delete process.env.FAKE_CONTAINER_MUTATION_RESPONSE;
          else process.env.FAKE_CONTAINER_MUTATION_RESPONSE = previousResponse;
        }
      },
      ASYNC_TEST_BUDGET_MS,
    );

    test("refreshes a tracked environment on explicit request", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        await commands.get("get_environment_diff_stats")?.({}, context);
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "initial diff stats to be announced",
        );
        emitted.splice(0);
        await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\nagain\n");

        await commands.get("refresh_environment_diff_stats")?.(
          { environmentId: environment.id },
          context,
        );
        await waitForCondition(
          () =>
            emitted.some(
              (entry) =>
                entry.event === "environment-diff-stats-changed" &&
                (entry.payload as { stats?: { additions?: number } }).stats?.additions === 2,
            ),
          "refreshed diff stats to be announced",
        );
      } finally {
        await commands
          .get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    test("clears published counts when a repository config retarget cannot be scanned", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        await commands.get("get_environment_diff_stats")?.({}, context);
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "initial diff stats to be announced",
        );
        emitted.splice(0);

        await commands.get("update_repository_config")?.(
          {
            projectId: environment.projectId,
            repoConfig: { defaultBranch: "missing-base", prBaseBranch: "missing-base" },
          },
          context,
        );
        await waitForCondition(
          () =>
            emitted.some(
              (entry) =>
                entry.event === "environment-diff-stats-changed" &&
                (entry.payload as { environmentId?: string; removed?: boolean }).environmentId ===
                  environment.id &&
                (entry.payload as { removed?: boolean }).removed === true,
            ),
          "retargeted counts to be removed",
        );

        const snapshot = (await commands.get("get_environment_diff_stats")?.({}, context)) as {
          entries: Array<{ environmentId: string }>;
        };
        expect(snapshot.entries).not.toContainEqual(
          expect.objectContaining({
            environmentId: environment.id,
          }),
        );
      } finally {
        await commands
          .get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    test("does not resurrect deleted tracking from a stale reconciliation", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      const environment = createEnvironment({
        id: "env-stale-sync",
        status: "stopped",
        worktreePath: worktree,
      });
      const { context, emitted } = createContext(environment);
      const commands = createCommandRegistry();
      await commands.get("get_environment_diff_stats")?.({}, context);
      await waitForCondition(
        () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
        "initial diff tracking to start",
      );
      expect(commandTesting.trackedDiffStatsIds()).toContain(environment.id);

      const staleSnapshot = [environment];
      let releaseLoad!: () => void;
      let loadStarted!: () => void;
      const loadBlocked = new Promise<void>((resolve) => {
        releaseLoad = resolve;
      });
      const loadEntered = new Promise<void>((resolve) => {
        loadStarted = resolve;
      });
      let loadCount = 0;
      context.storage.loadEnvironments = mock(async () => {
        loadCount += 1;
        // Only the reconciliation snapshot is stale and blocked. Environment
        // deletion also loads the current environment set while cleaning tmux;
        // blocking that independent lifecycle read deadlocks the test itself.
        if (loadCount === 1) {
          loadStarted();
          await loadBlocked;
        }
        return staleSnapshot;
      });

      const rehydrate = commands.get("get_environment_diff_stats")?.({}, context);
      await loadEntered;
      await commands.get("delete_environment")?.({ environmentId: environment.id }, context);
      releaseLoad();
      await rehydrate;

      expect(commandTesting.trackedDiffStatsIds()).not.toContain(environment.id);
    });

    test("reads for itself when no recent scan is cached", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      const { context } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      // Nothing armed tracking, so there is no cache to serve from.
      await withGitSubcommandLog("status", async (logPath) => {
        await commands.get("get_local_git_status")?.(
          { worktreePath: worktree, targetBranch: "main" },
          context,
        );

        await expect(fs.readFile(logPath, "utf8")).resolves.toContain("status");
      });
    });

    test("marks the counts approximate when the untracked scan is capped", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      const overflow = path.join(worktree, "generated");
      await fs.mkdir(overflow, { recursive: true });
      // One past the 2000-file cap the scanner applies.
      await Promise.all(
        Array.from({ length: 2_001 }, (_, index) =>
          fs.writeFile(path.join(overflow, `file-${index}.txt`), "one\n"),
        ),
      );
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        await commands.get("get_environment_diff_stats")?.({}, context);
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "capped diff stats to be announced",
          15_000,
        );

        const change = emitted.find((entry) => entry.event === "environment-diff-stats-changed")
          ?.payload as { stats: { truncated: boolean; filesChanged: number; additions: number } };
        expect(change.stats.truncated).toBe(true);
        // Every file is still listed; only the line counts past the cap are missing.
        expect(change.stats.filesChanged).toBe(2_001);
        expect(change.stats.additions).toBe(2_000);
      } finally {
        await commands
          .get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    }, 30_000);

    test("does not mark the counts approximate for an ordinary worktree", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "brand-new.txt"), "one\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      try {
        await commands.get("get_environment_diff_stats")?.({}, context);
        await waitForCondition(
          () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
          "diff stats to be announced",
        );

        const change = emitted.find((entry) => entry.event === "environment-diff-stats-changed")
          ?.payload as { stats: { truncated: boolean } };
        expect(change.stats.truncated).toBe(false);
      } finally {
        await commands
          .get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    test("marks capped container scans approximate and shares their file-list cache", async () => {
      const environment = createEnvironment({
        id: "env-container-diff-cap",
        environmentType: "containerized",
        worktreePath: undefined,
        containerId: "container-diff-cap",
        status: "running",
      });
      const { context, emitted } = createContext(environment);
      const commands = createCommandRegistry();
      const responsePath = path.join(
        await createTempDir("ork-container-diff-response-"),
        "response",
      );
      const names = Array.from({ length: 2_001 }, (_, index) => `generated/file-${index}.txt`);
      const untrackedStats = names
        .map((filePath, index) => `${index < 2_000 ? 1 : 0}\t${filePath}\0`)
        .join("");
      await fs.writeFile(responsePath, framedContainerGitStatus("", "", untrackedStats));
      const previousResponse = process.env.FAKE_CONTAINER_DIFF_RESPONSE;
      process.env.FAKE_CONTAINER_DIFF_RESPONSE = responsePath;

      try {
        await withFakeDocker(
          `#!/bin/sh
if [ "$1" = "exec" ]; then
  printf '%s\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  cat "$FAKE_CONTAINER_DIFF_RESPONSE"
  exit 0
fi
exit 1
`,
          async (logs) => {
            await commands.get("get_environment_diff_stats")?.({}, context);
            await waitForCondition(
              () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
              "container diff stats to be announced",
            );
            const change = emitted.find((entry) => entry.event === "environment-diff-stats-changed")
              ?.payload as {
              stats: { truncated: boolean; filesChanged: number; additions: number };
            };
            expect(change.stats).toEqual({
              additions: 2_000,
              deletions: 0,
              filesChanged: 2_001,
              truncated: true,
            });

            const execsBefore = (await fs.readFile(logs.exec, "utf8")).trim().split("\n").length;
            const files = (await commands.get("get_git_status")?.(
              { containerId: environment.containerId, targetBranch: "main" },
              context,
            )) as Array<{ path: string }>;
            expect(files).toHaveLength(2_001);
            const execsAfter = (await fs.readFile(logs.exec, "utf8")).trim().split("\n").length;
            expect(execsAfter).toBe(execsBefore);
          },
        );
      } finally {
        if (previousResponse === undefined) delete process.env.FAKE_CONTAINER_DIFF_RESPONSE;
        else process.env.FAKE_CONTAINER_DIFF_RESPONSE = previousResponse;
      }
    }, 15_000);

    // git status is dominated by walking and stat'ing the tree, and the
    // untracked cache is what stops it re-reading directories it has already
    // seen to be clean.
    test("enables git's scan caches on a newly created worktree", async () => {
      const { worktree, remote } = await createGitWorktreeWithOrigin();
      const suffix = randomUUID().slice(0, 8);
      const environment = createEnvironment({
        status: "stopped",
        worktreePath: undefined,
        branch: `feature/scan-caches-${suffix}`,
        environmentType: "local",
      });
      const { context, emitted } = createContext(environment, {
        project: {
          id: environment.projectId,
          name: `Scan Caches ${suffix}`,
          gitUrl: remote,
          localPath: worktree,
          addedAt: new Date(0).toISOString(),
          order: 0,
        },
        repositoryConfig: { defaultBranch: "main", prBaseBranch: "main" },
      });
      const commands = createCommandRegistry();

      try {
        await commands.get("start_environment")?.({ environmentId: environment.id }, context);
        const worktreePath = environment.worktreePath!;

        await waitForCondition(
          () =>
            emitted.some(
              (entry) =>
                entry.event === "environment-diff-stats-changed" &&
                (entry.payload as { environmentId?: string }).environmentId === environment.id,
            ),
          "new local environment diff tracking to start",
        );
        const snapshot = (await commands.get("get_environment_diff_stats")?.({}, context)) as {
          entries: Array<{ environmentId: string }>;
        };
        expect(snapshot.entries).toContainEqual(
          expect.objectContaining({
            environmentId: environment.id,
          }),
        );

        await expect(
          gitOutput(worktreePath, ["config", "--get", "core.untrackedCache"]),
        ).resolves.toBe("true");
        // Scoped to this worktree, never to the shared config: these worktrees
        // hang off a clone the user also drives by hand.
        await expect(
          gitOutput(worktreePath, ["config", "--worktree", "--get", "core.fsmonitor"]),
        ).resolves.toBe("true");
        await expect(
          gitOutput(worktree, ["config", "--get", "core.fsmonitor"]).catch(() => ""),
        ).resolves.not.toBe("true");
      } finally {
        await commands
          .get("delete_environment")?.({ environmentId: environment.id }, context)
          .catch(() => undefined);
      }
    });

    test("keeps scanning usable when Git rejects cache configuration", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();

      await withFailingGitSubcommand("config", async () => {
        await expect(commandTesting.enableGitScanCaches(worktree)).resolves.toBeUndefined();
      });

      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      await expect(
        createCommandRegistry().get("get_local_git_status")?.(
          { worktreePath: worktree, targetBranch: "main" },
          createContext(createEnvironment()).context,
        ),
      ).resolves.toContainEqual(
        expect.objectContaining({
          path: "tracked.txt",
          additions: 1,
        }),
      );
    });

    test("deleting an environment drops its counts from the snapshot", async () => {
      const { worktree } = await createGitWorktreeWithOrigin();
      await fs.writeFile(path.join(worktree, "tracked.txt"), "base\nchanged\n");
      const { environment, context, emitted } = localDiffEnvironment(worktree);
      const commands = createCommandRegistry();

      await commands.get("get_environment_diff_stats")?.({}, context);
      await waitForCondition(
        () => emitted.some((entry) => entry.event === "environment-diff-stats-changed"),
        "diff stats to be announced",
      );

      await commands.get("delete_environment")?.({ environmentId: environment.id }, context);

      const snapshot = (await commands.get("get_environment_diff_stats")?.({}, context)) as {
        entries: Array<{ environmentId: string }>;
      };
      expect(snapshot.entries.some((entry) => entry.environmentId === environment.id)).toBe(false);
    });
  });

  test(
    "keeps the preparation session attachable before its setup PTY exists",
    async () => {
      const environment = createEnvironment({
        id: "env-container-prepare-attach",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const setupSessionId = `${environment.id}:setup`;

      await withFakeDocker(
        `#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      touch "$FAKE_DOCKER_LOG.preparing"
      while [ ! -f "$FAKE_DOCKER_LOG.release" ]; do
        sleep 0.01
      done
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '6767676767676767676767676767676767676767\\n'
      ;;
  esac
  exit 0
fi
exit 0
`,
        async (logs) => {
          const setupPromise = commands.get("run_environment_setup")?.(
            { environmentId: environment.id },
            context,
          ) as Promise<Environment>;
          let verificationError: unknown;
          try {
            await waitForCondition(
              () => existsSync(`${logs.all}.preparing`),
              "workspace preparation to start",
            );

            // Preparation owns a logical setup session before the PTY is spawned.
            // It must be attachable so the renderer subscribes once instead of
            // replaying the intro in a reconnect loop.
            expect(ptySpawn).not.toHaveBeenCalled();
            expect(
              commands.get("get_terminal_session")?.({ sessionId: setupSessionId }, context),
            ).toEqual({ id: setupSessionId, running: true, bootstrapped: false });
            expect(
              await commands.get("await_environment_setup_session")?.(
                { environmentId: environment.id },
                context,
              ),
            ).toEqual(
              expect.objectContaining({
                sessionId: setupSessionId,
                running: true,
                terminalRunning: false,
              }),
            );
          } catch (error) {
            verificationError = error;
          } finally {
            await fs.writeFile(`${logs.all}.release`, "");
          }

          await waitForPtyProcessCount(1);
          ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
          await setupPromise;
          if (verificationError) throw verificationError;
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("does not attach an unknown setup session", async () => {
    const environment = createEnvironment({ id: "env-known-setup-session" });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const unknownSessionId = "env-unknown-setup-session:setup";

    expect(
      commands.get("get_terminal_session")?.({ sessionId: unknownSessionId }, context),
    ).toEqual({ id: unknownSessionId, running: false, bootstrapped: false });
    expect(
      await commands.get("await_environment_setup_session")?.(
        { environmentId: "env-unknown-setup-session" },
        context,
      ),
    ).toBeNull();
  });

  test(
    "closes the setup session when preparation fails",
    async () => {
      const environment = createEnvironment({
        id: "env-container-prepare-fails",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
        pendingAgentLaunch: true,
      });
      const { context, emitted } = createContext(environment);
      const commands = createCommandRegistry();

      await withFakeDocker(
        `#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf 'clone failed\\n' >&2
      exit 1
      ;;
  esac
  exit 0
fi
exit 0
`,
        async () => {
          await expect(
            commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
          ).rejects.toThrow("clone failed");

          // A session opened for preparation must not be left claiming to be running
          // with no process behind it.
          const session = (await commands.get("await_environment_setup_session")?.(
            { environmentId: environment.id },
            context,
          )) as { running: boolean; success?: boolean; error?: string };
          expect(session).toMatchObject({ running: false, success: false });
          expect(
            commands.get("get_terminal_session")?.(
              { sessionId: `${environment.id}:setup` },
              context,
            ),
          ).toEqual({ id: `${environment.id}:setup`, running: false, bootstrapped: false });
          expect(session.error).toContain("clone failed");
          expect(
            emitted.some(
              (entry) =>
                entry.event === "environment-setup-complete" &&
                (entry.payload as { success: boolean }).success === false,
            ),
          ).toBe(true);
          expect(environment.pendingAgentLaunch).toBe(false);
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "increments the terminal transcript generation when setup is retried",
    async () => {
      const environment = createEnvironment({
        id: "env-container-prepare-generation",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context, emitted } = createContext(environment);
      const commands = createCommandRegistry();
      const sessionId = `${environment.id}:setup`;

      await withFakeDocker(
        `#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf 'transient clone failure\\n' >&2
      exit 1
      ;;
  esac
fi
exit 0
`,
        async () => {
          await expect(
            commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
          ).rejects.toThrow("transient clone failure");
          const firstSnapshot = commands.get("get_terminal_output_snapshot")?.(
            { sessionId },
            context,
          ) as { output: string; revision: number; generation: number };
          expect(firstSnapshot.generation).toBe(1);
          expect(firstSnapshot.revision).toBeGreaterThan(0);

          await expect(
            commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
          ).rejects.toThrow("transient clone failure");
          const retrySnapshot = commands.get("get_terminal_output_snapshot")?.(
            { sessionId },
            context,
          ) as { output: string; revision: number; generation: number };
          expect(retrySnapshot.generation).toBe(2);
          expect(retrySnapshot.revision).toBeGreaterThan(0);

          const outputGenerations = emitted
            .filter(({ event }) => event === `terminal-output-${sessionId}`)
            .map(({ payload }) => (payload as { generation: number }).generation);
          expect(outputGenerations).toContain(1);
          expect(outputGenerations).toContain(2);
          expect(outputGenerations.indexOf(1)).toBeLessThan(outputGenerations.indexOf(2));
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("persists safe cleanup failure details and permits a backend deletion retry", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-cleanup-retry-");
    const environment = createEnvironment({
      id: "env-merge-cleanup-retry",
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const removeEnvironment = context.storage.removeEnvironment.bind(context.storage);
    context.storage.removeEnvironment = mock(async () => {
      throw { reason: "untrusted backend rejection" };
    });

    await withFakeGh(
      `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/retry","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/retry" ]; then
  exit 0
fi
exit 1
`,
      async () => {
        await expect(
          commands.get("merge_environment_pr")?.(
            {
              environmentId: environment.id,
              method: "squash",
              deleteBranch: true,
              cleanupAfterMerge: true,
            },
            context,
          ),
        ).resolves.toEqual({
          outcome: "merged",
          cleanupOutcome: "failed",
          cleanupError: "An unexpected error occurred",
        });
        await expect(context.storage.getEnvironment(environment.id)).resolves.toMatchObject({
          deletionRequestedAt: expect.any(String),
          cleanupAfterMergeRequestedAt: expect.any(String),
          cleanupAfterMergeError: "An unexpected error occurred",
        });

        context.storage.removeEnvironment = removeEnvironment;
        await expect(
          commands.get("delete_environment")?.(
            {
              environmentId: environment.id,
            },
            context,
          ),
        ).resolves.toBeUndefined();
        await expect(context.storage.getEnvironment(environment.id)).resolves.toBeNull();
      },
    );
  });

  test("rejects a direct deletion while the backend merge guard is active", async () => {
    const worktreePath = await createTempDir("ork-electron-merge-delete-race-");
    const environment = createEnvironment({
      id: "env-merge-delete-race",
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const updateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    let releaseLifecycleWrite!: () => void;
    const lifecycleWriteReached = new Promise<void>((resolve) => {
      context.storage.updateEnvironment = mock(
        async (environmentId: string, updates: Partial<Environment>) => {
          if (updates.lifecycleOperation === "merging") {
            resolve();
            await new Promise<void>((release) => {
              releaseLifecycleWrite = release;
            });
          }
          return updateEnvironment(environmentId, updates);
        },
      );
    });

    await withFakeGh(
      `#!/bin/sh
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  printf '%s\\n' 'false'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42/merge" ]; then
  printf '%s\\n' '{"merged":true}'
  exit 0
fi
exit 1
`,
      async () => {
        const merge = commands.get("merge_environment_pr")?.(
          {
            environmentId: environment.id,
            method: "squash",
            deleteBranch: false,
            cleanupAfterMerge: false,
          },
          context,
        );
        await lifecycleWriteReached;

        await expect(
          commands.get("delete_environment")?.(
            {
              environmentId: environment.id,
            },
            context,
          ),
        ).rejects.toThrow(`Environment is currently being merged: ${environment.id}`);

        releaseLifecycleWrite();
        await expect(merge).resolves.toEqual({
          outcome: "merged",
          cleanupOutcome: "not-requested",
        });
      },
    );
  });

  test.each(["cursor", "grok"] as const)(
    "starts the local %s ACP bridge and refuses until its toolchain exists",
    async (provider) => {
      const appRoot = await createTempDir(`ork-electron-acp-${provider}-`);
      const toolchainBinDir = await createTempDir(`ork-electron-acp-bin-${provider}-`);
      const worktreePath = await createTempDir(`ork-electron-acp-worktree-${provider}-`);
      const dataDir = await createTempDir(`ork-electron-acp-data-${provider}-`);
      const markerPath = path.join(appRoot, "acp-env.log");
      const bridgeDist = path.join(appRoot, "bridges", "acp-bridge", "dist");
      await fs.mkdir(bridgeDist, { recursive: true });
      await fs.writeFile(
        path.join(bridgeDist, "index.js"),
        `
          const http = require("node:http");
          require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
            provider: process.env.ACP_PROVIDER ?? "",
            agentPath: process.env.ACP_AGENT_PATH ?? "",
            approveProjectMcps: process.env.ACP_APPROVE_PROJECT_MCPS ?? "",
            stateDir: process.env.ACP_STATE_DIR ?? "",
            hostname: process.env.HOSTNAME ?? "",
            hasToken: Boolean(process.env.ACP_BRIDGE_TOKEN),
            hasCursorApiKey: Boolean(process.env.CURSOR_API_KEY),
            home: process.env.HOME ?? "",
            credentialStore: process.env.AGENT_CLI_CREDENTIAL_STORE ?? "",
            cursorApiKeyFingerprint: require("node:crypto")
              .createHash("sha256")
              .update(process.env.CURSOR_API_KEY ?? "")
              .digest("hex"),
          }));
          http.createServer((req, res) => {
            if (req.url === "/global/health") {
              res.writeHead(200, {
                "content-type": "application/json",
                "access-control-allow-origin": "*",
              });
              res.end(JSON.stringify({ ok: true }));
              return;
            }
            if (req.url === "/global/models") {
              res.writeHead(200, {
                "content-type": "application/json",
                "access-control-allow-origin": "*",
              });
              res.end(JSON.stringify({ models: [{
                platform: ${JSON.stringify(provider)},
                id: ${JSON.stringify(`${provider}-live-model`)},
                label: ${JSON.stringify(`${provider} live model`)},
                providerLabel: ${JSON.stringify(provider === "cursor" ? "Cursor" : "Grok")},
                supportsMode: true,
              }] }));
              return;
            }
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "not found" }));
          }).listen(Number(process.env.PORT), "127.0.0.1");
        `,
      );

      const environment = createEnvironment({ id: `env-acp-${provider}`, worktreePath });
      const globalConfig: { cursorApiKey?: string } =
        provider === "cursor" ? { cursorApiKey: "configured-cursor-key" } : {};
      const { context } = createContext(environment, {
        globalConfig,
        dataDir,
      });
      context.runtimeFlavor = "agent-test";
      context.credentialSources = new Set([provider]);
      context.appRoot = appRoot;
      context.resourceRoot = appRoot;
      context.toolchainBinDir = toolchainBinDir;
      const commands = createCommandRegistry();

      // Toolchains download at app startup, so a platform enabled mid-session
      // has no binary yet. A separate PATH install must not masquerade as the
      // managed executable selected for this backend generation; that used to
      // start a bridge which only failed later during session creation.
      const pathFallbackDir = await createTempDir(`ork-electron-acp-path-${provider}-`);
      const pathFallback = path.join(pathFallbackDir, provider);
      await fs.writeFile(pathFallback, "#!/bin/sh\nexit 0\n");
      await fs.chmod(pathFallback, 0o755);
      const previousPath = process.env.PATH;
      process.env.PATH = `${pathFallbackDir}:/usr/bin:/bin`;
      try {
        await expect(
          commands.get(`start_local_${provider}_server_cmd`)?.(
            { environmentId: environment.id },
            context,
          ),
        ).rejects.toThrow(/enabled but not installed yet/);
      } finally {
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
      }

      // Once the managed binary lands, the bridge starts against exactly it.
      const managedAgentPath = path.join(
        toolchainBinDir,
        provider === "cursor" ? "cursor-agent" : "grok",
      );
      if (provider === "cursor") {
        // An activation directory predating the `cursor-agent` alias holds only
        // the legacy managed name, and that bundle is still launchable — the
        // upgrade must not strand it. Adding the unambiguous name then wins.
        await fs.writeFile(path.join(toolchainBinDir, "cursor"), "legacy managed alias");
        await expect(commands.get("check_cursor_cli")?.({}, context)).resolves.toBe(true);
      }
      await fs.writeFile(managedAgentPath, `managed ${provider}`);
      const started = (await commands.get(`start_local_${provider}_server_cmd`)?.(
        { environmentId: environment.id },
        context,
      )) as { port: number; pid: number; wasRunning: boolean; authToken: string };
      try {
        expect(started.wasRunning).toBe(false);
        expect(started.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
        expect(marker.provider).toBe(provider);
        expect(marker.agentPath).toBe(managedAgentPath);
        expect(marker.approveProjectMcps).toBe("0");
        expect(marker.hasToken).toBe(true);
        expect(marker.hasCursorApiKey).toBe(provider === "cursor");
        if (provider === "cursor") {
          const cursorProviderHome = path.join(
            dataDir,
            "agent-credentials",
            "provider-homes",
            "cursor",
          );
          expect(marker.home).toBe(cursorProviderHome);
          // The bridge runs with this as its HOME whether or not anything was
          // imported, so it has to exist even on the revoke path. This run has
          // no host records at all, which is exactly that path.
          expect((await fs.stat(cursorProviderHome)).isDirectory()).toBe(true);
          expect(marker.credentialStore).toBe("file");
          expect(
            await fs
              .access(path.join(dataDir, "agent-credentials", "home", "Library", "Keychains"))
              .then(
                () => true,
                () => false,
              ),
          ).toBe(false);
        }
        expect(marker.cursorApiKeyFingerprint).toBe(
          createHash("sha256")
            .update(provider === "cursor" ? "configured-cursor-key" : "")
            .digest("hex"),
        );
        // Local bridges bind loopback only, and each environment keeps its own
        // state directory so two environments cannot share a transcript.
        expect(marker.hostname).toBe("127.0.0.1");
        expect(marker.stateDir).toContain(path.join("acp-bridge-state"));
        expect(marker.stateDir).toContain(path.join(path.sep, provider));

        const status = (await commands.get(`get_local_${provider}_server_status`)?.(
          { environmentId: environment.id },
          context,
        )) as { running: boolean; port: number };
        expect(status).toMatchObject({ running: true, port: started.port });

        const catalog = (await commands.get("get_native_agent_model_catalog")?.(
          { environmentId: environment.id },
          context,
        )) as Array<{ platform: string; id: string }>;
        expect(catalog).toContainEqual(
          expect.objectContaining({
            platform: provider,
            id: `${provider}-live-model`,
          }),
        );
        expect(context.storage.cacheAgentModelCatalog).toHaveBeenCalledWith(provider, [
          expect.objectContaining({ id: `${provider}-live-model` }),
        ]);

        if (provider === "cursor") {
          // The fingerprint exists to restart on a *changed* credential. An
          // unchanged one must reuse the live bridge: restarting here would
          // kill the agent's in-flight turn on every start request, and
          // `NativeAgentService.provider()` issues one per prompt dispatch.
          const unchanged = (await commands.get("start_local_cursor_server_cmd")?.(
            { environmentId: environment.id },
            context,
          )) as { wasRunning: boolean; authToken: string; pid: number };
          expect(unchanged.wasRunning).toBe(true);
          expect(unchanged.authToken).toBe(started.authToken);
          expect(unchanged.pid).toBe(started.pid);

          globalConfig.cursorApiKey = "rotated-cursor-key";
          const rotated = (await commands.get("start_local_cursor_server_cmd")?.(
            { environmentId: environment.id },
            context,
          )) as { wasRunning: boolean; authToken: string };
          expect(rotated.wasRunning).toBe(false);
          expect(rotated.authToken).not.toBe(started.authToken);
          const rotatedMarker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<
            string,
            unknown
          >;
          expect(rotatedMarker.cursorApiKeyFingerprint).toBe(
            createHash("sha256").update("rotated-cursor-key").digest("hex"),
          );

          delete globalConfig.cursorApiKey;
          const cleared = (await commands.get("start_local_cursor_server_cmd")?.(
            { environmentId: environment.id },
            context,
          )) as { wasRunning: boolean; authToken: string };
          expect(cleared.wasRunning).toBe(false);
          expect(cleared.authToken).not.toBe(rotated.authToken);
          const clearedMarker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<
            string,
            unknown
          >;
          expect(clearedMarker.hasCursorApiKey).toBe(false);
          expect(clearedMarker.cursorApiKeyFingerprint).toBe(
            createHash("sha256").update("").digest("hex"),
          );

          // "No key" is a credential state like any other, so a second start
          // with the key still absent must also reuse rather than restart.
          const stillCleared = (await commands.get("start_local_cursor_server_cmd")?.(
            { environmentId: environment.id },
            context,
          )) as { wasRunning: boolean; authToken: string };
          expect(stillCleared.wasRunning).toBe(true);
          expect(stillCleared.authToken).toBe(cleared.authToken);

          // Reusing a persistent profile with host credentials disabled must
          // restart any credential-bearing bridge and revoke its file snapshot,
          // even when the host lookup currently returns no records.
          const cursorAuthFile = path.join(
            dataDir,
            "agent-credentials",
            "provider-homes",
            "cursor",
            ".cursor",
            "auth.json",
          );
          await fs.mkdir(path.dirname(cursorAuthFile), { recursive: true });
          await fs.writeFile(cursorAuthFile, JSON.stringify({ accessToken: "stale-token" }));
          context.credentialSources = new Set();
          const denied = (await commands.get("start_local_cursor_server_cmd")?.(
            { environmentId: environment.id },
            context,
          )) as { wasRunning: boolean; authToken: string };
          expect(denied.wasRunning).toBe(false);
          expect(denied.authToken).not.toBe(stillCleared.authToken);
          expect(
            await fs.access(cursorAuthFile).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
        }
      } finally {
        await commands.get(`stop_local_${provider}_server_cmd`)?.(
          { environmentId: environment.id },
          context,
        );
      }
    },
  );

  test("starts the local Cursor SDK bridge from packaged resources with isolated state", async () => {
    const appRoot = await createTempDir("ork-electron-cursor-sdk-app-");
    const resourceRoot = await createTempDir("ork-electron-cursor-sdk-resources-");
    const toolchainBinDir = await createTempDir("ork-electron-cursor-sdk-bin-");
    const worktreePath = await createTempDir("ork-electron-cursor-sdk-worktree-");
    const dataDir = await createTempDir("ork-electron-cursor-sdk-data-");
    const markerPath = path.join(resourceRoot, "cursor-sdk-env.json");
    const bridgeDist = path.join(resourceRoot, "cursor-bridge", "dist");
    await fs.mkdir(bridgeDist, { recursive: true });
    await fs.writeFile(
      path.join(bridgeDist, "index.js"),
      `
        const http = require("node:http");
        require("node:fs").writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
          cwd: process.cwd(),
          envCwd: process.env.CWD ?? "",
          stateDir: process.env.CURSOR_BRIDGE_STATE_DIR ?? "",
          authFile: process.env.CURSOR_BRIDGE_AUTH_FILE ?? "",
          projectSettings: process.env.CURSOR_BRIDGE_PROJECT_SETTINGS ?? "",
          hasApiKey: Boolean(process.env.CURSOR_API_KEY),
          hostname: process.env.HOSTNAME ?? "",
        }));
        http.createServer((req, res) => {
          if (req.url === "/global/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(404).end();
        }).listen(Number(process.env.PORT), "127.0.0.1");
      `,
    );

    const environment = createEnvironment({ id: "env-local-cursor-sdk", worktreePath });
    const { context } = createContext(environment, {
      globalConfig: {
        experimentalCursorSdkBridge: true,
        cursorApiKey: "configured-cursor-key",
      },
      dataDir,
    });
    context.runtimeFlavor = "agent-test";
    context.credentialSources = new Set(["cursor"]);
    context.appRoot = appRoot;
    context.resourceRoot = resourceRoot;
    context.toolchainBinDir = toolchainBinDir;
    const commands = createCommandRegistry();

    const started = (await commands.get("start_local_cursor_server_cmd")?.(
      { environmentId: environment.id },
      context,
    )) as { port: number; wasRunning: boolean };
    try {
      expect(started.wasRunning).toBe(false);
      const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
      // Shell calls that omit workingDirectory inherit this cwd, so it must be
      // the worktree rather than the packaged bridge directory.
      expect(marker.cwd).toBe(await fs.realpath(worktreePath));
      expect(marker.envCwd).toBe(worktreePath);
      expect(marker.stateDir).toContain(path.join("cursor-bridge-state"));
      expect(marker.stateDir).not.toContain(path.join("acp-bridge-state"));
      expect(marker.authFile).toBe(path.join(dataDir, "cursor-sdk", "auth.json"));
      expect(marker.projectSettings).toBe("0");
      expect(marker.hasApiKey).toBe(true);
      expect(marker.hostname).toBe("127.0.0.1");
    } finally {
      await commands.get("stop_local_cursor_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test(
    "brokers only Claude's macOS credential into the local Claude bridge",
    async () => {
      if (process.platform !== "darwin") return;

      const appRoot = await createTempDir("ork-electron-claude-credential-bridge-");
      const worktreePath = await createTempDir("ork-electron-claude-credential-worktree-");
      const dataDir = await createTempDir("ork-electron-claude-credential-data-");
      const hostHome = await createTempDir("ork-electron-claude-credential-host-");
      const hostConfigDir = path.join(hostHome, ".claude-custom");
      const binDir = path.join(appRoot, "bin-stub");
      const markerPath = path.join(appRoot, "claude-env.json");
      const securityArgvPath = path.join(appRoot, "security-argv.txt");
      const fakeAccessToken = "test-claude-oauth-token";
      await fs.mkdir(hostConfigDir, { recursive: true });
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(
        path.join(binDir, "security"),
        `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(securityArgvPath)}
printf '%s' ${JSON.stringify(
          JSON.stringify({
            claudeAiOauth: { accessToken: fakeAccessToken },
          }),
        )}
`,
      );
      await fs.chmod(path.join(binDir, "security"), 0o755);
      await writeBridgeEntrypoint(
        appRoot,
        "claude-bridge",
        `
        const fs = require("node:fs");
        const http = require("node:http");
        const path = require("node:path");
        fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
          configDir: process.env.CLAUDE_CONFIG_DIR ?? "",
          hasAuthToken: Boolean(process.env.ANTHROPIC_AUTH_TOKEN),
          authTokenFingerprint: require("node:crypto")
            .createHash("sha256")
            .update(process.env.ANTHROPIC_AUTH_TOKEN ?? "")
            .digest("hex"),
          home: process.env.HOME ?? "",
          keychainsVisible: fs.existsSync(path.join(
            process.env.HOME ?? "",
            "Library",
            "Keychains",
          )),
        }));
        http.createServer((req, res) => {
          res.writeHead(req.url === "/global/health" ? 200 : 404);
          res.end();
        }).listen(Number(process.env.PORT), "127.0.0.1");
      `,
      );

      const environment = createEnvironment({ id: "env-claude-credential", worktreePath });
      const { context } = createContext(environment, { dataDir });
      context.runtimeFlavor = "agent-test";
      context.credentialSources = new Set(["claude"]);
      context.appRoot = appRoot;
      context.resourceRoot = appRoot;
      const commands = createCommandRegistry();
      const previousPath = process.env.PATH;
      const previousHome = process.env.HOME;
      const previousHostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
      const previousHostConfig = process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR;
      const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
      process.env.HOME = path.join(dataDir, "agent-credentials", "home");
      process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = hostHome;
      process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = hostConfigDir;
      delete process.env.ANTHROPIC_API_KEY;

      try {
        await commands.get("start_local_claude_server_cmd")?.(
          { environmentId: environment.id },
          context,
        );
        const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
        expect(marker).toMatchObject({
          configDir: hostConfigDir,
          hasAuthToken: true,
          authTokenFingerprint: createHash("sha256").update(fakeAccessToken).digest("hex"),
          keychainsVisible: false,
        });
        expect(marker.home).not.toBe(hostHome);
        expect(await fs.readFile(securityArgvPath, "utf8")).toBe(
          `find-generic-password -s Claude Code-credentials -w ${path.join(
            hostHome,
            "Library",
            "Keychains",
            "login.keychain-db",
          )}\n`,
        );
      } finally {
        await commands.get("stop_local_claude_server_cmd")?.(
          { environmentId: environment.id },
          context,
        );
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousHostHome === undefined) delete process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
        else process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = previousHostHome;
        if (previousHostConfig === undefined) {
          delete process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR;
        } else {
          process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = previousHostConfig;
        }
        if (previousAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
      }
    },
    ASYNC_TEST_BUDGET_MS,
  );

  // The Keychain-backed variant above can only assert anything on darwin. The
  // on-disk credential is what a Linux host uses and what a darwin host falls
  // back to, so the brokering itself — host config dir scoped to this one
  // process, access token extracted, isolated HOME preserved — is covered on
  // every platform here rather than skipped wherever CI happens to run.
  test(
    "brokers a disk-stored Claude credential into the local Claude bridge",
    async () => {
      const appRoot = await createTempDir("ork-electron-claude-disk-credential-");
      const worktreePath = await createTempDir("ork-electron-claude-disk-worktree-");
      const dataDir = await createTempDir("ork-electron-claude-disk-data-");
      const hostHome = await createTempDir("ork-electron-claude-disk-host-");
      const hostConfigDir = path.join(hostHome, ".claude");
      const binDir = path.join(appRoot, "bin-stub");
      const markerPath = path.join(appRoot, "claude-env.json");
      const securityArgvPath = path.join(appRoot, "security-argv.txt");
      const diskAccessToken = "test-claude-disk-token";
      await fs.mkdir(hostConfigDir, { recursive: true });
      await fs.writeFile(
        path.join(hostConfigDir, ".credentials.json"),
        JSON.stringify({
          claudeAiOauth: {
            accessToken: diskAccessToken,
            // Far enough out that the expiry guard cannot reject it, without
            // depending on a clock the test does not control.
            expiresAt: Date.now() + 86_400_000,
          },
        }),
      );
      await fs.mkdir(binDir, { recursive: true });
      // A darwin host consults the Keychain first. Record the attempt and fail it
      // so the disk fallback is what actually delivers the token, and so the real
      // host Keychain is never touched by this test.
      await fs.writeFile(
        path.join(binDir, "security"),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(securityArgvPath)}\nexit 1\n`,
      );
      await fs.chmod(path.join(binDir, "security"), 0o755);
      await writeBridgeEntrypoint(
        appRoot,
        "claude-bridge",
        `
        const fs = require("node:fs");
        const http = require("node:http");
        const path = require("node:path");
        fs.writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify({
          configDir: process.env.CLAUDE_CONFIG_DIR ?? "",
          authTokenFingerprint: require("node:crypto")
            .createHash("sha256")
            .update(process.env.ANTHROPIC_AUTH_TOKEN ?? "")
            .digest("hex"),
          home: process.env.HOME ?? "",
        }));
        http.createServer((req, res) => {
          res.writeHead(req.url === "/global/health" ? 200 : 404);
          res.end();
        }).listen(Number(process.env.PORT), "127.0.0.1");
      `,
      );

      const environment = createEnvironment({ id: "env-claude-disk-credential", worktreePath });
      const { context } = createContext(environment, { dataDir });
      context.runtimeFlavor = "agent-test";
      context.credentialSources = new Set(["claude"]);
      context.appRoot = appRoot;
      context.resourceRoot = appRoot;
      const commands = createCommandRegistry();
      const isolatedHome = path.join(dataDir, "agent-credentials", "home");
      const previousPath = process.env.PATH;
      const previousHome = process.env.HOME;
      const previousHostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
      const previousHostConfig = process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR;
      const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
      process.env.HOME = isolatedHome;
      process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = hostHome;
      process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = hostConfigDir;
      delete process.env.ANTHROPIC_API_KEY;

      try {
        await commands.get("start_local_claude_server_cmd")?.(
          { environmentId: environment.id },
          context,
        );
        const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as Record<string, unknown>;
        expect(marker).toMatchObject({
          configDir: hostConfigDir,
          authTokenFingerprint: createHash("sha256").update(diskAccessToken).digest("hex"),
        });
        // Only the config dir is host-scoped. The bridge keeps the isolated HOME,
        // so nothing else under the host home is reachable from it.
        expect(marker.home).toBe(isolatedHome);
        if (process.platform === "darwin") {
          // An isolated profile pins the lookup to the recorded host login
          // Keychain and stops there: retrying the default search list would
          // resolve against the launching session's own keychain.
          expect(await fs.readFile(securityArgvPath, "utf8")).toBe(
            `find-generic-password -s Claude Code-credentials -w ${path.join(
              hostHome,
              "Library",
              "Keychains",
              "login.keychain-db",
            )}\n`,
          );
        } else {
          expect(
            await fs.access(securityArgvPath).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
        }
      } finally {
        await commands.get("stop_local_claude_server_cmd")?.(
          { environmentId: environment.id },
          context,
        );
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousHostHome === undefined) delete process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
        else process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = previousHostHome;
        if (previousHostConfig === undefined) {
          delete process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR;
        } else {
          process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = previousHostConfig;
        }
        if (previousAnthropicApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
        else process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey;
      }
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "restarts the Cursor bridge when the host Keychain records rotate",
    async () => {
      const appRoot = await createTempDir("ork-electron-cursor-rotation-");
      const toolchainBinDir = await createTempDir("ork-electron-cursor-rotation-bin-");
      const worktreePath = await createTempDir("ork-electron-cursor-rotation-worktree-");
      const dataDir = await createTempDir("ork-electron-cursor-rotation-data-");
      const hostHome = await createTempDir("ork-electron-cursor-rotation-host-");
      const binDir = path.join(appRoot, "bin-stub");
      const securityArgvPath = path.join(appRoot, "security-argv.txt");
      // The stub reads the current token from a file the test rewrites, which is
      // how a host `cursor-agent login`/`logout` looks to this lookup.
      const tokenStatePath = path.join(appRoot, "host-cursor-token.txt");
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(tokenStatePath, "host-access-one");
      await fs.writeFile(
        path.join(binDir, "security"),
        `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(securityArgvPath)}
case "$*" in
  *cursor-access-token*) cat ${JSON.stringify(tokenStatePath)} ;;
  *) exit 1 ;;
esac
`,
      );
      await fs.chmod(path.join(binDir, "security"), 0o755);
      const bridgeDist = path.join(appRoot, "bridges", "acp-bridge", "dist");
      await fs.mkdir(bridgeDist, { recursive: true });
      await fs.writeFile(
        path.join(bridgeDist, "index.js"),
        `
        const http = require("node:http");
        http.createServer((req, res) => {
          res.writeHead(req.url === "/global/health" ? 200 : 404, {
            "content-type": "application/json",
          });
          res.end(JSON.stringify({ ok: true }));
        }).listen(Number(process.env.PORT), "127.0.0.1");
      `,
      );
      await fs.writeFile(path.join(toolchainBinDir, "cursor-agent"), "managed cursor");

      const environment = createEnvironment({ id: "env-cursor-rotation", worktreePath });
      const { context } = createContext(environment, { dataDir });
      context.runtimeFlavor = "agent-test";
      context.credentialSources = new Set(["cursor"]);
      context.appRoot = appRoot;
      context.resourceRoot = appRoot;
      context.toolchainBinDir = toolchainBinDir;
      const commands = createCommandRegistry();
      const authFile = path.join(
        dataDir,
        "agent-credentials",
        "provider-homes",
        "cursor",
        ".cursor",
        "auth.json",
      );
      const readAuthFile = async (): Promise<Record<string, unknown> | undefined> =>
        JSON.parse(await fs.readFile(authFile, "utf8")) as Record<string, unknown>;
      const previousPath = process.env.PATH;
      const previousHostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
      process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = hostHome;

      try {
        const started = (await commands.get("start_local_cursor_server_cmd")?.(
          { environmentId: environment.id },
          context,
        )) as { wasRunning: boolean; pid: number };
        expect(started.wasRunning).toBe(false);

        if (process.platform !== "darwin") {
          // Off darwin there is no Keychain to broker from, so the host lookup is
          // never attempted and no snapshot is ever written. Assert that rather
          // than skipping, so a regression that starts shelling out to `security`
          // on Linux is caught here.
          expect(
            await fs.access(securityArgvPath).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
          expect(
            await fs.access(authFile).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
          return;
        }

        expect(await readAuthFile()).toEqual({ accessToken: "host-access-one" });

        // An unchanged host record must reuse the live bridge rather than
        // restarting the agent on every start request.
        const unchanged = (await commands.get("start_local_cursor_server_cmd")?.(
          { environmentId: environment.id },
          context,
        )) as { wasRunning: boolean; pid: number };
        expect(unchanged.wasRunning).toBe(true);
        expect(unchanged.pid).toBe(started.pid);

        // A rotated host token is a different credential: the running bridge holds
        // the old one in its file store, so it has to be replaced.
        await fs.writeFile(tokenStatePath, "host-access-two");
        const rotated = (await commands.get("start_local_cursor_server_cmd")?.(
          { environmentId: environment.id },
          context,
        )) as { wasRunning: boolean; pid: number };
        expect(rotated.wasRunning).toBe(false);
        expect(rotated.pid).not.toBe(started.pid);
        expect(await readAuthFile()).toEqual({ accessToken: "host-access-two" });

        // A host logout revokes the snapshot and restarts the bridge signed out.
        await fs.writeFile(tokenStatePath, "");
        const loggedOut = (await commands.get("start_local_cursor_server_cmd")?.(
          { environmentId: environment.id },
          context,
        )) as { wasRunning: boolean; pid: number };
        expect(loggedOut.wasRunning).toBe(false);
        expect(
          await fs.access(authFile).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
      } finally {
        await commands.get("stop_local_cursor_server_cmd")?.(
          { environmentId: environment.id },
          context,
        );
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        if (previousHostHome === undefined) delete process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
        else process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = previousHostHome;
      }
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "drains a local Codex bridge and its descendants before deleting the environment",
    async () => {
      const appRoot = await createTempDir("ork-electron-app-delete-codex-");
      const worktreePath = await createTempDir("ork-electron-worktree-delete-codex-");
      const pidMarkerPath = path.join(appRoot, "codex-processes.json");
      const shutdownMarkerPath = path.join(appRoot, "codex-shutdown.txt");
      await writeBridgeEntrypoint(
        appRoot,
        "codex-bridge",
        `
        const fs = require("node:fs");
        const http = require("node:http");
        const { spawn } = require("node:child_process");
        const descendant = spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1_000)"],
          { stdio: "ignore" },
        );
        fs.writeFileSync(
          ${JSON.stringify(pidMarkerPath)},
          JSON.stringify({ bridgePid: process.pid, descendantPid: descendant.pid }),
        );
        const server = http.createServer((req, res) => {
          if (req.url === "/global/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          res.writeHead(404);
          res.end();
        });
        server.listen(Number(process.env.PORT), "127.0.0.1");
        process.on("SIGTERM", () => {
          fs.writeFileSync(
            ${JSON.stringify(shutdownMarkerPath)},
            String(fs.existsSync(process.env.CWD)),
          );
          server.close(() => process.exit(0));
        });
      `,
      );

      const environment = createEnvironment({ worktreePath });
      const { context } = createContext(environment);
      context.appRoot = appRoot;
      context.resourceRoot = appRoot;
      const commands = createCommandRegistry();
      const started = (await commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      )) as { port: number; pid: number };
      await waitForCondition(() => existsSync(pidMarkerPath), "Codex process marker");
      const processes = JSON.parse(await fs.readFile(pidMarkerPath, "utf8")) as {
        bridgePid: number;
        descendantPid: number;
      };

      expect(processes.bridgePid).toBe(started.pid);
      expect(isProcessRunning(processes.bridgePid)).toBe(true);
      expect(isProcessRunning(processes.descendantPid)).toBe(true);

      await commands.get("delete_environment")?.({ environmentId: environment.id }, context);

      expect(await fs.readFile(shutdownMarkerPath, "utf8")).toBe("true");
      expect(isProcessRunning(processes.bridgePid)).toBe(false);
      await waitForCondition(
        () => !isProcessRunning(processes.descendantPid),
        "Codex descendant to exit",
      );
      await expect(
        commands.get("get_environment")?.({ environmentId: environment.id }, context),
      ).resolves.toBeNull();
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "drains a start already in flight and rejects later starts once deletion begins",
    async () => {
      const appRoot = await createTempDir("ork-electron-app-start-delete-");
      const worktreePath = await createTempDir("ork-electron-worktree-start-delete-");
      const startedMarkerPath = path.join(appRoot, "bridge-started.txt");
      await writeBridgeEntrypoint(
        appRoot,
        "codex-bridge",
        `
        const fs = require("node:fs");
        const http = require("node:http");
        fs.writeFileSync(${JSON.stringify(startedMarkerPath)}, "started");
        setTimeout(() => {
          http.createServer((req, res) => {
            res.writeHead(req.url === "/global/health" ? 200 : 404);
            res.end();
          }).listen(Number(process.env.PORT), "127.0.0.1");
        }, 100);
      `,
      );
      const environment = createEnvironment({ worktreePath });
      const { context } = createContext(environment);
      context.appRoot = appRoot;
      context.resourceRoot = appRoot;
      const commands = createCommandRegistry();

      const startPromise = commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<{ pid: number }>;
      await waitForCondition(() => existsSync(startedMarkerPath), "in-flight bridge startup");
      const deletePromise = commands.get("delete_environment")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<void>;

      await expect(
        commands.get("delete_environment")?.({ environmentId: environment.id }, context),
      ).rejects.toThrow("Environment is already being deleted");
      expect(() =>
        commands.get("start_local_codex_server_cmd")?.({ environmentId: environment.id }, context),
      ).toThrow("Environment is being deleted");

      const started = await startPromise;
      await deletePromise;
      expect(isProcessRunning(started.pid)).toBe(false);
      await expect(
        commands.get("get_environment")?.({ environmentId: environment.id }, context),
      ).resolves.toBeNull();
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "persists deletion intent before closing active terminals and rejects raced terminal operations",
    async () => {
      const worktreePath = await createTempDir("ork-electron-terminal-delete-race-");
      const environment = createEnvironment({
        id: "env-terminal-delete-race",
        environmentType: "containerized",
        containerId: "container-terminal-delete-race",
        worktreePath,
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const local = terminalSessionResult(
        await commands.get("create_local_terminal_session")?.(
          {
            environmentId: environment.id,
            terminalKey: "local-tab",
            cols: 80,
            rows: 24,
          },
          context,
        ),
      );
      const container = terminalSessionResult(
        await commands.get("create_terminal_session")?.(
          {
            containerId: environment.containerId,
            environmentId: environment.id,
            terminalKey: "container-tab",
            cols: 80,
            rows: 24,
          },
          context,
        ),
      );
      await commands.get("start_local_terminal_session")?.({ sessionId: local.sessionId }, context);
      await commands.get("start_terminal_session")?.({ sessionId: container.sessionId }, context);

      const originalUpdateEnvironment = context.storage.updateEnvironment.bind(context.storage);
      let releaseDeletionMarker!: () => void;
      const deletionMarkerGate = new Promise<void>((resolve) => {
        releaseDeletionMarker = resolve;
      });
      let markerWriteStarted = false;
      context.storage.updateEnvironment = mock(async (environmentId, update) => {
        if ("deletionRequestedAt" in update) {
          markerWriteStarted = true;
          await deletionMarkerGate;
        }
        return originalUpdateEnvironment(environmentId, update);
      });

      const deletePromise = commands.get("delete_environment")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<void>;
      await waitForCondition(() => markerWriteStarted, "the deletion marker write");

      // Destructive cleanup waits for the durable marker.
      expect(ptyProcesses[0]?.kill).not.toHaveBeenCalled();
      expect(ptyProcesses[1]?.kill).not.toHaveBeenCalled();
      await expect(
        commands.get("create_local_terminal_session")?.(
          {
            environmentId: environment.id,
            terminalKey: "raced-local-tab",
            cols: 80,
            rows: 24,
          },
          context,
        ),
      ).rejects.toThrow("Environment is being deleted");
      await expect(
        commands.get("create_terminal_session")?.(
          {
            containerId: environment.containerId,
            environmentId: environment.id,
            terminalKey: "raced-container-tab",
            cols: 80,
            rows: 24,
          },
          context,
        ),
      ).rejects.toThrow("Environment is being deleted");
      await expect(
        commands.get("start_local_terminal_session")?.({ sessionId: local.sessionId }, context),
      ).rejects.toThrow("Environment is being deleted");
      await expect(
        commands.get("start_terminal_session")?.({ sessionId: container.sessionId }, context),
      ).rejects.toThrow("Environment is being deleted");

      releaseDeletionMarker();
      await deletePromise;
      expect(ptyProcesses[0]?.kill).toHaveBeenCalledTimes(1);
      expect(ptyProcesses[1]?.kill).toHaveBeenCalledTimes(1);
      expect(
        commands.get("get_terminal_output_snapshot")?.({ sessionId: local.sessionId }, context),
      ).toEqual({ output: "", revision: 0, generation: 0, truncated: false });
      expect(
        commands.get("get_terminal_output_snapshot")?.({ sessionId: container.sessionId }, context),
      ).toEqual({ output: "", revision: 0, generation: 0, truncated: false });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("leaves active terminals intact when persisting deletion intent fails", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-delete-marker-failure-");
    const environment = createEnvironment({
      id: "env-terminal-delete-marker-failure",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const session = terminalSessionResult(
      await commands.get("create_local_terminal_session")?.(
        {
          environmentId: environment.id,
          terminalKey: "surviving-tab",
          cols: 80,
          rows: 24,
        },
        context,
      ),
    );
    await commands.get("start_local_terminal_session")?.({ sessionId: session.sessionId }, context);
    const originalUpdateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    context.storage.updateEnvironment = mock(async (environmentId, update) => {
      if ("deletionRequestedAt" in update) {
        throw new Error("deletion marker storage unavailable");
      }
      return originalUpdateEnvironment(environmentId, update);
    });

    await expect(
      commands.get("delete_environment")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow("deletion marker storage unavailable");

    expect(ptyProcesses[0]?.kill).not.toHaveBeenCalled();
    expect(
      commands.get("get_terminal_session")?.({ sessionId: session.sessionId }, context),
    ).toEqual({ id: session.sessionId, running: true, bootstrapped: false });
    await expect(
      commands.get("get_environment")?.({ environmentId: environment.id }, context),
    ).resolves.toBe(environment);
    commands.get("close_local_terminal_session")?.({ sessionId: session.sessionId }, context);
  });

  test("rejects terminal create and start after deletion intent persists but deletion fails", async () => {
    const worktreePath = await createTempDir("ork-electron-terminal-durable-delete-marker-");
    const environment = createEnvironment({
      id: "env-terminal-durable-delete-marker",
      environmentType: "containerized",
      containerId: "container-durable-delete-marker",
      worktreePath,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const local = terminalSessionResult(
      await commands.get("create_local_terminal_session")?.(
        {
          environmentId: environment.id,
          terminalKey: "local-before-delete",
          cols: 80,
          rows: 24,
        },
        context,
      ),
    );
    const container = terminalSessionResult(
      await commands.get("create_terminal_session")?.(
        {
          containerId: environment.containerId,
          environmentId: environment.id,
          terminalKey: "container-before-delete",
          cols: 80,
          rows: 24,
        },
        context,
      ),
    );
    const originalUpdateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    context.storage.updateEnvironment = mock(async (environmentId, update) => {
      const updated = await originalUpdateEnvironment(environmentId, update);
      if ("deletionRequestedAt" in update) {
        // Model an acknowledged durable write whose caller subsequently sees a
        // transport/storage failure. The in-memory tombstone is cleared, but the
        // stored deletion intent must continue blocking terminal operations.
        throw new Error("deletion failed after marker persistence");
      }
      return updated;
    });

    await expect(
      commands.get("delete_environment")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow("deletion failed after marker persistence");
    expect(environment.deletionRequestedAt).toBeString();

    await expect(
      commands.get("create_local_terminal_session")?.(
        {
          environmentId: environment.id,
          terminalKey: "local-after-delete",
          cols: 80,
          rows: 24,
        },
        context,
      ),
    ).rejects.toThrow("Environment is being deleted");
    await expect(
      commands.get("create_terminal_session")?.(
        {
          containerId: environment.containerId,
          environmentId: environment.id,
          terminalKey: "container-after-delete",
          cols: 80,
          rows: 24,
        },
        context,
      ),
    ).rejects.toThrow("Environment is being deleted");
    await expect(
      commands.get("start_local_terminal_session")?.({ sessionId: local.sessionId }, context),
    ).rejects.toThrow("Environment is being deleted");
    await expect(
      commands.get("start_terminal_session")?.({ sessionId: container.sessionId }, context),
    ).rejects.toThrow("Environment is being deleted");
    expect(ptySpawn).not.toHaveBeenCalled();

    commands.get("close_local_terminal_session")?.({ sessionId: local.sessionId }, context);
    commands.get("detach_terminal")?.({ sessionId: container.sessionId }, context);
  });

  test(
    "does not spawn a local PTY after its environment is deleted during lookup",
    async () => {
      const worktreePath = await createTempDir("ork-electron-terminal-start-delete-race-");
      const environment = createEnvironment({
        id: "env-terminal-start-delete-race",
        worktreePath,
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const session = terminalSessionResult(
        await commands.get("create_local_terminal_session")?.(
          {
            environmentId: environment.id,
            terminalKey: "pending-tab",
            cols: 80,
            rows: 24,
          },
          context,
        ),
      );
      const originalGetEnvironment = context.storage.getEnvironment.bind(context.storage);
      let releaseLookup!: () => void;
      const lookupGate = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      let firstLookupStarted = false;
      context.storage.getEnvironment = mock(async (environmentId) => {
        if (!firstLookupStarted) {
          firstLookupStarted = true;
          await lookupGate;
          return environment;
        }
        return originalGetEnvironment(environmentId);
      });

      const startPromise = commands.get("start_local_terminal_session")?.(
        { sessionId: session.sessionId },
        context,
      ) as Promise<void>;
      await waitForCondition(() => firstLookupStarted, "the terminal environment lookup");
      await commands.get("delete_environment")?.({ environmentId: environment.id }, context);
      // Recreate the path to prove the final storage revalidation, not merely the
      // filesystem-existence check, prevents the stale start.
      await fs.mkdir(worktreePath, { recursive: true });
      releaseLookup();

      await expect(startPromise).rejects.toThrow("Environment is being deleted");
      expect(ptySpawn).not.toHaveBeenCalled();
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "waits for an in-flight start before global shutdown and rejects future starts",
    async () => {
      const appRoot = await createTempDir("ork-electron-app-start-shutdown-");
      const worktreePath = await createTempDir("ork-electron-worktree-start-shutdown-");
      const startedMarkerPath = path.join(appRoot, "bridge-started.txt");
      await writeBridgeEntrypoint(
        appRoot,
        "codex-bridge",
        `
        const fs = require("node:fs");
        const http = require("node:http");
        fs.writeFileSync(${JSON.stringify(startedMarkerPath)}, "started");
        setTimeout(() => {
          http.createServer((req, res) => {
            res.writeHead(req.url === "/global/health" ? 200 : 404);
            res.end();
          }).listen(Number(process.env.PORT), "127.0.0.1");
        }, 100);
      `,
      );
      const environment = createEnvironment({ worktreePath });
      const { context } = createContext(environment);
      context.appRoot = appRoot;
      context.resourceRoot = appRoot;
      const commands = createCommandRegistry();

      const startPromise = commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<{ pid: number }>;
      const queuedStartPromise = commands.get("start_local_codex_server_cmd")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<{ pid: number }>;
      await waitForCondition(() => existsSync(startedMarkerPath), "bridge startup before shutdown");
      const shutdownPromise = shutdownLocalServers();
      const started = await startPromise;
      await expect(queuedStartPromise).rejects.toThrow("Backend is shutting down");
      await shutdownPromise;

      expect(isProcessRunning(started.pid)).toBe(false);
      expect(() =>
        commands.get("start_local_codex_server_cmd")?.({ environmentId: environment.id }, context),
      ).toThrow("Backend is shutting down");
      await expect(
        commands.get("delete_environment")?.({ environmentId: environment.id }, context),
      ).rejects.toThrow("Backend is shutting down");
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("deletes an environment only after all three local server kinds exit", async () => {
    const appRoot = await createTempDir("ork-electron-app-delete-all-servers-");
    const toolchainBinDir = await createTempDir("ork-electron-tools-delete-all-servers-");
    const worktreePath = await createTempDir("ork-electron-worktree-delete-all-servers-");
    await writeBridgeServer(appRoot, "claude-bridge");
    await writeBridgeServer(appRoot, "codex-bridge");
    const opencodePath = path.join(toolchainBinDir, "opencode");
    await fs.writeFile(
      opencodePath,
      `#!/bin/sh
PORT=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--port" ]; then shift; PORT="$1"; fi
  shift
done
exec node -e 'const http=require("node:http");http.createServer((req,res)=>{res.writeHead(req.url==="/global/health"?200:404);res.end();}).listen(Number(process.env.PORT_ARG),"127.0.0.1");' \
  </dev/null
`,
    );
    // The wrapper receives the port as argv, so preserve it for the Node server.
    await fs.writeFile(
      opencodePath,
      (await fs.readFile(opencodePath, "utf8")).replace(
        "exec node",
        'export PORT_ARG="$PORT"\nexec node',
      ),
    );
    await fs.chmod(opencodePath, 0o755);

    const environment = createEnvironment({ worktreePath });
    const { context } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    context.toolchainBinDir = toolchainBinDir;
    const commands = createCommandRegistry();

    const started = (await Promise.all([
      commands.get("start_local_opencode_server_cmd")?.({ environmentId: environment.id }, context),
      commands.get("start_local_claude_server_cmd")?.({ environmentId: environment.id }, context),
      commands.get("start_local_codex_server_cmd")?.({ environmentId: environment.id }, context),
    ])) as Array<{ pid: number }>;

    await commands.get("delete_environment")?.({ environmentId: environment.id }, context);

    expect(started).toHaveLength(3);
    for (const server of started) expect(isProcessRunning(server.pid)).toBe(false);
    await expect(
      commands.get("get_environment")?.({ environmentId: environment.id }, context),
    ).resolves.toBeNull();
  });

  test("discovers and persists the Claude model catalog from the managed local runtime", async () => {
    const appRoot = await createTempDir("ork-electron-app-claude-models-");
    const toolchainBinDir = await createTempDir("ork-electron-tools-claude-models-");
    const worktreePath = await createTempDir("ork-electron-worktree-claude-models-");
    const markerPath = path.join(toolchainBinDir, "claude-cli-path.log");
    const managedClaudePath = path.join(toolchainBinDir, "claude");
    await fs.writeFile(managedClaudePath, "#!/bin/sh\nexit 0\n");
    await fs.chmod(managedClaudePath, 0o755);
    await writeBridgeServer(appRoot, "claude-bridge", markerPath, {
      models: [
        {
          id: "claude-opus-5",
          resolvedModel: "claude-opus-5-20260701",
          name: "Claude Opus 5",
          description: "Latest Opus model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "max"],
          supportsAdaptiveThinking: true,
        },
      ],
      source: "sdk",
      fetchedAt: freshFetchedAt(),
      sdkVersion: "0.2.1",
      cliVersion: "5.0.0",
    });

    const environment = createEnvironment({ worktreePath });
    let releaseHostCacheWrite: (() => void) | undefined;
    const hostCacheWrite = new Promise<void>((resolve) => {
      releaseHostCacheWrite = resolve;
    });
    const { context, updates, emitted } = createContext(environment, {
      cacheAgentModelCatalog: async () => hostCacheWrite,
    });
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    context.toolchainBinDir = toolchainBinDir;
    const commands = createCommandRegistry();

    try {
      const refresh = commands.get("get_claude_model_catalog")?.(
        { environmentId: environment.id, forceRefresh: true },
        context,
      );
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const snapshot = await Promise.race([
        refresh,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Claude model refresh waited for the host cache write")),
            2_000,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });

      expect(snapshot).toMatchObject({
        environmentId: environment.id,
        source: "sdk",
        sdkVersion: "0.2.1",
        cliVersion: "5.0.0",
        stale: false,
        models: [
          {
            id: "claude-opus-5",
            resolvedModel: "claude-opus-5-20260701",
            name: "Claude Opus 5",
            supportsAdaptiveThinking: true,
            supportedEffortLevels: ["low", "medium", "high", "max"],
          },
        ],
      });
      expect(await fs.readFile(markerPath, "utf8")).toBe(managedClaudePath);
      expect(updates).toContainEqual({ claudeModelCatalog: snapshot });
      expect(emitted).toContainEqual({
        event: "claude-model-catalog-updated",
        payload: snapshot,
      });
      expect(context.storage.cacheAgentModelCatalog).toHaveBeenCalledWith(
        "claude",
        expect.arrayContaining([expect.objectContaining({ id: "claude-opus-5" })]),
      );

      const updateCount = updates.length;
      await expect(
        commands.get("get_claude_model_catalog")?.({ environmentId: environment.id }, context),
      ).resolves.toEqual(snapshot);
      expect(updates).toHaveLength(updateCount);
    } finally {
      releaseHostCacheWrite?.();
      await commands.get("stop_local_claude_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test("does not persist bundled Claude fallback models in the host cache", async () => {
    const appRoot = await createTempDir("ork-electron-app-claude-fallback-models-");
    const worktreePath = await createTempDir("ork-electron-worktree-claude-fallback-models-");
    await writeBridgeServer(appRoot, "claude-bridge", undefined, {
      models: [{ id: "claude-sonnet-fallback", name: "Claude Sonnet Fallback" }],
      source: "fallback",
      fetchedAt: freshFetchedAt(),
    });

    const environment = createEnvironment({ worktreePath });
    const { context, updates, emitted } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    try {
      const snapshot = await commands.get("get_claude_model_catalog")?.(
        { environmentId: environment.id, forceRefresh: true },
        context,
      );

      expect(snapshot).toMatchObject({
        environmentId: environment.id,
        source: "fallback",
        stale: true,
        models: [{ id: "claude-sonnet-fallback" }],
      });
      expect(updates).toContainEqual({ claudeModelCatalog: snapshot });
      expect(emitted).toContainEqual({
        event: "claude-model-catalog-updated",
        payload: snapshot,
      });
      expect(context.storage.cacheAgentModelCatalog).not.toHaveBeenCalled();
    } finally {
      await commands.get("stop_local_claude_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
    }
  });

  test("launches managed local OpenCode without overriding inherited configuration", async () => {
    const appRoot = await createTempDir("ork-electron-app-opencode-");
    const toolchainBinDir = await createTempDir("ork-electron-tools-opencode-");
    const worktreePath = await createTempDir("ork-electron-worktree-opencode-");

    const markerPath = path.join(toolchainBinDir, "opencode-was-used.log");
    const configMarkerPath = path.join(toolchainBinDir, "opencode-config-content.json");
    const opencodeWrapperPath = path.join(toolchainBinDir, "opencode");
    await fs.writeFile(
      opencodeWrapperPath,
      `#!/bin/sh
printf 'used %s\\n' "$*" >> "${markerPath}"
printf '%s' "$OPENCODE_CONFIG_CONTENT" > "${configMarkerPath}"
PORT=""
HOST="127.0.0.1"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port)
      shift
      PORT="$1"
      ;;
    --hostname)
      shift
      HOST="$1"
      ;;
  esac
  shift
done
exec env PORT_ARG="$PORT" HOST_ARG="$HOST" node -e 'const http = require("node:http"); const port = Number(process.env.PORT_ARG); const host = process.env.HOST_ARG || "127.0.0.1"; const expected = "Basic " + Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString("base64"); http.createServer((req, res) => { if (req.headers.authorization !== expected) { res.writeHead(401); res.end(); return; } if (req.url === "/global/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return; } res.writeHead(404); res.end(); }).listen(port, host);'
`,
    );
    await fs.chmod(opencodeWrapperPath, 0o755);

    const environment = createEnvironment({ worktreePath });
    const { context, updates } = createContext(environment);
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    context.toolchainBinDir = toolchainBinDir;

    const commands = createCommandRegistry();
    const previousOpenCodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT;
    const userOpenCodeConfigContent = JSON.stringify({
      permission: { bash: "deny", external_directory: "deny" },
    });
    process.env.OPENCODE_CONFIG_CONTENT = userOpenCodeConfigContent;

    try {
      await expect(commands.get("check_opencode_cli")?.({}, context)).resolves.toBe(true);
      const result = (await commands.get("start_local_opencode_server_cmd")?.(
        { environmentId: environment.id },
        context,
      )) as {
        port: number;
        pid: number;
        wasRunning: boolean;
        authToken: string;
      };
      expect(result.wasRunning).toBe(false);
      expect(result.port).toBeGreaterThan(0);
      expect(result.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      await expect(requestOk(result.port, "/global/health")).resolves.toBe(false);
      await expect(
        requestOk(result.port, "/global/health", {
          Authorization: `Basic ${Buffer.from(`opencode:${result.authToken}`).toString("base64")}`,
        }),
      ).resolves.toBe(true);
      expect(await fs.readFile(markerPath, "utf8")).toContain("used serve --port");
      expect(await fs.readFile(configMarkerPath, "utf8")).toBe(userOpenCodeConfigContent);
      expect(updates).toContainEqual({ localOpencodePort: result.port, opencodePid: result.pid });
    } finally {
      await commands.get("stop_local_opencode_server_cmd")?.(
        { environmentId: environment.id },
        context,
      );
      if (previousOpenCodeConfigContent === undefined) {
        delete process.env.OPENCODE_CONFIG_CONTENT;
      } else {
        process.env.OPENCODE_CONFIG_CONTENT = previousOpenCodeConfigContent;
      }
    }
  });

  test(
    "cancels a tracked terminal completion retry when its environment is deleted",
    async () => {
      const worktreePath = await createTempDir("ork-electron-local-agent-delete-");
      const environment = createEnvironment({ id: "env-local-agent-delete", worktreePath });
      const { context, emitted } = createContext(environment);
      const recordCompletion = context.storage.recordEnvironmentCompletion as ReturnType<
        typeof mock
      >;
      recordCompletion.mockRejectedValueOnce(new Error("storage temporarily unavailable"));
      const notifyAgentTurnCompleted = mock(async () => undefined);
      context.notifyAgentTurnCompleted = notifyAgentTurnCompleted;
      const commands = createCommandRegistry();

      const sessionId = terminalSessionResult(
        await commands.get("create_local_terminal_session")?.(
          {
            environmentId: environment.id,
            terminalKey: "agent-tab",
            cols: 80,
            rows: 24,
            trackEnvironmentActivity: true,
          },
          context,
        ),
      ).sessionId;
      await commands.get("start_local_terminal_session")?.({ sessionId }, context);
      await commands.get("local_terminal_write")?.({ sessionId, data: "codex\r" }, context);
      ptyProcesses[0]?.emitData("done\r\n");
      await waitForCondition(
        () => recordCompletion.mock.calls.length === 1,
        "first failed completion write",
      );

      await commands.get("delete_environment")?.({ environmentId: environment.id }, context);
      await Bun.sleep(900);

      expect(recordCompletion).toHaveBeenCalledTimes(1);
      expect(notifyAgentTurnCompleted).not.toHaveBeenCalled();
      expect(
        emitted.some(
          ({ event, payload }) =>
            event === "environment-activity-recorded" &&
            (payload as { activity_kind?: string }).activity_kind === "completed",
        ),
      ).toBe(false);
    },
    ASYNC_TEST_BUDGET_MS,
  );
});
