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



  test("does not persist the configured PAT in new container metadata", async () => {
    const environment = createEnvironment({
      id: "env-container-pat",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment, {
      globalConfig: {
        useHostGitHubCredentials: false,
        githubToken: "configured-pat",
      },
    });
    const commands = createCommandRegistry();

    await withFakeGh(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
exit 1
`, async (ghLog) => {
      await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "create" ]; then
  printf 'container-created\\n'
  exit 0
fi
exit 0
`, async (logs) => {
        await expect(commands.get("provision_environment")?.(
          { environmentId: environment.id },
          context,
        )).resolves.toBe("container-created");

        expect(await fs.readFile(ghLog, "utf8").catch(() => "")).toBe("");
        const dockerCalls = await fs.readFile(logs.all, "utf8");
        expect(dockerCalls).not.toContain("-e GITHUB_TOKEN");
        expect(dockerCalls).not.toContain("-e GH_TOKEN");
        expect(dockerCalls).not.toContain("configured-pat");
      });
    });
  });



  test("does not expose configured credentials in Docker argv or container creation errors", async () => {
    const githubToken = "github_secret_token";
    const anthropicApiKey = "anthropic_secret_key";
    const cursorApiKey = "cursor_secret_key";
    const environment = createEnvironment({
      id: "env-container-secret-failure",
      environmentType: "containerized",
      worktreePath: undefined,
      containerId: null,
      status: "stopped",
      networkAccessMode: "full",
    });
    const { context } = createContext(environment);
    Object.assign(context.storage, {
      loadConfig: mock(async () => ({
        version: "1.0.0",
        global: {
          useHostGitHubCredentials: false,
          githubToken,
          anthropicApiKey,
          cursorApiKey,
        },
        repositories: {
          "project-1": { defaultBranch: "main", prBaseBranch: "main" },
        },
      })),
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "create" ]; then
  printf 'Docker permission denied for %s, %s and %s\\n' "$GITHUB_TOKEN" "$ANTHROPIC_API_KEY" "$CURSOR_API_KEY" >&2
  exit 42
fi
exit 0
`, async (logs) => {
      let failure: unknown;
      try {
        await commands.get("provision_environment")?.({ environmentId: environment.id }, context);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("Docker permission denied");
      expect((failure as Error).message).toContain("[REDACTED]");
      expect((failure as Error).message).not.toContain(githubToken);
      expect((failure as Error).message).not.toContain(anthropicApiKey);
      expect((failure as Error).message).not.toContain(cursorApiKey);

      const dockerCalls = await fs.readFile(logs.all, "utf8");
      expect(dockerCalls).not.toContain("-e GITHUB_TOKEN");
      expect(dockerCalls).not.toContain("-e GH_TOKEN");
      expect(dockerCalls).toContain("-e ANTHROPIC_API_KEY");
      expect(dockerCalls).toContain("-e CURSOR_API_KEY");
      expect(dockerCalls).not.toContain(githubToken);
      expect(dockerCalls).not.toContain(anthropicApiKey);
      expect(dockerCalls).not.toContain(cursorApiKey);
    });
  });



  test("matches short and full container IDs before removing orphaned Docker containers", async () => {
    const currentDataDir = path.join(os.tmpdir(), "orkestrator-current-registry");
    const foreignDataDir = path.join(os.tmpdir(), "orkestrator-foreign-registry");
    const currentOwner = dockerOwnerNamespace(currentDataDir);
    const foreignOwner = dockerOwnerNamespace(foreignDataDir);
    const fullAssignedId = "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const shortAssignedId = fullAssignedId.slice(0, 12);
    const orphanId = "1234567890ab";
    const legacyOrphanId = "0f0f0f0f0f0f";
    const foreignId = "fedcba098765";
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: fullAssignedId,
      status: "running",
    });
    const { context } = createContext(environment, { dataDir: currentDataDir });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  case "$*" in
    *ORKESTRATOR_SETUP_CAPABILITIES*)
      printf '\\036ORKESTRATOR_PREPARE_SUPPORTED\\037'
      exit 0
      ;;
    *--prepare-only*)
      printf '\\036ORKESTRATOR_PREPARE_OK\\037'
      exit 0
      ;;
    *'{{json .}}'*)
      printf '{"ID":"${shortAssignedId}","Names":"legacy-assigned","Status":"Up","State":"running","Image":"orkestrator","Labels":"app=orkestrator-v2"}\\n'
      printf '{"ID":"${legacyOrphanId}","Names":"legacy-orphan","Status":"Exited","State":"exited","Image":"orkestrator","Labels":"app=orkestrator-v2"}\\n'
      printf '{"ID":"${orphanId}","Names":"runtime-orphan","Status":"Exited","State":"exited","Image":"orkestrator","Labels":"app=orkestrator-v2,orkestrator-owner=${currentOwner},environment-name=current-orphan"}\\n'
      printf '{"ID":"${foreignId}","Names":"foreign","Status":"Up","State":"running","Image":"orkestrator","Labels":"app=orkestrator-v2,orkestrator-owner=${foreignOwner},environment-name=foreign"}\\n'
      ;;
    *'{{.Labels}}'*)
      printf '${shortAssignedId}\\tlegacy-assigned\\tapp=orkestrator-v2\\n'
      printf '${legacyOrphanId}\\tlegacy-orphan\\tapp=orkestrator-v2\\n'
      printf '${orphanId}\\truntime-orphan\\tapp=orkestrator-v2,orkestrator-owner=${currentOwner}\\n'
      printf '${foreignId}\\tforeign\\tapp=orkestrator-v2,orkestrator-owner=${foreignOwner}\\n'
      ;;
    *)
      printf '${shortAssignedId}\\tassigned\\n'
      printf '${orphanId}\\torphan\\n'
      printf '${foreignId}\\tforeign\\n'
      ;;
  esac
  exit 0
fi
if [ "$1" = "rm" ]; then
  printf '%s\\n' "$3" >> "$FAKE_DOCKER_RM_LOG"
  exit 0
fi
exit 0
`, async (logs) => {
      const containers = await commands.get("get_orkestrator_containers")?.({}, context) as Array<{ id: string; name: string; isAssigned: boolean; environmentId: string | null }>;
      expect(containers.find((container) => container.id === shortAssignedId)).toMatchObject({
        isAssigned: true,
        environmentId: "env-container",
      });
      expect(containers.find((container) => container.id === orphanId)).toMatchObject({ isAssigned: false });
      // Created before the owner label existed: adopted, not stranded.
      expect(containers.find((container) => container.id === legacyOrphanId)).toMatchObject({ isAssigned: false });
      expect(containers.find((container) => container.id === foreignId)).toBeUndefined();

      await expect(commands.get("cleanup_orphaned_containers")?.({}, context)).resolves.toBe(2);
      const removed = await fs.readFile(logs.rm, "utf8");
      expect(removed).toContain(orphanId);
      expect(removed).toContain(legacyOrphanId);
      expect(removed).not.toContain(shortAssignedId);
      expect(removed).not.toContain(foreignId);

      const dockerCalls = await fs.readFile(logs.all, "utf8");
      expect(dockerCalls).toContain("--no-trunc");
      // Ownership is decided from the returned labels. Filtering it in the
      // daemon query would hide unlabelled pre-upgrade containers for good.
      expect(dockerCalls).toContain("label=app=orkestrator-v2");
      expect(dockerCalls).not.toContain(`label=orkestrator-owner=${currentOwner}`);
    });
  });



  test("resolves a container's display name through its environment id when the name label is stale", async () => {
    const currentDataDir = path.join(os.tmpdir(), "orkestrator-stale-name-registry");
    const detachedId = "aabbccddeeff";
    const orphanId = "ffeeddccbbaa";
    // Renamed after `docker create` stamped `environment-name`, and its container
    // id no longer matches the record, so only the environment-id label connects
    // the two.
    const environment = createEnvironment({
      id: "env-renamed",
      name: "current-name",
      environmentType: "containerized",
      containerId: null,
      status: "stopped",
    });
    const { context } = createContext(environment, { dataDir: currentDataDir });
    const commands = createCommandRegistry();
    const owner = dockerOwnerNamespace(currentDataDir);

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "ps" ]; then
  case "$*" in
    *'{{json .}}'*)
      printf '{"ID":"${detachedId}","Names":"ork-${owner}-env-renamed","Status":"Exited","State":"exited","Image":"orkestrator","Labels":"app=orkestrator-v2,environment-id=env-renamed,environment-name=name-at-create,orkestrator-owner=${owner}"}\\n'
      printf '{"ID":"${orphanId}","Names":"ork-${owner}-env-deleted","Status":"Exited","State":"exited","Image":"orkestrator","Labels":"app=orkestrator-v2,environment-id=env-deleted,environment-name=name-at-create-deleted,orkestrator-owner=${owner}"}\\n'
      ;;
  esac
  exit 0
