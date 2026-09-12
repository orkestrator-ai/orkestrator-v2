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

describe("Electron backend environment lifecycle commands", () => {
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
      await context.environmentLifecycleTasks.beginShutdown();
      const recoveredEnvironment = await context.storage.getEnvironment(environment.id);
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
