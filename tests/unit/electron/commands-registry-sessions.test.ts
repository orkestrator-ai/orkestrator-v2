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

describe("pane layout commands", () => {
  test("validates and forwards pane layout envelopes", async () => {
    const persisted = {
      // Reads stay version-agnostic so the renderer can migrate legacy data.
      version: 1,
      environmentId: "env-1",
      containerId: null,
      activePaneId: "default",
      root: { kind: "leaf", id: "default", tabs: [], activeTabId: null },
      updatedAt: new Date(0).toISOString(),
      revision: 1,
    };
    const getPaneLayout = mock(async () => persisted);
    const savePaneLayout = mock(
      async (
        environmentId: string,
        layout: Record<string, unknown>,
        _expectedRevision: number,
      ) => ({
        ...layout,
        environmentId,
        updatedAt: new Date(0).toISOString(),
        revision: 1,
      }),
    );
    const deletePaneLayout = mock(async () => undefined);
    const context = {
      storage: {
        getPaneLayout,
        savePaneLayout,
        deletePaneLayout,
      },
    } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };

    await commands.get("save_pane_layout")?.(
      {
        environmentId: "env-1",
        layout: {
          version: 3,
          containerId: null,
          activePaneId: "default",
          root,
        },
        expectedRevision: 0,
      },
      context,
    );

    expect(savePaneLayout).toHaveBeenCalledWith(
      "env-1",
      {
        version: 3,
        containerId: null,
        activePaneId: "default",
        root,
      },
      0,
    );
    await expect(
      commands.get("get_pane_layout")?.({ environmentId: "env-1" }, context),
    ).resolves.toEqual(persisted);
    expect(getPaneLayout).toHaveBeenCalledWith("env-1");
    await expect(
      commands.get("delete_pane_layout")?.({ environmentId: "env-1" }, context),
    ).resolves.toBeUndefined();
    expect(deletePaneLayout).toHaveBeenCalledWith("env-1");
    await expect(
      commands.get("delete_pane_layout")?.(
        {
          environmentId: "env-1",
          expectedRevision: 7,
        },
        context,
      ),
    ).resolves.toBeUndefined();
    expect(deletePaneLayout).toHaveBeenCalledWith("env-1", 7);
    await expect(
      commands.get("save_pane_layout")?.(
        {
          environmentId: "env-1",
          layout: { version: 3, containerId: null, activePaneId: "", root },
          expectedRevision: 0,
        },
        context,
      ),
    ).rejects.toThrow("non-empty");
    await expect(
      commands.get("save_pane_layout")?.(
        {
          environmentId: "env-1",
          layout: { version: 3, containerId: null, activePaneId: "default", root: [] },
          expectedRevision: 0,
        },
        context,
      ),
    ).rejects.toThrow("layout.root");
    await expect(
      commands.get("save_pane_layout")?.(
        {
          environmentId: "env-1",
          layout: { version: 3, containerId: null, activePaneId: "default", root },
        },
        context,
      ),
    ).rejects.toThrow("Expected expectedRevision to be a number");
  });

  test("rejects older and future pane layout writes before reaching storage", async () => {
    const savePaneLayout = mock(async () => ({}));
    const context = { storage: { savePaneLayout } } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };

    for (const version of [1, 2, 4]) {
      await expect(
        commands.get("save_pane_layout")?.(
          {
            environmentId: "env-1",
            layout: { version, containerId: null, activePaneId: "default", root },
            expectedRevision: 0,
          },
          context,
        ),
      ).rejects.toThrow(`Unsupported pane layout version: ${version}`);
    }

    expect(savePaneLayout).not.toHaveBeenCalled();
  });

  test("rejects a non-numeric expectedRevision before reaching storage", async () => {
    const savePaneLayout = mock(async () => ({}));
    const context = { storage: { savePaneLayout } } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };
    const layout = { version: 3, containerId: null, activePaneId: "default", root };

    for (const expectedRevision of ["0", null, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        commands.get("save_pane_layout")?.(
          {
            environmentId: "env-1",
            layout,
            expectedRevision,
          },
          context,
        ),
      ).rejects.toThrow("Expected expectedRevision to be a number");
    }
    expect(savePaneLayout).not.toHaveBeenCalled();
  });

  test("propagates a storage revision conflict with the marker intact", async () => {
    const conflict = new Error(paneLayoutRevisionConflictMessage(3, 5));
    const savePaneLayout = mock(async () => {
      throw conflict;
    });
    const context = { storage: { savePaneLayout } } as unknown as CommandContext;
    const commands = createCommandRegistry();
    const root = { kind: "leaf", id: "default", tabs: [], activeTabId: null };

    const rejection = await commands
      .get("save_pane_layout")?.(
        {
          environmentId: "env-1",
          layout: { version: 3, containerId: null, activePaneId: "default", root },
          expectedRevision: 3,
        },
        context,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejection).toBe(conflict);
    // The renderer's rebase-and-retry path keys off this predicate alone.
    expect(isPaneLayoutRevisionConflict(rejection)).toBe(true);
    expect(savePaneLayout).toHaveBeenCalledWith(
      "env-1",
      {
        version: 3,
        containerId: null,
        activePaneId: "default",
        root,
      },
      3,
    );
  });
});
