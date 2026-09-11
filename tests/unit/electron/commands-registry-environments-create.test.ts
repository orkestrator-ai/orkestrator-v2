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
  environmentBranchBase,
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

  test("rejects local environment creation before persistence when the project has no checkout", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();

    await expect(
      commands.get("create_environment")?.(
        {
          projectId: "project-1",
          name: "Cannot start locally",
          environmentType: "local",
        },
        context,
      ),
    ).rejects.toThrow("Project has no local path - cannot create a local worktree");
    await expect(context.storage.getEnvironmentsByProject("project-1")).resolves.toEqual([]);
  });

  test("creates unnamed environments with a default timestamp while storing the initial prompt", async () => {
    const { context } = createContext([], { project: LOCAL_PROJECT_FOR_CREATE });
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
exit 42
`,
      async (logPath) => {
        const result = await withFixedDate(
          "2026-04-15T12:34:56.789Z",
          async () =>
            commands.get("create_environment")?.(
              {
                projectId: "project-1",
                initialPrompt: "Please review the OAuth callback flow",
                environmentType: "local",
              },
              context,
            ) as Promise<Environment>,
        );

        expect(result.name).toBe("20260415-123456");
        expect(result.branch).toBe(environmentBranchBase(result.name, result.id));
        expect(result.initialPrompt).toBe("Please review the OAuth callback flow");
        expect(result.createdAt).toBe("2026-04-15T12:34:56.789Z");
        expect(result.lastActivityAt).toBe(result.createdAt);
        await expect(fs.readFile(logPath, "utf8")).rejects.toThrow();
      },
    );
  });

  test("creates unnamed environments from a naming prompt without running codex during create", async () => {
    const { context } = createContext([]);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
exit 42
`,
      async (logPath) => {
        const result = await withFixedDate(
          "2026-04-15T12:34:56.789Z",
          async () =>
            commands.get("create_environment")?.(
              {
                projectId: "project-1",
                namingPrompt: "Build task\n\nShip the feature\n\nAll checks green",
                environmentType: "containerized",
              },
              context,
            ) as Promise<Environment>,
        );

        expect(result.name).toBe("20260415-123456");
        expect(result.branch).toBe(environmentBranchBase(result.name, result.id));
        expect(result.initialPrompt).toBeUndefined();
        expect(result.pendingRenamePrompt).toBeUndefined();
        expect((await context.storage.getEnvironment(result.id))?.pendingRenamePrompt).toBe(
          "Build task\n\nShip the feature\n\nAll checks green",
        );
        await expect(fs.readFile(logPath, "utf8")).rejects.toThrow();
      },
    );
  });

  test("does not persist a naming prompt when an explicit environment name is provided", async () => {
    const { context } = createContext([], { project: LOCAL_PROJECT_FOR_CREATE });
    const commands = createCommandRegistry();

    const result = (await commands.get("create_environment")?.(
      {
        projectId: "project-1",
        name: "Manual Name",
        namingPrompt: "This should not replace the manual name",
        environmentType: "local",
      },
      context,
    )) as Environment;

    expect(result.name).toBe("manual-name");
    expect(result.pendingRenamePrompt).toBeUndefined();
  });

  test("persists the originating build pipeline on a created environment", async () => {
    const { context } = createContext([], { project: LOCAL_PROJECT_FOR_CREATE });
    const commands = createCommandRegistry();

    const result = (await commands.get("create_environment")?.(
      {
        projectId: "project-1",
        name: "GitHub issue build",
        environmentType: "local",
        buildPipelineId: "pipeline-github-42",
      },
      context,
    )) as Environment;

    expect(result.buildPipelineId).toBe("pipeline-github-42");
    expect((await context.storage.getEnvironment(result.id))?.buildPipelineId).toBe(
      "pipeline-github-42",
    );
  });

  test("clears a pending prompt when the user manually renames the environment", async () => {
    const environment = createEnvironment({
      environmentType: "containerized",
      worktreePath: undefined,
      status: "stopped",
      pendingRenamePrompt: "Generate a name after startup",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await commands.get("rename_environment")?.(
      { environmentId: environment.id, name: "Manual Choice" },
      context,
    );

    expect(environment.name).toBe("manual-choice");
    expect(environment.branch).toBe("manual-choice-envlocal-r1");
    expect(environment.pendingRenamePrompt).toBeUndefined();
  });

  test("manual rename keeps the live local branch aligned for PR detection", async () => {
    const worktreePath = await createGitRepoOnBranch("old-branch");
    const environment = createEnvironment({
      environmentType: "local",
      worktreePath,
      name: "old-name",
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(
      commands.get("rename_environment")?.(
        { environmentId: environment.id, name: "Manual Choice" },
        context,
      ),
    ).resolves.toMatchObject({ name: "manual-choice", branch: "manual-choice-envlocal-r1" });

    expect(await currentGitBranch(worktreePath)).toBe("manual-choice-envlocal-r1");
    expect(environment.prUrl).toBeNull();
    expect(environment.prState).toBeNull();
    expect(environment.hasMergeConflicts).toBeNull();
    expect(emitted).toContainEqual({
      event: "environment-renamed",
      payload: {
        environment_id: environment.id,
        new_name: "manual-choice",
        new_branch: "manual-choice-envlocal-r1",
      },
    });
  });

  test(
    "completes a persisted prompt rename in the backend after startup",
    async () => {
      const worktreePath = await createGitRepoOnBranch("timestamp-name");
      const environment = createEnvironment({
        id: "env-pending-rename",
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
      const commands = createCommandRegistry();

      await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
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

        // The caller does not issue a separate rename command. The backend-owned
        // task survives a renderer reload and emits the normal rehydration event.
        await waitForCondition(
          () => emitted.some(({ event }) => event === "environment-renamed"),
          "pending environment rename",
        );

        expect(environment.name).toBe("review-oauth-flow");
        expect(environment.branch).toBe("review-oauth-flow-envpendingre-r1");
        expect(environment.pendingRenamePrompt).toBeUndefined();
        expect(await currentGitBranch(worktreePath)).toBe("review-oauth-flow-envpendingre-r1");
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "reconciles a persisted rename without an environment-list hydration",
    async () => {
      const worktreePath = await createGitRepoOnBranch("timestamp-name");
      const environment = createEnvironment({
        id: "env-pending-rename-rehydrate",
        name: "timestamp-name",
        branch: "timestamp-name",
        environmentType: "local",
        worktreePath,
        status: "running",
        setupScriptsComplete: true,
        pendingRenamePrompt: "Reconcile the background session state",
      });
      const { context, emitted } = createContext(environment);
      await isolateCodexBinaryLookup(context);
      const commands = createCommandRegistry();

      await withFakeCodex(codexSlugScript("Reconcile Session State"), async () => {
        await expect(
          commands.get("reconcile_pending_environment_renames")?.({}, context),
        ).resolves.toBeUndefined();

        await waitForCondition(
          () => emitted.some(({ event }) => event === "environment-renamed"),
          "backend-reconciled pending environment rename",
        );
      });

      expect(environment.name).toBe("reconcile-session-state");
      expect(environment.pendingRenamePrompt).toBeUndefined();
      expect(await currentGitBranch(worktreePath)).toBe("reconcile-session-state-envpendingre-r1");
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "does not re-enter the lifecycle queue when setup dispatch prepares naming",
    async () => {
      const worktreePath = await createGitRepoOnBranch("20260415-123456");
      const environment = createEnvironment({
        id: "env-reentrant-first-prompt",
        name: "20260415-123456",
        branch: "20260415-123456",
        environmentType: "local",
        worktreePath,
        status: "stopped",
        setupScriptsComplete: false,
        createdFromCommit: "base-commit",
        pendingAgentLaunch: true,
      });
      const { context, emitted } = createContext(environment);
      await isolateCodexBinaryLookup(context);
      const commands = createCommandRegistry();
      context.nativeAgents = {
        reconcileInitialLaunch: async () => {
          await commands.get("prepare_environment_first_prompt")?.(
            {
              environmentId: environment.id,
              prompt: "Review the lifecycle queue",
            },
            context,
          );
        },
      } as CommandContext["nativeAgents"];

      await withFakeCodex(codexSlugScript("Review Lifecycle Queue"), async () => {
        await expect(
          commands.get("start_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toEqual(
          expect.objectContaining({
            environment: expect.objectContaining({ status: "running" }),
          }),
        );
        await waitForCondition(
          () => emitted.some(({ event }) => event === "environment-renamed"),
          "lifecycle-queued first-prompt rename",
        );
      });

      expect(environment.name).toBe("review-lifecycle-queue");
      expect(environment.pendingRenamePrompt).toBeUndefined();
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("coalesces concurrent first-prompt preparation into one rename", async () => {
    const environment = createEnvironment({
      id: "env-concurrent-first-prompt",
      name: "20260415-123456",
      branch: "20260415-123456",
      status: "running",
      worktreePath: undefined,
    });
    const { context, emitted } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(
      `#!/bin/sh
printf 'invoke\n' >> "$FAKE_CODEX_LOG"
out=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--output-last-message" ]; then out="$argument"; fi
  previous="$argument"
done
printf '%s\n' '{"slug":"Concurrent Prompt"}' > "$out"
`,
      async (logPath) => {
        await Promise.all([
          commands.get("prepare_environment_first_prompt")?.(
            { environmentId: environment.id, prompt: "The first prompt" },
            context,
          ),
          commands.get("prepare_environment_first_prompt")?.(
            { environmentId: environment.id, prompt: "The first prompt" },
            context,
          ),
        ]);
        await waitForCondition(
          () => emitted.some(({ event }) => event === "environment-renamed"),
          "coalesced environment rename",
        );
        const invocations = (await fs.readFile(logPath, "utf8")).split("\n").filter(Boolean);
        expect(invocations).toHaveLength(1);
      },
    );
  });

  test("preserves a manual rename interleaved with first-prompt preparation", async () => {
    const environment = createEnvironment({
      id: "env-manual-rename-race",
      name: "20260415-123456",
      branch: "20260415-123456",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const updateEnvironment = context.storage.updateEnvironment.bind(context.storage);
    let interleaveManualRename = true;
    context.storage.updateEnvironment = (async (environmentId, update) => {
      const updated = await updateEnvironment(environmentId, update);
      if (interleaveManualRename && update.pendingRenamePrompt !== undefined) {
        interleaveManualRename = false;
        Object.assign(environment, {
          name: "manual-choice",
          branch: "manual-choice",
          pendingRenamePrompt: undefined,
        });
      }
      return updated;
    }) as typeof context.storage.updateEnvironment;

    await expect(
      commands.get("prepare_environment_first_prompt")?.(
        { environmentId: environment.id, prompt: "Do not overwrite the manual choice" },
        context,
      ),
    ).resolves.toBeUndefined();

    expect(environment.name).toBe("manual-choice");
    expect(environment.branch).toBe("manual-choice");
    expect(environment.pendingRenamePrompt).toBeUndefined();
    expect(context.environmentLifecycleTasks.pendingCount()).toBe(0);
  });

  test("backs off failed reconciliation for 30 seconds and clears the floor after success", async () => {
    const environment = createEnvironment({
      id: "env-rename-backoff",
      name: "20260415-123456",
      branch: "20260415-123456",
      status: "running",
      worktreePath: undefined,
      pendingRenamePrompt: "Retry this prompt",
    });
    const { context } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    const now = spyOn(Date, "now").mockReturnValue(100_000);

    try {
      await withFakeCodex(
        `#!/bin/sh
printf 'invoke\n' >> "$FAKE_CODEX_LOG"
invocations="$(wc -l < "$FAKE_CODEX_LOG" | tr -d ' ')"
if [ "$invocations" = "1" ]; then
  printf 'codex auth required\n' >&2
  exit 1
fi
out=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--output-last-message" ]; then out="$argument"; fi
  previous="$argument"
done
printf '%s\n' '{"slug":"Retry Recovered"}' > "$out"
`,
        async (logPath) => {
          await commands.get("reconcile_pending_environment_renames")?.({}, context);
          expect(warn).toHaveBeenCalledTimes(1);

          now.mockReturnValue(129_999);
          await commands.get("reconcile_pending_environment_renames")?.({}, context);
          expect((await fs.readFile(logPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);

          now.mockReturnValue(130_000);
          await commands.get("reconcile_pending_environment_renames")?.({}, context);
          expect(environment.name).toBe("retry-recovered");
          expect((await fs.readFile(logPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
          expect(warn).toHaveBeenCalledTimes(1);

          Object.assign(environment, {
            name: "20260415-123456",
            branch: "20260415-123456",
            pendingRenamePrompt: "A later durable intent",
          });
          await commands.get("reconcile_pending_environment_renames")?.({}, context);
          expect((await fs.readFile(logPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(3);
          expect(environment.pendingRenamePrompt).toBeUndefined();
        },
      );
    } finally {
      now.mockRestore();
      warn.mockRestore();
    }
  });

  test("does not repeat name generation when an unreachable origin is ignored", async () => {
    const worktreePath = await createGitRepoOnBranch("timestamp-name");
    await runGit(worktreePath, ["remote", "add", "origin", "/definitely/missing/origin.git"]);
    const environment = createEnvironment({
      id: "env-offline-pending-rename",
      name: "20260415-123456",
      branch: "timestamp-name",
      status: "running",
      environmentType: "local",
      worktreePath,
      pendingRenamePrompt: "Name this while offline",
    });
    const { context } = createContext(environment, {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://example.invalid/acme/repo.git",
        localPath: worktreePath,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(
      `#!/bin/sh
printf 'invoke\n' >> "$FAKE_CODEX_LOG"
out=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "--output-last-message" ]; then out="$argument"; fi
  previous="$argument"
done
printf '%s\n' '{"slug":"Offline Rename"}' > "$out"
`,
      async (logPath) => {
        await commands.get("reconcile_pending_environment_renames")?.({}, context);
        await commands.get("reconcile_pending_environment_renames")?.({}, context);

        expect(environment.name).toBe("offline-rename");
        expect(environment.pendingRenamePrompt).toBeUndefined();
        expect((await fs.readFile(logPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
      },
    );
  });

  test("lets an explicit first prompt bypass rename retry backoff", async () => {
    const environment = createEnvironment({
      id: "env-explicit-rename-retry",
      name: "20260415-123456",
      branch: "20260415-123456",
      status: "running",
      worktreePath: undefined,
      pendingRenamePrompt: "Retry this prompt",
    });
    const { context } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await withFakeCodex(
        `#!/bin/sh
printf 'invoke\n' >> "$FAKE_CODEX_LOG"
printf 'codex auth required\n' >&2
exit 1
`,
        async (logPath) => {
          await commands.get("reconcile_pending_environment_renames")?.({}, context);
          await commands.get("prepare_environment_first_prompt")?.(
            { environmentId: environment.id, prompt: "Retry this prompt" },
            context,
          );
          await waitForCondition(
            () => warn.mock.calls.length === 2,
            "explicit first-prompt retry during backoff",
          );
          expect((await fs.readFile(logPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
        },
      );
    } finally {
      warn.mockRestore();
    }
  });

  test("keeps rename intent while stopped and reconciles it after the environment runs", async () => {
    const environment = createEnvironment({
      id: "env-stopped-rename-intent",
      name: "20260415-123456",
      branch: "20260415-123456",
      status: "stopped",
      worktreePath: undefined,
    });
    const { context, emitted } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Started Later"), async () => {
      await commands.get("prepare_environment_first_prompt")?.(
        { environmentId: environment.id, prompt: "Name this after startup" },
        context,
      );
      await waitForCondition(
        () => context.environmentLifecycleTasks.pendingCount() === 0,
        "stopped rename task to leave the lifecycle queue",
      );
      expect(environment.name).toBe("20260415-123456");
      expect(environment.pendingRenamePrompt).toBe("Name this after startup");

      environment.status = "running";
      await commands.get("reconcile_pending_environment_renames")?.({}, context);
      expect(emitted.some(({ event }) => event === "environment-renamed")).toBe(true);
    });

    expect(environment.name).toBe("started-later");
    expect(environment.pendingRenamePrompt).toBeUndefined();
  });

  test("does not throw when rename scheduling is refused during shutdown", async () => {
    const environment = createEnvironment({
      id: "env-rename-during-shutdown",
      name: "20260415-123456",
      branch: "20260415-123456",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    await context.environmentLifecycleTasks.beginShutdown();

    try {
      await expect(
        commands.get("prepare_environment_first_prompt")?.(
          { environmentId: environment.id, prompt: "Keep this intent durable" },
          context,
        ),
      ).resolves.toBeUndefined();
      await waitForCondition(
        () => warn.mock.calls.length === 1,
        "shutdown rename admission failure to be contained",
      );
      expect(environment.pendingRenamePrompt).toBe("Keep this intent durable");
    } finally {
      warn.mockRestore();
    }
  });

  test("does not run codex exec for initial-prompt-only environment naming", async () => {
    const { context } = createContext([], { project: LOCAL_PROJECT_FOR_CREATE });
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
printf 'codex auth required\\n' >&2
exit 1
`,
      async (logPath) => {
        const result = await withFixedDate(
          "2026-04-15T12:34:56.789Z",
          async () =>
            commands.get("create_environment")?.(
              {
                projectId: "project-1",
                initialPrompt: "Please review the OAuth callback flow",
                environmentType: "local",
              },
              context,
            ) as Promise<Environment>,
        );

        expect(result.name).toBe("20260415-123456");
        expect(result.branch).toBe(environmentBranchBase(result.name, result.id));
        expect(result.initialPrompt).toBe("Please review the OAuth callback flow");
        await expect(fs.readFile(logPath, "utf8")).rejects.toThrow();
      },
    );
  });

  test("falls back to the default timestamp name when an initial prompt cannot form a slug", async () => {
    const { context } = createContext([], { project: LOCAL_PROJECT_FOR_CREATE });
    const commands = createCommandRegistry();

    const result = await withFixedDate(
      "2026-04-15T12:34:56.789Z",
      async () =>
        commands.get("create_environment")?.(
          {
            projectId: "project-1",
            initialPrompt: "🔥🔥🔥",
            environmentType: "local",
          },
          context,
        ) as Promise<Environment>,
    );

    expect(result.name).toBe("20260415-123456");
    expect(result.branch).toBe(environmentBranchBase(result.name, result.id));
    expect(result.initialPrompt).toBe("🔥🔥🔥");
  });

  test("suffixes default timestamp names when another environment already uses the same timestamp", async () => {
    const existing = createEnvironment({
      id: "env-existing",
      name: "20260415-123456",
      branch: "20260415-123456",
    });
    const { context } = createContext(existing, { project: LOCAL_PROJECT_FOR_CREATE });
    const commands = createCommandRegistry();

    const result = await withFixedDate(
      "2026-04-15T12:34:56.789Z",
      async () =>
        commands.get("create_environment")?.(
          {
            projectId: "project-1",
            environmentType: "local",
          },
          context,
        ) as Promise<Environment>,
    );

    expect(result.name).toBe("20260415-123456-1");
    expect(result.branch).toBe(environmentBranchBase(result.name, result.id));
  });

  test("suffixes explicit environment names when the current project already uses the slug", async () => {
    const existing = createEnvironment({
      id: "env-existing",
      name: "custom-name",
      branch: "custom-name",
    });
    const { context } = createContext(existing, { project: LOCAL_PROJECT_FOR_CREATE });
    const commands = createCommandRegistry();

    const result = (await commands.get("create_environment")?.(
      {
        projectId: "project-1",
        name: "Custom Name",
        environmentType: "local",
      },
      context,
    )) as Environment;

    expect(result.name).toBe("custom-name-1");
    expect(result.branch).toBe(environmentBranchBase(result.name, result.id));
  });

  test("keeps an explicit display name friendly when only a Git branch uses its slug", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["branch", "custom-name"]);
    const { context } = createContext([], {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://github.com/acme/repo.git",
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();

    const result = (await commands.get("create_environment")?.(
      {
        projectId: "project-1",
        name: "Custom Name",
        environmentType: "local",
      },
      context,
    )) as Environment;

    expect(result.name).toBe("custom-name");
    expect(result.branch).toBe(environmentBranchBase(result.name, result.id));
  });

  test("suffixes a container branch when the live remote reserves its generated base", async () => {
    const { context } = createContext([], {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://example.invalid/acme/repo.git",
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();
    let result: Environment | undefined;

    await withGitArgumentStub(
      `  *"ls-remote --heads "*)
    pattern=""
    for argument in "$@"; do pattern="$argument"; done
    ref="\${pattern%\\*}"
    printf '%040d\\t%s\\n' 0 "$ref"
    exit 0 ;;`,
      async () => {
        result = (await commands.get("create_environment")?.(
          {
            projectId: "project-1",
            name: "Container Remote Collision",
            environmentType: "containerized",
          },
          context,
        )) as Environment;
      },
    );

    expect(result).toBeDefined();
    expect(result!.branch).toBe(`${environmentBranchBase(result!.name, result!.id)}-1`);
  });

  test("builds distinct namespaces beyond a shared eight-character id prefix", () => {
    expect(environmentBranchBase("feature", "env-abcde-1111")).not.toBe(
      environmentBranchBase("feature", "env-abcde-2222"),
    );
    expect(environmentBranchBase("Feature", "A-B")).toBe("feature-ab");
    expect(() => environmentBranchBase("feature", "---")).toThrow("cannot form a branch namespace");
    expect(() => environmentBranchBase("feature", "valid", -1)).toThrow(
      "must be a non-negative integer",
    );
  });

  test("renames environments from prompts using codex exec output", async () => {
    const environment = createEnvironment({
      environmentType: "containerized",
      worktreePath: undefined,
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context, emitted } = createContext(environment);
    const appRoot = await createTempDir("ork-electron-codex-app-");
    context.appRoot = appRoot;
    context.resourceRoot = appRoot;
    const commands = createCommandRegistry();

    await withFakeCodex(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_CODEX_LOG"
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then
    out="$arg"
  fi
  prev="$arg"
done
[ -n "$out" ] || exit 2
printf '%s\\n' '{"slug":"Review OAuth Flow"}' > "$out"
`,
      async (logPath) => {
        await expect(
          commands.get("rename_environment_from_prompt")?.(
            { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
            context,
          ),
        ).resolves.toBeUndefined();

        expect(environment.name).toBe("review-oauth-flow");
        expect(environment.branch).toBe("review-oauth-flow-envlocal-r1");
        expect(environment.prUrl).toBeNull();
        expect(environment.prState).toBeNull();
        expect(environment.hasMergeConflicts).toBeNull();
        expect(emitted).toContainEqual({
          event: "environment-renamed",
          payload: {
            environment_id: environment.id,
            new_name: "review-oauth-flow",
            new_branch: "review-oauth-flow-envlocal-r1",
          },
        });

        const codexLog = await fs.readFile(logPath, "utf8");
        expect(codexLog).toContain(
          '--model gpt-5.6-luna --config model_reasoning_effort="medium" --sandbox read-only',
        );
        expect(codexLog).toContain(
          "exec --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules",
        );
        expect(codexLog).toContain("--output-last-message");
        expect(codexLog).not.toContain("claude");
      },
    );
  });

  test("suffixes prompt-renamed environments when another environment already uses the generated slug", async () => {
    const environment = createEnvironment({
      id: "env-new",
      name: "20260415-123456",
      branch: "20260415-123456",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
    });
    const existing = createEnvironment({
      id: "env-existing",
      name: "review-oauth-flow",
      branch: "review-oauth-flow",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
    });
    const { context, emitted } = createContext([environment, existing]);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await expect(
        commands.get("rename_environment_from_prompt")?.(
          { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
          context,
        ),
      ).resolves.toBeUndefined();

      expect(environment.name).toBe("review-oauth-flow-1");
      expect(environment.branch).toBe("review-oauth-flow-1-envnew-r1");
      expect(existing.name).toBe("review-oauth-flow");
      expect(existing.branch).toBe("review-oauth-flow");
      expect(emitted).toContainEqual({
        event: "environment-renamed",
        payload: {
          environment_id: environment.id,
          new_name: "review-oauth-flow-1",
          new_branch: "review-oauth-flow-1-envnew-r1",
        },
      });
    });
  });

  test("suffixes prompt-renamed local environments when the project already has the generated branch", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["branch", "review-oauth-flow-envnew-r1"]);
    const environment = createEnvironment({
      id: "env-new",
      name: "20260415-123456",
      branch: "20260415-123456",
      environmentType: "local",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
    });
    const { context } = createContext(environment, {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://github.com/acme/repo.git",
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await expect(
        commands.get("rename_environment_from_prompt")?.(
          { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
          context,
        ),
      ).resolves.toBeUndefined();

      expect(environment.name).toBe("review-oauth-flow");
      expect(environment.branch).toBe("review-oauth-flow-envnew-r1-1");
    });
  });

  test("suffixes a generated rename when only the live remote has the namespaced branch", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-remote-only",
      name: "20260415-123456",
      branch: "20260415-123456",
      environmentType: "local",
      worktreePath: undefined,
      status: "stopped",
    });
    const proposedBranch = environmentBranchBase("review-oauth-flow", environment.id, 1);
    await runGit(worktree, ["push", "origin", `main:refs/heads/${proposedBranch}`]);
    // Prove the collision is not visible through local or remote-tracking refs.
    await runGit(worktree, ["update-ref", "-d", `refs/remotes/origin/${proposedBranch}`]);
    expect(await gitOutput(worktree, ["branch", "-a", "--list", `*${proposedBranch}*`])).toBe("");

    const { context } = createContext(environment, {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://github.com/acme/repo.git",
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
        context,
      );
    });

    expect(environment.name).toBe("review-oauth-flow");
    expect(environment.branch).toBe(`${proposedBranch}-1`);
  });

  test("treats a stale remote-tracking ref as reserved during generated rename", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-stale-ref",
      name: "20260415-123456",
      branch: "20260415-123456",
      environmentType: "local",
      worktreePath: undefined,
      status: "stopped",
    });
    const proposedBranch = environmentBranchBase("review-oauth-flow", environment.id, 1);
    await runGit(worktree, ["update-ref", `refs/remotes/origin/${proposedBranch}`, "HEAD"]);

    const { context } = createContext(environment, {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://github.com/acme/repo.git",
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
        context,
      );
    });

    expect(environment.name).toBe("review-oauth-flow");
    expect(environment.branch).toBe(`${proposedBranch}-1`);
  });

  test("does not reuse a deleted historical PR head slug for a generated rename", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-after-merged-pr",
      name: "20260906-120040",
      branch: "20260906-120040",
      environmentType: "local",
      worktreePath: undefined,
      status: "stopped",
    });
    const { context } = createContext(environment, {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://github.com/acme/repo.git",
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    // `fix-flaky-tests` is intentionally absent from every ref, matching a merged
    // PR whose remote head was deleted but whose name remains in GitHub history.
    await withFakeCodex(codexSlugScript("Fix Flaky Tests"), async () => {
      await commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "Fix the flaky tests" },
        context,
      );
    });

    expect(environment.name).toBe("fix-flaky-tests");
    expect(environment.branch).toBe("fix-flaky-tests-envaftermerg-r1");
    expect(environment.branch).not.toBe(environment.name);
  });

  test("does not reuse a namespaced historical PR head after an A to B to A rename", async () => {
    const environment = createEnvironment({
      id: "env-repeat-name",
      name: "alpha",
      branch: environmentBranchBase("alpha", "env-repeat-name"),
      environmentType: "containerized",
      worktreePath: undefined,
      status: "stopped",
    });
    const firstAlphaBranch = environment.branch;
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await commands.get("rename_environment")?.(
      { environmentId: environment.id, name: "Beta" },
      context,
    );
    expect(environment.branch).toBe(environmentBranchBase("beta", environment.id, 1));
    expect(environment.branchRevision).toBe(1);

    await commands.get("rename_environment")?.(
      { environmentId: environment.id, name: "Alpha" },
      context,
    );
    expect(environment.branch).toBe(environmentBranchBase("alpha", environment.id, 2));
    expect(environment.branch).not.toBe(firstAlphaBranch);
    expect(environment.branchRevision).toBe(2);
  });

  test("checks a container-only project's live remote during manual rename", async () => {
    const { remote, worktree } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-container-remote",
      name: "old-name",
      branch: "old-branch",
      environmentType: "containerized",
      worktreePath: undefined,
      status: "stopped",
    });
    const proposedBranch = environmentBranchBase("manual-choice", environment.id, 1);
    await runGit(worktree, ["push", "origin", `main:refs/heads/${proposedBranch}`]);
    const { context } = createContext(environment, {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: remote,
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();

    await commands.get("rename_environment")?.(
      { environmentId: environment.id, name: "Manual Choice" },
      context,
    );

    expect(environment.branch).toBe(`${proposedBranch}-1`);
    expect(environment.branchRevision).toBe(1);
  });

  test("checks a container-only project's live remote during generated rename", async () => {
    const { remote, worktree } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-container-generated-remote",
      name: "20260415-123456",
      branch: "20260415-123456",
      environmentType: "containerized",
      worktreePath: undefined,
      status: "stopped",
    });
    const proposedBranch = environmentBranchBase("review-oauth-flow", environment.id, 1);
    await runGit(worktree, ["push", "origin", `main:refs/heads/${proposedBranch}`]);
    const { context } = createContext(environment, {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: remote,
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "Review the OAuth callback" },
        context,
      );
    });

    expect(environment.branch).toBe(`${proposedBranch}-1`);
    expect(environment.branchRevision).toBe(1);
  });

  test("uses one remote lookup while suffixing several occupied candidates", async () => {
    const environment = createEnvironment({
      id: "env-single-remote-probe",
      name: "old-name",
      branch: "old-branch",
      environmentType: "containerized",
      worktreePath: undefined,
      status: "stopped",
    });
    const proposedBranch = environmentBranchBase("manual-choice", environment.id, 1);
    const { context } = createContext(environment, {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://example.invalid/acme/repo.git",
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();
    const logPath = path.join(await createTempDir("ork-branch-lookup-"), "lookups.log");
    const previousLogPath = process.env.FAKE_BRANCH_LOOKUP_LOG;
    process.env.FAKE_BRANCH_LOOKUP_LOG = logPath;

    try {
      await withGitArgumentStub(
        `  *"ls-remote --heads "*)
    printf 'lookup\\n' >> "$FAKE_BRANCH_LOOKUP_LOG"
    pattern=""
    for argument in "$@"; do pattern="$argument"; done
    ref="\${pattern%\\*}"
    printf '%040d\\t%s\\n' 0 "$ref"
    printf '%040d\\t%s-1\\n' 0 "$ref"
    exit 0 ;;`,
        async () => {
          await commands.get("rename_environment")?.(
            { environmentId: environment.id, name: "Manual Choice" },
            context,
          );
        },
      );
    } finally {
      if (previousLogPath === undefined) delete process.env.FAKE_BRANCH_LOOKUP_LOG;
      else process.env.FAKE_BRANCH_LOOKUP_LOG = previousLogPath;
    }

    expect(environment.branch).toBe(`${proposedBranch}-2`);
    expect((await fs.readFile(logPath, "utf8")).trim().split("\n")).toHaveLength(1);
  });

  test("manual rename uses the same live-remote collision allocator", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-manual-remote",
      name: "main",
      branch: "main",
      environmentType: "local",
      worktreePath: worktree,
      status: "running",
    });
    const proposedBranch = environmentBranchBase("manual-choice", environment.id, 1);
    await runGit(worktree, ["push", "origin", `main:refs/heads/${proposedBranch}`]);
    await runGit(worktree, ["update-ref", "-d", `refs/remotes/origin/${proposedBranch}`]);
    const { context } = createContext(environment, {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://github.com/acme/repo.git",
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();

    await commands.get("rename_environment")?.(
      { environmentId: environment.id, name: "Manual Choice" },
      context,
    );

    expect(environment.name).toBe("manual-choice");
    expect(environment.branch).toBe(`${proposedBranch}-1`);
    expect(await currentGitBranch(worktree)).toBe(`${proposedBranch}-1`);
  });

  test("renames promptly when the configured origin is unreachable", async () => {
    const worktreePath = await createGitRepoOnBranch("old-branch");
    await runGit(worktreePath, ["remote", "add", "origin", "/definitely/missing/origin.git"]);
    const environment = createEnvironment({
      id: "env-remote-failure",
      name: "old-name",
      branch: "old-branch",
      environmentType: "local",
      worktreePath,
      status: "running",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
    });
    const { context, updates } = createContext(environment, {
      project: {
        id: "project-1",
        name: "repo",
        gitUrl: "https://github.com/acme/repo.git",
        localPath: worktreePath,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();

    await expect(
      commands.get("rename_environment")?.(
        { environmentId: environment.id, name: "Manual Choice" },
        context,
      ),
    ).resolves.toMatchObject({
      name: "manual-choice",
      branch: environmentBranchBase("manual-choice", environment.id, 1),
    });

    expect(environment.prUrl).toBeNull();
    expect(await currentGitBranch(worktreePath)).toBe(
      environmentBranchBase("manual-choice", environment.id, 1),
    );
    expect(updates).toHaveLength(1);
  });

  test(
    "renames the live local git branch and advances stored branch on success",
    async () => {
      const worktreePath = await createGitRepoOnBranch("old-branch");
      await runGit(worktreePath, ["config", "branch.old-branch.remote", "origin"]);
      await runGit(worktreePath, ["config", "branch.old-branch.merge", "refs/heads/old-branch"]);
      const environment = createEnvironment({
        environmentType: "local",
        worktreePath,
        branch: "old-branch",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open",
        hasMergeConflicts: true,
      });
      const { context, emitted } = createContext(environment);
      await isolateCodexBinaryLookup(context);
      const commands = createCommandRegistry();

      await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
        await expect(
          commands.get("rename_environment_from_prompt")?.(
            { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
            context,
          ),
        ).resolves.toBeUndefined();

        expect(environment.name).toBe("review-oauth-flow");
        expect(environment.branch).toBe("review-oauth-flow-envlocal-r1");
        expect(environment.prUrl).toBeNull();
        expect(environment.prState).toBeNull();
        expect(environment.hasMergeConflicts).toBeNull();
        expect(await currentGitBranch(worktreePath)).toBe("review-oauth-flow-envlocal-r1");
        await expect(configuredGitPushBehaviour(worktreePath)).resolves.toEqual({
          pushDefault: "current",
          autoSetupRemote: "true",
        });
        // The upstream `git branch -m` carried over from the old name would make the
        // renamed branch compare and pull against origin/old-branch, so it is dropped
        // and the next push records the right one.
        await expect(
          configuredGitUpstream(worktreePath, "review-oauth-flow-envlocal-r1"),
        ).resolves.toEqual({ remote: "", merge: "" });
        expect(emitted).toContainEqual({
          event: "environment-renamed",
          payload: {
            environment_id: environment.id,
            new_name: "review-oauth-flow",
            new_branch: "review-oauth-flow-envlocal-r1",
          },
        });
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "rolls back a local rename when push configuration fails",
    async () => {
      const worktreePath = await createGitRepoOnBranch("old-branch");
      await runGit(worktreePath, ["config", "branch.old-branch.remote", "origin"]);
      await runGit(worktreePath, ["config", "branch.old-branch.merge", "refs/heads/old-branch"]);
      const environment = createEnvironment({
        environmentType: "local",
        worktreePath,
        branch: "old-branch",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open",
        hasMergeConflicts: true,
      });
      const { context } = createContext(environment);
      await isolateCodexBinaryLookup(context);
      const commands = createCommandRegistry();

      await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
        await withFailingGitSubcommand("config", async () => {
          await expect(
            commands.get("rename_environment_from_prompt")?.(
              { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
              context,
            ),
          ).resolves.toBeUndefined();
        });
      });

      expect(await currentGitBranch(worktreePath)).toBe("old-branch");
      expect(environment.branch).toBe("old-branch");
      expect(environment.prUrl).toBe("https://github.com/acme/repo/pull/1");
      expect(environment.prState).toBe("open");
      expect(environment.hasMergeConflicts).toBe(true);
      // The rename moved this config to the new name and the rollback has to bring it
      // back, or the restored branch would be left comparing against nothing.
      await expect(configuredGitUpstream(worktreePath, "old-branch")).resolves.toEqual({
        remote: "origin",
        merge: "refs/heads/old-branch",
      });
      await expect(
        configuredGitUpstream(worktreePath, "review-oauth-flow-envlocal-r1"),
      ).resolves.toEqual({ remote: "", merge: "" });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "advances the stored branch when a local rollback fails and the new branch is the only one left",
    async () => {
      const worktreePath = await createGitRepoOnBranch("old-branch");
      const environment = createEnvironment({
        environmentType: "local",
        worktreePath,
        branch: "old-branch",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open",
        hasMergeConflicts: true,
      });
      const { context } = createContext(environment);
      await isolateCodexBinaryLookup(context);
      const commands = createCommandRegistry();

      await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
        await withGitArgumentStub(
          `  *" config --worktree push.default "*) echo "forced config failure" >&2; exit 42 ;;
  *" branch -m -- review-oauth-flow-envlocal-r1 old-branch"*) echo "forced rollback failure" >&2; exit 42 ;;`,
          async () => {
            await expect(
              commands.get("rename_environment_from_prompt")?.(
                { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
                context,
              ),
            ).resolves.toBeUndefined();
          },
        );
      });

      // The rollback never ran, so git really is on the new branch and storage has to
      // follow it.
      expect(await currentGitBranch(worktreePath)).toBe("review-oauth-flow-envlocal-r1");
      expect(environment.branch).toBe("review-oauth-flow-envlocal-r1");
      expect(environment.prUrl).toBeNull();
      expect(environment.prState).toBeNull();
      expect(environment.hasMergeConflicts).toBeNull();
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("keeps the stored branch when a local rollback took effect but reported failure", async () => {
    const worktreePath = await createGitRepoOnBranch("old-branch");
    await runGit(worktreePath, ["config", "branch.old-branch.remote", "origin"]);
    await runGit(worktreePath, ["config", "branch.old-branch.merge", "refs/heads/old-branch"]);
    // A detached HEAD is what makes `git branch --show-current` useless here: it
    // reports an empty string whichever of the two branch names actually exists.
    await runGit(worktreePath, ["checkout", "--detach"]);
    const environment = createEnvironment({
      environmentType: "local",
      worktreePath,
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await withGitArgumentStub(
        `  *" config --worktree push.default "*) echo "forced config failure" >&2; exit 42 ;;
  *" branch -m -- review-oauth-flow-envlocal-r1 old-branch"*) real_git "$@"; echo "forced timeout" >&2; exit 42 ;;`,
        async () => {
          await expect(
            commands.get("rename_environment_from_prompt")?.(
              { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
              context,
            ),
          ).resolves.toBeUndefined();
        },
      );
    });

    // The rollback did land, so the stored branch and its PR metadata must survive.
    expect(
      await gitOutput(worktreePath, [
        "branch",
        "--list",
        "old-branch",
        "--format=%(refname:short)",
      ]),
    ).toBe("old-branch");
    expect(
      await gitOutput(worktreePath, ["branch", "--list", "review-oauth-flow-envlocal-r1"]),
    ).toBe("");
    expect(environment.branch).toBe("old-branch");
    expect(environment.prUrl).toBe("https://github.com/acme/repo/pull/1");
    expect(environment.prState).toBe("open");
    expect(environment.hasMergeConflicts).toBe(true);
  });

  test("renames the running container git branch and advances stored branch", async () => {
    const environment = createEnvironment({
      id: "env-container-rename",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
      pendingAgentLaunch: true,
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
fi
exit 0
`,
        async (logs) => {
          await expect(
            commands.get("rename_environment_from_prompt")?.(
              { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
              context,
            ),
          ).resolves.toBeUndefined();

          expect(environment.name).toBe("review-oauth-flow");
          expect(environment.branch).toBe("review-oauth-flow-envcontainer-r1");
          expect(environment.prUrl).toBeNull();

          const execLog = await fs.readFile(logs.exec, "utf8");
          expect(execLog).toContain(
            "git -C /workspace branch -m -- 'old-branch' 'review-oauth-flow-envcontainer-r1'",
          );
          expect(execLog).toContain("git -C /workspace config --local push.default current");
          expect(execLog).toContain("git -C /workspace config --local push.autoSetupRemote true");
          // The upstream the rename carried over from the old name has to go, or the
          // renamed branch keeps comparing itself against origin/old-branch.
          expect(execLog).toContain(
            "git -C /workspace config --local --unset-all 'branch.review-oauth-flow-envcontainer-r1.merge'",
          );
          expect(execLog).toContain(
            "git -C /workspace config --local --unset-all 'branch.review-oauth-flow-envcontainer-r1.remote'",
          );
          // Nothing may pre-create an upstream for a branch that has never been pushed.
          expect(execLog).not.toContain(
            "config --local 'branch.review-oauth-flow-envcontainer-r1.merge' 'refs/heads/review-oauth-flow-envcontainer-r1'",
          );
        },
      );
    });
  });

  test("rolls back a container rename when push configuration fails", async () => {
    const environment = createEnvironment({
      id: "env-container-rename-config-failure",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  case "$*" in
    *" config --local "*) exit 42 ;;
  esac
fi
exit 0
`,
        async (logs) => {
          await expect(
            commands.get("rename_environment_from_prompt")?.(
              { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
              context,
            ),
          ).resolves.toBeUndefined();

          expect(environment.branch).toBe("old-branch");
          expect(environment.prUrl).toBe("https://github.com/acme/repo/pull/1");
          expect(environment.prState).toBe("open");
          expect(environment.hasMergeConflicts).toBe(true);

          const execCalls = (await fs.readFile(logs.exec, "utf8")).trim().split("\n");
          expect(execCalls).toHaveLength(3);
          expect(execCalls[0]).toContain(
            "git -C /workspace branch -m -- 'old-branch' 'review-oauth-flow-envcontainer-r1'",
          );
          expect(execCalls[1]).toContain("git -C /workspace config --local push.default current");
          expect(execCalls[2]).toContain(
            "git -C /workspace branch -m -- 'review-oauth-flow-envcontainer-r1' 'old-branch'",
          );
        },
      );
    });
  });

  test("advances storage after push configuration and container rollback both fail", async () => {
    const environment = createEnvironment({
      id: "env-container-rename-rollback-failure",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      // Only the new branch resolves, so the rename is the state that survived.
      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  case "$*" in
    *"rev-parse --verify --quiet 'refs/heads/review-oauth-flow-envcontainer-r1'"*)
      printf '%s' '${commandTesting.BRANCH_REF_EXISTS_SENTINEL}'; exit 0 ;;
    *"rev-parse --verify --quiet 'refs/heads/old-branch'"*) exit 0 ;;
    *" config --local "*) exit 42 ;;
    *"branch -m -- 'review-oauth-flow-envcontainer-r1' 'old-branch'"*) exit 43 ;;
  esac
fi
exit 0
`,
        async (logs) => {
          await expect(
            commands.get("rename_environment_from_prompt")?.(
              { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
              context,
            ),
          ).resolves.toBeUndefined();

          expect(environment.branch).toBe("review-oauth-flow-envcontainer-r1");
          expect(environment.prUrl).toBeNull();
          expect(environment.prState).toBeNull();
          expect(environment.hasMergeConflicts).toBeNull();

          const execCalls = (await fs.readFile(logs.exec, "utf8")).trim().split("\n");
          expect(execCalls).toHaveLength(5);
          expect(execCalls[2]).toContain(
            "git -C /workspace branch -m -- 'review-oauth-flow-envcontainer-r1' 'old-branch'",
          );
          expect(execCalls[3]).toContain(
            "rev-parse --verify --quiet 'refs/heads/review-oauth-flow-envcontainer-r1'",
          );
          expect(execCalls[4]).toContain("rev-parse --verify --quiet 'refs/heads/old-branch'");
        },
      );
    });
  });

  test("keeps the stored branch when a container rollback outcome cannot be established", async () => {
    const environment = createEnvironment({
      id: "env-container-rename-rollback-unverifiable",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      // Both names resolve, so the rollback may well have landed; clearing the PR
      // metadata on that guess is not recoverable, and keeping the branch is.
      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  case "$*" in
    *"rev-parse --verify --quiet "*)
      printf '%s' '${commandTesting.BRANCH_REF_EXISTS_SENTINEL}'; exit 0 ;;
    *" config --local "*) exit 42 ;;
    *"branch -m -- 'review-oauth-flow-envcontainer-r1' 'old-branch'"*) exit 43 ;;
  esac
fi
exit 0
`,
        async () => {
          await expect(
            commands.get("rename_environment_from_prompt")?.(
              { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
              context,
            ),
          ).resolves.toBeUndefined();

          expect(environment.name).toBe("review-oauth-flow");
          expect(environment.branch).toBe("old-branch");
          expect(environment.prUrl).toBe("https://github.com/acme/repo/pull/1");
          expect(environment.prState).toBe("open");
          expect(environment.hasMergeConflicts).toBe(true);
        },
      );
    });
  });

  test("keeps the stored branch when a container rollback fails and the container is unreachable", async () => {
    const environment = createEnvironment({
      id: "env-container-rename-rollback-unreachable",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  case "$*" in
    *"rev-parse --verify --quiet "*) echo "container is gone" >&2; exit 44 ;;
    *" config --local "*) exit 42 ;;
    *"branch -m -- 'review-oauth-flow-envcontainer-r1' 'old-branch'"*) exit 43 ;;
  esac
fi
exit 0
`,
        async () => {
          await expect(
            commands.get("rename_environment_from_prompt")?.(
              { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
              context,
            ),
          ).resolves.toBeUndefined();

          expect(environment.branch).toBe("old-branch");
          expect(environment.prUrl).toBe("https://github.com/acme/repo/pull/1");
        },
      );
    });
  });

  test("keeps stored branch and PR metadata when the live git branch rename fails", async () => {
    // worktreePath is a plain directory (not a git repo) so `git branch -m` fails.
    const worktreePath = await createTempDir("ork-electron-rename-nonrepo-");
    const environment = createEnvironment({
      environmentType: "local",
      worktreePath,
      branch: "old-branch",
      prUrl: "https://github.com/acme/repo/pull/1",
      prState: "open",
      hasMergeConflicts: true,
    });
    const { context, emitted, updates } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("Review OAuth Flow"), async () => {
      await expect(
        commands.get("rename_environment_from_prompt")?.(
          { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
          context,
        ),
      ).resolves.toBeUndefined();

      // Display name advances, but the branch and PR metadata stay put (no divergence).
      expect(environment.name).toBe("review-oauth-flow");
      expect(environment.branch).toBe("old-branch");
      expect(environment.prUrl).toBe("https://github.com/acme/repo/pull/1");
      expect(environment.prState).toBe("open");
      expect(environment.hasMergeConflicts).toBe(true);
      expect(updates).toEqual([{ name: "review-oauth-flow" }]);
      expect(emitted).toContainEqual({
        event: "environment-renamed",
        payload: {
          environment_id: environment.id,
          new_name: "review-oauth-flow",
          new_branch: "old-branch",
        },
      });
    });
  });

  test("rejects renaming from an empty prompt without touching storage", async () => {
    const environment = createEnvironment({ environmentType: "local", worktreePath: undefined });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(
      commands.get("rename_environment_from_prompt")?.(
        { environmentId: environment.id, prompt: "   " },
        context,
      ),
    ).rejects.toThrow("Prompt cannot be empty");
    expect(updates).toHaveLength(0);
  });

  test("surfaces codex failures during rename", async () => {
    const environment = createEnvironment({ environmentType: "local", worktreePath: undefined });
    const { context, updates } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(
      `#!/bin/sh
printf 'codex auth required\\n' >&2
exit 1
`,
      async () => {
        await expect(
          commands.get("rename_environment_from_prompt")?.(
            { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
            context,
          ),
        ).rejects.toThrow("codex auth required");
        expect(updates).toHaveLength(0);
      },
    );
  });

  test("rejects when codex output has no extractable slug", async () => {
    const environment = createEnvironment({ environmentType: "local", worktreePath: undefined });
    const { context, updates } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(
      `#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--output-last-message" ]; then out="$arg"; fi
  prev="$arg"
done
[ -n "$out" ] || exit 2
printf '%s\\n' '{}' > "$out"
`,
      async () => {
        await expect(
          commands.get("rename_environment_from_prompt")?.(
            { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
            context,
          ),
        ).rejects.toThrow("Could not extract slug");
        expect(updates).toHaveLength(0);
      },
    );
  });

  test("rejects when codex slug sanitizes to an empty name", async () => {
    const environment = createEnvironment({ environmentType: "local", worktreePath: undefined });
    const { context, updates } = createContext(environment);
    await isolateCodexBinaryLookup(context);
    const commands = createCommandRegistry();

    await withFakeCodex(codexSlugScript("###"), async () => {
      await expect(
        commands.get("rename_environment_from_prompt")?.(
          { environmentId: environment.id, prompt: "Please review the OAuth callback flow" },
          context,
        ),
      ).rejects.toThrow("Generated name is empty");
      expect(updates).toHaveLength(0);
    });
  });

  test("keeps running local environments running during status sync", async () => {
    const environment = createEnvironment({
      status: "running",
      containerId: null,
      environmentType: "local",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(
      commands.get("get_environment_status")?.({ environmentId: environment.id }, context),
    ).resolves.toBe("running");
    await expect(
      commands.get("get_environments")?.({ projectId: environment.projectId }, context),
    ).resolves.toEqual([toClientEnvironment(environment)]);
    expect(updates).toHaveLength(0);
  });

  test("returns read-only environment snapshots without invoking Docker reconciliation", async () => {
    const environment = createEnvironment({
      status: "running",
      containerId: "container-existing",
      environmentType: "containerized",
      opencodePid: 40,
      claudeBridgePid: 41,
      codexBridgePid: 42,
      cursorBridgePid: 43,
      grokBridgePid: 44,
      piBridgePid: 45,
      tabTeardownIntents: {
        "tab-1": {
          tabId: "tab-1",
          kind: "pi-native",
          sessionId: "session-1",
          createdAt: new Date().toISOString(),
        },
      },
      claudeModelCatalog: {
        environmentId: "env-1",
        models: [],
        source: "sdk",
        fetchedAt: new Date().toISOString(),
        stale: false,
      },
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
      pendingRenamePrompt: "private launch instruction",
      prRecheckAfterAgentCompletionArmedAt: new Date().toISOString(),
      pendingAgentLaunch: false,
      initialAgentModel: "launch-only-model",
      initialReasoningEffort: "high",
      initialPromptAttachments: [
        {
          id: "image-1",
          name: "private.png",
          base64Data: "cHJpdmF0ZQ==",
        },
      ],
      branchRevision: 7,
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    const snapshots = (await commands.get("get_environment_snapshots")?.(
      { projectId: environment.projectId },
      context,
    )) as Array<Record<string, unknown>>;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      id: environment.id,
      projectId: environment.projectId,
      status: "running",
    });
    // Every key `ClientEnvironment` omits. TypeScript cannot enforce this —
    // excess-property checking does not apply to the spread `toClientEnvironment`
    // returns — so a backend-only field left in the projection reaches clients
    // silently, and this list is the only thing that catches it.
    for (const field of [
      "opencodePid",
      "claudeBridgePid",
      "codexBridgePid",
      "cursorBridgePid",
      "grokBridgePid",
      "piBridgePid",
      "tabTeardownIntents",
      "claudeModelCatalog",
      "agentActivitySources",
      "frontendAgentActivityObservers",
      "prRecheckAfterAgentCompletionArmedAt",
      "pendingRenamePrompt",
      "initialAgentModel",
      "initialReasoningEffort",
      "initialPromptAttachments",
      "branchRevision",
    ]) {
      expect(snapshots[0]).not.toHaveProperty(field);
    }
    expect(updates).toHaveLength(0);
  });

});
