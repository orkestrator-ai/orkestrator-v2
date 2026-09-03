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

describe("environment status and settings commands", () => {
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
        expect(result.branch).toBe("20260415-123456");
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
        expect(result.branch).toBe("20260415-123456");
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
    expect(environment.branch).toBe("manual-choice");
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
    ).resolves.toMatchObject({ name: "manual-choice", branch: "manual-choice" });

    expect(await currentGitBranch(worktreePath)).toBe("manual-choice");
    expect(environment.prUrl).toBeNull();
    expect(environment.prState).toBeNull();
    expect(environment.hasMergeConflicts).toBeNull();
    expect(emitted).toContainEqual({
      event: "environment-renamed",
      payload: {
        environment_id: environment.id,
        new_name: "manual-choice",
        new_branch: "manual-choice",
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
        expect(environment.branch).toBe("review-oauth-flow");
        expect(environment.pendingRenamePrompt).toBeUndefined();
        expect(await currentGitBranch(worktreePath)).toBe("review-oauth-flow");
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
      expect(await currentGitBranch(worktreePath)).toBe("reconcile-session-state");
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
        expect(result.branch).toBe("20260415-123456");
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
    expect(result.branch).toBe(result.name);
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
    expect(result.branch).toBe("20260415-123456-1");
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
    expect(result.branch).toBe("custom-name-1");
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
        expect(environment.branch).toBe("review-oauth-flow");
        expect(environment.prUrl).toBeNull();
        expect(environment.prState).toBeNull();
        expect(environment.hasMergeConflicts).toBeNull();
        expect(emitted).toContainEqual({
          event: "environment-renamed",
          payload: {
            environment_id: environment.id,
            new_name: "review-oauth-flow",
            new_branch: "review-oauth-flow",
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
      expect(environment.branch).toBe("review-oauth-flow-1");
      expect(existing.name).toBe("review-oauth-flow");
      expect(existing.branch).toBe("review-oauth-flow");
      expect(emitted).toContainEqual({
        event: "environment-renamed",
        payload: {
          environment_id: environment.id,
          new_name: "review-oauth-flow-1",
          new_branch: "review-oauth-flow-1",
        },
      });
    });
  });

  test("suffixes prompt-renamed local environments when the project already has the generated branch", async () => {
    const { worktree } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["branch", "review-oauth-flow"]);
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

      expect(environment.name).toBe("review-oauth-flow-1");
      expect(environment.branch).toBe("review-oauth-flow-1");
    });
  });

  test("renames the live local git branch and advances stored branch on success", async () => {
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
      expect(environment.branch).toBe("review-oauth-flow");
      expect(environment.prUrl).toBeNull();
      expect(environment.prState).toBeNull();
      expect(environment.hasMergeConflicts).toBeNull();
      expect(await currentGitBranch(worktreePath)).toBe("review-oauth-flow");
      await expect(configuredGitPushBehaviour(worktreePath)).resolves.toEqual({
        pushDefault: "current",
        autoSetupRemote: "true",
      });
      // The upstream `git branch -m` carried over from the old name would make the
      // renamed branch compare and pull against origin/old-branch, so it is dropped
      // and the next push records the right one.
      await expect(configuredGitUpstream(worktreePath, "review-oauth-flow")).resolves.toEqual({
        remote: "",
        merge: "",
      });
      expect(emitted).toContainEqual({
        event: "environment-renamed",
        payload: {
          environment_id: environment.id,
          new_name: "review-oauth-flow",
          new_branch: "review-oauth-flow",
        },
      });
    });
  });

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
      await expect(configuredGitUpstream(worktreePath, "review-oauth-flow")).resolves.toEqual({
        remote: "",
        merge: "",
      });
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
  *" branch -m -- review-oauth-flow old-branch"*) echo "forced rollback failure" >&2; exit 42 ;;`,
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
      expect(await currentGitBranch(worktreePath)).toBe("review-oauth-flow");
      expect(environment.branch).toBe("review-oauth-flow");
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
  *" branch -m -- review-oauth-flow old-branch"*) real_git "$@"; echo "forced timeout" >&2; exit 42 ;;`,
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
    expect(await gitOutput(worktreePath, ["branch", "--list", "review-oauth-flow"])).toBe("");
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
          expect(environment.branch).toBe("review-oauth-flow");
          expect(environment.prUrl).toBeNull();

          const execLog = await fs.readFile(logs.exec, "utf8");
          expect(execLog).toContain(
            "git -C /workspace branch -m -- 'old-branch' 'review-oauth-flow'",
          );
          expect(execLog).toContain("git -C /workspace config --local push.default current");
          expect(execLog).toContain("git -C /workspace config --local push.autoSetupRemote true");
          // The upstream the rename carried over from the old name has to go, or the
          // renamed branch keeps comparing itself against origin/old-branch.
          expect(execLog).toContain(
            "git -C /workspace config --local --unset-all 'branch.review-oauth-flow.merge'",
          );
          expect(execLog).toContain(
            "git -C /workspace config --local --unset-all 'branch.review-oauth-flow.remote'",
          );
          // Nothing may pre-create an upstream for a branch that has never been pushed.
          expect(execLog).not.toContain(
            "config --local 'branch.review-oauth-flow.merge' 'refs/heads/review-oauth-flow'",
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
            "git -C /workspace branch -m -- 'old-branch' 'review-oauth-flow'",
          );
          expect(execCalls[1]).toContain("git -C /workspace config --local push.default current");
          expect(execCalls[2]).toContain(
            "git -C /workspace branch -m -- 'review-oauth-flow' 'old-branch'",
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
    *"rev-parse --verify --quiet 'refs/heads/review-oauth-flow'"*)
      printf '%s' '${commandTesting.BRANCH_REF_EXISTS_SENTINEL}'; exit 0 ;;
    *"rev-parse --verify --quiet 'refs/heads/old-branch'"*) exit 0 ;;
    *" config --local "*) exit 42 ;;
    *"branch -m -- 'review-oauth-flow' 'old-branch'"*) exit 43 ;;
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

          expect(environment.branch).toBe("review-oauth-flow");
          expect(environment.prUrl).toBeNull();
          expect(environment.prState).toBeNull();
          expect(environment.hasMergeConflicts).toBeNull();

          const execCalls = (await fs.readFile(logs.exec, "utf8")).trim().split("\n");
          expect(execCalls).toHaveLength(5);
          expect(execCalls[2]).toContain(
            "git -C /workspace branch -m -- 'review-oauth-flow' 'old-branch'",
          );
          expect(execCalls[3]).toContain(
            "rev-parse --verify --quiet 'refs/heads/review-oauth-flow'",
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
    *"branch -m -- 'review-oauth-flow' 'old-branch'"*) exit 43 ;;
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
    *"branch -m -- 'review-oauth-flow' 'old-branch'"*) exit 43 ;;
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
    ]) {
      expect(snapshots[0]).not.toHaveProperty(field);
    }
    expect(updates).toHaveLength(0);
  });

  /**
   * The setup-start commands return the environment *nested* inside a result
   * object, so they need their own projection rather than inheriting the one
   * applied to the flat mutation responses.
   */
  test("projects the environment nested inside a setup-start result", async () => {
    const { worktree: worktreePath } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-setup-start-projection",
      status: "running",
      environmentType: "local",
      worktreePath,
      containerId: null,
      setupScriptsComplete: false,
      opencodePid: 40,
      pendingRenamePrompt: "backend-owned rename prompt",
      initialPromptAttachments: [
        {
          id: "image-1",
          name: "private.png",
          base64Data: "cHJpdmF0ZQ==",
        },
      ],
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const result = (await commands.get("ensure_environment_setup")?.(
      { environmentId: environment.id },
      context,
    )) as { environment: Record<string, unknown> };

    expect(result.environment).toMatchObject({ id: environment.id });
    for (const field of [
      "opencodePid",
      "pendingRenamePrompt",
      "initialPromptAttachments",
      "claudeModelCatalog",
      "agentActivitySources",
      "frontendAgentActivityObservers",
    ]) {
      expect(result.environment).not.toHaveProperty(field);
    }
    expect(result.environment.hasInitialPromptAttachments).toBe(true);
    // The stored record keeps everything the projection strips.
    expect(
      (await context.storage.getEnvironment(environment.id))?.initialPromptAttachments,
    ).toHaveLength(1);
  });

  test("passes an absent recreate result through without projecting it", async () => {
    const environment = createEnvironment({
      id: "env-recreate-no-container",
      status: "running",
      containerId: null,
      environmentType: "local",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    // A recreate with nothing to recreate has no result to project. Projecting
    // `undefined` would hand the renderer an object with no environment in it.
    await expect(
      commands.get("recreate_environment")?.({ environmentId: environment.id }, context),
    ).resolves.toBeUndefined();
    await expect(
      commands.get("recreate_environment")?.({ environmentId: "missing-environment" }, context),
    ).resolves.toBeUndefined();
  });

  test("preserves container identity when Docker status reconciliation fails transiently", async () => {
    const environment = createEnvironment({
      status: "running",
      containerId: "container-existing",
      environmentType: "containerized",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\n' 'Cannot connect to the Docker daemon' >&2
exit 1
`,
      async () => {
        await expect(
          commands.get("get_environments")?.({ projectId: environment.projectId }, context),
        ).resolves.toEqual([toClientEnvironment(environment)]);
      },
    );

    expect(environment.containerId).toBe("container-existing");
    expect(environment.status).toBe("running");
    expect(updates).toHaveLength(0);
  });

  test("clears a container identity only when Docker confirms the container is absent", async () => {
    const environment = createEnvironment({
      status: "running",
      containerId: "container-missing",
      environmentType: "containerized",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\n' 'Error: No such object: container-missing' >&2
exit 1
`,
      async () => {
        await commands.get("get_environments")?.({ projectId: environment.projectId }, context);
      },
    );

    expect(environment.containerId).toBeNull();
    expect(environment.status).toBe("stopped");
    expect(updates).toContainEqual({ status: "stopped", containerId: null });
  });

  test(
    "runs inactive container setup in the backend and persists completion",
    async () => {
      const environment = createEnvironment({
        id: "env-container-setup",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context, emitted } = createContext(environment);
      const commands = createCommandRegistry();

      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '1111111111111111111111111111111111111111\\n'
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
          await waitForPtyProcessCount(1);
          ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
          const updated = await setupPromise;

          expect(updated.setupScriptsComplete).toBe(true);
          expect(updated.createdFromCommit).toBe("1111111111111111111111111111111111111111");
          expect(environment.setupScriptsComplete).toBe(true);
          expect(environment.createdFromCommit).toBe("1111111111111111111111111111111111111111");
          const execLog = await fs.readFile(logs.exec, "utf8");
          expect(execLog).toContain("workspace-setup.sh --prepare-only");
          expect(execLog).toContain("git -C /workspace rev-parse --verify 'HEAD^{commit}'");
          expect(execLog.indexOf("workspace-setup.sh --prepare-only")).toBeLessThan(
            execLog.indexOf("git -C /workspace rev-parse --verify 'HEAD^{commit}'"),
          );
          expect(ptySpawn).toHaveBeenCalledWith(
            "docker",
            expect.arrayContaining([
              "exec",
              "-it",
              "container-1",
              "zsh",
              "-lc",
              expect.stringContaining("/usr/local/bin/workspace-setup.sh"),
            ]),
            expect.any(Object),
          );
          expect(ptySpawn.mock.calls[0]?.[1].at(-1)).toContain("flock");
          const setupOutput = emitted
            .filter((entry) => entry.event === `terminal-output-${environment.id}:setup`)
            .map((entry) => (entry.payload as { text: string }).text)
            .join("");
          expect(setupOutput).toContain("[orkestrator] Starting environment setup");
          expect(setupOutput).toContain("/usr/local/bin/workspace-setup.sh");
          const setupStarted = emitted
            .filter((entry) => entry.event === "environment-setup-started")
            .at(-1)?.payload;
          expect(setupStarted).toMatchObject({
            environment_id: environment.id,
            session_id: `${environment.id}:setup`,
            environment: {
              id: environment.id,
              setupScriptsComplete: false,
              createdFromCommit: environment.createdFromCommit,
            },
          });
          const setupComplete = emitted.find(
            (entry) => entry.event === "environment-setup-complete",
          )?.payload;
          expect(setupComplete).toMatchObject({
            environment_id: environment.id,
            success: true,
            environment: {
              id: updated.id,
              setupScriptsComplete: true,
              createdFromCommit: updated.createdFromCommit,
            },
          });
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "retries container baseline capture before any setup command runs",
    async () => {
      const environment = createEnvironment({
        id: "env-container-baseline-retry",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();

      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
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
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *--prepare-only*)
      exit 0
      ;;
    *rev-parse*)
      if [ ! -f "$FAKE_DOCKER_LOG.capture-failed" ]; then
        touch "$FAKE_DOCKER_LOG.capture-failed"
        printf 'transient capture failure\\n' >&2
        exit 1
      fi
      printf '4444444444444444444444444444444444444444\\n'
      exit 0
      ;;
  esac
fi
exit 0
`,
        async (logs) => {
          await expect(
            commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
          ).rejects.toThrow("transient capture failure");
          expect(ptySpawn).not.toHaveBeenCalled();
          expect(environment.setupScriptsComplete).toBe(false);
          expect(environment.createdFromCommit).toBeUndefined();

          const retry = commands.get("run_environment_setup")?.(
            { environmentId: environment.id },
            context,
          ) as Promise<Environment>;
          await waitForPtyProcessCount(1);
          expect(environment.createdFromCommit).toBe("4444444444444444444444444444444444444444");
          expect(environment.setupScriptsComplete).toBe(false);
          ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
          await expect(retry).resolves.toMatchObject({
            createdFromCommit: "4444444444444444444444444444444444444444",
            setupScriptsComplete: true,
          });

          const execLog = await fs.readFile(logs.exec, "utf8");
          expect(
            execLog
              .split("\n")
              .filter((line) => line.includes("workspace-setup.sh --prepare-only")),
          ).toHaveLength(2);
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "rejects an invalid container HEAD without starting setup",
    async () => {
      const environment = createEnvironment({
        id: "env-container-invalid-head",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
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
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*) printf 'not-a-commit\\n' ;;
  esac
  exit 0
fi
exit 0
`,
        async () => {
          await expect(
            commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
          ).rejects.toThrow("Could not resolve environment creation commit");
          expect(ptySpawn).not.toHaveBeenCalled();
          expect(environment.setupScriptsComplete).toBe(false);
          expect(environment.createdFromCommit).toBeUndefined();
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "preserves an existing baseline without preparing or recapturing HEAD",
    async () => {
      const originalCommit = "7777777777777777777777777777777777777777";
      const environment = createEnvironment({
        id: "env-container-existing-baseline",
        environmentType: "containerized",
        setupScriptsComplete: false,
        createdFromCommit: originalCommit,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();

      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
exit 0
`,
        async (logs) => {
          const setup = commands.get("run_environment_setup")?.(
            { environmentId: environment.id },
            context,
          ) as Promise<Environment>;
          await waitForPtyProcessCount(1);
          ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
          await expect(setup).resolves.toMatchObject({
            createdFromCommit: originalCommit,
            setupScriptsComplete: true,
          });

          const dockerLog = await fs.readFile(logs.all, "utf8");
          expect(dockerLog).not.toContain("--prepare-only");
          expect(dockerLog).not.toContain("rev-parse");
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("preserves a running environment and pending launch when setup fails before publishing an attempt", async () => {
    const worktreePath = await createTempDir("ork-electron-setup-invalid-config-");
    await fs.writeFile(path.join(worktreePath, "orkestrator-ai.json"), "{ invalid json");
    const environment = createEnvironment({
      id: "env-local-invalid-setup-config",
      environmentType: "local",
      setupScriptsComplete: false,
      setupPhase: "pending",
      createdFromCommit: "7878787878787878787878787878787878787878",
      worktreePath,
      containerId: null,
      status: "running",
      pendingAgentLaunch: true,
      initialAgentModel: "model-1",
      initialReasoningEffort: "high",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(
      commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow();

    expect(ptySpawn).not.toHaveBeenCalled();
    expect(environment).toMatchObject({
      status: "running",
      setupScriptsComplete: false,
      setupPhase: "failed",
      pendingAgentLaunch: true,
      initialAgentModel: "model-1",
      initialReasoningEffort: "high",
    });
  });

  test(
    "a failed baseline storage write blocks setup and succeeds on retry",
    async () => {
      const environment = createEnvironment({
        id: "env-container-baseline-storage-retry",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context, updates } = createContext(environment);
      let failBaselineWrite = true;
      context.storage.updateEnvironment = mock(
        async (environmentId: string, update: Partial<Environment>) => {
          if (environmentId !== environment.id)
            throw new Error(`Environment not found: ${environmentId}`);
          if (failBaselineWrite && update.createdFromCommit) {
            failBaselineWrite = false;
            throw new Error("baseline storage unavailable");
          }
          updates.push(update);
          Object.assign(environment, update);
          return environment;
        },
      ) as typeof context.storage.updateEnvironment;
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
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*) printf '5555555555555555555555555555555555555555\\n' ;;
  esac
  exit 0
fi
exit 0
`,
        async () => {
          await expect(
            commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
          ).rejects.toThrow("baseline storage unavailable");
          expect(ptySpawn).not.toHaveBeenCalled();
          expect(environment.setupScriptsComplete).toBe(false);

          const retry = commands.get("run_environment_setup")?.(
            { environmentId: environment.id },
            context,
          ) as Promise<Environment>;
          await waitForPtyProcessCount(1);
          ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
          await expect(retry).resolves.toMatchObject({
            createdFromCommit: "5555555555555555555555555555555555555555",
            setupScriptsComplete: true,
          });
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "serializes concurrent setup starts through one preparation and PTY",
    async () => {
      const environment = createEnvironment({
        id: "env-container-concurrent-setup",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();

      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
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
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*) printf '6666666666666666666666666666666666666666\\n' ;;
  esac
  exit 0
fi
exit 0
`,
        async (logs) => {
          const first = commands.get("run_environment_setup")?.(
            { environmentId: environment.id },
            context,
          ) as Promise<Environment>;
          const second = commands.get("run_environment_setup")?.(
            { environmentId: environment.id },
            context,
          ) as Promise<Environment>;
          await waitForPtyProcessCount(1);
          expect(ptySpawn).toHaveBeenCalledTimes(1);
          ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
          await expect(Promise.all([first, second])).resolves.toHaveLength(2);

          const execLog = await fs.readFile(logs.exec, "utf8");
          expect(
            execLog
              .split("\n")
              .filter((line) => line.includes("workspace-setup.sh --prepare-only")),
          ).toHaveLength(1);
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("returns completed container environments without rerunning backend setup", async () => {
    const environment = createEnvironment({
      id: "env-container-setup-complete",
      environmentType: "containerized",
      setupScriptsComplete: true,
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
exit 1
`,
      async () => {
        const result = await commands.get("run_environment_setup")?.(
          { environmentId: environment.id },
          context,
        );

        expect(result).toEqual(toClientEnvironment(environment));
        expect(emitted).toEqual([]);
      },
    );
  });

  test("ensures no-op local setup without spawning a terminal", async () => {
    const { worktree: worktreePath } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-local-noop-setup",
      environmentType: "local",
      setupScriptsComplete: false,
      worktreePath,
      containerId: null,
      status: "running",
    });
    const { context, emitted } = createContext(environment);
    const commands = createCommandRegistry();

    const result = await commands.get("ensure_environment_setup")?.(
      { environmentId: environment.id },
      context,
    );

    expect(result).toEqual(
      expect.objectContaining({
        setupStarted: false,
        environment: expect.objectContaining({
          id: environment.id,
          setupScriptsComplete: true,
        }),
      }),
    );
    expect(environment.setupScriptsComplete).toBe(true);
    expect(ptySpawn).not.toHaveBeenCalled();
    expect(emitted).toContainEqual({
      event: "environment-setup-complete",
      payload: {
        environment_id: environment.id,
        success: true,
        environment: expect.objectContaining({
          id: environment.id,
          setupScriptsComplete: true,
        }),
      },
    });
  });

  test(
    "spawns local setup commands in an interactive login PTY",
    async () => {
      const { worktree: worktreePath } = await createGitWorktreeWithOrigin();
      await fs.writeFile(
        path.join(worktreePath, "orkestrator-ai.json"),
        JSON.stringify({ setupLocal: ["bun install", "bun run prepare"] }),
      );
      const environment = createEnvironment({
        id: "env-local-setup-terminal",
        environmentType: "local",
        setupScriptsComplete: false,
        worktreePath,
        containerId: null,
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();

      const setupPromise = commands.get("run_environment_setup")?.(
        { environmentId: environment.id },
        context,
      ) as Promise<Environment>;
      await waitForPtyProcessCount(1);

      expect(ptySpawn.mock.calls[0]?.[0]).toBe(expectedLocalShellPath());
      expect(ptySpawn.mock.calls[0]?.[1]?.[0]).toBe("-ilc");
      expect(ptySpawn.mock.calls[0]?.[1]?.[1]).toContain("bun install && bun run prepare");
      expect(ptySpawn.mock.calls[0]?.[2]).toMatchObject({
        cwd: worktreePath,
        cols: 80,
        rows: 24,
      });

      ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
      await expect(setupPromise).resolves.toEqual(
        expect.objectContaining({ setupScriptsComplete: true }),
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "emits a failure event when inactive container setup fails",
    async () => {
      const environment = createEnvironment({
        id: "env-container-setup-fails",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
        // Seed the launch intent *and* both one-shot options, otherwise the
        // "must not survive" assertions below are vacuously true.
        pendingAgentLaunch: true,
        initialAgentModel: "claude-fable-5[1m]",
        initialReasoningEffort: "max",
      });
      const { context, emitted } = createContext(environment);
      const commands = createCommandRegistry();

      await withFakeDocker(
        `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '3333333333333333333333333333333333333333\n'
      ;;
  esac
  exit 0
fi
exit 0
`,
        async () => {
          const setupPromise = commands.get("run_environment_setup")?.(
            { environmentId: environment.id },
            context,
          ) as Promise<Environment>;
          await waitForPtyProcessCount(1);
          ptyProcesses[0]?.emitData(SETUP_FAILED_OSC);
          await expect(setupPromise).rejects.toThrow("Setup script failed");

          expect(environment.setupScriptsComplete).toBe(false);
          expect(environment.status).toBe("error");
          expect(environment.lifecycleError).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript);
          const failure = emitted.find(
            (entry) =>
              entry.event === "environment-setup-complete" &&
              (entry.payload as { success?: boolean }).success === false,
          );
          expect(failure?.payload).toMatchObject({
            environment_id: environment.id,
            success: false,
            error: "Setup script failed",
          });
          // A launch that can never be honoured must not survive the failure.
          expect(environment.pendingAgentLaunch).toBe(false);
          expect(environment.initialAgentModel).toBeUndefined();
          expect(environment.initialReasoningEffort).toBeUndefined();
          expect(
            (failure!.payload as { environment?: Environment }).environment?.pendingAgentLaunch,
          ).toBe(false);
          expect(
            (failure!.payload as { environment?: Environment }).environment?.initialAgentModel,
          ).toBeUndefined();
          expect(
            (failure!.payload as { environment?: Environment }).environment?.initialReasoningEffort,
          ).toBeUndefined();

          // A renderer may have been inactive when the one-shot event fired. The
          // failure must therefore survive a registry/backend reconstruction and be
          // available from an authoritative snapshot alone.
          const restartedRegistry = createCommandRegistry();
          await expect(
            restartedRegistry.get("get_environment_snapshots")?.(
              { projectId: environment.projectId },
              context,
            ),
          ).resolves.toEqual([
            expect.objectContaining({
              id: environment.id,
              status: "error",
              lifecycleError: ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript,
            }),
          ]);
          await expect(
            restartedRegistry.get("get_environments")?.(
              { projectId: environment.projectId },
              context,
            ),
          ).resolves.toEqual([
            expect.objectContaining({
              id: environment.id,
              status: "error",
              lifecycleError: ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript,
            }),
          ]);
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "completes setup when the done marker is split across PTY chunks",
    async () => {
      const environment = createEnvironment({
        id: "env-container-split-marker",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();

      await withFakeDocker(RUNNING_CONTAINER_DOCKER_SCRIPT, async () => {
        const setupPromise = commands.get("run_environment_setup")?.(
          { environmentId: environment.id },
          context,
        ) as Promise<Environment>;
        await waitForPtyProcessCount(1);
        // Deliver the completion marker split across two reads, mimicking how a
        // PTY can chunk output at an arbitrary boundary.
        const splitAt = Math.floor(SETUP_DONE_OSC.length / 2);
        ptyProcesses[0]?.emitData(SETUP_DONE_OSC.slice(0, splitAt));
        ptyProcesses[0]?.emitData(SETUP_DONE_OSC.slice(splitAt));
        const updated = await setupPromise;

        expect(updated.setupScriptsComplete).toBe(true);
        expect(environment.setupScriptsComplete).toBe(true);
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "fails setup when the PTY exits before reporting completion",
    async () => {
      const environment = createEnvironment({
        id: "env-container-early-exit",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context, emitted } = createContext(environment);
      const commands = createCommandRegistry();

      await withFakeDocker(RUNNING_CONTAINER_DOCKER_SCRIPT, async () => {
        const setupPromise = commands.get("run_environment_setup")?.(
          { environmentId: environment.id },
          context,
        ) as Promise<Environment>;
        await waitForPtyProcessCount(1);
        ptyProcesses[0]?.emitExit({ exitCode: 1 });
        await expect(setupPromise).rejects.toThrow(
          "Setup terminal exited before reporting completion",
        );

        expect(environment.setupScriptsComplete).toBe(false);
        expect(
          emitted.find(
            (entry) =>
              entry.event === "environment-setup-complete" &&
              (entry.payload as { success?: boolean }).success === false,
          )?.payload,
        ).toMatchObject({
          environment_id: environment.id,
          success: false,
          error: "Setup terminal exited before reporting completion",
        });
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "syncs the host gh auth token after starting a newly created container",
    async () => {
      const environment = createEnvironment({
        id: "env-container-create",
        environmentType: "containerized",
        worktreePath: undefined,
        containerId: null,
        status: "stopped",
        branch: "feature/container-create",
        networkAccessMode: "full",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();

      await withFakeGh(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "auth" ] && [ "$2" = "token" ]; then
  printf 'host-gh-token\\n'
  exit 0
fi
exit 1
`,
        async (ghLog) => {
          await withFakeDocker(
            `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create) printf 'container-created\\n'; exit 0 ;;
  start) exit 0 ;;
  inspect) printf 'running\\n'; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *github-token*)
        cat > "$FAKE_DOCKER_EXEC_LOG.stdin"
        exit 0
        ;;
      *ORKESTRATOR_SETUP_CAPABILITIES*)
        printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
        exit 0
        ;;
      *--prepare-only*)
        printf '\\036ORKESTRATOR_PREPARE_OK\\037'
        exit 0
        ;;
      *rev-parse*) printf '3333333333333333333333333333333333333333\\n' ;;
    esac
    exit 0
    ;;
esac
exit 0
`,
            async (logs) => {
              let result: unknown;
              try {
                result = await commands.get("start_environment")?.(
                  { environmentId: environment.id },
                  context,
                );
              } catch (error) {
                const dockerCalls = await fs.readFile(logs.all, "utf8").catch(() => "");
                const ghCalls = await fs.readFile(ghLog, "utf8").catch(() => "");
                throw new Error(
                  `${error instanceof Error ? error.message : String(error)}\nDocker calls:\n${dockerCalls}\nGH calls:\n${ghCalls}`,
                );
              }
              expect(result).toEqual(
                expect.objectContaining({
                  setupStarted: true,
                  setupSessionId: `${environment.id}:setup`,
                  environment: expect.objectContaining({
                    id: environment.id,
                    status: "running",
                  }),
                }),
              );
              await waitForPtyProcessCount(1);
              expect(ptySpawn.mock.calls[0]?.[1].at(-1)).toContain(
                "/usr/local/bin/workspace-setup.sh",
              );
              ptyProcesses[0]?.emitData(SETUP_DONE_OSC);

              const ghCalls = await fs.readFile(ghLog, "utf8").catch(() => "");
              expect(ghCalls).toContain("auth token --hostname github.com");

              const dockerCalls = await fs.readFile(logs.all, "utf8");
              expect(dockerCalls).not.toContain("-e GITHUB_TOKEN");
              expect(dockerCalls).not.toContain("-e GH_TOKEN");
              expect(dockerCalls).not.toContain("host-gh-token");
              expect(await fs.readFile(`${logs.exec}.stdin`, "utf8")).toBe("host-gh-token");
              expect(environment.containerId).toBe("container-created");

              const execCalls = await fs.readFile(logs.exec, "utf8");
              expect(execCalls).toMatch(/exec --user root container-created sh -c/);
              expect(execCalls).toContain(
                "chgrp -R node /project-files && chmod -R g+rX,o-rwx /project-files",
              );
            },
          );
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "accepts a background container start before Docker creation finishes",
    async () => {
      const environment = createEnvironment({
        id: "env-container-background",
        environmentType: "containerized",
        worktreePath: undefined,
        containerId: null,
        status: "stopped",
        setupScriptsComplete: true,
        pendingAgentLaunch: true,
        networkAccessMode: "full",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const gateDirectory = await createTempDir("ork-background-container-start-");
      const startedPath = path.join(gateDirectory, "started");
      const releasePath = path.join(gateDirectory, "release");
      const shellStartedPath = startedPath.replaceAll("'", "'\\''");
      const shellReleasePath = releasePath.replaceAll("'", "'\\''");

      await withFakeGh(
        `#!/bin/sh
exit 1
`,
        async () => {
          await withFakeDocker(
            `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    : > '${shellStartedPath}'
    while [ ! -f '${shellReleasePath}' ]; do sleep 0.01; done
    printf 'container-background\\n'
    ;;
  start|exec)
    exit 0
    ;;
esac
`,
            async () => {
              try {
                await expect(
                  commands.get("start_environment_background")?.(
                    { environmentId: environment.id },
                    context,
                  ),
                ).resolves.toBeUndefined();

                await waitForCondition(
                  () => existsSync(startedPath),
                  "background Docker create to begin",
                );
                expect(environment.status).toBe("creating");
                expect(environment.containerId).toBeNull();
                expect(environment.pendingAgentLaunch).toBe(true);
              } finally {
                await fs.writeFile(releasePath, "");
              }

              await waitForCondition(
                () => environment.status === "running",
                "background environment start to finish",
              );
              expect(environment.containerId).toBe("container-background");
              // The start task owns lifecycle only; the renderer clears this after it
              // has durably persisted the requested agent tab.
              expect(environment.pendingAgentLaunch).toBe(true);
            },
          );
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("rejects a background start before admission when the environment is missing or shutdown began", async () => {
    const commands = createCommandRegistry();
    const missing = createContext([]);
    await expect(
      commands.get("start_environment_background")?.(
        { environmentId: "missing-environment" },
        missing.context,
      ),
    ).rejects.toThrow("Environment not found: missing-environment");

    const environment = createEnvironment({
      id: "env-background-shutdown",
      status: "stopped",
      lifecycleError: "Previous failure",
    });
    const { context } = createContext(environment);
    await context.environmentLifecycleTasks.beginShutdown();
    await expect(
      commands.get("start_environment_background")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow("Backend is shutting down");
    expect(environment.status).toBe("stopped");
    expect(environment.lifecycleError).toBe("Previous failure");
  });

  test(
    "deduplicates concurrent background starts for one environment",
    async () => {
      const environment = createEnvironment({
        id: "env-background-deduplicated",
        environmentType: "containerized",
        containerId: null,
        status: "stopped",
        setupScriptsComplete: true,
        networkAccessMode: "full",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const gateDirectory = await createTempDir("ork-background-dedupe-");
      const releasePath = path.join(gateDirectory, "release");
      const shellReleasePath = releasePath.replaceAll("'", "'\\''");

      await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
        await withFakeDocker(
          `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    while [ ! -f '${shellReleasePath}' ]; do sleep 0.01; done
    printf 'container-deduplicated\\n'
    ;;
  start|exec) exit 0 ;;
esac
`,
          async (logs) => {
            await Promise.all([
              commands.get("start_environment_background")?.(
                { environmentId: environment.id },
                context,
              ),
              commands.get("start_environment_background")?.(
                { environmentId: environment.id },
                context,
              ),
            ]);
            await fs.writeFile(releasePath, "");
            await waitForCondition(
              () => environment.status === "running",
              "deduplicated background start to finish",
            );
            const calls = await fs.readFile(logs.all, "utf8");
            expect(calls.split("\n").filter((line) => line.startsWith("create "))).toHaveLength(1);
          },
        );
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "persists and logs only a safe background start failure",
    async () => {
      const secret = "https://user:private-token@example.invalid/private/repo.git";
      const environment = createEnvironment({
        id: "env-background-failure",
        environmentType: "containerized",
        containerId: null,
        status: "stopped",
        lifecycleError: "Old failure",
        setupScriptsComplete: true,
        networkAccessMode: "full",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const errorLog = spyOn(console, "error").mockImplementation(() => undefined);

      try {
        await withFakeDocker(
          `#!/bin/sh
if [ "$1" = "create" ]; then
  printf '%s\\n' '${secret}' >&2
  exit 1
fi
exit 0
`,
          async () => {
            await expect(
              commands.get("start_environment_background")?.(
                { environmentId: environment.id },
                context,
              ),
            ).resolves.toBeUndefined();
            await waitForCondition(
              () => environment.status === "error",
              "background failure to persist",
            );
          },
        );
        expect(environment.lifecycleError).toBe(
          "Environment start failed. Check the backend logs and retry.",
        );
        expect(JSON.stringify(errorLog.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(errorLog.mock.calls)).toContain(environment.lifecycleError);

        await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
          await withFakeDocker(
            `#!/bin/sh
case "$1" in
  create) printf 'container-after-retry\\n' ;;
  start|exec) exit 0 ;;
esac
`,
            async () => {
              await expect(
                commands.get("start_environment")?.({ environmentId: environment.id }, context),
              ).resolves.toEqual(
                expect.objectContaining({
                  environment: expect.objectContaining({
                    id: environment.id,
                    status: "running",
                  }),
                }),
              );
            },
          );
        });
        expect(environment.status).toBe("running");
        expect(environment.lifecycleError).toBeNull();
      } finally {
        errorLog.mockRestore();
      }
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("persists and rejects with the sanitized Git SSH authentication failure", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      id: "env-local-ssh-auth-failure",
      environmentType: "local",
      status: "stopped",
      worktreePath: undefined,
      branch: `ssh-auth-${randomUUID().slice(0, 8)}`,
    });
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: "ssh-auth-repo",
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
    });
    const commands = createCommandRegistry();
    const rawFailure =
      "git@example.invalid: Permission denied (publickey). Could not read from remote repository.";

    await withFailingGitSubcommand(
      "fetch",
      async () => {
        await expect(
          commands.get("start_environment")?.({ environmentId: environment.id }, context),
        ).rejects.toThrow(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitSshAuthentication);
      },
      rawFailure,
    );

    expect(environment.status).toBe("error");
    expect(environment.lifecycleError).toBe(
      ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.gitSshAuthentication,
    );
    expect(environment.lifecycleError).not.toContain("example.invalid");
  });

  test("removes a newly created container when persisting its identity fails", async () => {
    const environment = createEnvironment({
      id: "env-container-persist-compensation",
      environmentType: "containerized",
      containerId: null,
      status: "stopped",
      setupScriptsComplete: true,
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    const updateEnvironment = context.storage.updateEnvironment as ReturnType<typeof mock>;
    const originalImplementation = updateEnvironment.getMockImplementation();
    let rejectedContainerIdentity = false;
    updateEnvironment.mockImplementation(
      async (environmentId: string, update: Record<string, unknown>) => {
        if (!rejectedContainerIdentity && update.containerId === "container-unpersisted") {
          rejectedContainerIdentity = true;
          throw new Error("storage unavailable at /private/user/path");
        }
        return originalImplementation!(environmentId, update);
      },
    );
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create) printf 'container-unpersisted\\n' ;;
  rm) exit 0 ;;
esac
`,
      async (logs) => {
        await expect(
          commands.get("start_environment")?.({ environmentId: environment.id }, context),
        ).rejects.toThrow("storage unavailable");
        const calls = await fs.readFile(logs.all, "utf8");
        expect(calls).toContain("rm -f container-unpersisted");
        expect(environment.containerId).toBeNull();
        expect(environment.status).toBe("error");
        expect(environment.lifecycleError).not.toContain("/private/user/path");
      },
    );
  });

  test(
    "removes a newly created worktree and its branch when persisting them fails",
    async () => {
      const { worktree, remote } = await createGitWorktreeWithOrigin();
      const projectName = "rollback-repo";
      const branch = `worktree-rollback-${randomUUID().slice(0, 8)}`;
      const expectedWorktreePath = expectedManagedWorktreePath(projectName, branch);
      await fs.rm(expectedWorktreePath, { recursive: true, force: true });

      const environment = createEnvironment({
        id: "env-worktree-persist-compensation",
        status: "stopped",
        worktreePath: undefined,
        branch,
        environmentType: "local",
      });
      const { context } = createContext(environment, {
        project: {
          id: environment.projectId,
          name: projectName,
          gitUrl: remote,
          localPath: worktree,
          addedAt: new Date(0).toISOString(),
          order: 0,
        },
      });
      const updateEnvironment = context.storage.updateEnvironment as ReturnType<typeof mock>;
      const originalImplementation = updateEnvironment.getMockImplementation();
      updateEnvironment.mockImplementation(
        async (environmentId: string, update: Record<string, unknown>) => {
          // `createLocalWorktree` has already succeeded at this point, so the
          // compensation under test is the one in `startEnvironmentOnce`, not the
          // one inside worktree creation.
          if (update.worktreePath === expectedWorktreePath) {
            throw new Error("storage unavailable at /private/user/path");
          }
          return originalImplementation!(environmentId, update);
        },
      );
      const commands = createCommandRegistry();

      try {
        await expect(
          commands.get("start_environment")?.({ environmentId: environment.id }, context),
        ).rejects.toThrow("storage unavailable");

        expect(environment.status).toBe("error");
        expect(environment.worktreePath).toBeUndefined();
        expect(environment.lifecycleError).not.toContain("/private/user/path");
        // `git worktree add -b` created a branch as well as a directory. Leaving
        // it behind makes the next start pick `<slug>-1` and drift the branch
        // name further on every retry.
        await expectLocalWorktreeRolledBack(worktree, expectedWorktreePath, branch);
      } finally {
        updateEnvironment.mockImplementation(originalImplementation!);
        await fs.rm(expectedWorktreePath, { recursive: true, force: true });
        await runGit(worktree, ["branch", "-D", branch]).catch(() => undefined);
      }
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "queues a container stop behind background provisioning",
    async () => {
      const environment = createEnvironment({
        id: "env-background-stop-race",
        environmentType: "containerized",
        containerId: null,
        status: "stopped",
        setupScriptsComplete: true,
        pendingAgentLaunch: true,
        networkAccessMode: "full",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const gateDirectory = await createTempDir("ork-background-stop-race-");
      const startedPath = path.join(gateDirectory, "started");
      const releasePath = path.join(gateDirectory, "release");

      await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
        await withFakeDocker(
          `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    : > '${startedPath.replaceAll("'", "'\\''")}'
    while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
    printf 'container-stop-race\\n'
    ;;
  start|stop|exec) exit 0 ;;
esac
`,
          async (logs) => {
            await commands.get("start_environment_background")?.(
              { environmentId: environment.id },
              context,
            );
            await waitForCondition(() => existsSync(startedPath), "container create to begin");
            const stop = commands.get("stop_environment")?.(
              { environmentId: environment.id },
              context,
            );
            await fs.writeFile(releasePath, "");
            await expect(stop).resolves.toBeUndefined();
            expect(environment.status).toBe("stopped");
            expect(environment.pendingAgentLaunch).toBe(false);
            const calls = await fs.readFile(logs.all, "utf8");
            expect(calls.indexOf("start container-stop-race")).toBeLessThan(
              calls.indexOf("stop container-stop-race"),
            );
          },
        );
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "queues container deletion behind provisioning and removes the created resource",
    async () => {
      const environment = createEnvironment({
        id: "env-background-delete-race",
        environmentType: "containerized",
        containerId: null,
        status: "stopped",
        setupScriptsComplete: true,
        networkAccessMode: "full",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const gateDirectory = await createTempDir("ork-background-delete-race-");
      const startedPath = path.join(gateDirectory, "started");
      const releasePath = path.join(gateDirectory, "release");

      await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
        await withFakeDocker(
          `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    : > '${startedPath.replaceAll("'", "'\\''")}'
    while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
    printf 'container-delete-race\\n'
    ;;
  start|exec|rm) exit 0 ;;
esac
`,
          async (logs) => {
            await commands.get("start_environment_background")?.(
              { environmentId: environment.id },
              context,
            );
            await waitForCondition(() => existsSync(startedPath), "container create to begin");
            const deletion = commands.get("delete_environment")?.(
              { environmentId: environment.id },
              context,
            );
            await fs.writeFile(releasePath, "");
            await expect(deletion).resolves.toBeUndefined();
            await expect(context.storage.getEnvironment(environment.id)).resolves.toBeNull();
            const calls = await fs.readFile(logs.all, "utf8");
            expect(calls).toContain("rm -f container-delete-race");
          },
        );
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "queues a local stop behind a background start",
    async () => {
      const worktreePath = await createGitRepoOnBranch("feature-local-start-stop");
      const environment = createEnvironment({
        id: "env-local-background-stop-race",
        environmentType: "local",
        worktreePath,
        branch: "feature-local-start-stop",
        status: "stopped",
        setupScriptsComplete: true,
        pendingAgentLaunch: true,
      });
      const { context } = createContext(environment);
      const updateEnvironment = context.storage.updateEnvironment as ReturnType<typeof mock>;
      const originalImplementation = updateEnvironment.getMockImplementation();
      let announceCreating!: () => void;
      let releaseCreating!: () => void;
      const creatingStarted = new Promise<void>((resolve) => {
        announceCreating = resolve;
      });
      const creatingRelease = new Promise<void>((resolve) => {
        releaseCreating = resolve;
      });
      updateEnvironment.mockImplementation(
        async (environmentId: string, update: Record<string, unknown>) => {
          if (update.status === "creating") {
            announceCreating();
            await creatingRelease;
          }
          return originalImplementation!(environmentId, update);
        },
      );
      const commands = createCommandRegistry();

      await commands.get("start_environment_background")?.(
        { environmentId: environment.id },
        context,
      );
      await creatingStarted;
      const stop = commands.get("stop_environment")?.({ environmentId: environment.id }, context);
      releaseCreating();
      await expect(stop).resolves.toBeUndefined();
      expect(environment.status).toBe("stopped");
      expect(environment.pendingAgentLaunch).toBe(false);
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "queues stop behind container recreation without orphaning the replacement",
    async () => {
      const environment = createEnvironment({
        id: "env-recreate-stop-race",
        environmentType: "containerized",
        containerId: "container-old",
        status: "running",
        setupScriptsComplete: true,
        networkAccessMode: "full",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const gateDirectory = await createTempDir("ork-recreate-stop-race-");
      const startedPath = path.join(gateDirectory, "started");
      const releasePath = path.join(gateDirectory, "release");

      await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
        await withFakeDocker(
          `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1:$2" in
  rm:-f)
    : > '${startedPath.replaceAll("'", "'\\''")}'
    while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
    ;;
esac
case "$1" in
  create) printf 'container-replacement\\n' ;;
  start|stop|exec|rm) exit 0 ;;
esac
`,
          async (logs) => {
            const recreate = commands.get("recreate_environment")?.(
              { environmentId: environment.id },
              context,
            );
            await waitForCondition(() => existsSync(startedPath), "container removal to begin");
            const stop = commands.get("stop_environment")?.(
              { environmentId: environment.id },
              context,
            );
            await fs.writeFile(releasePath, "");
            await expect(recreate).resolves.toEqual(
              expect.objectContaining({
                environment: expect.objectContaining({
                  id: environment.id,
                  containerId: "container-replacement",
                }),
              }),
            );
            await expect(stop).resolves.toBeUndefined();
            expect(environment.containerId).toBe("container-replacement");
            expect(environment.status).toBe("stopped");
            const calls = await fs.readFile(logs.all, "utf8");
            expect(calls).toContain("rm -f container-old");
            expect(calls).toContain("stop container-replacement");
          },
        );
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("refuses to delete a merging environment without reserving the tombstone", async () => {
    const environment = createEnvironment({
      id: "env-delete-while-merging",
      environmentType: "local",
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    commandTesting.markEnvironmentMerging(environment.id);

    await expect(
      commands.get("delete_environment")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow("Environment is currently being merged");
    // Reserving before the refusal would block local-server starts and further
    // merges for an environment that is not being deleted at all.
    expect(commandTesting.isEnvironmentDeleting(environment.id)).toBe(false);
  });

  test("rejects starts while deletion is reserved before cleanup settles", async () => {
    const worktreePath = await createTempDir("ork-start-while-delete-reserved-");
    const environment = createEnvironment({
      id: "env-start-while-delete-reserved",
      environmentType: "local",
      containerId: null,
      worktreePath,
      status: "running",
      setupScriptsComplete: true,
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    let announceTermination!: () => void;
    let releaseTermination!: (terminated: boolean) => void;
    const terminationStarted = new Promise<void>((resolve) => {
      announceTermination = resolve;
    });
    const terminationResult = new Promise<boolean>((resolve) => {
      releaseTermination = resolve;
    });
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, createFakeChild(95050));
    commandTesting.setTerminateProcessTree(async () => {
      announceTermination();
      return terminationResult;
    });

    const deletion = commands.get("delete_environment")?.(
      { environmentId: environment.id },
      context,
    );
    await terminationStarted;
    expect(commandTesting.isEnvironmentDeleting(environment.id)).toBe(true);

    await expect(
      commands.get("start_environment")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow(`Environment is being deleted: ${environment.id}`);
    await expect(
      commands.get("start_environment_background")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow(`Environment is being deleted: ${environment.id}`);

    releaseTermination(false);
    await expect(deletion).rejects.toThrow("Failed to stop all local servers");
    commandTesting.setTerminateProcessTree(async () => true);
  });

  test("rejects starts carrying a durable deletion tombstone", async () => {
    const environment = createEnvironment({
      id: "env-start-with-delete-tombstone",
      environmentType: "containerized",
      containerId: "container-delete-tombstone",
      status: "stopped",
      setupScriptsComplete: true,
      deletionRequestedAt: "2026-07-29T10:00:00.000Z",
    });
    const { context, updates } = createContext(environment);
    const commands = createCommandRegistry();

    await expect(
      commands.get("start_environment")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow(`Environment is being deleted: ${environment.id}`);
    await expect(
      commands.get("start_environment_background")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow(`Environment is being deleted: ${environment.id}`);
    expect(updates).toHaveLength(0);
  });

  test(
    "rechecks a durable deletion tombstone when a queued start executes",
    async () => {
      const environment = createEnvironment({
        id: "env-queued-start-delete-tombstone",
        environmentType: "containerized",
        containerId: "container-queued-delete-tombstone",
        status: "running",
        setupScriptsComplete: true,
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const gateDirectory = await createTempDir("ork-queued-start-delete-tombstone-");
      const stopStartedPath = path.join(gateDirectory, "stop-started");
      const releaseStopPath = path.join(gateDirectory, "release-stop");
      const errorLog = spyOn(console, "error").mockImplementation(() => undefined);

      try {
        await withFakeDocker(
          `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "stop" ]; then
  : > '${stopStartedPath.replaceAll("'", "'\\''")}'
  while [ ! -f '${releaseStopPath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
  exit 0
fi
exit 0
`,
          async ({ all }) => {
            const stop = commands.get("stop_environment")?.(
              { environmentId: environment.id },
              context,
            );
            await waitForCondition(() => existsSync(stopStartedPath), "container stop to begin");
            await commands.get("start_environment_background")?.(
              { environmentId: environment.id },
              context,
            );

            // This represents deletion intent persisted while the accepted start
            // was waiting behind an earlier lifecycle operation.
            environment.deletionRequestedAt = "2026-07-29T11:00:00.000Z";
            await fs.writeFile(releaseStopPath, "");
            await expect(stop).resolves.toBeUndefined();
            await waitForCondition(
              () =>
                errorLog.mock.calls.some(([message]) =>
                  String(message).includes("background start failed"),
                ),
              "queued start rejection",
            );

            const calls = await fs.readFile(all, "utf8");
            expect(calls.split("\n").filter((line) => line.startsWith("start "))).toHaveLength(0);
            expect(environment.status).toBe("stopped");
            expect(environment.deletionRequestedAt).toBe("2026-07-29T11:00:00.000Z");
          },
        );
      } finally {
        errorLog.mockRestore();
      }
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("refuses deletion while local servers are shutting down", async () => {
    const environment = createEnvironment({
      id: "env-delete-during-shutdown",
      environmentType: "local",
      containerId: null,
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    closeLocalServerAdmission();

    await expect(
      commands.get("delete_environment")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow("Backend is shutting down");
    expect(commandTesting.isEnvironmentDeleting(environment.id)).toBe(false);
  });

  test(
    "deduplicates concurrent foreground starts for one environment",
    async () => {
      const environment = createEnvironment({
        id: "env-foreground-deduplicated",
        environmentType: "containerized",
        containerId: null,
        status: "stopped",
        setupScriptsComplete: true,
        networkAccessMode: "full",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const gateDirectory = await createTempDir("ork-foreground-dedupe-");
      const releasePath = path.join(gateDirectory, "release");

      await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
        await withFakeDocker(
          `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
    printf 'container-foreground-dedupe\\n'
    ;;
  start|exec) exit 0 ;;
esac
`,
          async (logs) => {
            const first = commands.get("start_environment")?.(
              { environmentId: environment.id },
              context,
            );
            const second = commands.get("start_environment")?.(
              { environmentId: environment.id },
              context,
            );
            await fs.writeFile(releasePath, "");
            await Promise.all([first, second]);

            const calls = await fs.readFile(logs.all, "utf8");
            expect(calls.split("\n").filter((line) => line.startsWith("create "))).toHaveLength(1);
          },
        );
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "clears a stale failure only once the stop has actually committed",
    async () => {
      const environment = createEnvironment({
        id: "env-stop-clears-failure",
        environmentType: "containerized",
        containerId: "container-stop-failure",
        status: "error",
        lifecycleError: "The container runtime is unavailable. Start it and retry.",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();

      await withFakeDocker(
        `#!/bin/sh
if [ "$1" = "stop" ]; then
  printf 'container runtime refused stop\\n' >&2
  exit 1
fi
exit 0
`,
        async () => {
          await expect(
            commands.get("stop_environment")?.({ environmentId: environment.id }, context),
          ).rejects.toThrow("container runtime refused stop");
        },
      );
      // Clearing ahead of the stop would have erased the only explanation the
      // user has, leaving an environment in `error` with nothing to show.
      expect(environment.status).toBe("error");
      expect(environment.lifecycleError).toBe(
        "The container runtime is unavailable. Start it and retry.",
      );

      await withFakeDocker("#!/bin/sh\nexit 0\n", async () => {
        await expect(
          commands.get("stop_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeUndefined();
      });
      expect(environment.status).toBe("stopped");
      expect(environment.lifecycleError).toBeNull();
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("keeps a local stop failure's explanation while still recording the stop", async () => {
    const worktreePath = await createTempDir("ork-electron-stop-local-keeps-error-");
    const environment = createEnvironment({
      id: "env-stop-local-keeps-error",
      environmentType: "local",
      containerId: null,
      worktreePath,
      status: "error",
      lifecycleError: "Environment start failed. Check the backend logs and retry.",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, createFakeChild(95010));
    commandTesting.setTerminateProcessTree(async () => false);

    await expect(
      commands.get("stop_environment")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow("Failed to stop all local servers");

    // Partial progress is recorded so the environment is not stranded, but the
    // failure it was already carrying is not silently erased by a stop that
    // itself failed.
    expect(environment.status).toBe("stopped");
    expect(environment.lifecycleError).toBe(
      "Environment start failed. Check the backend logs and retry.",
    );

    commandTesting.setTerminateProcessTree(async () => true);
  });

  test(
    "queues a recreate behind an in-flight start instead of interleaving it",
    async () => {
      const environment = createEnvironment({
        id: "env-start-recreate-race",
        environmentType: "containerized",
        containerId: null,
        status: "stopped",
        setupScriptsComplete: true,
        networkAccessMode: "full",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const gateDirectory = await createTempDir("ork-start-recreate-race-");
      const startedPath = path.join(gateDirectory, "started");
      const releasePath = path.join(gateDirectory, "release");

      await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
        await withFakeDocker(
          `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    if [ ! -f '${startedPath.replaceAll("'", "'\\''")}' ]; then
      : > '${startedPath.replaceAll("'", "'\\''")}'
      while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
      printf 'container-first\\n'
    else
      printf 'container-recreated\\n'
    fi
    ;;
  start|stop|exec|rm) exit 0 ;;
esac
`,
          async (logs) => {
            await commands.get("start_environment_background")?.(
              { environmentId: environment.id },
              context,
            );
            await waitForCondition(
              () => existsSync(startedPath),
              "first container create to begin",
            );
            const recreate = commands.get("recreate_environment")?.(
              { environmentId: environment.id },
              context,
            );
            await fs.writeFile(releasePath, "");
            await expect(recreate).resolves.toEqual(
              expect.objectContaining({
                environment: expect.objectContaining({
                  id: environment.id,
                  containerId: "container-recreated",
                  status: "running",
                }),
              }),
            );

            expect(environment.containerId).toBe("container-recreated");
            expect(environment.status).toBe("running");
            const calls = await fs.readFile(logs.all, "utf8");
            // The recreate observed the container the start had produced, which is
            // only possible if it ran after that start committed rather than
            // alongside it.
            expect(calls.indexOf("start container-first")).toBeLessThan(
              calls.indexOf("rm -f container-first"),
            );
          },
        );
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "a start requested after a stop does not join the start the stop will undo",
    async () => {
      const environment = createEnvironment({
        id: "env-start-dedupe-invalidated",
        environmentType: "containerized",
        containerId: null,
        status: "stopped",
        setupScriptsComplete: true,
        networkAccessMode: "full",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const gateDirectory = await createTempDir("ork-start-dedupe-invalidated-");
      const startedPath = path.join(gateDirectory, "started");
      const releasePath = path.join(gateDirectory, "release");

      await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
        await withFakeDocker(
          `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    : > '${startedPath.replaceAll("'", "'\\''")}'
    while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
    printf 'container-dedupe\\n'
    ;;
  start|stop|exec) exit 0 ;;
esac
`,
          async () => {
            await commands.get("start_environment_background")?.(
              { environmentId: environment.id },
              context,
            );
            await waitForCondition(() => existsSync(startedPath), "container create to begin");

            const stop = commands.get("stop_environment")?.(
              { environmentId: environment.id },
              context,
            );
            // Joining the in-flight start here would resolve as soon as that start
            // finished — before the stop that is already queued ahead of it — and
            // report a running environment the user had asked to be stopped.
            const restart = commands.get("start_environment")?.(
              { environmentId: environment.id },
              context,
            );
            await fs.writeFile(releasePath, "");

            await expect(stop).resolves.toBeUndefined();
            await expect(restart).resolves.toEqual(
              expect.objectContaining({
                environment: expect.objectContaining({
                  id: environment.id,
                  status: "running",
                }),
              }),
            );
            expect(environment.status).toBe("running");
          },
        );
      });
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "runs work queued behind a lifecycle operation that rejected",
    async () => {
      const environment = createEnvironment({
        id: "env-queue-not-poisoned",
        environmentType: "containerized",
        containerId: null,
        status: "stopped",
        setupScriptsComplete: true,
        networkAccessMode: "full",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const gateDirectory = await createTempDir("ork-queue-not-poisoned-");
      const startedPath = path.join(gateDirectory, "started");
      const releasePath = path.join(gateDirectory, "release");
      const errorLog = spyOn(console, "error").mockImplementation(() => undefined);

      try {
        await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
          await withFakeDocker(
            `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    : > '${startedPath.replaceAll("'", "'\\''")}'
    while [ ! -f '${releasePath.replaceAll("'", "'\\''")}' ]; do sleep 0.01; done
    printf 'provisioning refused\\n' >&2
    exit 1
    ;;
  start|stop|exec) exit 0 ;;
esac
`,
            async () => {
              await commands.get("start_environment_background")?.(
                { environmentId: environment.id },
                context,
              );
              await waitForCondition(() => existsSync(startedPath), "container create to begin");
              // Queued while the predecessor is still running, so it can only run
              // through the rejected tail.
              const stop = commands.get("stop_environment")?.(
                { environmentId: environment.id },
                context,
              );
              await fs.writeFile(releasePath, "");

              await expect(stop).resolves.toBeUndefined();
              expect(environment.status).toBe("stopped");
            },
          );
        });
      } finally {
        errorLog.mockRestore();
      }
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "recreates a container even when the old one cannot be removed",
    async () => {
      const environment = createEnvironment({
        id: "env-recreate-remove-failure",
        environmentType: "containerized",
        containerId: "container-still-present",
        status: "running",
        setupScriptsComplete: true,
        networkAccessMode: "full",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const errorLog = spyOn(console, "error").mockImplementation(() => undefined);

      try {
        // Recreate is the repair action for an already-broken container, so a
        // daemon that refuses the removal must not be what makes the environment
        // permanently unrepairable from the UI.
        await withFakeGh("#!/bin/sh\nexit 1\n", async () => {
          await withFakeDocker(
            `#!/bin/sh
case "$1" in
  rm)
    printf 'container runtime refused removal\\n' >&2
    exit 1
    ;;
  create) printf 'container-after-recreate\\n' ;;
  start|exec) exit 0 ;;
esac
`,
            async () => {
              await expect(
                commands.get("recreate_environment")?.({ environmentId: environment.id }, context),
              ).resolves.toEqual(
                expect.objectContaining({
                  environment: expect.objectContaining({
                    id: environment.id,
                    containerId: "container-after-recreate",
                    status: "running",
                  }),
                }),
              );
            },
          );
        });

        expect(environment.containerId).toBe("container-after-recreate");
        expect(environment.status).toBe("running");
        expect(environment.lifecycleError).toBeNull();
        // The daemon-level cause is still recoverable from the backend logs.
        expect(JSON.stringify(errorLog.mock.calls)).toContain("container runtime refused removal");
      } finally {
        errorLog.mockRestore();
      }
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "stages configured gitignored files into new container environments",
    async () => {
      const projectPath = await createTempDir("ork-electron-container-copy-source-");
      await runGit(projectPath, ["init"]);
      await runGit(projectPath, ["checkout", "-b", "main"]);
      await fs.writeFile(
        path.join(projectPath, ".gitignore"),
        "environments.json\nnested/secret.json\n",
      );
      await runGit(projectPath, ["add", ".gitignore"]);
      await runGit(projectPath, ["commit", "-m", "ignore copied files"]);
      await fs.mkdir(path.join(projectPath, "nested"), { recursive: true });
      await fs.writeFile(path.join(projectPath, "environments.json"), '{"copied":true}\n');
      await fs.writeFile(path.join(projectPath, "nested", "secret.json"), '{"nested":true}\n');
      await runGit(projectPath, ["check-ignore", "environments.json"]);

      const environment = createEnvironment({
        id: "env-container-copy",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: null,
        status: "stopped",
        networkAccessMode: "full",
      });
      const { context } = createContext(environment, {
        project: {
          id: environment.projectId,
          name: "Copy Source",
          gitUrl: "https://github.com/acme/copy-source.git",
          localPath: projectPath,
          addedAt: new Date(0).toISOString(),
          order: 0,
        },
        repositoryConfig: {
          defaultBranch: "main",
          prBaseBranch: "main",
          filesToCopy: ["environments.json", "nested/secret.json"],
        },
      });
      const commands = createCommandRegistry();

      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    printf 'container-copy-created\\n'
    exit 0
    ;;
  cp)
    src="$2"
    cat "$src/environments.json" > "$FAKE_DOCKER_LOG.container-copy-root"
    cat "$src/nested/secret.json" > "$FAKE_DOCKER_LOG.container-copy-nested"
    printf '%s\\n' "$3" > "$FAKE_DOCKER_LOG.container-copy-dest"
    exit 0
    ;;
  start)
    exit 0
    ;;
  inspect)
    printf 'running\\n'
    exit 0
    ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *ORKESTRATOR_SETUP_CAPABILITIES*)
        printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
        exit 0
        ;;
      *--prepare-only*)
        printf '\\036ORKESTRATOR_PREPARE_OK\\037'
        exit 0
        ;;
      *rev-parse*) printf '4444444444444444444444444444444444444444\\n' ;;
    esac
    exit 0
    ;;
esac
exit 0
`,
        async (logs) => {
          let result: unknown;
          try {
            result = await commands.get("start_environment")?.(
              { environmentId: environment.id },
              context,
            );
          } catch (error) {
            const dockerCalls = await fs.readFile(logs.all, "utf8").catch(() => "");
            const copiedRoot = await fs
              .readFile(`${logs.all}.container-copy-root`, "utf8")
              .catch(() => "");
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}\nDocker calls:\n${dockerCalls}\nCopied root:\n${copiedRoot}`,
            );
          }
          expect(result).toEqual(
            expect.objectContaining({
              setupStarted: true,
              setupSessionId: `${environment.id}:setup`,
              environment: expect.objectContaining({
                id: environment.id,
                containerId: "container-copy-created",
                status: "running",
              }),
            }),
          );
          await waitForPtyProcessCount(1);
          ptyProcesses[0]?.emitData(SETUP_DONE_OSC);

          await expect(fs.readFile(`${logs.all}.container-copy-root`, "utf8")).resolves.toBe(
            '{"copied":true}\n',
          );
          await expect(fs.readFile(`${logs.all}.container-copy-nested`, "utf8")).resolves.toBe(
            '{"nested":true}\n',
          );
          await expect(fs.readFile(`${logs.all}.container-copy-dest`, "utf8")).resolves.toBe(
            "container-copy-created:/project-files\n",
          );
          expect(environment.containerId).toBe("container-copy-created");

          const execCalls = await fs.readFile(logs.exec, "utf8");
          expect(execCalls).toMatch(/exec --user root container-copy-created sh -c/);
          expect(execCalls).toContain(
            "chgrp -R node /project-files && chmod -R g+rX,o-rwx /project-files",
          );
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("removes a newly created container when configured file docker copy fails", async () => {
    const projectPath = await createTempDir("ork-electron-container-copy-fail-source-");
    await fs.writeFile(path.join(projectPath, "settings.json"), '{"copied":true}\n');

    const environment = createEnvironment({
      id: "env-container-copy-fail",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: "Copy Failure",
        gitUrl: "https://github.com/acme/copy-failure.git",
        localPath: projectPath,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: {
        defaultBranch: "main",
        prBaseBranch: "main",
        filesToCopy: ["settings.json"],
      },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    printf 'container-copy-fail\\n'
    exit 0
    ;;
  cp)
    exit 42
    ;;
  rm)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_RM_LOG"
    exit 0
    ;;
esac
exit 0
`,
      async (logs) => {
        await expect(
          commands.get("start_environment")?.({ environmentId: environment.id }, context),
        ).rejects.toThrow();

        const dockerCalls = (await fs.readFile(logs.all, "utf8")).split("\n").filter(Boolean);
        expect(dockerCalls.some((line) => line.startsWith("create "))).toBe(true);
        expect(dockerCalls.some((line) => line.startsWith("cp "))).toBe(true);
        expect(dockerCalls.some((line) => line.startsWith("start "))).toBe(false);
        await expect(fs.readFile(logs.rm, "utf8")).resolves.toBe("rm -f container-copy-fail\n");
        expect(environment.status).toBe("error");
        expect(environment.containerId).toBeNull();
      },
    );
  });

  test("rejects configured container file symlinks that escape the project and removes the container", async () => {
    const projectPath = await createTempDir("ork-electron-container-copy-symlink-source-");
    const outsidePath = path.join(
      await createTempDir("ork-electron-container-copy-outside-"),
      "secret.json",
    );
    await fs.writeFile(outsidePath, '{"outside":true}\n');
    await fs.symlink(outsidePath, path.join(projectPath, "secret-link.json"));

    const environment = createEnvironment({
      id: "env-container-copy-symlink",
      environmentType: "containerized",
      setupScriptsComplete: false,
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: "Copy Symlink",
        gitUrl: "https://github.com/acme/copy-symlink.git",
        localPath: projectPath,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: {
        defaultBranch: "main",
        prBaseBranch: "main",
        filesToCopy: ["secret-link.json"],
      },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  create)
    printf 'container-symlink-fail\\n'
    exit 0
    ;;
  rm)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_RM_LOG"
    exit 0
    ;;
esac
exit 0
`,
      async (logs) => {
        await expect(
          commands.get("start_environment")?.({ environmentId: environment.id }, context),
        ).rejects.toThrow("Configured file to copy must stay inside the project: secret-link.json");

        const dockerCalls = (await fs.readFile(logs.all, "utf8")).split("\n").filter(Boolean);
        expect(dockerCalls.some((line) => line.startsWith("create "))).toBe(true);
        expect(dockerCalls.some((line) => line.startsWith("cp "))).toBe(false);
        expect(dockerCalls.some((line) => line.startsWith("start "))).toBe(false);
        await expect(fs.readFile(logs.rm, "utf8")).resolves.toBe("rm -f container-symlink-fail\n");
        expect(environment.status).toBe("error");
        expect(environment.containerId).toBeNull();
      },
    );
  });

  test("creates local worktrees from the fetched remote base branch", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const updater = await createTempDir("ork-electron-remote-updater-");
    await runGit(updater, ["clone", remote, "."]);
    await runGit(updater, ["checkout", "main"]);
    await fs.writeFile(path.join(updater, "tracked.txt"), "remote\n");
    await runGit(updater, ["add", "tracked.txt"]);
    await runGit(updater, ["commit", "-m", "remote update"]);
    await runGit(updater, ["push", "origin", "main"]);

    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: "feature/remote-base",
      environmentType: "local",
    });
    const projectName = `Remote Base ${randomUUID().slice(0, 8)}`;
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: projectName,
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
      expect(environment.branch).toBe("feature-remote-base");
      expect(await fs.readFile(path.join(environment.worktreePath!, "tracked.txt"), "utf8")).toBe(
        "remote\n",
      );
      expect(environment.createdFromCommit).toMatch(/^[0-9a-f]{40}$/);
      await expect(currentGitCommit(environment.worktreePath!)).resolves.toBe(
        environment.createdFromCommit,
      );
      await expect(configuredGitPushBehaviour(environment.worktreePath!)).resolves.toEqual({
        pushDefault: "current",
        autoSetupRemote: "true",
      });
      // Scoped to the worktree: how `git push` behaves in the user's own checkout of
      // their project is not this application's decision to make.
      await expect(configuredGitPushBehaviour(worktree)).resolves.toEqual({
        pushDefault: "",
        autoSetupRemote: "",
      });
      // The branch starts from origin/main but must not adopt it as an upstream, and
      // must not claim a same-named upstream that does not exist yet either: that is
      // what would make `git status` report a gone upstream and `git pull` fail.
      await expect(
        configuredGitUpstream(environment.worktreePath!, "feature-remote-base"),
      ).resolves.toEqual({
        remote: "",
        merge: "",
      });
      expect(await gitOutput(environment.worktreePath!, ["status", "-sb"])).toBe(
        "## feature-remote-base",
      );

      // A plain `git push` has to publish the environment branch and leave the base
      // branch it was created from exactly where it was.
      const baseBefore = await gitOutput(remote, ["rev-parse", "refs/heads/main"]);
      await fs.writeFile(path.join(environment.worktreePath!, "tracked.txt"), "environment\n");
      await runGit(environment.worktreePath!, ["commit", "-am", "environment commit"]);
      await runGit(environment.worktreePath!, ["push"]);
      expect(await gitOutput(remote, ["rev-parse", "refs/heads/feature-remote-base"])).toBe(
        await gitOutput(environment.worktreePath!, ["rev-parse", "HEAD"]),
      );
      expect(await gitOutput(remote, ["rev-parse", "refs/heads/main"])).toBe(baseBefore);
      await expect(
        configuredGitUpstream(environment.worktreePath!, "feature-remote-base"),
      ).resolves.toEqual({
        remote: "origin",
        merge: "refs/heads/feature-remote-base",
      });
    } finally {
      if (environment.worktreePath)
        await fs.rm(environment.worktreePath, { recursive: true, force: true });
    }
  });

  test("copies configured gitignored files into new local worktrees", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await fs.writeFile(
      path.join(worktree, ".gitignore"),
      "environments.json\nnested/secret.json\n",
    );
    await runGit(worktree, ["add", ".gitignore"]);
    await runGit(worktree, ["commit", "-m", "ignore copied files"]);
    await runGit(worktree, ["push", "origin", "main"]);
    await fs.mkdir(path.join(worktree, "nested"), { recursive: true });
    await fs.writeFile(path.join(worktree, "environments.json"), '{"local":true}\n');
    await fs.writeFile(path.join(worktree, "nested", "secret.json"), '{"nested":true}\n');
    await runGit(worktree, ["check-ignore", "environments.json"]);

    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: "feature/copy-files",
      environmentType: "local",
    });
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: `Copy Files ${randomUUID().slice(0, 8)}`,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: {
        defaultBranch: "main",
        prBaseBranch: "main",
        filesToCopy: ["environments.json", "nested/secret.json"],
      },
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
      expect(
        await fs.readFile(path.join(environment.worktreePath!, "environments.json"), "utf8"),
      ).toBe('{"local":true}\n');
      expect(
        await fs.readFile(path.join(environment.worktreePath!, "nested", "secret.json"), "utf8"),
      ).toBe('{"nested":true}\n');
    } finally {
      if (environment.worktreePath)
        await fs.rm(environment.worktreePath, { recursive: true, force: true });
    }
  });

  test("rolls back a local worktree when a configured file is missing", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const suffix = randomUUID().slice(0, 8);
    const projectName = `copy-missing-${suffix}`;
    const branch = `copy-missing-${suffix}`;
    const expectedWorktreePath = expectedManagedWorktreePath(projectName, branch);
    await fs.rm(expectedWorktreePath, { recursive: true, force: true });

    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch,
      environmentType: "local",
    });
    const { context, updates } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: projectName,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: {
        defaultBranch: "main",
        prBaseBranch: "main",
        filesToCopy: ["missing.json"],
      },
    });
    const commands = createCommandRegistry();

    try {
      await expect(
        commands.get("start_environment")?.({ environmentId: environment.id }, context),
      ).rejects.toThrow("Configured file to copy not found: missing.json");

      expect(environment.status).toBe("error");
      expect(environment.worktreePath).toBeUndefined();
      expect(updates.map((update) => update.status)).toEqual(["creating", "error"]);
      await expectLocalWorktreeRolledBack(worktree, expectedWorktreePath, branch);
    } finally {
      await fs.rm(expectedWorktreePath, { recursive: true, force: true });
      await runGit(worktree, ["branch", "-D", branch]).catch(() => undefined);
    }
  });

  test("rolls back a local worktree when a configured path is a directory", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await fs.mkdir(path.join(worktree, "nested-dir"), { recursive: true });
    const suffix = randomUUID().slice(0, 8);
    const projectName = `copy-directory-${suffix}`;
    const branch = `copy-directory-${suffix}`;
    const expectedWorktreePath = expectedManagedWorktreePath(projectName, branch);
    await fs.rm(expectedWorktreePath, { recursive: true, force: true });

    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch,
      environmentType: "local",
    });
    const { context, updates } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: projectName,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: {
        defaultBranch: "main",
        prBaseBranch: "main",
        filesToCopy: ["nested-dir"],
      },
    });
    const commands = createCommandRegistry();

    try {
      await expect(
        commands.get("start_environment")?.({ environmentId: environment.id }, context),
      ).rejects.toThrow("Configured path to copy is not a file: nested-dir");

      expect(environment.status).toBe("error");
      expect(environment.worktreePath).toBeUndefined();
      expect(updates.map((update) => update.status)).toEqual(["creating", "error"]);
      await expectLocalWorktreeRolledBack(worktree, expectedWorktreePath, branch);
    } finally {
      await fs.rm(expectedWorktreePath, { recursive: true, force: true });
      await runGit(worktree, ["branch", "-D", branch]).catch(() => undefined);
    }
  });

  test("suffixes local worktree branches when origin has an unfetched branch with the stored name", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const updater = await createTempDir("ork-electron-remote-branch-");
    await runGit(updater, ["clone", remote, "."]);
    await runGit(updater, ["checkout", "-b", "review-oauth-callback"]);
    await fs.writeFile(path.join(updater, "remote-only.txt"), "remote branch\n");
    await runGit(updater, ["add", "remote-only.txt"]);
    await runGit(updater, ["commit", "-m", "remote branch"]);
    await runGit(updater, ["push", "origin", "review-oauth-callback"]);

    const { stdout: knownBranches } = await execFileAsync("git", [
      "-C",
      worktree,
      "branch",
      "-a",
      "--format=%(refname:short)",
    ]);
    expect(knownBranches).not.toContain("review-oauth-callback");

    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: "review-oauth-callback",
      environmentType: "local",
    });
    const projectName = `Remote Branch Collision ${randomUUID().slice(0, 8)}`;
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: projectName,
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
      expect(environment.branch).toBe("review-oauth-callback-1");
      await expect(currentGitBranch(environment.worktreePath!)).resolves.toBe(
        "review-oauth-callback-1",
      );
    } finally {
      if (environment.worktreePath)
        await fs.rm(environment.worktreePath, { recursive: true, force: true });
    }
  });

  test("creates local worktrees from a configured remote default branch", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    await runGit(worktree, ["checkout", "-b", "develop"]);
    await fs.writeFile(path.join(worktree, "tracked.txt"), "develop\n");
    await runGit(worktree, ["add", "tracked.txt"]);
    await runGit(worktree, ["commit", "-m", "develop base"]);
    await runGit(worktree, ["push", "-u", "origin", "develop"]);

    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: "feature/custom-base",
      environmentType: "local",
    });
    const projectName = `Custom Base ${randomUUID().slice(0, 8)}`;
    const { context } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: projectName,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: { defaultBranch: "develop", prBaseBranch: "develop" },
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
      expect(environment.branch).toBe("feature-custom-base");
      expect(await fs.readFile(path.join(environment.worktreePath!, "tracked.txt"), "utf8")).toBe(
        "develop\n",
      );
    } finally {
      if (environment.worktreePath)
        await fs.rm(environment.worktreePath, { recursive: true, force: true });
    }
  });

  test("marks local environment errored when the remote base branch is missing", async () => {
    const { worktree, remote } = await createGitWorktreeWithOrigin();
    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: "feature/missing-base",
      environmentType: "local",
    });
    const { context, updates } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: `Missing Base ${randomUUID().slice(0, 8)}`,
        gitUrl: remote,
        localPath: worktree,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: { defaultBranch: "missing-base", prBaseBranch: "missing-base" },
    });
    const commands = createCommandRegistry();

    await expect(
      commands.get("start_environment")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow();

    expect(environment.status).toBe("error");
    expect(environment.worktreePath).toBeUndefined();
    expect(updates.map((update) => update.status)).toEqual(["creating", "error"]);
  });

  test("marks local environment errored when the project repository has no origin remote", async () => {
    const repo = await createGitRepoOnBranch("main");
    const environment = createEnvironment({
      status: "stopped",
      worktreePath: undefined,
      branch: "feature/no-origin",
      environmentType: "local",
    });
    const { context, updates } = createContext(environment, {
      project: {
        id: environment.projectId,
        name: `No Origin ${randomUUID().slice(0, 8)}`,
        gitUrl: "",
        localPath: repo,
        addedAt: new Date(0).toISOString(),
        order: 0,
      },
      repositoryConfig: { defaultBranch: "main", prBaseBranch: "main" },
    });
    const commands = createCommandRegistry();

    await expect(
      commands.get("start_environment")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow();

    expect(environment.status).toBe("error");
    expect(environment.worktreePath).toBeUndefined();
    expect(updates.map((update) => update.status)).toEqual(["creating", "error"]);
  });

  test(
    "refuses to prepare a workspace on a base image that predates the prepare contract",
    async () => {
      const environment = createEnvironment({
        id: "env-container-stale-image",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();

      // An older image's workspace-setup.sh has no argument handling at all: the
      // capability probe finds nothing, and invoking --prepare-only there would run
      // the whole setup - including repository-controlled commands, as root - before
      // HEAD is read, producing a baseline that is not a pre-setup one.
      await withFakeDocker(
        `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
exit 0
`,
        async (logs) => {
          await expect(
            commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
          ).rejects.toThrow("Container base image is out of date");

          const dockerLog = await fs.readFile(logs.all, "utf8");
          expect(dockerLog).not.toContain("--prepare-only");
          expect(ptySpawn).not.toHaveBeenCalled();
          expect(environment.createdFromCommit).toBeUndefined();
          expect(environment.setupScriptsComplete).toBe(false);
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "rejects a preparation run that never reports completion",
    async () => {
      const environment = createEnvironment({
        id: "env-container-prepare-silent",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
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
      printf 'looks fine but never reached the checkpoint\\n'
      exit 0
      ;;
  esac
  exit 0
fi
exit 0
`,
        async () => {
          await expect(
            commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
          ).rejects.toThrow("did not report completion");
          expect(ptySpawn).not.toHaveBeenCalled();
          expect(environment.createdFromCommit).toBeUndefined();
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "opens the setup terminal before preparation and streams the clone output into it",
    async () => {
      const environment = createEnvironment({
        id: "env-container-prepare-stream",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
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
      printf 'Cloning into /workspace...\\n'
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '6666666666666666666666666666666666666666\\n'
      ;;
  esac
  exit 0
fi
exit 0
`,
        async () => {
          const setupPromise = commands.get("run_environment_setup")?.(
            { environmentId: environment.id },
            context,
          ) as Promise<Environment>;
          await waitForPtyProcessCount(1);
          ptyProcesses[0]?.emitData(SETUP_DONE_OSC);
          await setupPromise;

          const setupOutput = emitted
            .filter((entry) => entry.event === `terminal-output-${environment.id}:setup`)
            .map((entry) => (entry.payload as { text: string }).text)
            .join("");
          // Preparation performs the clone, so its announcement and output have to
          // reach the terminal before the setup commands are even known.
          expect(setupOutput).toContain("[orkestrator] Preparing workspace");
          expect(setupOutput).toContain("Cloning into /workspace...");
          expect(setupOutput.indexOf("[orkestrator] Preparing workspace")).toBeLessThan(
            setupOutput.indexOf("[orkestrator] Starting environment setup"),
          );
          // The buffer survives into the setup phase rather than being reset by it.
          expect(setupOutput.indexOf("Cloning into /workspace...")).toBeLessThan(
            setupOutput.indexOf("[orkestrator] Starting environment setup"),
          );
        },
      );
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "closes the setup session when the terminal cannot be spawned after preparation",
    async () => {
      const environment = createEnvironment({
        id: "env-container-spawn-fails",
        environmentType: "containerized",
        setupScriptsComplete: false,
        worktreePath: undefined,
        containerId: "container-1",
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();

      // Preparation succeeds and opens the session, then the container disappears
      // before the setup PTY starts. Nothing but this path can close that session,
      // because no process was ever attached to it.
      let preparedOnce = false;
      await withFakeDocker(
        `#!/bin/sh
if [ "$1" = "inspect" ]; then
  if [ -f "$FAKE_DOCKER_LOG.prepared" ]; then
    printf 'exited\\n'
  else
    printf 'running\\n'
  fi
  exit 0
fi
if [ "$1" = "exec" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *rev-parse*)
      printf '7777777777777777777777777777777777777777\\n'
      touch "$FAKE_DOCKER_LOG.prepared"
      ;;
  esac
  exit 0
fi
exit 0
`,
        async () => {
          preparedOnce = true;
          await expect(
            commands.get("run_environment_setup")?.({ environmentId: environment.id }, context),
          ).rejects.toThrow("Container is not running");

          const session = (await commands.get("await_environment_setup_session")?.(
            { environmentId: environment.id },
            context,
          )) as { running: boolean; success?: boolean };
          expect(session).toMatchObject({ running: false, success: false });
          // The baseline was still captured and kept, so a retry does not re-prepare.
          expect(environment.createdFromCommit).toBe("7777777777777777777777777777777777777777");
          expect(environment.setupScriptsComplete).toBe(false);
          expect(ptySpawn).not.toHaveBeenCalled();
        },
      );
      expect(preparedOnce).toBe(true);
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "rehydration resumes only persisted cleanup after a merge was already confirmed",
    async () => {
      const worktreePath = await createTempDir("ork-electron-merge-cleanup-recovery-");
      const environment = createEnvironment({
        id: "env-merge-cleanup-recovery",
        worktreePath,
        prUrl: null,
        prState: "merged",
        cleanupAfterMergeRequestedAt: "2026-07-28T12:00:00.000Z",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();

      await expect(
        commands.get("get_environments")?.(
          {
            projectId: environment.projectId,
          },
          context,
        ),
      ).resolves.toContainEqual(
        expect.objectContaining({
          id: environment.id,
          cleanupAfterMergeRequestedAt: "2026-07-28T12:00:00.000Z",
        }),
      );

      await waitForCondition(
        () =>
          !environment.cleanupAfterMergeRequestedAt ||
          environment.deletionRequestedAt !== undefined,
        "persisted cleanup recovery to begin",
      );
      let recoveredEnvironment: Environment | null = environment;
      for (let attempt = 0; attempt < 100 && recoveredEnvironment; attempt += 1) {
        recoveredEnvironment = await context.storage.getEnvironment(environment.id);
        if (recoveredEnvironment) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      expect(recoveredEnvironment).toBeNull();
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("deletes the remote head branch during merged local environment cleanup", async () => {
    const worktreePath = await createTempDir("ork-electron-cleanup-delete-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "merged",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/cleanup","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/cleanup" ] && [ "$3" = "--method" ] && [ "$4" = "DELETE" ]; then
  exit 0
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      async (logPath) => {
        await expect(
          commands.get("delete_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeUndefined();

        const ghLog = await fs.readFile(logPath, "utf8");
        expect(ghLog).toContain("api repos/acme/repo/pulls/42");
        expect(ghLog).toContain(
          "api repos/acme/repo/git/refs/heads/feature/cleanup --method DELETE",
        );
        await expect(
          commands.get("get_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeNull();
      },
    );
  });

  test("continues merged environment cleanup when the remote head branch is already deleted", async () => {
    const worktreePath = await createTempDir("ork-electron-cleanup-delete-404-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "merged",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/pulls/42" ]; then
  printf '%s\\n' '{"head":{"ref":"feature/already-cleaned","repo":{"full_name":"acme/repo"}}}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "repos/acme/repo/git/refs/heads/feature/already-cleaned" ] && [ "$3" = "--method" ] && [ "$4" = "DELETE" ]; then
  printf '%s\\n' 'HTTP 422: Reference does not exist' >&2
  exit 1
fi
printf 'unexpected gh args: %s\\n' "$*" >&2
exit 1
`,
      async (logPath) => {
        await expect(
          commands.get("delete_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeUndefined();

        const ghLog = await fs.readFile(logPath, "utf8");
        expect(ghLog).toContain(
          "api repos/acme/repo/git/refs/heads/feature/already-cleaned --method DELETE",
        );
        await expect(
          commands.get("get_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeNull();
      },
    );
  });

  test("does not delete remote branches during closed environment cleanup", async () => {
    const worktreePath = await createTempDir("ork-electron-cleanup-closed-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "closed",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf 'gh should not be called\\n' >&2
exit 1
`,
      async (logPath) => {
        await expect(
          commands.get("delete_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeUndefined();

        expect(existsSync(logPath)).toBe(false);
        await expect(
          commands.get("get_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeNull();
      },
    );
  });

  test("deletes the remote head branch during merged running container cleanup", async () => {
    const environment = createEnvironment({
      id: "env-container-cleanup",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-1",
      status: "running",
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "merged",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *pulls/42*)
      printf '%s\\n' '{"head":{"ref":"feature/container-cleanup","repo":{"full_name":"acme/repo"}}}'
      exit 0
      ;;
    *refs/heads/feature/container-cleanup*)
      exit 0
      ;;
  esac
  printf 'unexpected docker exec args: %s\\n' "$*" >&2
  exit 1
fi
if [ "$1" = "rm" ]; then
  printf '%s\\n' "$3" >> "$FAKE_DOCKER_RM_LOG"
  exit 0
fi
exit 0
`,
      async (logs) => {
        await expect(
          commands.get("delete_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeUndefined();

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain("pulls/42");
        expect(execLog).toContain("refs/heads/feature/container-cleanup");
        expect(execLog).toContain("DELETE");
        const rmLog = await fs.readFile(logs.rm, "utf8");
        expect(rmLog).toContain("container-1");
        await expect(
          commands.get("get_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeNull();
      },
    );
  });

  test("removes the environment even when remote branch deletion fails for a non-404 reason", async () => {
    const worktreePath = await createTempDir("ork-electron-cleanup-delete-error-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "merged",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf '%s\\n' 'HTTP 500: Internal Server Error' >&2
exit 1
`,
      async (logPath) => {
        await expect(
          commands.get("delete_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeUndefined();

        const ghLog = await fs.readFile(logPath, "utf8");
        expect(ghLog).toContain("api repos/acme/repo/pulls/42");
        await expect(
          commands.get("get_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeNull();
      },
    );
  });

  test("does not delete remote branches when a merged environment has no PR url", async () => {
    const worktreePath = await createTempDir("ork-electron-cleanup-no-prurl-worktree-");
    const environment = createEnvironment({
      worktreePath,
      prUrl: null,
      prState: "merged",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeGh(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
printf 'gh should not be called\\n' >&2
exit 1
`,
      async (logPath) => {
        await expect(
          commands.get("delete_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeUndefined();

        expect(existsSync(logPath)).toBe(false);
        await expect(
          commands.get("get_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeNull();
      },
    );
  });

  test("does not delete remote branches when a merged container environment is not running", async () => {
    const environment = createEnvironment({
      id: "env-container-stopped",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: "container-stopped",
      status: "stopped",
      prUrl: "https://github.com/acme/repo/pull/42",
      prState: "merged",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    await withFakeDocker(
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  printf 'docker exec should not be called for a stopped container\\n' >&2
  exit 1
fi
if [ "$1" = "rm" ]; then
  printf '%s\\n' "$3" >> "$FAKE_DOCKER_RM_LOG"
  exit 0
fi
exit 0
`,
      async (logs) => {
        await expect(
          commands.get("delete_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeUndefined();

        expect(existsSync(logs.exec)).toBe(false);
        const rmLog = await fs.readFile(logs.rm, "utf8");
        expect(rmLog).toContain("container-stopped");
        await expect(
          commands.get("get_environment")?.({ environmentId: environment.id }, context),
        ).resolves.toBeNull();
      },
    );
  });

  test("retains the environment and process ownership when deletion cannot reap a server", async () => {
    const worktreePath = await createTempDir("ork-electron-delete-failure-");
    const environment = createEnvironment({ id: "env-delete-failure", worktreePath });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const child = createFakeChild(92001);
    commandTesting.setLocalServerProcess(`codex:${environment.id}`, child);
    commandTesting.setTerminateProcessTree(async () => false);

    await expect(
      commands.get("delete_environment")?.({ environmentId: environment.id }, context),
    ).rejects.toThrow("Failed to stop all local servers");
    expect(await context.storage.getEnvironment(environment.id)).toBe(environment);
    expect(existsSync(worktreePath)).toBe(true);
    expect(commandTesting.getLocalServerProcess(`codex:${environment.id}`)).toBe(child);

    commandTesting.setTerminateProcessTree(async () => true);
    await expect(
      commands.get("delete_environment")?.({ environmentId: environment.id }, context),
    ).resolves.toBeUndefined();
  });
});

describe("log storage commands", () => {
  function logStorageContext(logDirectory: string): CommandContext {
    return { storage: { getLogDirectory: () => logDirectory } } as unknown as CommandContext;
  }

  test("reports the size and file count of the log directory", async () => {
    const dataDir = await createTempDir("ork-log-storage-stats-");
    const logDirectory = path.join(dataDir, "logs");
    await fs.mkdir(path.join(logDirectory, "codex-raw"), { recursive: true });
    await fs.writeFile(path.join(logDirectory, "app.log"), "1234");
    await fs.writeFile(path.join(logDirectory, "codex-raw", "raw.jsonl"), "123456");
    const commands = createCommandRegistry();

    await expect(
      commands.get("get_log_storage_stats")?.({}, logStorageContext(logDirectory)),
    ).resolves.toEqual({ totalBytes: 10, fileCount: 2 });
  });

  test("reports zero for a log directory that was never created", async () => {
    const dataDir = await createTempDir("ork-log-storage-missing-");
    const commands = createCommandRegistry();

    await expect(
      commands.get("get_log_storage_stats")?.({}, logStorageContext(path.join(dataDir, "logs"))),
    ).resolves.toEqual({ totalBytes: 0, fileCount: 0 });
  });

  test("deletes every stored log and returns the emptied stats", async () => {
    const dataDir = await createTempDir("ork-log-storage-cleanup-");
    const logDirectory = path.join(dataDir, "logs");
    await fs.mkdir(path.join(logDirectory, "nested"), { recursive: true });
    await fs.writeFile(path.join(logDirectory, "app.log"), "app");
    await fs.writeFile(path.join(logDirectory, "nested", "raw.jsonl"), "raw");
    const commands = createCommandRegistry();

    await expect(
      commands.get("cleanup_logs")?.({}, logStorageContext(logDirectory)),
    ).resolves.toEqual({ totalBytes: 0, fileCount: 0 });
    expect(await fs.readdir(logDirectory)).toEqual([]);
  });

  test("rejects arguments neither command accepts", async () => {
    const dataDir = await createTempDir("ork-log-storage-args-");
    const context = logStorageContext(path.join(dataDir, "logs"));
    const commands = createCommandRegistry();

    // Both take no arguments, so an unexpected key is a caller bug rather than
    // something to silently ignore against a destructive command. Validation is
    // synchronous, so it rejects before any filesystem work is scheduled.
    expect(() => commands.get("get_log_storage_stats")?.({ path: "/etc" }, context)).toThrow(
      /Unexpected arguments field: path/,
    );
    expect(() => commands.get("cleanup_logs")?.({ path: "/etc" }, context)).toThrow(
      /Unexpected arguments field: path/,
    );
  });

  test("surfaces a cleanup the process is not permitted to perform", async () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const dataDir = await createTempDir("ork-log-storage-denied-");
    const logDirectory = path.join(dataDir, "logs");
    await fs.mkdir(logDirectory, { recursive: true });
    await fs.writeFile(path.join(logDirectory, "app.log"), "app");
    await fs.chmod(logDirectory, 0o500);
    const commands = createCommandRegistry();

    try {
      await expect(
        commands.get("cleanup_logs")?.({}, logStorageContext(logDirectory)),
      ).rejects.toThrow();
    } finally {
      await fs.chmod(logDirectory, 0o700);
    }
  });
});
