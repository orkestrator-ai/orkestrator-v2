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



describe("feature plan commands", () => {
  function featureContext() {
    const storage = {
      createFeaturePlan: mock(async () => ({ id: "feature-1" })),
      updateFeaturePlan: mock(async () => ({ id: "feature-1" })),
      getFeaturePlans: mock(async () => []),
      appendFeaturePlanMessage: mock(async () => ({ id: "feature-1" })),
      appendFeatureStoryMessage: mock(async () => ({ id: "feature-1" })),
    };
    return { context: { storage } as unknown as CommandContext, storage };
  }

  test("forwards a valid feature plan message role to storage", async () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    await commands.get("append_feature_plan_message")?.(
      { featureId: "feature-1", role: "assistant", content: "hello" },
      context,
    );

    expect(storage.appendFeaturePlanMessage).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      "hello",
      undefined,
      undefined,
    );
  });

  test("validates and forwards feature-plan state application metadata", async () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    await commands.get("append_feature_plan_message")?.(
      {
        featureId: "feature-1",
        role: "assistant",
        content: "hello",
        stateApplication: "pending",
        modelId: "  gpt-5.3-codex  ",
      },
      context,
    );
    expect(storage.appendFeaturePlanMessage).toHaveBeenCalledWith(
      "feature-1",
      "assistant",
      "hello",
      "pending",
      "gpt-5.3-codex",
    );

    expect(() =>
      commands.get("append_feature_story_message")!(
        {
          featureId: "feature-1",
          storyId: "story-1",
          role: "assistant",
          content: "hello",
          stateApplication: "ignored",
        },
        context,
      ),
    ).toThrow(/stateApplication/i);
    expect(storage.appendFeatureStoryMessage).not.toHaveBeenCalled();
  });

  test("rejects malformed feature-plan model attribution", () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    expect(() =>
      commands.get("append_feature_plan_message")!(
        {
          featureId: "feature-1",
          role: "assistant",
          content: "hello",
          modelId: "   ",
        },
        context,
      ),
    ).toThrow(/modelId/i);
    expect(storage.appendFeaturePlanMessage).not.toHaveBeenCalled();
  });

  test("rejects an invalid feature plan message role before touching storage", async () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    expect(() =>
      commands.get("append_feature_plan_message")!(
        { featureId: "feature-1", role: "robot", content: "hello" },
        context,
      ),
    ).toThrow(/role/i);
    expect(storage.appendFeaturePlanMessage).not.toHaveBeenCalled();
  });

  test("rejects an invalid story message role before touching storage", async () => {
    const commands = createCommandRegistry();
    const { context, storage } = featureContext();

    expect(() =>
      commands.get("append_feature_story_message")!(
        { featureId: "feature-1", storyId: "story-1", role: "", content: "hello" },
        context,
      ),
    ).toThrow(/role/i);
    expect(storage.appendFeatureStoryMessage).not.toHaveBeenCalled();
  });
});
