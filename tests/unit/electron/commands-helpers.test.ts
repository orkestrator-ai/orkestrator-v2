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

  test("registers every command exposed by the typed frontend wrapper", async () => {
    const source = await fs.readFile(
      path.join(process.cwd(), "apps", "web", "src", "lib", "backend.ts"),
      "utf8",
    );
    const exposedCommands = Array.from(
      source.matchAll(/invoke(?:<[^>]+>)?\("([^"]+)"/g),
      (match) => match[1],
    );
    const commands = createCommandRegistry();

    for (const command of exposedCommands) {
      expect(commands.has(command)).toBe(true);
    }
  });

  test("validates and delegates resource revision manifest requests", async () => {
    const generation = "a".repeat(32);
    const projectRevision = "b".repeat(32);
    const response = {
      generation,
      reset: false,
      revisions: { project: projectRevision },
    };
    const getResourceRevisionManifest = mock(async () => response);
    const context = {
      storage: { getResourceRevisionManifest },
    } as unknown as CommandContext;
    const command = createCommandRegistry().get("get_resource_revision_manifest")!;

    await expect(
      command(
        {
          knownGeneration: generation,
          knownRevisions: { project: projectRevision },
        },
        context,
      ),
    ).resolves.toEqual(response);
    expect(getResourceRevisionManifest).toHaveBeenCalledWith(generation, {
      project: projectRevision,
    });

    await expect(command({}, context)).resolves.toEqual(response);
    expect(getResourceRevisionManifest).toHaveBeenLastCalledWith(undefined, {});

    for (const knownRevisions of [null, [], "revisions"]) {
      expect(() => command({ knownRevisions }, context)).toThrow("knownRevisions");
    }
    expect(() =>
      command(
        {
          knownRevisions: { unknown: projectRevision },
        },
        context,
      ),
    ).toThrow("Unknown manifest resource: unknown");
    expect(() =>
      command(
        {
          knownRevisions: { project: "invalid" },
        },
        context,
      ),
    ).toThrow("Invalid manifest revision for project");
    expect(() =>
      command(
        {
          knownGeneration: "invalid",
        },
        context,
      ),
    ).toThrow("knownGeneration must be an opaque resource generation");
    expect(getResourceRevisionManifest).toHaveBeenCalledTimes(2);
  });

  test("requires paired, well-formed conditional snapshot cursors", async () => {
    const generation = "a".repeat(32);
    const revision = "b".repeat(32);
    const storage = {
      loadProjects: mock(async () => []),
      readConditionalResourceSnapshot: mock(async () => ({
        status: "unchanged" as const,
        generation,
        revision,
      })),
    };
    const context = { storage } as unknown as CommandContext;
    const command = createCommandRegistry().get("get_projects")!;

    await expect(command({ knownManifestGeneration: generation }, context)).rejects.toThrow(
      "knownManifestGeneration and knownResourceRevision must be provided together",
    );
    await expect(command({ knownResourceRevision: revision }, context)).rejects.toThrow(
      "knownManifestGeneration and knownResourceRevision must be provided together",
    );
    for (const knownManifestGeneration of [null, 42, "A".repeat(32), "a".repeat(31)]) {
      await expect(
        command(
          {
            knownManifestGeneration,
            knownResourceRevision: revision,
          },
          context,
        ),
      ).rejects.toThrow("knownManifestGeneration must be an opaque resource generation");
    }
    for (const knownResourceRevision of [null, 42, "B".repeat(32), "b".repeat(33)]) {
      await expect(
        command(
          {
            knownManifestGeneration: generation,
            knownResourceRevision,
          },
          context,
        ),
      ).rejects.toThrow("knownResourceRevision must be an opaque resource revision");
    }
    expect(storage.readConditionalResourceSnapshot).not.toHaveBeenCalled();
    expect(storage.loadProjects).not.toHaveBeenCalled();
  });

  test("preserves legacy snapshots and returns changed and unchanged envelopes", async () => {
    const generation = "a".repeat(32);
    const revision = "b".repeat(32);
    const projects = [{ id: "project-1" }];
    const loadProjects = mock(async () => projects);
    const readConditionalResourceSnapshot = mock(
      async (
        _resource: string,
        requestedGeneration: string,
        _requestedRevision: string,
        load: () => Promise<unknown> | unknown,
      ) => ({
        status: "changed" as const,
        generation: requestedGeneration,
        revision,
        snapshot: await load(),
      }),
    );
    const storage = { loadProjects, readConditionalResourceSnapshot };
    const context = { storage } as unknown as CommandContext;
    const command = createCommandRegistry().get("get_projects")!;

    await expect(command({}, context)).resolves.toEqual(projects);
    expect(readConditionalResourceSnapshot).not.toHaveBeenCalled();

    await expect(
      command(
        {
          knownManifestGeneration: generation,
          knownResourceRevision: revision,
        },
        context,
      ),
    ).resolves.toEqual({
      status: "changed",
      generation,
      revision,
      snapshot: projects,
    });
    expect(readConditionalResourceSnapshot).toHaveBeenCalledWith(
      "project",
      generation,
      revision,
      expect.any(Function),
    );

    readConditionalResourceSnapshot.mockImplementation(async () => ({
      status: "unchanged" as const,
      generation,
      revision,
    }));
    loadProjects.mockClear();
    await expect(
      command(
        {
          knownManifestGeneration: generation,
          knownResourceRevision: revision,
        },
        context,
      ),
    ).resolves.toEqual({
      status: "unchanged",
      generation,
      revision,
    });
    expect(loadProjects).not.toHaveBeenCalled();
  });

  test("accepts only a full 40-character commit sha as a HEAD commit", () => {
    expect(commandTesting.parseHeadCommit("  1111111111111111111111111111111111111111\n")).toBe(
      "1111111111111111111111111111111111111111",
    );
    expect(commandTesting.parseHeadCommit("ABCDEF1111111111111111111111111111111111")).toBe(
      "ABCDEF1111111111111111111111111111111111",
    );
    for (const invalid of [
      "",
      "not-a-commit",
      "1111",
      "1".repeat(39),
      "1".repeat(41),
      "z".repeat(40),
    ]) {
      expect(commandTesting.parseHeadCommit(invalid)).toBeUndefined();
    }
  });

  test("does not let a stale child release replacement ownership", () => {
    const stale = createFakeChild(93001);
    const replacement = createFakeChild(93002);
    commandTesting.setLocalServerProcess("codex:env-owner", replacement);

    commandTesting.releaseLocalServerOwnership("codex:env-owner", stale);
    expect(commandTesting.getLocalServerProcess("codex:env-owner")).toBe(replacement);

    commandTesting.releaseLocalServerOwnership("codex:env-owner", replacement);
    expect(commandTesting.getLocalServerProcess("codex:env-owner")).toBeUndefined();
  });

  test.each(["cursor", "grok"] as const)(
    "allows a delayed %s ACP server to become healthy after the old attempt limit",
    async (kind) => {
      let checks = 0;

      await expect(
        commandTesting.waitForLocalServerHealth(45_678, kind, undefined, {
          checkHealth: async () => {
            checks += 1;
            return checks === commandTesting.LOCAL_SERVER_HEALTH_ATTEMPTS + 1;
          },
          delay: async () => {},
        }),
      ).resolves.toBeUndefined();

      expect(checks).toBe(commandTesting.LOCAL_SERVER_HEALTH_ATTEMPTS + 1);
    },
  );

  test.each(["cursor", "grok"] as const)(
    "gives %s servers the full ACP startup window before failing",
    async (kind) => {
      let checks = 0;

      await expect(
        commandTesting.waitForLocalServerHealth(45_678, kind, undefined, {
          checkHealth: async () => {
            checks += 1;
            return false;
          },
          delay: async () => {},
        }),
      ).rejects.toThrow("Server on port 45678 did not become healthy");

      expect(checks).toBe(commandTesting.ACP_LOCAL_SERVER_HEALTH_ATTEMPTS);
    },
  );

  test.each(["opencode", "claude", "codex"] as const)(
    "keeps the existing startup window for %s servers",
    async (kind) => {
      let checks = 0;

      await expect(
        commandTesting.waitForLocalServerHealth(45_678, kind, undefined, {
          checkHealth: async () => {
            checks += 1;
            return false;
          },
          delay: async () => {},
        }),
      ).rejects.toThrow("Server on port 45678 did not become healthy");

      expect(checks).toBe(commandTesting.LOCAL_SERVER_HEALTH_ATTEMPTS);
    },
  );
});
