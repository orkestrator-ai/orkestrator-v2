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

  test("routes all manifest-backed snapshot commands through their resource cursor", async () => {
    const generation = "a".repeat(32);
    const revision = "b".repeat(32);
    const rawConfig = {
      version: "1.0.0",
      global: {
        githubToken: "configured-token",
        cursorApiKey: "configured-cursor-key",
      },
      repositories: {},
    };
    const storage = {
      loadProjects: mock(async () => [{ id: "project-1" }]),
      loadConfig: mock(async () => rawConfig),
      getEnvironmentsByProject: mock(async () => []),
      getSessionsByEnvironment: mock(async () => []),
      getPaneLayout: mock(async () => null),
      listLoopedReviewWorkflows: mock(async () => []),
      listBuildPipelines: mock(async () => []),
      listPromptQueues: mock(async () => []),
      getKanbanTasks: mock(async () => []),
      getProjectNotes: mock(async () => ({ projectId: "project-1", content: "notes" })),
      getFeaturePlans: mock(async () => []),
      readConditionalResourceSnapshot: mock(
        async (
          _resource: string,
          requestedGeneration: string,
          _requestedRevision: string,
          load: () => Promise<unknown> | unknown,
        ) => ({
          status: "changed" as const,
          generation: requestedGeneration,
          revision,
          snapshot: await load(),
        }),
      ),
    };
    const context = { storage } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const cases = [
      { command: "get_projects", resource: "project", args: {}, snapshot: [{ id: "project-1" }] },
      {
        command: "get_config",
        resource: "config",
        args: {},
        snapshot: {
          version: "1.0.0",
          global: {
            githubTokenConfigured: true,
            anthropicApiKeyConfigured: false,
            anthropicApiKeySource: "none",
            cursorApiKeyConfigured: true,
            cursorApiKeySource: "config",
          },
          repositories: {},
        },
      },
      {
        command: "get_environment_snapshots",
        resource: "environment",
        args: { projectId: "project-1" },
        snapshot: [],
      },
      {
        command: "get_sessions_by_environment",
        resource: "session",
        args: { environmentId: "env-1" },
        snapshot: [],
      },
      {
        command: "get_pane_layout",
        resource: "pane-layout",
        args: { environmentId: "env-1" },
        snapshot: null,
      },
      {
        command: "list_looped_review_workflows",
        resource: "looped-review",
        args: { environmentId: "env-1" },
        snapshot: [],
      },
      {
        command: "list_build_pipelines",
        resource: "build-pipeline",
        args: { projectId: "project-1" },
        snapshot: [],
      },
      {
        command: "list_prompt_queues",
        resource: "prompt-queue",
        args: { environmentId: "env-1" },
        snapshot: [],
      },
      {
        command: "get_kanban_tasks",
        resource: "kanban",
        args: { projectId: "project-1" },
        snapshot: [],
      },
      {
        command: "get_project_notes",
        resource: "project-notes",
        args: { projectId: "project-1" },
        snapshot: { projectId: "project-1", content: "notes" },
      },
      {
        command: "get_feature_plans",
        resource: "feature-plan",
        args: { projectId: "project-1" },
        snapshot: [],
      },
    ] as const;

    for (const entry of cases) {
      storage.readConditionalResourceSnapshot.mockClear();
      await expect(
        commands.get(entry.command)?.(
          {
            ...entry.args,
            knownManifestGeneration: generation,
            knownResourceRevision: revision,
          },
          context,
        ),
      ).resolves.toEqual({
        status: "changed",
        generation,
        revision,
        snapshot: entry.snapshot,
      });
      expect(storage.readConditionalResourceSnapshot).toHaveBeenCalledWith(
        entry.resource,
        generation,
        revision,
        expect.any(Function),
      );

      storage.readConditionalResourceSnapshot.mockImplementationOnce(async () => ({
        status: "unchanged" as const,
        generation,
        revision,
      }));
      await expect(
        commands.get(entry.command)?.(
          {
            ...entry.args,
            knownManifestGeneration: generation,
            knownResourceRevision: revision,
          },
          context,
        ),
      ).resolves.toEqual({
        status: "unchanged",
        generation,
        revision,
      });
    }
  });

  test(
    "retains a failed pending rename so a later backend start can retry it",
    async () => {
      const worktreePath = await createGitRepoOnBranch("timestamp-name");
      const environment = createEnvironment({
        id: "env-pending-rename-retry",
        name: "timestamp-name",
        branch: "timestamp-name",
        environmentType: "local",
        worktreePath,
        status: "stopped",
        setupScriptsComplete: true,
        pendingRenamePrompt: "Please review the OAuth callback flow",
      });
      const { context, emitted } = createContext(environment);
      await isolateCodexBinaryLookup(context);
      const originalConsoleWarn = console.warn;
      const consoleWarnMock = mock(() => undefined);
      console.warn = consoleWarnMock as typeof console.warn;

      try {
        await withFakeCodex(
          `#!/bin/sh
printf 'codex auth required\\n' >&2
exit 1
`,
          async () => {
            const firstRegistry = createCommandRegistry();
            await firstRegistry.get("start_environment")?.(
              { environmentId: environment.id },
              context,
            );
            await waitForCondition(
              () =>
                consoleWarnMock.mock.calls.some(
                  ([message]) =>
                    message ===
                    "[ElectronBackend] Failed to rename environment from pending prompt:",
                ),
              "failed pending rename to settle",
            );
          },
        );

        expect(environment.pendingRenamePrompt).toBe("Please review the OAuth callback flow");
        expect(emitted.some(({ event }) => event === "environment-renamed")).toBe(false);

        await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
          // A fresh registry represents the backend process rebuilding its in-memory
          // task state while retaining the persisted environment snapshot.
          const restartedRegistry = createCommandRegistry();
          await restartedRegistry.get("start_environment")?.(
            { environmentId: environment.id },
            context,
          );
          await waitForCondition(
            () => emitted.some(({ event }) => event === "environment-renamed"),
            "retried pending environment rename",
          );
        });

        expect(environment.name).toBe("review-oauth-flow");
        expect(environment.pendingRenamePrompt).toBeUndefined();
      } finally {
        console.warn = originalConsoleWarn;
      }
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("projects launch-only fields only while a launch remains pending", () => {
    const environment = createEnvironment({
      pendingAgentLaunch: false,
      initialAgentModel: "launch-model",
      initialReasoningEffort: "high",
    });
    expect(toClientEnvironment(environment)).not.toHaveProperty("initialAgentModel");
    expect(toClientEnvironment(environment)).not.toHaveProperty("initialReasoningEffort");

    environment.pendingAgentLaunch = true;
    expect(toClientEnvironment(environment)).toMatchObject({
      initialAgentModel: "launch-model",
      initialReasoningEffort: "high",
    });

    environment.pendingAgentLaunch = false;
    environment.startupAgentSession = {
      tabId: "startup-agent",
      agent: "codex",
      style: "native",
      status: "starting",
      startedAt: new Date().toISOString(),
    };
    expect(toClientEnvironment(environment)).toMatchObject({
      initialAgentModel: "launch-model",
      initialReasoningEffort: "high",
    });
  });

  /**
   * The bodies stay backend-only, but the renderer still has to know whether a
   * targeted detail read is worth making — and whether failing that read should
   * block a launch. `false` must be emitted, not omitted, so a client can tell
   * "this backend says there are none" apart from "this backend cannot say".
   */
  test("always reports whether stripped attachment bodies exist", () => {
    const withAttachments = createEnvironment({
      initialPromptAttachments: [
        {
          id: "image-1",
          name: "private.png",
          base64Data: "cHJpdmF0ZQ==",
        },
      ],
    });
    expect(toClientEnvironment(withAttachments)).toMatchObject({
      hasInitialPromptAttachments: true,
    });
    expect(toClientEnvironment(withAttachments)).not.toHaveProperty("initialPromptAttachments");

    expect(toClientEnvironment(createEnvironment({})).hasInitialPromptAttachments).toBe(false);
    expect(
      toClientEnvironment(createEnvironment({ initialPromptAttachments: [] }))
        .hasInitialPromptAttachments,
    ).toBe(false);
  });

  test("injects the current managed GitHub credential into every OpenCode shell", async () => {
    const directory = await createTempDir("ork-opencode-github-plugin-");
    const credentialFile = path.join(directory, "github-token");
    const pluginFile = path.join(directory, "orkestrator-github-env.mjs");
    await fs.writeFile(
      pluginFile,
      commandTesting.buildOpenCodeGitHubEnvironmentPluginSource(credentialFile),
    );
    const pluginModule = (await import(
      `${pathToFileURL(pluginFile).href}?test=${randomUUID()}`
    )) as {
      OrkestratorGitHubEnvironmentPlugin: () => Promise<{
        "shell.env": (
          input: Record<string, string>,
          output: { env: Record<string, string> },
        ) => Promise<void>;
      }>;
    };
    const plugin = await pluginModule.OrkestratorGitHubEnvironmentPlugin();
    const readEnvironment = async (): Promise<Record<string, string>> => {
      const output = { env: {} as Record<string, string> };
      await plugin["shell.env"](
        { cwd: "/workspace", sessionID: "session", callID: "call" },
        output,
      );
      return output.env;
    };

    await fs.writeFile(credentialFile, "first-token");
    await expect(readEnvironment()).resolves.toMatchObject({
      GITHUB_TOKEN: "first-token",
      GH_TOKEN: "first-token",
    });

    await fs.writeFile(credentialFile, "rotated-token");
    await expect(readEnvironment()).resolves.toMatchObject({
      GITHUB_TOKEN: "rotated-token",
      GH_TOKEN: "rotated-token",
    });

    await fs.writeFile(credentialFile, "");
    await expect(readEnvironment()).resolves.toEqual({});
  });

  test("preserves unusual Git paths and binary stats in NUL-delimited output", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const textPaths = [
      "literal => arrow.txt",
      "brace{name}.txt",
      "tab\tname.txt",
      "line\nname.txt",
      "雪.txt",
    ];
    for (const filePath of textPaths) {
      await fs.writeFile(path.join(worktree, filePath), "base\n");
    }
    await fs.writeFile(path.join(worktree, "binary.bin"), Buffer.from([1, 0, 2]));
    await runGit(worktree, ["add", "-A"]);
    await runGit(worktree, ["commit", "-m", "add unusual paths"]);
    const base = await currentGitCommit(worktree);

    for (const filePath of textPaths) {
      await fs.writeFile(path.join(worktree, filePath), "base\nchanged\n");
    }
    await fs.writeFile(path.join(worktree, "binary.bin"), Buffer.from([3, 0, 4]));
    const changes = (await createCommandRegistry().get("get_local_git_status")?.(
      { worktreePath: worktree, targetBranch: base },
      createContext(createEnvironment()).context,
    )) as Array<{ path: string; additions: number; deletions: number }>;

    for (const filePath of textPaths) {
      expect(changes).toContainEqual(
        expect.objectContaining({
          path: filePath,
          additions: 1,
          deletions: 0,
        }),
      );
    }
    expect(changes).toContainEqual(
      expect.objectContaining({
        path: "binary.bin",
        additions: 0,
        deletions: 0,
      }),
    );
  });

  test("rejects a local HEAD that git did not report as a commit sha", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-local-bad-head",
      environmentType: "local",
      worktreePath: worktree,
      setupScriptsComplete: false,
    });
    const { context } = createContext(environment);

    await withFakeGitSubcommandOutput("rev-parse", "not-a-commit", async () => {
      await expect(commandTesting.establishCreatedFromCommit(environment, context)).rejects.toThrow(
        "Git returned an invalid HEAD commit",
      );
    });
    expect(environment.createdFromCommit).toBeUndefined();
  });

  test("returns the persisted Claude catalog as last-known-good when refresh fails", async () => {
    const worktreePath = await createTempDir("ork-electron-worktree-stale-claude-models-");
    const missingBridgeRoot = await createTempDir("ork-electron-missing-claude-models-");
    const cachedCatalog = {
      environmentId: "env-local",
      models: [{ id: "claude-opus-5", name: "Claude Opus 5" }],
      source: "sdk" as const,
      fetchedAt: new Date().toISOString(),
      stale: false,
    };
    const environment = createEnvironment({
      worktreePath,
      claudeModelCatalog: cachedCatalog,
    });
    const { context, updates } = createContext(environment);
    context.appRoot = missingBridgeRoot;
    context.resourceRoot = missingBridgeRoot;

    const snapshot = await createCommandRegistry().get("get_claude_model_catalog")?.(
      { environmentId: environment.id },
      context,
    );

    expect(snapshot).toMatchObject({
      environmentId: environment.id,
      models: cachedCatalog.models,
      source: "last-known-good",
      stale: true,
    });
    expect(snapshot).toHaveProperty("error");
    expect(updates).toContainEqual({ claudeModelCatalog: snapshot });
  });
});
