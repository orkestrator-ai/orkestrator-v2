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



describe("resolveBrowserOpenCommand", () => {
  test("uses direct platform launchers without a command interpreter", () => {
    expect(resolveBrowserOpenCommand("https://example.com/a?x=1&y=2", "darwin")).toEqual({
      command: "open",
      args: ["https://example.com/a?x=1&y=2"],
    });
    expect(resolveBrowserOpenCommand("https://example.com/a?x=1&y=2", "win32")).toEqual({
      command: "explorer.exe",
      args: ["https://example.com/a?x=1&y=2"],
    });
    expect(resolveBrowserOpenCommand("http://127.0.0.1:34121/", "linux")).toEqual({
      command: "xdg-open",
      args: ["http://127.0.0.1:34121/"],
    });
  });

  test("rejects malformed and non-web URLs", () => {
    expect(() => resolveBrowserOpenCommand("not a url", "win32")).toThrow("Invalid browser URL");
    expect(() => resolveBrowserOpenCommand("file:///tmp/secret", "win32")).toThrow(
      "Unsupported browser URL protocol",
    );
  });
});



describe("resolveFileManagerRevealCommands", () => {
  test("uses native selection commands on macOS and Windows", () => {
    expect(resolveFileManagerRevealCommands("/tmp/project/file.ts", "darwin")).toEqual([
      { command: "open", args: ["-R", "/tmp/project/file.ts"] },
    ]);
    expect(resolveFileManagerRevealCommands("C:\\project\\file.ts", "win32")).toEqual([
      { command: "explorer", args: ["/select,", "C:\\project\\file.ts"] },
    ]);
  });

  test("selects through FileManager1 on Linux with an encoded URI and parent-folder fallback", () => {
    expect(resolveFileManagerRevealCommands("/tmp/project/file, name.ts", "linux")).toEqual([
      {
        command: "dbus-send",
        args: [
          "--session",
          "--print-reply",
          "--dest=org.freedesktop.FileManager1",
          "/org/freedesktop/FileManager1",
          "org.freedesktop.FileManager1.ShowItems",
          "array:string:file:///tmp/project/file%2C%20name.ts",
          "string:",
        ],
      },
      { command: "xdg-open", args: ["/tmp/project"] },
    ]);
  });
});
