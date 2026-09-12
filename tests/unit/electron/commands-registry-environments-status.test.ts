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

describe("environment status and settings commands", () => {
  test("fake Docker pins and exactly restores host credential paths", async () => {
    const names = [
      "ORKESTRATOR_AGENT_TEST_HOST_HOME",
      "ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR",
      "CLAUDE_CONFIG_DIR",
    ] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const fakeDocker = "#!/bin/sh\nexit 0\n";

    try {
      process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = "/before/host";
      process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = "/before/claude";
      process.env.CLAUDE_CONFIG_DIR = "/before/override";
      await withFakeDocker(fakeDocker, async ({ home }) => {
        expect(process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME).toBe(home);
        expect(process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR).toBe(
          path.join(home, ".claude"),
        );
        expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      });
      expect(process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME).toBe("/before/host");
      expect(process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR).toBe("/before/claude");
      expect(process.env.CLAUDE_CONFIG_DIR).toBe("/before/override");

      for (const name of names) delete process.env[name];
      await withFakeDocker(fakeDocker, async ({ home }) => {
        expect(process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME).toBe(home);
        expect(process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR).toBe(
          path.join(home, ".claude"),
        );
        expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      });
      for (const name of names) expect(process.env[name]).toBeUndefined();
    } finally {
      for (const name of names) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("reports Claude credential availability through the credential status handler", async () => {
    const { context } = createContext([]);
    const commands = createCommandRegistry();
    const hasClaudeCredentials = mock(async () => true);
    commands.set("has_claude_credentials", hasClaudeCredentials);

    await expect(commands.get("get_credential_status")?.({}, context)).resolves.toEqual({
      available: true,
      expiresAt: null,
    });
    expect(hasClaudeCredentials).toHaveBeenCalledTimes(1);
  });

  test(
    "preserves an admitted container start while its container is not yet persisted",
    async () => {
      const environment = createEnvironment({
        id: "env-active-start-status",
        environmentType: "containerized",
        containerId: null,
        status: "stopped",
        setupScriptsComplete: true,
        networkAccessMode: "full",
      });
      const { context, updates } = createContext(environment);
      const updateEnvironment = context.storage.updateEnvironment as ReturnType<typeof mock>;
      const originalImplementation = updateEnvironment.getMockImplementation();
      let announceCreating!: () => void;
      let releaseCreating!: () => void;
      const creatingPersisted = new Promise<void>((resolve) => {
        announceCreating = resolve;
      });
      const creatingRelease = new Promise<void>((resolve) => {
        releaseCreating = resolve;
      });
      updateEnvironment.mockImplementation(
        async (environmentId: string, update: Record<string, unknown>) => {
          const updated = await originalImplementation!(environmentId, update);
          if (update.status === "creating") {
            announceCreating();
            await creatingRelease;
          }
          return updated;
        },
      );
      const commands = createCommandRegistry();

      await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
        await withFakeDocker(
          `#!/bin/sh
case "$1" in
  create) printf 'container-active-start-status\\n' ;;
  start|exec) exit 0 ;;
esac
`,
          async () => {
            await commands.get("start_environment_background")?.(
              { environmentId: environment.id },
              context,
            );
            await creatingPersisted;

            await expect(
              commands.get("get_environments")?.({ projectId: environment.projectId }, context),
            ).resolves.toEqual([
              expect.objectContaining({
                id: environment.id,
                status: "creating",
                containerId: null,
              }),
            ]);
            expect(updatesWithStatus(updates, "stopped")).toHaveLength(0);

            releaseCreating();
            await waitForCondition(
              () => environment.status === "running",
              "active start to finish",
            );
          },
        );
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("preserves a durable lifecycle failure over Docker container state", async () => {
    const environment = createEnvironment({
      id: "env-error-status-authoritative",
      environmentType: "containerized",
      containerId: "container-error-status",
      status: "error",
      lifecycleError: ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable,
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  printf 'container-error-status\\trunning\\n'
  exit 0
fi
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
exit 1
`,
      async ({ all }) => {
        await expect(
          commands.get("get_environments")?.({ projectId: environment.projectId }, context),
        ).resolves.toEqual([
          expect.objectContaining({
            id: environment.id,
            status: "error",
            lifecycleError: ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable,
          }),
        ]);

        const calls = await fs.readFile(all, "utf8");
        expect(calls).toContain("ps -a");
        expect(calls).not.toContain("inspect -f");
      },
    );
    expect(updates).toHaveLength(0);
  });

  test("synchronizes individual and all stored environment statuses", async () => {
    const local = createEnvironment({
      id: "env-local",
      environmentType: "local",
      containerId: null,
    });
    const missingContainer = createEnvironment({
      id: "env-missing",
      environmentType: "containerized",
      containerId: "container-missing",
    });
    const { context, updates } = createContext([local, missingContainer]);
    const commands = createCommandRegistry();

    await expect(
      commands.get("sync_environment_status")?.({ environmentId: local.id }, context),
    ).resolves.toEqual(toClientEnvironment(local));
    await expect(
      commands.get("sync_environment_status")?.({ environmentId: "unknown" }, context),
    ).rejects.toThrow("Environment not found: unknown");
    await withFakeDocker(
      `#!/bin/sh
printf 'Error: No such object: %s\\n' "$4" >&2
exit 1
`,
      async () => {
        await expect(
          commands.get("sync_all_environments_with_docker")?.({}, context),
        ).resolves.toEqual(["env-missing"]);
      },
    );
    expect(updates).toContainEqual({ status: "stopped", containerId: null });
  });

  test("reconciles container statuses from one labelled docker ps snapshot", async () => {
    const agreeing = createEnvironment({
      id: "env-agree",
      environmentType: "containerized",
      containerId: "container-agree",
      status: "running",
    });
    const transitioned = createEnvironment({
      id: "env-transitioned",
      environmentType: "containerized",
      containerId: "container-transitioned",
      status: "running",
    });
    const { context, updates } = createContext([agreeing, transitioned]);
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  printf 'container-agree\\trunning\\n'
  printf 'container-transitioned\\texited\\n'
  exit 0
fi
if [ "$1" = "inspect" ]; then
  printf 'exited\\n'
  exit 0
fi
exit 0
`,
      async ({ all }) => {
        await commands.get("get_environments")?.({ projectId: agreeing.projectId }, context);
        const log = (await fs.readFile(all, "utf8")).split("\n").filter(Boolean);
        // The whole batch shares one labelled `docker ps` instead of one
        // `docker inspect` per environment.
        expect(log.filter((line) => line.startsWith("ps -a")).length).toBe(1);
        // Only the container whose snapshot state disagrees with storage is
        // confirmed with a fresh inspect before anything is rewritten.
        expect(log.filter((line) => line.startsWith("inspect"))).toEqual([
          "inspect -f {{.State.Status}} container-transitioned",
        ]);
      },
    );

    expect(updates).toEqual([{ status: "stopped" }]);
    expect(agreeing.status).toBe("running");
    expect(transitioned.status).toBe("stopped");
  });

  test("reuses one docker ps snapshot across a burst of status refreshes", async () => {
    const environment = createEnvironment({
      id: "env-burst",
      environmentType: "containerized",
      containerId: "container-burst",
      status: "running",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  printf 'container-burst\\trunning\\n'
  exit 0
fi
exit 1
`,
      async ({ all }) => {
        await commands.get("get_environments")?.({ projectId: environment.projectId }, context);
        await commands.get("get_environments")?.({ projectId: environment.projectId }, context);
        await expect(
          commands.get("get_environment_status")?.({ environmentId: environment.id }, context),
        ).resolves.toBe("running");
        const log = (await fs.readFile(all, "utf8")).split("\n").filter(Boolean);
        expect(log.filter((line) => line.startsWith("ps -a")).length).toBe(1);
        expect(log.some((line) => line.startsWith("inspect"))).toBe(false);
      },
    );
    expect(updates).toHaveLength(0);
  });

  test("strict reconciliation confirms an owned container missing from a stale snapshot", async () => {
    const environment = createEnvironment({
      id: "env-strict-stale",
      environmentType: "containerized",
      containerId: "container-before-create",
      status: "error",
      lifecycleError: ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable,
    });
    const { context, updates } = createContext(environment);
    context.strictDockerOwner = true;
    const owner = dockerOwnerNamespace(context.storage.getDataDir());
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  exit 0
fi
if [ "$1" = "inspect" ]; then
  printf '${owner}\\trunning\\n'
  exit 0
fi
exit 1
`,
      async ({ all }) => {
        await withFixedDate("2026-08-14T12:00:00.000Z", async () => {
          await commands.get("get_environments")?.({ projectId: environment.projectId }, context);
          environment.containerId = "container-created-after-snapshot";
          environment.status = "running";
          environment.lifecycleError = undefined;

          await expect(
            commands.get("sync_environment_status")?.({ environmentId: environment.id }, context),
          ).resolves.toEqual(toClientEnvironment(environment));
        });

        const log = (await fs.readFile(all, "utf8")).split("\n").filter(Boolean);
        expect(log.filter((line) => line.startsWith("ps -a"))).toHaveLength(1);
        expect(log.filter((line) => line.startsWith("inspect -f"))).toEqual([
          `inspect -f {{ index .Config.Labels "orkestrator-owner" }}\t{{.State.Status}} container-created-after-snapshot`,
        ]);
      },
    );
    expect(updates).toHaveLength(0);
    expect(environment.containerId).toBe("container-created-after-snapshot");
  });

  test("refreshes the docker ps snapshot after its cache expires", async () => {
    const environment = createEnvironment({
      id: "env-cache-expiry",
      environmentType: "containerized",
      containerId: "container-cache-expiry",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  printf 'container-cache-expiry\\trunning\\n'
  exit 0
fi
exit 1
`,
      async ({ all }) => {
        await withFixedDate("2026-07-28T12:00:00.000Z", () =>
          commands.get("get_environments")?.({ projectId: environment.projectId }, context),
        );
        await withFixedDate("2026-07-28T12:00:03.001Z", () =>
          commands.get("get_environments")?.({ projectId: environment.projectId }, context),
        );

        const log = (await fs.readFile(all, "utf8")).split("\n").filter(Boolean);
        expect(log.filter((line) => line.startsWith("ps -a"))).toHaveLength(2);
      },
    );
  });

  test("falls back to per-container inspect when the shared docker scan fails", async () => {
    const environment = createEnvironment({
      id: "env-cache-failure",
      environmentType: "containerized",
      containerId: "container-cache-failure",
      status: "running",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  exit 1
fi
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
exit 1
`,
      async ({ all }) => {
        await commands.get("get_environments")?.({ projectId: environment.projectId }, context);
        const log = (await fs.readFile(all, "utf8")).split("\n").filter(Boolean);
        expect(log.filter((line) => line.startsWith("ps -a"))).toHaveLength(1);
        expect(log.filter((line) => line.startsWith("inspect"))).toEqual([
          "inspect -f {{.State.Status}} container-cache-failure",
        ]);
      },
    );
    expect(updates).toHaveLength(0);
  });

  test("only probes containers missing from the labelled snapshot during full sync", async () => {
    const listed = createEnvironment({
      id: "env-listed",
      environmentType: "containerized",
      containerId: "container-listed",
      status: "running",
    });
    const missing = createEnvironment({
      id: "env-absent",
      environmentType: "containerized",
      containerId: "container-absent",
      status: "running",
    });
    const { context, updates } = createContext([listed, missing]);
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  printf 'container-listed\\trunning\\n'
  exit 0
fi
printf 'Error: No such object: container-absent\\n' >&2
exit 1
`,
      async ({ all }) => {
        await expect(
          commands.get("sync_all_environments_with_docker")?.({}, context),
        ).resolves.toEqual([missing.id]);
        const log = (await fs.readFile(all, "utf8")).split("\n").filter(Boolean);
        expect(log.filter((line) => line.startsWith("ps -a")).length).toBe(1);
        expect(log.filter((line) => line.startsWith("inspect"))).toEqual([
          "inspect -f {{.State.Status}} container-absent",
        ]);
      },
    );
    expect(updates).toEqual([{ status: "stopped", containerId: null }]);
  });

  test("stops local and container environments and treats recreation without a container as a no-op", async () => {
    const local = createEnvironment({
      id: "env-local",
      environmentType: "local",
      containerId: null,
      pendingAgentLaunch: true,
      initialAgentModel: "claude-fable-5[1m]",
      initialReasoningEffort: "max",
    });
    const container = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      pendingAgentLaunch: true,
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
      initialPromptAttachments: [
        {
          id: "attachment-1",
          name: "diagram.png",
          previewUrl: "blob:diagram",
          base64Data: "aW1hZ2U=",
        },
      ],
    });
    const { context, updates } = createContext([local, container]);
    const commands = createCommandRegistry();

    await commands.get("stop_environment")?.({ environmentId: local.id }, context);
    // A stopped environment cannot honour a post-setup agent launch, and the
    // renderer no longer mounts it, so the intent is dropped here.
    const localStopUpdates = updatesWithStatus(updates, "stopped");
    expect(localStopUpdates).toHaveLength(1);
    expectClearsPendingAgentLaunch(localStopUpdates[0]);
    // The update actually lands on the stored environment, so a restart cannot
    // resurrect the previous run's model.
    expect(local.pendingAgentLaunch).toBe(false);
    expect(local.initialAgentModel).toBeUndefined();
    expect(local.initialReasoningEffort).toBeUndefined();
    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
exit 0
`,
      async (logs) => {
        await commands.get("stop_environment")?.({ environmentId: container.id }, context);
        expect(await fs.readFile(logs.all, "utf8")).toContain("stop container-1");
      },
    );
    // Both lanes clear it, containerized as well as local.
    const allStopUpdates = updatesWithStatus(updates, "stopped");
    expect(allStopUpdates).toHaveLength(2);
    expectClearsPendingAgentLaunch(allStopUpdates[1]);
    expect(container.pendingAgentLaunch).toBe(false);
    expect(container.initialAgentModel).toBeUndefined();
    expect(container.initialReasoningEffort).toBeUndefined();
    await expect(
      commands.get("recreate_environment")?.({ environmentId: local.id }, context),
    ).resolves.toBeUndefined();
  });

  test("strict lifecycle commands never stop, recreate, or delete a foreign container", async () => {
    const environment = createEnvironment({
      id: "env-foreign-container",
      environmentType: "containerized",
      containerId: "foreign-container",
      status: "running",
    });
    const { context, updates } = createContext(environment);
    context.strictDockerOwner = true;
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'another-owner\\trunning\\n'
  exit 0
fi
exit 0
`,
      async ({ all }) => {
        for (const command of [
          "stop_environment",
          "recreate_environment",
          "delete_environment",
        ] as const) {
          await expect(
            commands.get(command)?.({ environmentId: environment.id }, context),
          ).rejects.toThrow("not owned by this development profile");
        }

        const log = await fs.readFile(all, "utf8");
        expect(log.match(/inspect -f/g)).toHaveLength(3);
        expect(log).not.toContain("stop foreign-container");
        expect(log).not.toContain("rm -f foreign-container");
      },
    );
    expect(updates).toHaveLength(0);
    expect(environment.containerId).toBe("foreign-container");
  });

  test("strict lifecycle commands still repair an environment whose container is already gone", async () => {
    // An errored environment is exempt from status reconciliation, so its stale
    // containerId never clears on its own. If the ownership probe treated "no
    // such object" as a refusal, recreate and delete — the only repair actions
    // for this state — would fail identically on every retry, forever.
    const recreatable = createEnvironment({
      id: "env-vanished-recreate",
      environmentType: "containerized",
      containerId: "vanished-container",
      status: "error",
      lifecycleError: ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable,
    });
    const deletable = createEnvironment({
      id: "env-vanished-delete",
      environmentType: "containerized",
      containerId: "vanished-container",
      status: "error",
      lifecycleError: ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable,
    });
    const { context } = createContext([recreatable, deletable]);
    context.strictDockerOwner = true;
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'error: no such object: %s\\n' "$4" >&2
  exit 1
fi
if [ "$1" = "create" ]; then
  exit 42
fi
exit 0
`,
      async ({ all }) => {
        await expect(
          commands.get("delete_environment")?.({ environmentId: deletable.id }, context),
        ).resolves.toBeUndefined();

        // Recreate goes on to provision a fresh container, which this fake fails
        // at `create`. The regression under test is only that it got that far
        // rather than being refused by the ownership probe.
        const recreateFailure = await commands
          .get("recreate_environment")?.({ environmentId: recreatable.id }, context)
          .then(
            () => null,
            (error: unknown) => String(error),
          );
        expect(recreateFailure ?? "").not.toContain("not owned by this development profile");

        const log = await fs.readFile(all, "utf8");
        expect(log.match(/inspect -f/g)).toHaveLength(2);
        expect(log).toContain("rm -f vanished-container");
      },
    );
  });

  test("agent-test container mounts come from the isolated profile paths, not the host home", async () => {
    const environment = createEnvironment({
      id: "env-agent-test-mounts",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    context.runtimeFlavor = "agent-test";
    context.credentialSources = new Set(["claude", "codex", "cursor", "grok", "opencode"]);
    const commands = createCommandRegistry();
    const saved = {
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      ORKESTRATOR_AGENT_TEST_HOST_HOME: process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME,
      ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR:
        process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR,
      CURSOR_API_KEY: process.env.CURSOR_API_KEY,
    };

    try {
      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "create" ]; then
  exit 42
fi
exit 0
`,
        async ({ all, home }) => {
          const isolated = path.join(home, "isolated");
          const hostHome = path.join(home, "host-home");
          const claudeConfigDir = path.join(isolated, "claude");
          const codexHome = path.join(isolated, "codex");
          const xdgConfigHome = path.join(isolated, "xdg-config");
          const xdgDataHome = path.join(isolated, "xdg-data");
          const xdgStateHome = path.join(isolated, "xdg-state");
          for (const directory of [
            claudeConfigDir,
            codexHome,
            path.join(xdgConfigHome, "opencode"),
            path.join(xdgDataHome, "opencode"),
            path.join(xdgStateHome, "opencode"),
            hostHome,
            path.join(hostHome, ".grok"),
            path.join(hostHome, ".config", "grok"),
            // Decoys: the developer's real agent homes, which `withFakeDocker`
            // points $HOME at. An agent-test container must never mount these.
            path.join(home, ".claude"),
            path.join(home, ".codex"),
            path.join(home, ".config", "opencode"),
          ])
            await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(path.join(hostHome, ".claude.json"), "{}");
          await fs.writeFile(path.join(home, ".claude.json"), "{}");
          await fs.writeFile(path.join(xdgStateHome, "opencode", "model.json"), "{}");

          process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
          process.env.CODEX_HOME = codexHome;
          process.env.XDG_CONFIG_HOME = xdgConfigHome;
          process.env.XDG_DATA_HOME = xdgDataHome;
          process.env.XDG_STATE_HOME = xdgStateHome;
          process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = hostHome;
          process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = claudeConfigDir;
          process.env.CURSOR_API_KEY = "agent-test-cursor-key";

          await commands
            .get("provision_environment")?.({ environmentId: environment.id }, context)
            .catch(() => undefined);

          const log = await fs.readFile(all, "utf8");
          expect(log).toContain(`-v ${claudeConfigDir}:/claude-config:ro`);
          expect(log).toContain(`-v ${codexHome}:/codex-home:ro`);
          expect(log).toContain(`-v ${path.join(xdgConfigHome, "opencode")}:/opencode-config:ro`);
          expect(log).toContain(`-v ${path.join(xdgDataHome, "opencode")}:/opencode-data:ro`);
          expect(log).toContain(
            `-v ${path.join(xdgStateHome, "opencode", "model.json")}:/opencode-state/model.json:ro`,
          );
          expect(log).not.toContain(":/cursor-config:ro");
          expect(log).toContain(`-v ${path.join(hostHome, ".grok")}:/grok-home:ro`);
          expect(log).toContain(`-v ${path.join(hostHome, ".config", "grok")}:/grok-config:ro`);
          expect(log).toContain("-e CURSOR_API_KEY");
          expect(log).not.toContain("agent-test-cursor-key");
          // `.claude.json` has no CLAUDE_CONFIG_DIR equivalent, so it is the one
          // path resolved against the recorded host home rather than an env var.
          expect(log).toContain(`-v ${path.join(hostHome, ".claude.json")}:/claude-config.json:ro`);

          expect(log).not.toContain(`${path.join(home, ".claude")}:/claude-config`);
          expect(log).not.toContain(`${path.join(home, ".codex")}:`);
          expect(log).not.toContain(`${path.join(home, ".config", "opencode")}:`);
          expect(log).not.toContain(`${path.join(home, ".claude.json")}:`);
          // The developer's actual HOME and gitconfig remain outside the profile.
          expect(log).not.toContain("/tmp/gitconfig");
        },
      );
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("agent-test containers omit the credential sources the profile did not allow", async () => {
    const environment = createEnvironment({
      id: "env-agent-test-denied-mounts",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    context.runtimeFlavor = "agent-test";
    context.credentialSources = new Set(["codex"]);
    const commands = createCommandRegistry();
    const savedCodexHome = process.env.CODEX_HOME;
    const savedClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

    try {
      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "create" ]; then
  exit 42
fi
exit 0
`,
        async ({ all, home }) => {
          const codexHome = path.join(home, "isolated", "codex");
          const claudeConfigDir = path.join(home, "isolated", "claude");
          await fs.mkdir(codexHome, { recursive: true });
          await fs.mkdir(claudeConfigDir, { recursive: true });
          process.env.CODEX_HOME = codexHome;
          process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

          await commands
            .get("provision_environment")?.({ environmentId: environment.id }, context)
            .catch(() => undefined);

          const log = await fs.readFile(all, "utf8");
          expect(log).toContain(`-v ${codexHome}:/codex-home:ro`);
          // The Claude directory exists and is readable; only the profile's
          // credential-source list keeps it out of the container.
          expect(log).not.toContain("/claude-config");
          expect(log).not.toContain("/opencode-config");
        },
      );
    } finally {
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
      if (savedClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = savedClaudeConfigDir;
    }
  });

  test("an unreachable Docker daemon is not evidence of ownership", async () => {
    // "no such object" is a definite answer; a daemon that cannot be reached is
    // no answer at all, and must never be read as permission to proceed.
    const environment = createEnvironment({
      id: "env-daemon-down",
      environmentType: "containerized",
      containerId: "unreachable-container",
      status: "running",
    });
    const { context, updates } = createContext(environment);
    context.strictDockerOwner = true;
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\\n' >&2
  exit 1
fi
exit 0
`,
      async ({ all }) => {
        await expect(
          commands.get("stop_environment")?.({ environmentId: environment.id }, context),
        ).rejects.toThrow("Cannot connect to the Docker daemon");

        expect(await fs.readFile(all, "utf8")).not.toContain("stop unreachable-container");
      },
    );
    expect(updates).toHaveLength(0);
  });

  test("stopping a local environment also stops its bridge processes", async () => {
    const worktreePath = await createTempDir("ork-electron-stop-local-");
    const environment = createEnvironment({
      id: "env-stop-local",
      environmentType: "local",
      containerId: null,
      worktreePath,
      localCodexPort: 40201,
      codexBridgePid: 95001,
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();
    const child = createFakeChild(95001);
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, child);
    commandTesting.setTerminateProcessTree(async () => true);

    await commands.get("stop_environment")?.({ environmentId: environment.id }, context);

    // The bridge is gone and its ownership entry released, so a later start
    // does not think a server is already running.
    expect(commandTesting.getLocalServerProcess(`codex:${environment.id}`)).toBeUndefined();
    expect(updates).toContainEqual({ codexBridgePid: null, localCodexPort: null });
    expect(updates).toContainEqual({
      status: "stopped",
      lifecycleError: null,
      pendingAgentLaunch: false,
    });
  });

  test("a local environment is still marked stopped when a bridge refuses to die", async () => {
    const worktreePath = await createTempDir("ork-electron-stop-local-failure-");
    const environment = createEnvironment({
      id: "env-stop-local-failure",
      environmentType: "local",
      containerId: null,
      worktreePath,
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, createFakeChild(95002));
    commandTesting.setTerminateProcessTree(async () => false);

    // The failure is surfaced...
    await expect(
      commands.get("stop_environment")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow("Failed to stop all local servers");

    // ...but not at the cost of stranding the environment as running, with no
    // way for the user to stop it from the UI.
    expect(updates).toContainEqual({ status: "stopped", pendingAgentLaunch: false });

    commandTesting.setTerminateProcessTree(async () => true);
  });

  test("stores PR metadata, normalized settings, and deduplicated domain changes", async () => {
    const environment = createEnvironment({
      allowedDomains: ["api.example.com", "shared.example.com"],
      initialPromptAttachments: [
        {
          id: "attachment-1",
          name: "diagram.png",
          previewUrl: "blob:diagram",
          base64Data: "aW1hZ2U=",
        },
      ],
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await commands.get("set_environment_pr")?.(
      {
        environmentId: environment.id,
        prUrl: "https://github.com/acme/repo/pull/42",
        prState: "open",
        hasMergeConflicts: false,
      },
      context,
    );
    expect(updates).toContainEqual({
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "open",
      hasMergeConflicts: false,
    });
    await expect(
      commands.get("get_environment_pr_url")?.({ environmentId: environment.id }, context),
    ).resolves.toBe("https://github.com/acme/repo/pull/42");
    await commands.get("clear_environment_pr")?.({ environmentId: environment.id }, context);
    expect(updates).toContainEqual({ prUrl: null, prState: null, hasMergeConflicts: null });
    await expect(
      commands.get("get_environment_pr_url")?.({ environmentId: "missing" }, context),
    ).resolves.toBeNull();

    await commands.get("update_port_mappings")?.(
      {
        environmentId: environment.id,
        portMappings: [{ hostPort: 3000, containerPort: 3001, protocol: "tcp" }],
      },
      context,
    );
    expect(updates).toContainEqual({
      portMappings: [{ hostPort: 3000, containerPort: 3001, protocol: "tcp" }],
    });
    await commands.get("update_port_mappings")?.(
      { environmentId: environment.id, portMappings: null },
      context,
    );
    expect(updates).toContainEqual({ portMappings: [] });
    await commands.get("update_environment_agent_settings")?.(
      {
        environmentId: environment.id,
        agentSettings: {
          defaultAgent: "codex",
          platforms: {
            // "bridge" is not a Claude backend, so normalization drops it.
            claude: { mode: "native", claudeNativeBackend: "bridge" },
            opencode: { mode: "native" },
            codex: { mode: "native" },
          },
        },
        pendingAgentLaunch: true,
        initialAgentModel: "gpt-5.6-sol",
        initialReasoningEffort: "high",
      },
      context,
    );
    expect(updates).toContainEqual({
      agentSettings: {
        defaultAgent: "codex",
        platforms: {
          claude: { mode: "native" },
          opencode: { mode: "native" },
          codex: { mode: "native" },
        },
      },
      pendingAgentLaunch: true,
      initialAgentModel: "gpt-5.6-sol",
      initialReasoningEffort: "high",
    });
    await commands.get("update_environment_agent_settings")?.(
      {
        environmentId: environment.id,
        agentSettings: {
          defaultAgent: "codex",
          platforms: {
            claude: { mode: null, claudeNativeBackend: null },
            opencode: { mode: null },
            codex: { mode: "native" },
          },
        },
        pendingAgentLaunch: false,
        initialAgentModel: "must-not-survive",
        initialReasoningEffort: "ultra",
      },
      context,
    );
    // Clearing the flag must emit both option keys explicitly: `updateEnvironment`
    // only clears a stored field when the key is present, so dropping the keys
    // here would leave the previous run's model on the environment.
    expect(updates.at(-1)).toEqual({
      // Every cleared field normalizes away, leaving only what is still set.
      agentSettings: { defaultAgent: "codex", platforms: { codex: { mode: "native" } } },
      pendingAgentLaunch: false,
      initialAgentModel: undefined,
      initialReasoningEffort: undefined,
      initialPromptAttachments: undefined,
    });
    expectClearsPendingAgentLaunch(updates.at(-1));
    // ...and the stored environment really loses the model it had from the first
    // call in this test, rather than silently keeping "gpt-5.6-sol".
    expect(environment.initialAgentModel).toBeUndefined();
    expect(environment.initialReasoningEffort).toBeUndefined();
    expect(environment.initialPromptAttachments).toBeUndefined();
    await commands.get("update_environment_agent_settings")?.(
      {
        environmentId: environment.id,
        agentSettings: {
          defaultAgent: "codex",
          platforms: {
            claude: { mode: null, claudeNativeBackend: null },
            opencode: { mode: null },
            codex: { mode: "native" },
          },
        },
        initialAgentModel: "gpt-5.4-mini",
        initialReasoningEffort: "medium",
      },
      context,
    );
    expect(updates.at(-1)).toEqual({
      agentSettings: {
        defaultAgent: "codex",
        platforms: {
          codex: { mode: "native" },
        },
      },
      initialAgentModel: "gpt-5.4-mini",
      initialReasoningEffort: "medium",
    });
    expect(updates.at(-1)).not.toHaveProperty("pendingAgentLaunch");
    await commands.get("update_environment_agent_settings")?.(
      {
        environmentId: environment.id,
        agentSettings: {
          defaultAgent: "codex",
          platforms: {
            claude: { mode: null, claudeNativeBackend: null },
            opencode: { mode: null },
            codex: { mode: "native" },
          },
        },
        initialAgentModel: 42,
        initialReasoningEffort: {},
      },
      context,
    );
    expect(updates.at(-1)).toEqual({
      agentSettings: {
        defaultAgent: "codex",
        platforms: {
          codex: { mode: "native" },
        },
      },
    });
    // Omitting the flag must leave an in-flight launch intent alone: the settings
    // dialog, FeaturesView and the non-Claude pipeline lanes all call this
    // command without it while an environment may still be awaiting its launch.
    await commands.get("update_environment_agent_settings")?.(
      {
        environmentId: environment.id,
        agentSettings: {
          defaultAgent: "claude",
          platforms: {
            claude: { mode: "terminal", claudeNativeBackend: null },
            opencode: { mode: null },
            codex: { mode: null },
          },
        },
      },
      context,
    );
    expect(updates).toContainEqual({
      agentSettings: {
        defaultAgent: "claude",
        platforms: { claude: { mode: "terminal" } },
      },
    });
    expect(updates.at(-1)).not.toHaveProperty("pendingAgentLaunch");
    // A non-boolean must not be coerced either.
    await commands.get("update_environment_agent_settings")?.(
      {
        environmentId: environment.id,
        agentSettings: {
          defaultAgent: "claude",
          platforms: {
            claude: { mode: "terminal", claudeNativeBackend: null },
            opencode: { mode: null },
            codex: { mode: null },
          },
        },
        pendingAgentLaunch: "true",
      },
      context,
    );
    expect(updates.at(-1)).not.toHaveProperty("pendingAgentLaunch");

    // Re-arm a launch with options so the clear below has something to destroy.
    await commands.get("update_environment_agent_settings")?.(
      {
        environmentId: environment.id,
        agentSettings: {
          defaultAgent: "codex",
          platforms: {
            claude: { mode: null, claudeNativeBackend: null },
            opencode: { mode: null },
            codex: { mode: "native" },
          },
        },
        pendingAgentLaunch: true,
        initialAgentModel: "gpt-5.6-sol",
        initialReasoningEffort: "high",
      },
      context,
    );
    expect(environment.initialAgentModel).toBe("gpt-5.6-sol");

    await commands.get("set_environment_pending_agent_launch")?.(
      {
        environmentId: environment.id,
        pending: false,
      },
      context,
    );
    expectClearsPendingAgentLaunch(updates.at(-1));
    expect(environment.initialAgentModel).toBeUndefined();
    expect(environment.initialReasoningEffort).toBeUndefined();
    await commands.get("set_environment_pending_agent_launch")?.(
      {
        environmentId: environment.id,
        pending: true,
      },
      context,
    );
    // Arming must not touch the options: the renderer sets the model through
    // `update_environment_agent_settings`, and clobbering it here would drop a
    // choice that had already been recorded.
    expect(updates.at(-1)).toEqual({ pendingAgentLaunch: true });
    expect(updates.at(-1)).not.toHaveProperty("initialAgentModel");
    expect(updates.at(-1)).not.toHaveProperty("initialReasoningEffort");
    // A malformed call must fail rather than silently destroying the intent by
    // reading a missing/garbage value as `false`.
    expect(() =>
      commands.get("set_environment_pending_agent_launch")?.(
        {
          environmentId: environment.id,
        },
        context,
      ),
    ).toThrow("Expected pending to be a boolean");
    expect(() =>
      commands.get("set_environment_pending_agent_launch")?.(
        {
          environmentId: environment.id,
          pending: "false",
        },
        context,
      ),
    ).toThrow("Expected pending to be a boolean");

    await commands.get("set_environment_initial_prompt")?.(
      {
        environmentId: environment.id,
        initialPrompt: "Fix the bug [image](/work/attachment-1.png)",
      },
      context,
    );
    expect(updates).toContainEqual({
      initialPrompt: "Fix the bug [image](/work/attachment-1.png)",
    });
    expect(() =>
      commands.get("set_environment_initial_prompt")?.(
        {
          environmentId: environment.id,
          initialPrompt: 42,
        },
        context,
      ),
    ).toThrow("Expected initialPrompt to be a string");
    await commands.get("update_environment_allowed_domains")?.(
      {
        environmentId: environment.id,
        domains: ["one.example.com", "two.example.com"],
      },
      context,
    );
    expect(updates).toContainEqual({ allowedDomains: ["one.example.com", "two.example.com"] });

    environment.allowedDomains = ["api.example.com", "shared.example.com"];
    await expect(
      commands.get("add_environment_domains")?.(
        {
          environmentId: environment.id,
          domains: ["shared.example.com", "new.example.com"],
        },
        context,
      ),
    ).resolves.toBe("api.example.com,shared.example.com,new.example.com");
    expect(updates).toContainEqual({
      allowedDomains: ["api.example.com", "shared.example.com", "new.example.com"],
    });
    await expect(
      commands.get("remove_environment_domains")?.(
        {
          environmentId: environment.id,
          domains: ["shared.example.com"],
        },
        context,
      ),
    ).resolves.toBe("api.example.com,new.example.com");
    await expect(
      commands.get("add_environment_domains")?.(
        {
          environmentId: "missing",
          domains: [],
        },
        context,
      ),
    ).rejects.toThrow("Environment not found: missing");
    await expect(
      commands.get("remove_environment_domains")?.(
        {
          environmentId: "missing",
          domains: [],
        },
        context,
      ),
    ).rejects.toThrow("Environment not found: missing");
  });

  test("leaves stored agent settings alone when the request omits the block", async () => {
    const environment = createEnvironment({
      agentSettings: {
        defaultAgent: "codex",
        actionDefaults: { review: { platform: "codex", model: "gpt-5.6-sol" } },
        platforms: { codex: { mode: "native", model: "gpt-5.6-sol", reasoningEffort: "high" } },
      },
    });
    const stored = structuredClone(environment.agentSettings);
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    // The environment tier now carries models, reasoning levels and action
    // defaults, not just the three modes it used to. A launch-intent-only call
    // must not be able to erase any of it: storage decides by key presence, so
    // the handler has to withhold the key rather than send an empty block.
    await commands.get("update_environment_agent_settings")?.(
      { environmentId: environment.id, pendingAgentLaunch: false },
      context,
    );
    expect(updates.at(-1)).not.toHaveProperty("agentSettings");
    expect(environment.agentSettings).toEqual(stored);

    await commands.get("update_environment_agent_settings")?.(
      { environmentId: environment.id, initialAgentModel: "gpt-5.4-mini" },
      context,
    );
    expect(updates.at(-1)).toEqual({ initialAgentModel: "gpt-5.4-mini" });
    expect(environment.agentSettings).toEqual(stored);

    // An explicit clear still clears, and lands as absence rather than as an
    // empty block every environment would then carry.
    await commands.get("update_environment_agent_settings")?.(
      { environmentId: environment.id, agentSettings: null },
      context,
    );
    expect(updates.at(-1)).toEqual({ agentSettings: undefined });
    expect(environment.agentSettings).toBeUndefined();
  });

  test("stores an all-empty agent settings block as absence", async () => {
    const environment = createEnvironment({
      agentSettings: { defaultAgent: "codex" },
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    // Every field here normalizes away, so what is left says nothing at all —
    // which is what absence already means.
    await commands.get("update_environment_agent_settings")?.(
      {
        environmentId: environment.id,
        agentSettings: {
          defaultAgent: "not-a-platform",
          actionDefaults: { review: { model: "orphan-without-a-platform" } },
          platforms: { claude: { mode: "sideways" }, nope: { mode: "native" } },
        },
      },
      context,
    );
    expect(updates.at(-1)).toEqual({ agentSettings: undefined });
    expect(environment.agentSettings).toBeUndefined();
  });
});
