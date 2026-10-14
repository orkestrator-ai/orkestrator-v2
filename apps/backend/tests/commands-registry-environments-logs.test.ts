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
