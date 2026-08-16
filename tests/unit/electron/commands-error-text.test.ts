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



  test("classifies each lifecycle failure category from its structured outcome", () => {
    const classify = commandTesting.environmentLifecycleErrorMessage;

    // `execFile` SIGTERMs a timed-out child, so stdout/stderr are empty and the
    // message is the generic "Command failed: <argv>". The outcome flag is the
    // only place the timeout is visible.
    expect(classify(new CommandFailedError("Command failed: docker start abc", {
      timedOut: true,
    }))).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.timedOut);
    expect(classify(new CommandFailedError("spawn docker ENOENT", {
      executableMissing: true,
    }))).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable);

    // Real Docker CLI strings, not paraphrases of them.
    expect(classify(new Error(
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    ))).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.runtimeUnavailable);
    expect(classify(new Error(
      "Unable to find image 'orkestrator-v2:latest' locally\ndocker: Error response from daemon: pull access denied",
    ))).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.imageUnavailable);
    expect(classify(new Error(
      "docker: Error response from daemon: manifest unknown",
    ))).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.imageUnavailable);
    expect(classify(new Error(
      "failed to register layer: write /var/lib/docker/x: no space left on device",
    ))).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.diskFull);

    expect(classify(new Error("Project has no local path - cannot create a local worktree")))
      .toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.noLocalPath);
    expect(classify(new Error("Setup script failed")))
      .toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.setupScript);

    // Anything unrecognized collapses to the fallback rather than leaking the
    // child's own text into a persisted, rendered field.
    expect(classify(new Error("fatal: could not read Username for 'https://github.com'")))
      .toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown);
    expect(classify("a bare string")).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown);
    expect(classify(undefined)).toBe(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES.unknown);

    // Every reachable value is one of the fixed constants.
    expect(Object.values(ENVIRONMENT_LIFECYCLE_ERROR_MESSAGES))
      .toContain(classify(new Error("anything at all")));
  });



  test("scrubs credentials a child echoed but the caller never named", () => {
    const scrub = commandTesting.scrubLifecycleLogDetail;

    expect(scrub("fatal: could not read from https://user:private-token@example.invalid/repo.git"))
      .toBe("fatal: could not read from https://[redacted]@example.invalid/repo.git");
    expect(scrub("remote: Authorization: Bearer abc123.def-456"))
      .toBe("remote: Authorization: Bearer [redacted]");
    expect(scrub("token ghp_abcdefghijklmnop rejected")).toBe("token [redacted] rejected");
    expect(scrub("token github_pat_11ABCDEFG0abcdefg rejected")).toBe("token [redacted] rejected");
    expect(scrub("key sk-ant-api03-abcdefghijklmnop rejected")).toBe("key [redacted] rejected");

    // Bounded, so one pathological child cannot flood the log.
    expect(scrub("x".repeat(2_000))).toHaveLength(501);
    // Ordinary diagnostics survive intact — the point is to keep them readable.
    expect(scrub("Cannot connect to the Docker daemon at unix:///var/run/docker.sock"))
      .toBe("Cannot connect to the Docker daemon at unix:///var/run/docker.sock");
  });

});
