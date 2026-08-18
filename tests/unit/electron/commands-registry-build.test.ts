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

test("build pipeline point reads omit unchanged transcripts and return tail patches", async () => {
  const environment = createEnvironment();
  const { context } = createContext(environment);
  const record = {
    version: 2,
    id: "pipeline-1",
    projectId: environment.projectId,
    environmentId: environment.id,
    revision: 8,
    updatedAt: new Date().toISOString(),
    snapshot: {
      id: "pipeline-1",
      sessions: [
        {
          sessionKey: "session-1",
          messageRevision: 3,
          messages: [{ id: "m1" }, { id: "m2-old" }, { id: "m3" }],
        },
      ],
    },
  };
  context.storage.getBuildPipeline = mock(async () => record);
  const commands = createCommandRegistry();

  expect(
    await commands.get("get_build_pipeline")?.(
      {
        pipelineId: record.id,
        knownRevision: 8,
      },
      context,
    ),
  ).toEqual({ unchanged: true, revision: 8 });

  expect(
    await commands.get("get_build_pipeline")?.(
      {
        pipelineId: record.id,
        knownRevision: 7,
        knownSessions: {
          "session-1": { revision: 2, count: 2 },
        },
      },
      context,
    ),
  ).toMatchObject({
    unchanged: false,
    record: {
      revision: 8,
      snapshot: {
        sessions: [{ sessionKey: "session-1", messageRevision: 3 }],
      },
    },
    messagePatches: [
      {
        sessionKey: "session-1",
        baseRevision: 2,
        baseCount: 2,
        startIndex: 1,
        revision: 3,
        messages: [{ id: "m2-old" }, { id: "m3" }],
      },
    ],
  });

  expect(
    await commands.get("get_build_pipeline")?.(
      {
        pipelineId: record.id,
        knownRevision: 7,
        knownSessions: {
          "session-1": { revision: 3, count: 3 },
        },
      },
      context,
    ),
  ).toMatchObject({
    unchanged: false,
    record: {
      revision: 8,
      snapshot: {
        sessions: [{ sessionKey: "session-1", messageRevision: 3 }],
      },
    },
    messagePatches: [],
  });

  expect(
    await commands.get("get_build_pipeline")?.(
      {
        pipelineId: record.id,
        knownRevision: 7,
        knownSessions: {
          "session-1": { revision: 2, count: 99 },
        },
      },
      context,
    ),
  ).toMatchObject({
    unchanged: false,
    messagePatches: [
      {
        sessionKey: "session-1",
        startIndex: 0,
        revision: 3,
        messages: [{ id: "m1" }, { id: "m2-old" }, { id: "m3" }],
      },
    ],
  });

  expect(
    await commands.get("get_build_pipeline")?.(
      {
        pipelineId: record.id,
        knownRevision: "8",
      },
      context,
    ),
  ).toBe(record);

  context.storage.getBuildPipeline = mock(async () => null);
  expect(
    await commands.get("get_build_pipeline")?.(
      {
        pipelineId: "missing",
        knownRevision: 1,
        knownSessions: {},
      },
      context,
    ),
  ).toBeNull();
});

test("build pipeline list reads return only changed records and retain deletion ids", async () => {
  const environment = createEnvironment();
  const { context } = createContext(environment);
  const records = [
    {
      version: 2,
      id: "pipeline-1",
      projectId: environment.projectId,
      environmentId: environment.id,
      revision: 2,
      updatedAt: new Date().toISOString(),
      snapshot: { id: "pipeline-1" },
    },
    {
      version: 2,
      id: "pipeline-2",
      projectId: environment.projectId,
      environmentId: environment.id,
      revision: 4,
      updatedAt: new Date().toISOString(),
      snapshot: { id: "pipeline-2" },
    },
  ];
  context.storage.listBuildPipelines = mock(async () => records);
  const commands = createCommandRegistry();

  expect(
    await commands.get("list_build_pipelines")?.(
      {
        projectId: environment.projectId,
      },
      context,
    ),
  ).toBe(records);
  expect(
    await commands.get("list_build_pipelines")?.(
      {
        projectId: environment.projectId,
        knownRevisions: [],
      },
      context,
    ),
  ).toBe(records);
  expect(
    await commands.get("list_build_pipelines")?.(
      {
        projectId: environment.projectId,
        knownRevisions: {
          "pipeline-1": 2,
          "pipeline-2": 3,
          "pipeline-deleted": 7,
        },
      },
      context,
    ),
  ).toEqual({
    ids: ["pipeline-1", "pipeline-2"],
    records: [records[1]],
  });

  context.storage.listBuildPipelines = mock(async () => []);
  expect(
    await commands.get("list_build_pipelines")?.(
      {
        projectId: environment.projectId,
        knownRevisions: { "pipeline-deleted": 7 },
      },
      context,
    ),
  ).toEqual({
    ids: [],
    records: [],
  });
});