fi
exit 0
`, async () => {
      const containers = await commands.get("get_orkestrator_containers")?.({}, context) as Array<{ id: string; name: string }>;

      expect(containers.find((container) => container.id === detachedId)?.name).toBe("current-name");
      // No environment left to ask, so the creation-time label is the best available.
      expect(containers.find((container) => container.id === orphanId)?.name).toBe("name-at-create-deleted");
    });
  });



  test("persists the selected GitHub credential through stdin and container git config", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: {
        useHostGitHubCredentials: false,
        githubToken: "token-value",
      },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  cat > "$FAKE_DOCKER_EXEC_LOG.stdin"
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commands.get("propagate_github_token_to_containers")?.({}, context)).resolves.toEqual({
        updated: ["env-container"],
        failed: [],
      });

      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog).toContain("git config --global --list");
      expect(execLog).toContain("--remove-section");
      expect(execLog).toContain("token_url=\"https://x-access-token:$token@github.com/\"");
      expect(execLog).toContain("git config --global --replace-all");
      expect(execLog).toContain("https://github.com/");
      expect(execLog).toContain("git@github.com:");
      expect(execLog).not.toContain("token-value");
      expect(await fs.readFile(`${logs.exec}.stdin`, "utf8")).toBe("token-value");
    });
  });



  test("clears persisted GitHub token rewrites when propagation receives an empty token", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: { useHostGitHubCredentials: false },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
  cat > "$FAKE_DOCKER_EXEC_LOG.stdin"
  exit 0
fi
exit 0
`, async (logs) => {
      await expect(commands.get("propagate_github_token_to_containers")?.({}, context)).resolves.toEqual({
        updated: ["env-container"],
        failed: [],
      });

      const execLog = await fs.readFile(logs.exec, "utf8");
      expect(execLog).toContain("grep '^url\\.https://x-access-token:'");
      expect(execLog).toContain("--remove-section");
      expect(await fs.readFile(`${logs.exec}.stdin`, "utf8")).toBe("");
    });
  });



  test("refreshes and clears the managed credential after direct container starts", async () => {
    const environment = createEnvironment({
      id: "env-direct-start",
      environmentType: "containerized",
      containerId: "container-1",
      status: "stopped",
    });
    const config = {
      version: "1.0.0",
      global: {
        useHostGitHubCredentials: false,
        githubToken: "rotated-token",
      },
      repositories: {},
    };
    const { context } = createContext(environment);
    context.storage.loadConfig = mock(async () => config);
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "start" ]; then exit 0; fi
if [ "$1" = "exec" ]; then
  if [ "$2" = "--user" ]; then exit 0; fi
  cat >> "$FAKE_DOCKER_EXEC_LOG.stdin"
  printf '\\n--sync--\\n' >> "$FAKE_DOCKER_EXEC_LOG.stdin"
  exit 0
fi
exit 1
`, async (logs) => {
      await commands.get("docker_start_container")?.({ containerId: "container-1" }, context);
      config.global.githubToken = "";
      await commands.get("docker_start_container")?.({ containerId: "container-1" }, context);

      const input = await fs.readFile(`${logs.exec}.stdin`, "utf8");
      expect(input).toBe("rotated-token\n--sync--\n\n--sync--\n");
      const calls = await fs.readFile(logs.all, "utf8");
      expect(calls.match(/start container-1/g)).toHaveLength(2);
      expect(calls.match(/exec --user root container-1 sh -c/g)).toHaveLength(2);
      expect(calls).toContain("chgrp -R node /project-files && chmod -R g+rX,o-rwx /project-files");
    });
  });



  test("delivers the host Claude credential into the container on start", async () => {
    const { context } = claudeCredentialSyncContext();
    const commands = createCommandRegistry();
    const credential = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-from-host"}}';

    await withFakeDocker(
      CLAUDE_CREDENTIAL_SYNC_DOCKER_SCRIPT,
      async (logs) => {
        await commands.get("docker_start_container")?.({ containerId: "container-1" }, context);

        // Codex rides in on the read-only /codex-home mount; Claude's credential
        // lives in the macOS Keychain and has to be piped in over stdin, which is
        // the gap that left container agents reporting "Not logged in".
        const input = await fs.readFile(`${logs.exec}.stdin`, "utf8");
        expect(input).toContain(credential);
        const calls = await fs.readFile(logs.all, "utf8");
        expect(calls).toContain("/home/node/.claude/.credentials.json");
        // The sync runs as the image's default user (node), not `--user root`:
        // the `exec -i <id> bash -lc` argv form proves no --user flag precedes
        // the container id, so the credential lands owned by the agent's user.
        // The single `--user root` exec is the project-files access repair.
        expect(calls).toContain("exec -i container-1 bash -lc");
        expect(calls.match(/exec --user root container-1/g)).toHaveLength(1);
        // The token must never be passed as an argv value a `ps` or
        // `docker inspect` could read.
        expect(calls).not.toContain("sk-ant-oat01-from-host");
      },
      `#!/bin/sh\nprintf '%s' '${credential}'\n`,
      credential,
    );
  });



  test("does not read or deliver the host credential when the user opted out", async () => {
    const { context } = claudeCredentialSyncContext({ useHostClaudeCredentials: false });
    const commands = createCommandRegistry();
    const credential = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-opted-out"}}';

    await withFakeDocker(
      CLAUDE_CREDENTIAL_SYNC_DOCKER_SCRIPT,
      async (logs) => {
        await commands.get("docker_start_container")?.({ containerId: "container-1" }, context);

        // The opt-out has to short-circuit before the Keychain read, not after:
        // its whole point is that the host token never enters this process, let
        // alone an environment running untrusted repository code. The GitHub
        // sync pipes its own (empty) payload, so the stdin log exists either
        // way — what must be absent is the Claude credential itself.
        const input = existsSync(`${logs.exec}.stdin`)
          ? await fs.readFile(`${logs.exec}.stdin`, "utf8")
          : "";
        expect(input).not.toContain("claudeAiOauth");
        const calls = await fs.readFile(logs.all, "utf8");
        expect(calls).not.toContain("/home/node/.claude/.credentials.json");
        expect(calls).not.toContain("sk-ant-oat01-opted-out");
        // The GitHub sync still runs, so this is an opt-out and not a start that
        // silently skipped credential delivery altogether.
        expect(calls).toContain("exec -i container-1");
      },
      // Both sources are armed; neither may be consulted.
      `#!/bin/sh\nprintf '%s' '${credential}'\n`,
      credential,
    );
  });



  test("a failed Claude credential sync does not fail the container start", async () => {
    const { context } = claudeCredentialSyncContext();
    const commands = createCommandRegistry();
    const credential = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-undeliverable"}}';

    await withFakeDocker(
      // `start` succeeds; the credential sync exec is the one that fails. The
      // GitHub sync exec must still be allowed through so this test isolates the
      // best-effort contract rather than failing earlier for another reason.
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [ "$1" = "start" ]; then exit 0; fi
if [ "$1" = "exec" ]; then
  if [ "$2" = "--user" ]; then exit 0; fi
  payload="$(cat)"
  case "$payload" in
    *claudeAiOauth*)
      printf 'exec failed\\n' >&2
      exit 17
      ;;
  esac
  exit 0
fi
exit 1
`,
      async (logs) => {
        // A credential that cannot be delivered leaves the agent logged out and
        // saying so. Failing the whole start over it is the worse outcome.
        await expect(
          commands.get("docker_start_container")?.({ containerId: "container-1" }, context),
        ).resolves.toBeUndefined();

        const calls = await fs.readFile(logs.all, "utf8");
        expect(calls).toContain("start container-1");
        expect(calls).not.toContain("sk-ant-oat01-undeliverable");
      },
      `#!/bin/sh\nprintf '%s' '${credential}'\n`,
      credential,
    );
  });



  test("reports a credential sync failure after a direct container start", async () => {
    const { context } = createContext(createEnvironment(), {
      globalConfig: {
        useHostGitHubCredentials: false,
        githubToken: "secret-token",
      },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "start" ]; then exit 0; fi
if [ "$1" = "exec" ]; then
  if [ "$2" = "--user" ]; then exit 0; fi
  token="$(cat)"
  printf 'sync rejected %s\\n' "$token" >&2
  exit 7
fi
exit 1
`, async () => {
      await expect(commands.get("docker_start_container")?.(
        { containerId: "container-1" },
        context,
      )).rejects.toThrow("sync rejected [REDACTED]");
    });
  });



  test("redacts the GitHub token from propagation failure messages", async () => {
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: {
        useHostGitHubCredentials: false,
        githubToken: "secret-token-123",
      },
    });
    const commands = createCommandRegistry();

    await withFakeDocker(`#!/bin/sh
if [ "$1" = "inspect" ]; then
  printf 'running\\n'
  exit 0
fi
if [ "$1" = "exec" ]; then
  secret="$(cat)"
  printf 'credential update failed for %s\\n' "$secret" >&2
  exit 1
fi
exit 0
`, async () => {
      const result = await commands.get("propagate_github_token_to_containers")?.(
        {},
        context,
      ) as { updated: string[]; failed: [string, string][] };

      expect(result.updated).toEqual([]);
      expect(result.failed).toHaveLength(1);
      const [, message] = result.failed[0]!;
      expect(message).not.toContain("secret-token-123");
      expect(message).toContain("[REDACTED]");
    });
  });

});
