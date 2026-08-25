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

  test("discovers and persists the Claude model catalog from a containerized bridge", async () => {
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-claude-models-container-pid-"), "pid");
    const modelsJson = JSON.stringify({
      models: [
        {
          id: "claude-opus-5",
          resolvedModel: "claude-opus-5-20260701",
          name: "Claude Opus 5",
          description: "Latest Opus model",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "max"],
          supportsAdaptiveThinking: true,
        },
      ],
      source: "sdk",
      fetchedAt: freshFetchedAt(),
      sdkVersion: "0.2.1",
      cliVersion: "5.0.0",
    });

    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context, updates, emitted } = createContext(environment, {
      cacheAgentModelCatalog: async () => {
        throw new Error("injected host cache failure");
      },
    });
    const commands = createCommandRegistry();
    const warning = spyOn(console, "warn").mockImplementation(() => undefined);

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
    const previousModelsJson = process.env.FAKE_CLAUDE_MODELS_JSON;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;
    process.env.FAKE_CLAUDE_MODELS_JSON = modelsJson;

    // Fake docker: report the container running, map the bridge port to our host
    // port, and on `exec -d` spin up a real server that answers both the health
    // probe and the /config/models discovery request.
    const dockerScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    bun -e 'const m=process.env.FAKE_CLAUDE_MODELS_JSON;require("node:http").createServer((q,s)=>{if(q.url==="/global/health"||q.url==="/global/auth-check"){s.writeHead(200,{"content-type":"application/json"});return s.end("{}")}if(q.url==="/config/models"){s.writeHead(200,{"content-type":"application/json","access-control-allow-origin":"*"});return s.end(m)}s.writeHead(404);s.end()}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async () => {
        const snapshot = await commands.get("get_claude_model_catalog")?.(
          { environmentId: environment.id, forceRefresh: true },
          context,
        );

        expect(snapshot).toMatchObject({
          environmentId: environment.id,
          source: "sdk",
          sdkVersion: "0.2.1",
          cliVersion: "5.0.0",
          stale: false,
          models: [
            {
              id: "claude-opus-5",
              resolvedModel: "claude-opus-5-20260701",
              name: "Claude Opus 5",
              supportsAdaptiveThinking: true,
              supportedEffortLevels: ["low", "medium", "high", "max"],
            },
          ],
        });
        expect(updates).toContainEqual({ claudeModelCatalog: snapshot });
        expect(emitted).toContainEqual({
          event: "claude-model-catalog-updated",
          payload: snapshot,
        });
        await Promise.resolve();
        expect(warning).toHaveBeenCalledWith(
          "[ElectronBackend] Failed to persist the Claude model catalogue:",
          "injected host cache failure",
        );
      });
    } finally {
      warning.mockRestore();
      const pid = await fs.readFile(pidFile, "utf8").catch(() => "");
      if (pid) {
        try {
          process.kill(Number(pid));
        } catch {
          // already gone
        }
      }
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousPidFile === undefined) delete process.env.FAKE_BRIDGE_PID_FILE;
      else process.env.FAKE_BRIDGE_PID_FILE = previousPidFile;
      if (previousModelsJson === undefined) delete process.env.FAKE_CLAUDE_MODELS_JSON;
      else process.env.FAKE_CLAUDE_MODELS_JSON = previousModelsJson;
    }
  });

  test("starts the in-container Codex bridge with bun and its configured thread limit", async () => {
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-bridge-pid-"), "pid");
    const environment = createEnvironment({
      id: "env-container",
      environmentType: "containerized",
      containerId: "container-1",
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: { codexMaxConcurrentThreads: 9 },
    });
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
    const previousTokenFile = process.env.FAKE_BRIDGE_TOKEN_FILE;
    const tokenFile = path.join(path.dirname(pidFile), "token");
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;

    // Fake docker: report the container running, map the bridge port to our host
    // port, and on `exec -d` spin up a real health endpoint so waitForHealth
    // resolves. stdout is redirected so the detached server does not keep the
    // `docker exec` pipe open. The exec command itself is logged for assertions.
    const dockerScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/codex-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/orkestrator-ai/cursor-api-key-fingerprint"*)
        printf 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*CODEX_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    bun -e 'require("node:http").createServer((q,s)=>{s.writeHead(q.url==="/global/health"||q.url==="/global/auth-check"?200:404,{"content-type":"application/json"});s.end("{}")}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const [first, second] = (await Promise.all([
          commands.get("start_codex_server")?.({ containerId: "container-1" }, context),
          commands.get("start_codex_server")?.({ containerId: "container-1" }, context),
        ])) as Array<{ hostPort: number; wasRunning: boolean; authToken: string }>;
        expect(first).toMatchObject({ hostPort, wasRunning: false });
        expect(second).toMatchObject({ hostPort, wasRunning: true });
        expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(second.authToken).toBe(first.authToken);

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog.split("\n").filter((line) => line.startsWith("exec -d "))).toHaveLength(1);
        expect(execLog).toContain("/tmp/codex-bridge-token");
        expect(execLog).toContain("export CODEX_BRIDGE_TOKEN=");
        expect(execLog).toContain("export CODEX_MAX_CONCURRENT_THREADS_PER_SESSION=9");
        expect(execLog).toContain("setsid bun /opt/codex-bridge/dist/index.js");
        expect(execLog).not.toContain("unset GITHUB_TOKEN GH_TOKEN");
        expect(execLog).not.toContain("setsid node");
      });
    } finally {
      const pid = await fs.readFile(pidFile, "utf8").catch(() => "");
      if (pid) {
        try {
          process.kill(Number(pid));
        } catch {
          // already gone
        }
      }
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousPidFile === undefined) delete process.env.FAKE_BRIDGE_PID_FILE;
      else process.env.FAKE_BRIDGE_PID_FILE = previousPidFile;
      if (previousTokenFile === undefined) delete process.env.FAKE_BRIDGE_TOKEN_FILE;
      else process.env.FAKE_BRIDGE_TOKEN_FILE = previousTokenFile;
    }
  });

  test.each(["cursor", "grok"] as const)(
    "starts, inspects, and stops the in-container %s ACP bridge",
    async (provider) => {
      const hostPort = await reserveFreePort();
      const pidFile = path.join(await createTempDir(`ork-${provider}-acp-pid-`), "pid");
      const environment = createEnvironment({
        id: `env-container-${provider}`,
        environmentType: "containerized",
        containerId: `container-${provider}`,
        status: "running",
      });
      const cursorApiKey = provider === "cursor" ? "configured-container-cursor-key" : undefined;
      const globalConfig: { cursorApiKey?: string } = cursorApiKey ? { cursorApiKey } : {};
      const { context } = createContext(environment, {
        globalConfig,
      });
      const commands = createCommandRegistry();

      const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
      const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
      const previousTokenFile = process.env.FAKE_BRIDGE_TOKEN_FILE;
      const previousCursorFingerprintFile = process.env.FAKE_CURSOR_FINGERPRINT_FILE;
      const previousCursorKeyCapture = process.env.FAKE_CURSOR_KEY_CAPTURE;
      const previousCursorDirMarker = process.env.FAKE_CURSOR_DIR_MARKER;
      const tokenFile = path.join(path.dirname(pidFile), "token");
      const cursorKeyCapture = path.join(path.dirname(pidFile), "cursor-key");
      const cursorFingerprintFile = path.join(path.dirname(pidFile), "cursor-fingerprint");
      const cursorDirMarker = path.join(path.dirname(pidFile), "cursor-credential-dir");
      process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
      process.env.FAKE_BRIDGE_PID_FILE = pidFile;
      process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;
      process.env.FAKE_CURSOR_FINGERPRINT_FILE = cursorFingerprintFile;
      process.env.FAKE_CURSOR_KEY_CAPTURE = cursorKeyCapture;
      process.env.FAKE_CURSOR_DIR_MARKER = cursorDirMarker;

      const dockerScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    # /tmp/orkestrator-ai is not guaranteed to exist in the image, so model it:
    # a redirection into it only lands once some command has created it. This
    # is what catches a fingerprint write that skips its own mkdir.
    case "$*" in
      *"mkdir -p '/tmp/orkestrator-ai'"*|*'mkdir -p "$credential_dir"'*)
        : > "$FAKE_CURSOR_DIR_MARKER" ;;
    esac
    case "$*" in
      *"cat /tmp/${provider}-acp-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/orkestrator-ai/cursor-api-key-fingerprint"*)
        cat "$FAKE_CURSOR_FINGERPRINT_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/${provider}-acp-bridge.log"*)
        printf '${provider} acp log\\n'; exit 0 ;;
      *pkill*)
        rm -f "$FAKE_BRIDGE_TOKEN_FILE"
        pid=$(cat "$FAKE_BRIDGE_PID_FILE" 2>/dev/null || true)
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
        case "$*" in
          *"rm -f /tmp/${provider}-acp-bridge-token"*)
            rm -f "$FAKE_CURSOR_KEY_CAPTURE" "$FAKE_CURSOR_FINGERPRINT_FILE" ;;
        esac
        exit 0 ;;
      *"rm -f /tmp/orkestrator-ai/cursor-api-key"*)
        rm -f "$FAKE_CURSOR_KEY_CAPTURE"
        exit 0 ;;
      *".cursor-api-key.XXXXXX"*)
        cat > "$FAKE_CURSOR_KEY_CAPTURE"
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*ACP_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    fingerprint=$(printf '%s' "$*" | sed -n "s#.*printf '%s' '\\([0-9a-f][0-9a-f]*\\)' > /tmp/orkestrator-ai/cursor-api-key-fingerprint.*#\\1#p")
    if [ -n "$fingerprint" ] && [ -e "$FAKE_CURSOR_DIR_MARKER" ]; then
      printf '%s' "$fingerprint" > "$FAKE_CURSOR_FINGERPRINT_FILE"
    fi
    bun -e 'require("node:http").createServer((q,s)=>{s.writeHead(q.url==="/global/health"?200:404,{"content-type":"application/json"});s.end("{}")}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

      try {
        await withFakeDocker(dockerScript, async (logs) => {
          // Concurrent starts must be serialized into one bridge process.
          const [first, second] = (await Promise.all([
            commands.get(`start_${provider}_server`)?.(
              { containerId: `container-${provider}` },
              context,
            ),
            commands.get(`start_${provider}_server`)?.(
              { containerId: `container-${provider}` },
              context,
            ),
          ])) as Array<{ hostPort: number; wasRunning: boolean; authToken: string }>;
          expect(first).toMatchObject({ hostPort, wasRunning: false });
          expect(second).toMatchObject({ hostPort, wasRunning: true });
          expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
          expect(second.authToken).toBe(first.authToken);

          const status = (await commands.get(`get_${provider}_server_status`)?.(
            { containerId: `container-${provider}` },
            context,
          )) as { running: boolean; hostPort: number; authToken?: string };
          expect(status).toEqual({ running: true, hostPort, authToken: first.authToken });

          expect(
            await commands.get(`get_${provider}_server_log`)?.(
              { containerId: `container-${provider}` },
              context,
            ),
          ).toBe(`${provider} acp log\n`);

          const execLog = await fs.readFile(logs.exec, "utf8");
          expect(execLog.split("\n").filter((line) => line.startsWith("exec -d "))).toHaveLength(1);
          expect(execLog).toContain(`export ACP_PROVIDER=${provider}`);
          expect(execLog).toContain("export ACP_BRIDGE_TOKEN=");
          expect(execLog).toContain(`export ACP_STATE_DIR=/tmp/orkestrator-acp-state/${provider}`);
          expect(execLog).toContain("export HOSTNAME=0.0.0.0");
          expect(execLog).toContain(
            `setsid bun /opt/acp-bridge/dist/index.js --provider=${provider}`,
          );
          if (provider === "cursor") {
            expect(execLog).toContain("export ACP_APPROVE_PROJECT_MCPS=1");
          } else {
            expect(execLog).not.toContain("ACP_APPROVE_PROJECT_MCPS");
          }
          // The launch script is assembled by interpolation, and several
          // branches expand to nothing for a non-Cursor provider. Parse the
          // exact text with the same interpreter the container runs it under
          // (`docker exec ... bash -lc`), so an interpolation that produces
          // broken shell fails here rather than as a silent startup failure
          // inside a container. `-n` parses without executing.
          const detachedExec = execLog.slice(execLog.indexOf("exec -d "));
          const scriptStart = detachedExec.indexOf(" bash -lc ") + " bash -lc ".length;
          const setsidLine = detachedExec.indexOf(
            `setsid bun /opt/acp-bridge/dist/index.js --provider=${provider}`,
            scriptStart,
          );
          const scriptEnd = detachedExec.indexOf("2>&1 &", setsidLine) + "2>&1 &".length;
          expect(setsidLine).toBeGreaterThan(scriptStart);
          const launchScript = detachedExec.slice(scriptStart, scriptEnd);
          const parsed = Bun.spawnSync(["bash", "-n", "-c", launchScript]);
          expect(parsed.stderr.toString()).toBe("");
          expect(parsed.exitCode).toBe(0);
          // The token is written under a restrictive umask, never echoed.
          expect(execLog).toContain("umask 077");
          expect(execLog).not.toContain(cursorApiKey ?? "configured-container-cursor-key");
          if (provider === "cursor") {
            expect(await fs.readFile(cursorKeyCapture, "utf8")).toBe(cursorApiKey!);
            expect(execLog).toContain("exec -i container-cursor sh -c");
            expect(execLog).toContain(
              'export CURSOR_API_KEY="$(cat /tmp/orkestrator-ai/cursor-api-key)"',
            );
            // Nothing in the image guarantees the credential directory, and the
            // fingerprint write is not allowed to fail: an unreadable
            // fingerprint reads as "changed" and restarts a healthy bridge.
            expect(execLog).toContain("mkdir -p '/tmp/orkestrator-ai'");

            // An unchanged credential must reuse the running bridge. Restarting
            // here would kill the agent's in-flight turn on every start
            // request, and one is issued per prompt dispatch.
            const unchanged = (await commands.get("start_cursor_server")?.(
              { containerId: "container-cursor" },
              context,
            )) as { hostPort: number; wasRunning: boolean; authToken: string };
            expect(unchanged).toMatchObject({ hostPort, wasRunning: true });
            expect(unchanged.authToken).toBe(first.authToken);
            expect(
              (await fs.readFile(logs.exec, "utf8"))
                .split("\n")
                .filter((line) => line.startsWith("exec -d ")),
            ).toHaveLength(1);

            globalConfig.cursorApiKey = "rotated-container-cursor-key";
            const rotated = (await commands.get("start_cursor_server")?.(
              { containerId: "container-cursor" },
              context,
            )) as { hostPort: number; wasRunning: boolean; authToken: string };
            expect(rotated).toMatchObject({ hostPort, wasRunning: false });
            expect(rotated.authToken).not.toBe(first.authToken);
            expect(await fs.readFile(cursorKeyCapture, "utf8")).toBe(
              "rotated-container-cursor-key",
            );
            expect(await fs.readFile(cursorFingerprintFile, "utf8")).toBe(
              createHash("sha256").update("rotated-container-cursor-key").digest("hex"),
            );

            delete globalConfig.cursorApiKey;
            const cleared = (await commands.get("start_cursor_server")?.(
              { containerId: "container-cursor" },
              context,
            )) as { hostPort: number; wasRunning: boolean; authToken: string };
            expect(cleared).toMatchObject({ hostPort, wasRunning: false });
            expect(cleared.authToken).not.toBe(rotated.authToken);
            await expect(fs.readFile(cursorKeyCapture, "utf8")).rejects.toThrow();
            expect(await fs.readFile(cursorFingerprintFile, "utf8")).toBe(
              createHash("sha256").update("").digest("hex"),
            );
            const rotatedExecLog = await fs.readFile(logs.exec, "utf8");
            expect(
              rotatedExecLog.split("\n").filter((line) => line.startsWith("exec -d ")),
            ).toHaveLength(3);

            // "No key" is a credential state like any other. This is also the
            // path where nothing writes the credential directory for us: the
            // clearing sync only removes a file, so the startup script's own
            // mkdir is the only thing that lets its fingerprint land. Without
            // it the fingerprint reads back empty and this reuse becomes a
            // fourth restart.
            const stillCleared = (await commands.get("start_cursor_server")?.(
              { containerId: "container-cursor" },
              context,
            )) as { hostPort: number; wasRunning: boolean; authToken: string };
            expect(stillCleared).toMatchObject({ hostPort, wasRunning: true });
            expect(stillCleared.authToken).toBe(cleared.authToken);
            expect(
              (await fs.readFile(logs.exec, "utf8"))
                .split("\n")
                .filter((line) => line.startsWith("exec -d ")),
            ).toHaveLength(3);
          }

          await commands.get(`stop_${provider}_server`)?.(
            { containerId: `container-${provider}` },
            context,
          );
          const afterStop = await fs.readFile(logs.exec, "utf8");
          expect(afterStop).toContain(
            `pkill -f '[a]cp-bridge/dist/index.js --provider=${provider}'`,
          );
          expect(afterStop).toContain(`rm -f /tmp/${provider}-acp-bridge-token`);
        });
      } finally {
        const pid = await fs.readFile(pidFile, "utf8").catch(() => "");
        if (pid) {
          try {
            process.kill(Number(pid));
          } catch {
            // already gone
          }
        }
        if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
        else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
        if (previousPidFile === undefined) delete process.env.FAKE_BRIDGE_PID_FILE;
        else process.env.FAKE_BRIDGE_PID_FILE = previousPidFile;
        if (previousTokenFile === undefined) delete process.env.FAKE_BRIDGE_TOKEN_FILE;
        else process.env.FAKE_BRIDGE_TOKEN_FILE = previousTokenFile;
        if (previousCursorFingerprintFile === undefined)
          delete process.env.FAKE_CURSOR_FINGERPRINT_FILE;
        else process.env.FAKE_CURSOR_FINGERPRINT_FILE = previousCursorFingerprintFile;
        if (previousCursorKeyCapture === undefined) delete process.env.FAKE_CURSOR_KEY_CAPTURE;
        else process.env.FAKE_CURSOR_KEY_CAPTURE = previousCursorKeyCapture;
        if (previousCursorDirMarker === undefined) delete process.env.FAKE_CURSOR_DIR_MARKER;
        else process.env.FAKE_CURSOR_DIR_MARKER = previousCursorDirMarker;
      }
    },
  );

  test("starts, inspects, and stops the in-container Pi bridge", async () => {
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-pi-bridge-pid-"), "pid");
    const environment = createEnvironment({
      id: "env-container-pi",
      environmentType: "containerized",
      containerId: "container-pi",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
    const previousTokenFile = process.env.FAKE_BRIDGE_TOKEN_FILE;
    const tokenFile = path.join(path.dirname(pidFile), "token");
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;

    const dockerScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/pi-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/pi-bridge.log"*)
        printf 'pi bridge log\\n'
        exit 0 ;;
      *pkill*)
        rm -f "$FAKE_BRIDGE_TOKEN_FILE"
        pid=$(cat "$FAKE_BRIDGE_PID_FILE" 2>/dev/null || true)
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*PI_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    bun -e 'require("node:http").createServer((q,s)=>{s.writeHead(q.url==="/global/health"?200:404,{"content-type":"application/json"});s.end("{}")}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const [first, second] = (await Promise.all([
          commands.get("start_pi_server")?.({ containerId: "container-pi" }, context),
          commands.get("start_pi_server")?.({ containerId: "container-pi" }, context),
        ])) as Array<{ hostPort: number; wasRunning: boolean; authToken: string }>;
        expect(first).toMatchObject({ hostPort, wasRunning: false });
        expect(second).toMatchObject({ hostPort, wasRunning: true });
        expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(second.authToken).toBe(first.authToken);

        await expect(
          commands.get("get_pi_server_status")?.({ containerId: "container-pi" }, context),
        ).resolves.toEqual({ running: true, hostPort, authToken: first.authToken });
        await expect(
          commands.get("get_pi_server_log")?.({ containerId: "container-pi" }, context),
        ).resolves.toBe("pi bridge log\n");

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog.split("\n").filter((line) => line.startsWith("exec -d "))).toHaveLength(1);
        expect(execLog).toContain("export PI_AGENT_DIR=/home/node/.pi/agent");
        expect(execLog).toContain("export PI_SESSION_DIR=/home/node/.pi/agent/sessions");
        expect(execLog).toContain("export PI_BRIDGE_STATE_DIR=/tmp/orkestrator-pi-state");
        expect(execLog).toContain("export PI_BRIDGE_PROJECT_RESOURCES=1");
        expect(execLog).toContain("setsid bun /opt/pi-bridge/dist/index.js");
        expect(execLog).toContain("umask 077");

        await commands.get("stop_pi_server")?.({ containerId: "container-pi" }, context);
        const afterStop = await fs.readFile(logs.exec, "utf8");
        expect(afterStop).toContain("pkill -f '[p]i-bridge/dist/index.js'");
        expect(afterStop).toContain("rm -f /tmp/pi-bridge-token");
      });
    } finally {
      const pid = await fs.readFile(pidFile, "utf8").catch(() => "");
      if (pid) {
        try {
          process.kill(Number(pid));
        } catch {
          // already gone
        }
      }
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousPidFile === undefined) delete process.env.FAKE_BRIDGE_PID_FILE;
      else process.env.FAKE_BRIDGE_PID_FILE = previousPidFile;
      if (previousTokenFile === undefined) delete process.env.FAKE_BRIDGE_TOKEN_FILE;
      else process.env.FAKE_BRIDGE_TOKEN_FILE = previousTokenFile;
    }
  });

  test("persists the container Cursor fingerprint when no API key was ever configured", async () => {
    // The cold-start path nothing else covers: with no key, the credential
    // sync only removes a file, so /tmp/orkestrator-ai is never created for
    // it. `workspace-setup.sh` creates that directory only past its
    // `--prepare-only` exit and only as `node`, so a prepared-but-not-set-up
    // container reaches here without it. If the fingerprint write is allowed
    // to fail, the file reads back empty, never matches sha256("") and
    // restarts a healthy bridge on every single start request.
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-cursor-coldstart-pid-"), "pid");
    const environment = createEnvironment({
      id: "env-container-cursor-coldstart",
      environmentType: "containerized",
      containerId: "container-cursor-coldstart",
      status: "running",
    });
    const { context } = createContext(environment, { globalConfig: {} });
    const commands = createCommandRegistry();

    const previous = {
      hostPort: process.env.FAKE_BRIDGE_HOST_PORT,
      pidFile: process.env.FAKE_BRIDGE_PID_FILE,
      tokenFile: process.env.FAKE_BRIDGE_TOKEN_FILE,
      fingerprintFile: process.env.FAKE_CURSOR_FINGERPRINT_FILE,
      keyCapture: process.env.FAKE_CURSOR_KEY_CAPTURE,
      dirMarker: process.env.FAKE_CURSOR_DIR_MARKER,
    };
    const scratch = path.dirname(pidFile);
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;
    process.env.FAKE_BRIDGE_TOKEN_FILE = path.join(scratch, "token");
    process.env.FAKE_CURSOR_FINGERPRINT_FILE = path.join(scratch, "cursor-fingerprint");
    process.env.FAKE_CURSOR_KEY_CAPTURE = path.join(scratch, "cursor-key");
    // Deliberately never created up front: only a command that runs its own
    // mkdir may bring the credential directory into existence.
    process.env.FAKE_CURSOR_DIR_MARKER = path.join(scratch, "cursor-credential-dir");

    const dockerScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"mkdir -p '/tmp/orkestrator-ai'"*|*'mkdir -p "$credential_dir"'*)
        : > "$FAKE_CURSOR_DIR_MARKER" ;;
    esac
    case "$*" in
      *"cat /tmp/cursor-acp-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/orkestrator-ai/cursor-api-key-fingerprint"*)
        cat "$FAKE_CURSOR_FINGERPRINT_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/cursor-acp-bridge.log"*)
        printf 'cursor acp log\\n'; exit 0 ;;
      *pkill*)
        rm -f "$FAKE_BRIDGE_TOKEN_FILE"
        pid=$(cat "$FAKE_BRIDGE_PID_FILE" 2>/dev/null || true)
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
        exit 0 ;;
      *"rm -f /tmp/orkestrator-ai/cursor-api-key"*)
        rm -f "$FAKE_CURSOR_KEY_CAPTURE"
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*ACP_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    fingerprint=$(printf '%s' "$*" | sed -n "s#.*printf '%s' '\\([0-9a-f][0-9a-f]*\\)' > /tmp/orkestrator-ai/cursor-api-key-fingerprint.*#\\1#p")
    if [ -n "$fingerprint" ] && [ -e "$FAKE_CURSOR_DIR_MARKER" ]; then
      printf '%s' "$fingerprint" > "$FAKE_CURSOR_FINGERPRINT_FILE"
    fi
    bun -e 'require("node:http").createServer((q,s)=>{s.writeHead(q.url==="/global/health"?200:404,{"content-type":"application/json"});s.end("{}")}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const started = (await commands.get("start_cursor_server")?.(
          { containerId: "container-cursor-coldstart" },
          context,
        )) as { hostPort: number; wasRunning: boolean; authToken: string };
        expect(started).toMatchObject({ hostPort, wasRunning: false });

        // The bridge ran without a key, and still recorded sha256("").
        expect(await fs.readFile(process.env.FAKE_CURSOR_FINGERPRINT_FILE!, "utf8")).toBe(
          createHash("sha256").update("").digest("hex"),
        );
        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain("unset CURSOR_API_KEY");

        const second = (await commands.get("start_cursor_server")?.(
          { containerId: "container-cursor-coldstart" },
          context,
        )) as { hostPort: number; wasRunning: boolean; authToken: string };
        expect(second).toMatchObject({ hostPort, wasRunning: true });
        expect(second.authToken).toBe(started.authToken);
        expect(
          (await fs.readFile(logs.exec, "utf8"))
            .split("\n")
            .filter((line) => line.startsWith("exec -d ")),
        ).toHaveLength(1);
      });
    } finally {
      const pid = await fs.readFile(pidFile, "utf8").catch(() => "");
      if (pid) {
        try {
          process.kill(Number(pid));
        } catch {
          // already gone
        }
      }
      for (const [name, value] of [
        ["FAKE_BRIDGE_HOST_PORT", previous.hostPort],
        ["FAKE_BRIDGE_PID_FILE", previous.pidFile],
        ["FAKE_BRIDGE_TOKEN_FILE", previous.tokenFile],
        ["FAKE_CURSOR_FINGERPRINT_FILE", previous.fingerprintFile],
        ["FAKE_CURSOR_KEY_CAPTURE", previous.keyCapture],
        ["FAKE_CURSOR_DIR_MARKER", previous.dirMarker],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("keeps the in-container Claude bridge on its bun entrypoint", async () => {
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-claude-bridge-pid-"), "pid");
    const environment = createEnvironment({
      id: "env-container-claude",
      environmentType: "containerized",
      containerId: "container-claude",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;

    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    bun -e 'require("node:http").createServer((q,s)=>{s.writeHead(q.url==="/global/health"||q.url==="/global/auth-check"?200:404,{"content-type":"application/json"});s.end("{}")}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const result = (await commands.get("start_claude_server")?.(
          { containerId: "container-claude" },
          context,
        )) as { hostPort: number; wasRunning: boolean; authToken: string };
        expect(result).toMatchObject({ hostPort, wasRunning: false });
        expect(result.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain("setsid bun /opt/claude-bridge/dist/index.js");
        expect(execLog).not.toContain("setsid node");
        expect(execLog).toContain("/tmp/claude-bridge-token");
        expect(execLog).toContain("export CLAUDE_BRIDGE_TOKEN=");
        expect(execLog).toContain(
          "export ORKESTRATOR_GITHUB_CREDENTIAL_FILE='/tmp/orkestrator-ai/github-token'",
        );
        expect(execLog).toContain("unset GITHUB_TOKEN GH_TOKEN");
      });
    } finally {
      const pid = await fs.readFile(pidFile, "utf8").catch(() => "");
      if (pid) {
        try {
          process.kill(Number(pid));
        } catch {
          // already gone
        }
      }
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousPidFile === undefined) delete process.env.FAKE_BRIDGE_PID_FILE;
      else process.env.FAKE_BRIDGE_PID_FILE = previousPidFile;
    }
  });

  test("starts, replaces, and reuses an authenticated container OpenCode server", async () => {
    const hostPort = await reserveFreePort();
    const stateDir = await createTempDir("ork-opencode-container-auth-");
    const tokenFile = path.join(stateDir, "persisted-password");
    const liveTokenFile = path.join(stateDir, "live-password");
    const healthyFile = path.join(stateDir, "healthy");
    const pluginFingerprintFile = path.join(stateDir, "plugin-fingerprint");
    const environment = createEnvironment({
      id: "env-container-opencode-auth",
      environmentType: "containerized",
      containerId: "container-opencode-auth",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const previous = {
      hostPort: process.env.FAKE_BRIDGE_HOST_PORT,
      tokenFile: process.env.FAKE_BRIDGE_TOKEN_FILE,
      liveTokenFile: process.env.FAKE_BRIDGE_LIVE_TOKEN_FILE,
      healthyFile: process.env.FAKE_BRIDGE_HEALTHY_FILE,
      pluginFingerprintFile: process.env.FAKE_OPENCODE_PLUGIN_FINGERPRINT_FILE,
      pluginFingerprint: process.env.FAKE_OPENCODE_PLUGIN_FINGERPRINT,
    };
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;
    process.env.FAKE_BRIDGE_LIVE_TOKEN_FILE = liveTokenFile;
    process.env.FAKE_BRIDGE_HEALTHY_FILE = healthyFile;
    process.env.FAKE_OPENCODE_PLUGIN_FINGERPRINT_FILE = pluginFingerprintFile;
    process.env.FAKE_OPENCODE_PLUGIN_FINGERPRINT =
      commandTesting.OPENCODE_GITHUB_ENV_PLUGIN_FINGERPRINT;

    const bridge = await startAuthenticatedContainerServer(hostPort, {
      isHealthy: () => existsSync(healthyFile),
      isAuthorized: (request) =>
        request.headers.authorization ===
        `Basic ${Buffer.from(`opencode:${readTestCredential(liveTokenFile)}`).toString("base64")}`,
    });
    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/opencode-server-password"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/orkestrator-ai/opencode-github-env-plugin-fingerprint"*)
        cat "$FAKE_OPENCODE_PLUGIN_FINGERPRINT_FILE" 2>/dev/null || true
        exit 0 ;;
      *"pkill -f '[o]pencode serve'"*)
        rm -f "$FAKE_BRIDGE_HEALTHY_FILE" "$FAKE_BRIDGE_TOKEN_FILE" "$FAKE_OPENCODE_PLUGIN_FINGERPRINT_FILE"
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*OPENCODE_SERVER_PASSWORD='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    printf '%s' "$token" > "$FAKE_BRIDGE_LIVE_TOKEN_FILE"
    printf '%s' "$FAKE_OPENCODE_PLUGIN_FINGERPRINT" > "$FAKE_OPENCODE_PLUGIN_FINGERPRINT_FILE"
    : > "$FAKE_BRIDGE_HEALTHY_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const first = (await commands.get("start_opencode_server")?.(
          { containerId: "container-opencode-auth" },
          context,
        )) as { hostPort: number; wasRunning: boolean; authToken: string };
        expect(first).toMatchObject({ hostPort, wasRunning: false });
        expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

        // An authenticated server from a build before the GitHub environment
        // hook existed must also restart instead of being reused indefinitely.
        await fs.rm(pluginFingerprintFile);
        const capabilityReplacement = (await commands.get("start_opencode_server")?.(
          { containerId: "container-opencode-auth" },
          context,
        )) as { hostPort: number; wasRunning: boolean; authToken: string };
        expect(capabilityReplacement).toMatchObject({ hostPort, wasRunning: false });
        expect(capabilityReplacement.authToken).not.toBe(first.authToken);

        // A reachable legacy process without a readable password is replaced,
        // rather than being handed to the renderer unauthenticated.
        await fs.rm(tokenFile);
        const legacyReplacement = (await commands.get("start_opencode_server")?.(
          { containerId: "container-opencode-auth" },
          context,
        )) as { hostPort: number; wasRunning: boolean; authToken: string };
        expect(legacyReplacement).toMatchObject({ hostPort, wasRunning: false });
        expect(legacyReplacement.authToken).not.toBe(first.authToken);

        const stalePassword = "S".repeat(43);
        await fs.writeFile(tokenFile, stalePassword);
        await fs.writeFile(liveTokenFile, "L".repeat(43));
        const replacement = (await commands.get("start_opencode_server")?.(
          { containerId: "container-opencode-auth" },
          context,
        )) as { hostPort: number; wasRunning: boolean; authToken: string };
        expect(replacement).toMatchObject({ hostPort, wasRunning: false });
        expect(replacement.authToken).not.toBe(stalePassword);

        await expect(
          commands.get("start_opencode_server")?.(
            { containerId: "container-opencode-auth" },
            context,
          ),
        ).resolves.toEqual({
          hostPort,
          wasRunning: true,
          authToken: replacement.authToken,
        });

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog.split("\n").filter((line) => line.startsWith("exec -d "))).toHaveLength(4);
        expect(execLog).toContain("pkill -f '[o]pencode serve'");
        expect(execLog).toContain("/home/node/.config/opencode/plugins/orkestrator-github-env.js");
        expect(execLog).not.toContain("OPENCODE_CONFIG_CONTENT");
        expect(execLog).toContain("unset GITHUB_TOKEN GH_TOKEN");
      });
    } finally {
      await bridge.close();
      for (const [key, value] of Object.entries(previous)) {
        const envName = {
          hostPort: "FAKE_BRIDGE_HOST_PORT",
          tokenFile: "FAKE_BRIDGE_TOKEN_FILE",
          liveTokenFile: "FAKE_BRIDGE_LIVE_TOKEN_FILE",
          healthyFile: "FAKE_BRIDGE_HEALTHY_FILE",
          pluginFingerprintFile: "FAKE_OPENCODE_PLUGIN_FINGERPRINT_FILE",
          pluginFingerprint: "FAKE_OPENCODE_PLUGIN_FINGERPRINT",
        }[key]!;
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      }
    }
  });

  test("replaces a healthy Claude bridge when its persisted token does not authenticate", async () => {
    const hostPort = await reserveFreePort();
    const stateDir = await createTempDir("ork-claude-stale-identity-");
    const tokenFile = path.join(stateDir, "persisted-token");
    const liveTokenFile = path.join(stateDir, "live-token");
    const healthyFile = path.join(stateDir, "healthy");
    const staleToken = "S".repeat(43);
    await fs.writeFile(tokenFile, staleToken);
    await fs.writeFile(liveTokenFile, "L".repeat(43));
    await fs.writeFile(healthyFile, "");

    const environment = createEnvironment({
      id: "env-container-claude-stale",
      environmentType: "containerized",
      containerId: "container-claude-stale",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const previous = {
      hostPort: process.env.FAKE_BRIDGE_HOST_PORT,
      tokenFile: process.env.FAKE_BRIDGE_TOKEN_FILE,
      liveTokenFile: process.env.FAKE_BRIDGE_LIVE_TOKEN_FILE,
      healthyFile: process.env.FAKE_BRIDGE_HEALTHY_FILE,
    };
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;
    process.env.FAKE_BRIDGE_LIVE_TOKEN_FILE = liveTokenFile;
    process.env.FAKE_BRIDGE_HEALTHY_FILE = healthyFile;

    const bridge = await startAuthenticatedContainerServer(hostPort, {
      isHealthy: () => existsSync(healthyFile),
      isAuthorized: (request) =>
        request.headers["x-orkestrator-claude-token"] === readTestCredential(liveTokenFile),
    });
    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/claude-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"pkill -f '[c]laude-bridge/dist/index.js'"*)
        rm -f "$FAKE_BRIDGE_HEALTHY_FILE"
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*CLAUDE_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    printf '%s' "$token" > "$FAKE_BRIDGE_LIVE_TOKEN_FILE"
    : > "$FAKE_BRIDGE_HEALTHY_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        await expect(
          commands.get("get_claude_server_status")?.(
            { containerId: "container-claude-stale" },
            context,
          ),
        ).resolves.toEqual({ running: true, hostPort });

        const result = (await commands.get("start_claude_server")?.(
          { containerId: "container-claude-stale" },
          context,
        )) as { hostPort: number; wasRunning: boolean; authToken: string };

        expect(result).toMatchObject({ hostPort, wasRunning: false });
        expect(result.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(result.authToken).not.toBe(staleToken);
        expect(readTestCredential(liveTokenFile)).toBe(result.authToken);
        expect(await fs.readFile(logs.exec, "utf8")).toContain(
          "pkill -f '[c]laude-bridge/dist/index.js'",
        );
      });
    } finally {
      await bridge.close();
      for (const [key, value] of Object.entries(previous)) {
        const envName = {
          hostPort: "FAKE_BRIDGE_HOST_PORT",
          tokenFile: "FAKE_BRIDGE_TOKEN_FILE",
          liveTokenFile: "FAKE_BRIDGE_LIVE_TOKEN_FILE",
          healthyFile: "FAKE_BRIDGE_HEALTHY_FILE",
        }[key]!;
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      }
    }
  });

  test("authenticates the persisted Claude token when a bridge arrives between health checks", async () => {
    const hostPort = await reserveFreePort();
    const tokenFile = path.join(await createTempDir("ork-claude-late-identity-"), "token");
    const persistedToken = "P".repeat(43);
    await fs.writeFile(tokenFile, persistedToken);
    const environment = createEnvironment({
      id: "env-container-claude-late",
      environmentType: "containerized",
      containerId: "container-claude-late",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();
    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousTokenFile = process.env.FAKE_BRIDGE_TOKEN_FILE;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;

    let healthChecks = 0;
    const bridge = await startAuthenticatedContainerServer(hostPort, {
      isHealthy: () => (healthChecks += 1) > 1,
      isAuthorized: (request) => request.headers["x-orkestrator-claude-token"] === persistedToken,
    });
    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/claude-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE"
        exit 0 ;;
      *"cat /tmp/orkestrator-ai/claude-github-env-fingerprint"*)
        printf '%s' '${commandTesting.CLAUDE_GITHUB_ENV_FINGERPRINT}'
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        await expect(
          commands.get("start_claude_server")?.({ containerId: "container-claude-late" }, context),
        ).resolves.toEqual({
          hostPort,
          wasRunning: true,
          authToken: persistedToken,
        });
        expect(await fs.readFile(logs.exec, "utf8")).not.toContain("exec -d ");
      });
    } finally {
      await bridge.close();
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousTokenFile === undefined) delete process.env.FAKE_BRIDGE_TOKEN_FILE;
      else process.env.FAKE_BRIDGE_TOKEN_FILE = previousTokenFile;
    }
  });

  test("defaults a malformed in-container Codex thread limit before shell interpolation", async () => {
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-codex-fallback-pid-"), "pid");
    const environment = createEnvironment({
      id: "env-container-codex-fallback",
      environmentType: "containerized",
      containerId: "container-codex-fallback",
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: { codexMaxConcurrentThreads: "invalid" },
    });
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;

    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    bun -e 'require("node:http").createServer((q,s)=>{s.writeHead(q.url==="/global/health"?200:404);s.end()}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        await commands.get("start_codex_server")?.(
          { containerId: "container-codex-fallback" },
          context,
        );
        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain("export CODEX_MAX_CONCURRENT_THREADS_PER_SESSION=5");
        expect(execLog).not.toContain("invalid");
      });
    } finally {
      const pid = await fs.readFile(pidFile, "utf8").catch(() => "");
      if (pid) {
        try {
          process.kill(Number(pid));
        } catch {
          // already gone
        }
      }
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousPidFile === undefined) delete process.env.FAKE_BRIDGE_PID_FILE;
      else process.env.FAKE_BRIDGE_PID_FILE = previousPidFile;
    }
  });

  test("replaces an in-container Codex bridge that has no usable persisted token", async () => {
    const hostPort = await reserveFreePort();
    const stateDir = await createTempDir("ork-codex-legacy-bridge-");
    const tokenFile = path.join(stateDir, "token");
    const killedFile = path.join(stateDir, "killed");
    // A bridge from before per-process authentication: healthy, but its token
    // file holds something the renderer cannot use.
    await fs.writeFile(tokenFile, "legacy");

    const environment = createEnvironment({
      id: "env-container-codex-legacy",
      environmentType: "containerized",
      containerId: "container-codex-legacy",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousTokenFile = process.env.FAKE_BRIDGE_TOKEN_FILE;
    const previousKilledFile = process.env.FAKE_BRIDGE_KILLED_FILE;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;
    process.env.FAKE_BRIDGE_KILLED_FILE = killedFile;

    // The bridge is healthy until `pkill` drops the marker, and healthy again
    // once the start script has run.
    const bridge = await startControllableHealthServer(hostPort, () => !existsSync(killedFile));

    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/codex-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"pkill -f '[c]odex-bridge/dist/index.js'"*)
        : > "$FAKE_BRIDGE_KILLED_FILE"
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*CODEX_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    rm -f "$FAKE_BRIDGE_KILLED_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const result = (await commands.get("start_codex_server")?.(
          { containerId: "container-codex-legacy" },
          context,
        )) as { hostPort: number; wasRunning: boolean; authToken: string };

        expect(result).toMatchObject({ hostPort, wasRunning: false });
        expect(result.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(await fs.readFile(tokenFile, "utf8")).toBe(result.authToken);

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).toContain("pkill -f '[c]odex-bridge/dist/index.js'");
        expect(execLog.split("\n").filter((line) => line.startsWith("exec -d "))).toHaveLength(1);
      });
    } finally {
      await bridge.close();
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousTokenFile === undefined) delete process.env.FAKE_BRIDGE_TOKEN_FILE;
      else process.env.FAKE_BRIDGE_TOKEN_FILE = previousTokenFile;
      if (previousKilledFile === undefined) delete process.env.FAKE_BRIDGE_KILLED_FILE;
      else process.env.FAKE_BRIDGE_KILLED_FILE = previousKilledFile;
    }
  });

  test("returns the container's persisted token when a bridge arrives after the health check", async () => {
    const hostPort = await reserveFreePort();
    const stateDir = await createTempDir("ork-codex-late-bridge-");
    const tokenFile = path.join(stateDir, "token");
    const persistedToken = "L".repeat(43);
    await fs.writeFile(tokenFile, persistedToken);

    const environment = createEnvironment({
      id: "env-container-codex-late",
      environmentType: "containerized",
      containerId: "container-codex-late",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousTokenFile = process.env.FAKE_BRIDGE_TOKEN_FILE;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;

    // Unhealthy for the handler's own check and healthy by the time
    // startContainerServer re-checks: a prior start whose health wait timed out
    // but whose bridge came up late.
    let healthChecks = 0;
    const bridge = await startControllableHealthServer(hostPort, () => (healthChecks += 1) > 1);

    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/codex-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const result = (await commands.get("start_codex_server")?.(
          { containerId: "container-codex-late" },
          context,
        )) as { hostPort: number; wasRunning: boolean; authToken: string };

        expect(result).toEqual({ hostPort, wasRunning: true, authToken: persistedToken });
        expect(await fs.readFile(tokenFile, "utf8")).toBe(persistedToken);

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog).not.toContain("exec -d ");
      });
    } finally {
      await bridge.close();
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
      if (previousTokenFile === undefined) delete process.env.FAKE_BRIDGE_TOKEN_FILE;
      else process.env.FAKE_BRIDGE_TOKEN_FILE = previousTokenFile;
    }
  });

  test("keeps the Codex bridge token out of a failed docker exec error", async () => {
    const hostPort = await reserveFreePort();
    const environment = createEnvironment({
      id: "env-container-codex-redaction",
      environmentType: "containerized",
      containerId: "container-codex-redaction",
      status: "running",
    });
    const { context } = createContext(environment);
    const commands = createCommandRegistry();

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);

    // The start exec fails without writing anything, so the only material left
    // for an error message is the argv that carries the token.
    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/codex-bridge-token"*) exit 0 ;;
    esac
    exit 9 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const failure = await commands
          .get("start_codex_server")?.({ containerId: "container-codex-redaction" }, context)
          .then(
            () => null,
            (error: unknown) => error as Error,
          );

        expect(failure).toBeInstanceOf(Error);
        const execLog = await fs.readFile(logs.exec, "utf8");
        const token = execLog.match(/CODEX_BRIDGE_TOKEN='([^']+)'/)?.[1];
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(failure!.message).not.toContain(token!);
        expect(failure!.message).toContain("[REDACTED]");
      });
    } finally {
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
    }
  });
});
