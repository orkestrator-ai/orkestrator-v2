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

  test("refuses every foreground lifecycle command once shutdown has begun", async () => {
    const environment = createEnvironment({
      id: "env-foreground-shutdown",
      environmentType: "containerized",
      containerId: "container-shutdown",
      status: "running",
      lifecycleError: "Previous failure",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    await context.environmentLifecycleTasks.beginShutdown();

    for (const command of [
      "start_environment",
      "stop_environment",
      "recreate_environment",
      "delete_environment",
    ]) {
      await expect(
        commands.get(command)?.({ environmentId: environment.id }, context),
      ).rejects.toThrow("Backend is shutting down");
    }

    // Refusal is total: nothing was mutated on the way out.
    expect(environment.status).toBe("running");
    expect(environment.containerId).toBe("container-shutdown");
    expect(environment.lifecycleError).toBe("Previous failure");
    // A refused delete must not keep the tombstone that blocks local-server
    // starts and merges for this environment.
    expect(commandTesting.isEnvironmentDeleting(environment.id)).toBe(false);
  });

  test("keeps credential sync compatible with repeated workspace Git configuration", async () => {
    const home = await createTempDir("ork-github-config-home-");
    const credentialFile = path.join(home, "runtime", "github-token");
    const env = { ...process.env, HOME: home, GITHUB_TOKEN: "token-value", GH_TOKEN: "" };
    const sync = spawnSync(
      "bash",
      ["-c", commandTesting.buildSyncContainerGitHubCredentialCommand(credentialFile)],
      { env, input: "token-value", encoding: "utf8" },
    );
    expect(sync.status).toBe(0);

    const workspaceSetup = await fs.readFile(
      path.join(process.cwd(), "docker", "workspace-setup.sh"),
      "utf8",
    );
    const start = workspaceSetup.indexOf('TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"');
    const end = workspaceSetup.indexOf("\nprint_workspace_disk_status()", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const credentialSetup = workspaceSetup.slice(start, end);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const configured = spawnSync("bash", ["-c", credentialSetup], {
        env,
        encoding: "utf8",
      });
      expect(configured.status).toBe(0);
    }

    const values = spawnSync(
      "git",
      [
        "config",
        "--global",
        "--get-all",
        "url.https://x-access-token:token-value@github.com/.insteadOf",
      ],
      { env, encoding: "utf8" },
    );
    expect(values.status).toBe(0);
    expect(values.stdout.trim().split("\n")).toEqual([
      "https://github.com/",
      "https://github.com",
      "git@github.com:",
    ]);
  });

  test(
    "survives a login shell whose logout hook fails",
    async () => {
      const workspace = await createTempDir("ork-container-script-nonrepo-");
      const home = await createTempDir("ork-container-script-home-");
      // Debian's ~/.bash_logout runs `clear_console -q`, which fails when no console
      // is attached. Under `set -e` a failing logout hook replaces the script's own
      // exit status, which turned an empty status into an error for every workspace
      // that had not been cloned yet.
      await fs.writeFile(path.join(home, ".bash_logout"), "false\n");
      const loginEnv = { ...process.env, HOME: home };
      const script = commandTesting.buildContainerGitStatusScript("main", true);

      const nonRepo = spawnSync("bash", ["-lc", script], {
        cwd: workspace,
        encoding: "utf8",
        env: loginEnv,
      });
      expect(nonRepo.status).toBe(0);
      expect(nonRepo.stdout).toBe("");
      expect(commandTesting.parseContainerGitStatusResponse(nonRepo.stdout, true)).toEqual([]);

      const repo = await createTempDir("ork-container-script-missing-ref-");
      await runGit(repo, ["init", "-b", "work", "."]);
      await fs.writeFile(path.join(repo, "file.txt"), "a\n");
      await runGit(repo, ["add", "-A"]);
      await runGit(repo, ["commit", "-m", "base"]);
      const missingRef = spawnSync(
        "bash",
        [
          "-lc",
          commandTesting.buildContainerGitStatusScript(
            "0123456789012345678901234567890123456789",
            true,
          ),
        ],
        { cwd: repo, encoding: "utf8", env: loginEnv },
      );
      expect(missingRef.status).toBe(0);
      expect(commandTesting.isMissingTargetRefResponse(missingRef.stdout)).toBe(true);
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test("releases local and container merge guards when lifecycle persistence fails", async () => {
    for (const kind of ["local", "container"] as const) {
      const environment = createEnvironment(
        kind === "local"
          ? {
              id: "env-local-lifecycle-failure",
              worktreePath: "/tmp/worktree",
              prUrl: "https://github.com/acme/repo/pull/42",
            }
          : {
              id: "env-container-lifecycle-failure",
              environmentType: "containerized",
              worktreePath: undefined,
              containerId: "container-1",
              status: "running",
            },
      );
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const updateEnvironment = context.storage.updateEnvironment.bind(context.storage);
      let failLifecycleWrite = true;
      context.storage.updateEnvironment = mock(
        async (environmentId: string, updates: Partial<Environment>) => {
          if (updates.lifecycleOperation === "merging" && failLifecycleWrite) {
            failLifecycleWrite = false;
            throw new Error("lifecycle storage unavailable");
          }
          return updateEnvironment(environmentId, updates);
        },
      );

      const command = kind === "local" ? "merge_pr_local" : "merge_pr";
      const argumentsFor = (method: string) =>
        kind === "local"
          ? { environmentId: environment.id, method, deleteBranch: false }
          : { containerId: environment.containerId, method, deleteBranch: false };

      await expect(commands.get(command)?.(argumentsFor("squash"), context)).rejects.toThrow(
        "lifecycle storage unavailable",
      );

      // An invalid method fails after acquiring the guard. If the first call
      // leaked that guard, this would instead report "already being merged".
      await expect(commands.get(command)?.(argumentsFor("fast-forward"), context)).rejects.toThrow(
        "Invalid merge method: fast-forward",
      );
    }
  });

  test.each([
    ["Claude", "start_claude_server", "container-claude-redaction", "CLAUDE_BRIDGE_TOKEN"],
    [
      "OpenCode",
      "start_opencode_server",
      "container-opencode-redaction",
      "OPENCODE_SERVER_PASSWORD",
    ],
  ] as const)(
    "redacts a generated %s container credential when detached startup fails",
    async (_label, commandName, containerId, credentialName) => {
      const hostPort = await reserveFreePort();
      const environment = createEnvironment({
        id: `env-${containerId}`,
        environmentType: "containerized",
        containerId,
        status: "running",
      });
      const { context } = createContext(environment);
      const commands = createCommandRegistry();
      const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
      process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
      const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/claude-bridge-token"*|*"cat /tmp/opencode-server-password"*)
        exit 0 ;;
    esac
    exit 9 ;;
esac
exit 0
`;

      try {
        await withFakeDocker(dockerScript, async (logs) => {
          const failure = await commands
            .get(commandName)?.({ containerId }, context)
            .then(
              () => null,
              (error: unknown) => error as Error,
            );

          expect(failure).toBeInstanceOf(Error);
          const execLog = await fs.readFile(logs.exec, "utf8");
          const token = execLog.match(new RegExp(`${credentialName}='([^']+)'`))?.[1];
          expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
          expect(failure!.message).not.toContain(token!);
          expect(failure!.message).toContain("[REDACTED]");
        });
      } finally {
        if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
        else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      }
    },
  );
});
