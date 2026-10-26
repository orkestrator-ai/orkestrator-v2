import { describe, expect, mock, spyOn, test } from "bun:test";
import os from "node:os";

import { enqueueContainerBridgeOperation } from "../src/core/container-bridge-operations.js";

import { DOCKER_LABEL_APP_VALUE } from "../src/core/constants";
import { createCommandFixtures } from "./command-fixtures";

const {
  ASYNC_TEST_BUDGET_MS,
  ASYNC_TEST_WAIT_TIMEOUT_MS,
  commandTesting,
  createCommandRegistry,
  createContext,
  createEnvironment,
  createHash,
  createTempDir,
  existsSync,
  freshFetchedAt,
  fs,
  path,
  readTestCredential,
  reserveFreePort,
  startAuthenticatedContainerServer,
  startControllableHealthServer,
  waitForCondition,
  withFakeDocker,
} = await createCommandFixtures();

import type { CommandContext } from "./command-fixtures";

type ServerStart = { hostPort: number; wasRunning: boolean; authToken: string };

describe("Electron backend command registry", () => {
  test.each([true, false])(
    "reads OpenCode preferences with XDG_STATE_HOME set: %s",
    async (useXdg) => {
      const root = await createTempDir("ork-opencode-preferences-");
      const previousHome = process.env.HOME;
      const previousState = process.env.XDG_STATE_HOME;
      const state = path.join(root, "state");
      const home = path.join(root, "home");
      const preferences = {
        recent: [{ providerID: "openai", modelID: "test" }],
        favorite: [],
        variant: {},
      };
      const directory = path.join(useXdg ? state : path.join(home, ".local", "state"), "opencode");
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, "model.json"), JSON.stringify(preferences));
      process.env.HOME = home;
      // Bun caches os.homedir(), so redirect it explicitly as well.
      const homeDirectory = spyOn(os, "homedir").mockReturnValue(home);
      if (useXdg) process.env.XDG_STATE_HOME = state;
      else delete process.env.XDG_STATE_HOME;
      try {
        const { context } = createContext(createEnvironment());
        expect(
          await createCommandRegistry().get("get_opencode_model_preferences")?.({}, context),
        ).toEqual(preferences);
      } finally {
        homeDirectory.mockRestore();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousState === undefined) delete process.env.XDG_STATE_HOME;
        else process.env.XDG_STATE_HOME = previousState;
      }
    },
  );

  // The `security` stub only takes effect on darwin, where `getHostClaudeCredentials`
  // consults the Keychain; elsewhere resolution starts at the on-disk credential.
  // Seeding both with the same payload keeps these tests asserting the same thing
  // on every platform instead of silently depending on the developer's OS.

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
      globalConfig: { codexMaxConcurrentThreads: 9, debugLogging: true },
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
        ])) as [ServerStart, ServerStart];
        expect(first).toMatchObject({ hostPort, wasRunning: false });
        expect(second).toMatchObject({ hostPort, wasRunning: true });
        expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(second.authToken).toBe(first.authToken);

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog.split("\n").filter((line) => line.startsWith("exec -d "))).toHaveLength(1);
        expect(execLog).toContain("/tmp/codex-bridge-token");
        expect(execLog).toContain("export CODEX_BRIDGE_TOKEN=");
        expect(execLog).toContain("export CODEX_MAX_CONCURRENT_THREADS_PER_SESSION=9");
        // Skills and templates resolve against the container's workspace and
        // the container user's own CODEX_HOME, never a host path.
        expect(execLog).toContain("cd /workspace");
        expect(execLog).toContain("export CWD=/workspace");
        expect(execLog).not.toContain("CODEX_HOME=");
        expect(execLog).toContain("export ORKESTRATOR_BRIDGE_DEBUG=1");
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

  test("starts the in-container Cursor SDK bridge", async () => {
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-cursor-sdk-pid-"), "pid");
    const dataDir = await createTempDir("ork-cursor-sdk-data-");
    const environment = createEnvironment({
      id: "env-container-cursor-sdk",
      environmentType: "containerized",
      containerId: "container-cursor-sdk",
      status: "running",
    });
    const globalConfig: Record<string, unknown> = { debugLogging: true };
    const { context } = createContext(environment, { globalConfig, dataDir });
    const commands = createCommandRegistry();

    // A login-minted credential the bridge is meant to be handed, in the SDK's
    // own on-disk shape.
    await fs.mkdir(path.join(dataDir, "cursor-sdk"), { recursive: true });
    await fs.writeFile(
      path.join(dataDir, "cursor-sdk", "auth.json"),
      JSON.stringify({ apiKey: "minted-sdk-key", email: "dev@example.com" }),
    );

    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
    const previousTokenFile = process.env.FAKE_BRIDGE_TOKEN_FILE;
    const previousCursorFingerprintFile = process.env.FAKE_CURSOR_FINGERPRINT_FILE;
    const previousCursorKeyCapture = process.env.FAKE_CURSOR_KEY_CAPTURE;
    const previousCursorDirMarker = process.env.FAKE_CURSOR_DIR_MARKER;
    const previousSdkKeyCapture = process.env.FAKE_CURSOR_SDK_KEY_CAPTURE;
    const tokenFile = path.join(path.dirname(pidFile), "token");
    const cursorKeyCapture = path.join(path.dirname(pidFile), "cursor-key");
    const cursorFingerprintFile = path.join(path.dirname(pidFile), "cursor-fingerprint");
    const cursorDirMarker = path.join(path.dirname(pidFile), "cursor-credential-dir");
    const sdkKeyCapture = path.join(path.dirname(pidFile), "cursor-sdk-auth");
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;
    process.env.FAKE_CURSOR_FINGERPRINT_FILE = cursorFingerprintFile;
    process.env.FAKE_CURSOR_KEY_CAPTURE = cursorKeyCapture;
    process.env.FAKE_CURSOR_DIR_MARKER = cursorDirMarker;
    process.env.FAKE_CURSOR_SDK_KEY_CAPTURE = sdkKeyCapture;

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
      # The launch script embeds several of the commands below as ordinary
      # lines, so it has to be recognised first — otherwise the fake answers it
      # as a one-shot exec and never starts a bridge.
      *setsid*) ;;
      *"cat /tmp/cursor-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/orkestrator-ai/cursor-api-key-fingerprint"*)
        cat "$FAKE_CURSOR_FINGERPRINT_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/cursor-bridge.log"*)
        printf 'cursor log\\n'; exit 0 ;;
      *pkill*)
        rm -f "$FAKE_BRIDGE_TOKEN_FILE"
        pid=$(cat "$FAKE_BRIDGE_PID_FILE" 2>/dev/null || true)
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
        exit 0 ;;
      *".cursor-sdk-auth.XXXXXX"*)
        cat > "$FAKE_CURSOR_SDK_KEY_CAPTURE"
        exit 0 ;;
      *"rm -f /tmp/orkestrator-ai/cursor-sdk-auth.json"*)
        rm -f "$FAKE_CURSOR_SDK_KEY_CAPTURE"
        exit 0 ;;
      *"rm -f /tmp/orkestrator-ai/cursor-api-key"*)
        rm -f "$FAKE_CURSOR_KEY_CAPTURE"
        exit 0 ;;
      *".cursor-api-key.XXXXXX"*)
        cat > "$FAKE_CURSOR_KEY_CAPTURE"
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*CURSOR_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    if [ -z "$token" ]; then
      token=$(printf '%s' "$*" | sed -n "s/.*ACP_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    fi
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    fingerprint=$(printf '%s' "$*" | sed -n "s#.*printf '%s' '\\([a-z][a-z]*:[0-9a-f]*\\)' > /tmp/orkestrator-ai/cursor-api-key-fingerprint.*#\\1#p")
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
          { containerId: "container-cursor-sdk" },
          context,
        )) as { hostPort: number; wasRunning: boolean; authToken: string };
        expect(started).toMatchObject({ hostPort, wasRunning: false });

        const execLog = await fs.readFile(logs.exec, "utf8");
        // The SDK engine, not the ACP one, and nothing left over from it.
        expect(execLog).toContain("setsid bun /opt/cursor-bridge/dist/index.js");
        expect(execLog).not.toContain("/opt/acp-bridge/dist/index.js --provider=cursor");
        expect(execLog).not.toContain("export ACP_PROVIDER=");
        expect(execLog).not.toContain("export ACP_BRIDGE_TOKEN=");
        expect(execLog).toContain("export CURSOR_BRIDGE_TOKEN=");
        expect(execLog).toContain("export ORKESTRATOR_BRIDGE_DEBUG=1");
        expect(execLog).toContain(
          "export CURSOR_BRIDGE_STATE_DIR=/tmp/orkestrator-cursor-sdk-state",
        );
        expect(execLog).toContain(
          "export CURSOR_BRIDGE_AUTH_FILE=/tmp/orkestrator-ai/cursor-sdk-auth.json",
        );
        // Project-resource access is now passed as a per-session execution
        // policy rather than a process-wide launcher flag.
        expect(execLog).not.toContain("CURSOR_BRIDGE_PROJECT_SETTINGS");
        expect(execLog).toContain("umask 077");
        // The minted key is piped over stdin, so it never reaches docker argv
        // or a process listing.
        expect(execLog).not.toContain("minted-sdk-key");
        expect(await fs.readFile(sdkKeyCapture, "utf8")).toContain("minted-sdk-key");
        // Written by the backend rather than copied, so a host file carrying
        // extra fields cannot smuggle them into a container.
        expect(Object.keys(JSON.parse(await fs.readFile(sdkKeyCapture, "utf8")))).toEqual([
          "version",
          "backendUrl",
          "apiKey",
          "createdAtMs",
        ]);

        expect(await fs.readFile(cursorFingerprintFile, "utf8")).toBe(
          `sdk:${createHash("sha256").update("").digest("hex")}`,
        );

        // Several branches of the launch script expand to nothing for this
        // engine, so parse the exact text with the interpreter the container
        // runs it under rather than trusting the interpolation.
        const detachedExec = execLog.slice(execLog.indexOf("exec -d "));
        const scriptStart = detachedExec.indexOf(" bash -lc ") + " bash -lc ".length;
        const setsidLine = detachedExec.indexOf(
          "setsid bun /opt/cursor-bridge/dist/index.js",
          scriptStart,
        );
        // The launch is an if/else choosing the rotating log writer; parse through
        // its closing fi.
        const scriptEnd = detachedExec.indexOf("\nfi", setsidLine) + "\nfi".length;
        expect(setsidLine).toBeGreaterThan(scriptStart);
        const parsed = Bun.spawnSync([
          "bash",
          "-n",
          "-c",
          detachedExec.slice(scriptStart, scriptEnd),
        ]);
        expect(parsed.stderr.toString()).toBe("");
        expect(parsed.exitCode).toBe(0);

        // An unchanged credential reuses the running bridge rather than
        // restarting the agent's in-flight turn on every prompt dispatch.
        const reused = (await commands.get("start_cursor_server")?.(
          { containerId: "container-cursor-sdk" },
          context,
        )) as { wasRunning: boolean; authToken: string };
        expect(reused).toMatchObject({ wasRunning: true });
        expect(reused.authToken).toBe(started.authToken);
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
      const restore = (name: string, value: string | undefined) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      };
      restore("FAKE_BRIDGE_HOST_PORT", previousHostPort);
      restore("FAKE_BRIDGE_PID_FILE", previousPidFile);
      restore("FAKE_BRIDGE_TOKEN_FILE", previousTokenFile);
      restore("FAKE_CURSOR_FINGERPRINT_FILE", previousCursorFingerprintFile);
      restore("FAKE_CURSOR_KEY_CAPTURE", previousCursorKeyCapture);
      restore("FAKE_CURSOR_DIR_MARKER", previousCursorDirMarker);
      restore("FAKE_CURSOR_SDK_KEY_CAPTURE", previousSdkKeyCapture);
    }
  });

  test("starts, inspects, and stops the in-container Grok ACP bridge", async () => {
    const provider = "grok";
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir(`ork-${provider}-acp-pid-`), "pid");
    const environment = createEnvironment({
      id: `env-container-${provider}`,
      environmentType: "containerized",
      containerId: `container-${provider}`,
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: { enabledAgentPlatforms: ["grok"] },
    });
    context.runtimeFlavor = "agent-test";
    context.credentialSources = new Set(["grok"]);
    const hostHome = path.join(path.dirname(pidFile), "host");
    const hostAuth = path.join(hostHome, ".grok", "auth.json");
    const importedAuth = path.join(path.dirname(pidFile), "imported-auth.json");
    await fs.mkdir(path.dirname(hostAuth), { recursive: true });
    const writeHostLogin = (key: string, expired = false) =>
      fs.writeFile(
        hostAuth,
        JSON.stringify({
          live: {
            key,
            refresh_token: "SENTINEL-HOST-REFRESH",
            expires_at: new Date(Date.now() + (expired ? -3600_000 : 3600_000)).toISOString(),
          },
        }),
      );
    await writeHostLogin("first-access");
    const previousHostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
    const previousImportedAuth = process.env.FAKE_GROK_IMPORTED_AUTH;
    process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = hostHome;
    process.env.FAKE_GROK_IMPORTED_AUTH = importedAuth;
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
      *"/home/node/.grok/auth.json"*)
        cat > "$FAKE_GROK_IMPORTED_AUTH"
        exit 0 ;;
      *"cat /tmp/${provider}-acp-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/orkestrator-ai/cursor-api-key-fingerprint"*)
        cat "$FAKE_CURSOR_FINGERPRINT_FILE" 2>/dev/null || true
        exit 0 ;;
      *"tail -c"*"/tmp/${provider}-acp-bridge.log"*)
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
    # A cold launch must see sync's access-only credential first.
    test -s "$FAKE_GROK_IMPORTED_AUTH" || exit 91
    token=$(printf '%s' "$*" | sed -n "s/.*ACP_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    if [ -z "$token" ]; then
      token=$(printf '%s' "$*" | sed -n "s/.*CURSOR_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    fi
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    fingerprint=$(printf '%s' "$*" | sed -n "s#.*printf '%s' '\\([a-z][a-z]*:[0-9a-f]*\\)' > /tmp/orkestrator-ai/cursor-api-key-fingerprint.*#\\1#p")
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
        process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = hostHome;
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
        ])) as [ServerStart, ServerStart];
        expect(first).toMatchObject({ hostPort, wasRunning: false });
        expect(second).toMatchObject({ hostPort, wasRunning: true });
        expect(first.authToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(second.authToken).toBe(first.authToken);

        expect(JSON.parse(await fs.readFile(importedAuth, "utf8")).live).toMatchObject({
          key: "first-access",
          refresh_token: "",
        });
        // Model expiry without sleeping: an expired host login cannot replace
        // the existing access-only copy, and cannot spend the host refresh token.
        await writeHostLogin("expired-access", true);
        await commands.get("start_grok_server")?.(
          { containerId: environment.containerId },
          context,
        );
        expect(JSON.parse(await fs.readFile(importedAuth, "utf8")).live.key).toBe("first-access");
        await writeHostLogin("renewed-access");
        const renewed = await commands.get("start_grok_server")?.(
          { containerId: environment.containerId },
          context,
        );
        expect(renewed).toEqual(second);
        expect(JSON.parse(await fs.readFile(importedAuth, "utf8")).live).toMatchObject({
          key: "renewed-access",
          refresh_token: "",
        });
        expect(JSON.parse(await fs.readFile(hostAuth, "utf8")).live.refresh_token).toBe(
          "SENTINEL-HOST-REFRESH",
        );

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
        expect(execLog).toContain("export ORKESTRATOR_BRIDGE_DEBUG=0");
        expect(execLog).toContain(`export ACP_STATE_DIR=/tmp/orkestrator-acp-state/${provider}`);
        expect(execLog).toContain("export HOSTNAME=0.0.0.0");
        // The ACP session's cwd, and so Grok's project skills and folder trust,
        // is the container's workspace; GROK_HOME stays the container user's.
        expect(execLog).toContain("cd /workspace");
        expect(execLog).toContain("export CWD=/workspace");
        expect(execLog).not.toContain("GROK_HOME=");
        expect(execLog).toContain(
          `setsid bun /opt/acp-bridge/dist/index.js --provider=${provider}`,
        );
        expect(execLog).not.toContain("ACP_APPROVE_PROJECT_MCPS");
        // Parse the exact launch script with the same interpreter the container runs it under
        // (`docker exec ... bash -lc`), so an interpolation that produces
        // broken shell fails here rather than as a silent startup failure
        // inside a container. `-n` parses without executing.
        const detachedExec = execLog.slice(execLog.indexOf("exec -d "));
        const scriptStart = detachedExec.indexOf(" bash -lc ") + " bash -lc ".length;
        const setsidLine = detachedExec.indexOf(
          `setsid bun /opt/acp-bridge/dist/index.js --provider=${provider}`,
          scriptStart,
        );
        // The launch is an if/else choosing the rotating log writer; parse through
        // its closing fi.
        const scriptEnd = detachedExec.indexOf("\nfi", setsidLine) + "\nfi".length;
        expect(setsidLine).toBeGreaterThan(scriptStart);
        const launchScript = detachedExec.slice(scriptStart, scriptEnd);
        const parsed = Bun.spawnSync(["bash", "-n", "-c", launchScript]);
        expect(parsed.stderr.toString()).toBe("");
        expect(parsed.exitCode).toBe(0);
        // The token is written under a restrictive umask, never echoed.
        expect(execLog).toContain("umask 077");
        expect(execLog).not.toContain("configured-container-cursor-key");
        expect(execLog).not.toContain("SENTINEL-HOST-REFRESH");
        expect(execLog).not.toContain("renewed-access");
        expect(execLog).not.toContain("first-access");

        await commands.get(`stop_${provider}_server`)?.(
          { containerId: `container-${provider}` },
          context,
        );
        const afterStop = await fs.readFile(logs.exec, "utf8");
        expect(afterStop).toContain(`pkill -f '[a]cp-bridge/dist/index.js --provider=${provider}'`);
        expect(afterStop).toContain(`rm -f /tmp/${provider}-acp-bridge-token`);
      });
    } finally {
      if (previousHostHome === undefined) delete process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
      else process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = previousHostHome;
      if (previousImportedAuth === undefined) delete process.env.FAKE_GROK_IMPORTED_AUTH;
      else process.env.FAKE_GROK_IMPORTED_AUTH = previousImportedAuth;
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

  test("starts, inspects, and stops the in-container Pi bridge", async () => {
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-pi-bridge-pid-"), "pid");
    const environment = createEnvironment({
      id: "env-container-pi",
      environmentType: "containerized",
      containerId: "container-pi",
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: { enabledAgentPlatforms: ["pi"] },
    });
    context.runtimeFlavor = "agent-test";
    context.credentialSources = new Set(["pi"]);
    const hostHome = path.join(path.dirname(pidFile), "host");
    const hostAuth = path.join(hostHome, ".pi", "agent", "auth.json");
    const importedAuth = path.join(path.dirname(pidFile), "imported-auth.jsonl");
    await fs.mkdir(path.dirname(hostAuth), { recursive: true });
    await fs.writeFile(
      hostAuth,
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "pi-access",
          refresh: "SENTINEL-HOST-REFRESH",
          expires: Date.now() + 8 * 3600_000,
        },
      }),
    );
    const commands = createCommandRegistry();
    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    const previousPidFile = process.env.FAKE_BRIDGE_PID_FILE;
    const previousTokenFile = process.env.FAKE_BRIDGE_TOKEN_FILE;
    const previousHostHome = process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
    const previousImportedAuth = process.env.FAKE_PI_IMPORTED_AUTH;
    const tokenFile = path.join(path.dirname(pidFile), "token");
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;
    process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;
    process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = hostHome;
    process.env.FAKE_PI_IMPORTED_AUTH = importedAuth;

    const dockerScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"/home/node/.pi/agent/auth.json"*)
        cat >> "$FAKE_PI_IMPORTED_AUTH"
        printf '\n' >> "$FAKE_PI_IMPORTED_AUTH"
        exit 0 ;;
      *"cat /tmp/pi-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"tail -c"*"/tmp/pi-bridge.log"*)
        printf 'pi bridge log\\n'
        exit 0 ;;
      *pkill*)
        rm -f "$FAKE_BRIDGE_TOKEN_FILE"
        pid=$(cat "$FAKE_BRIDGE_PID_FILE" 2>/dev/null || true)
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
        exit 0 ;;
    esac
    # A cold launch must see sync's access-only login first.
    test -s "$FAKE_PI_IMPORTED_AUTH" || exit 91
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
        process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = hostHome;
        const [first, second] = (await Promise.all([
          commands.get("start_pi_server")?.({ containerId: "container-pi" }, context),
          commands.get("start_pi_server")?.({ containerId: "container-pi" }, context),
        ])) as [ServerStart, ServerStart];
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
        // Templates, skills and extensions resolve in the container's workspace.
        expect(execLog).toContain("export CWD=/workspace");
        expect(execLog).toContain("export ORKESTRATOR_BRIDGE_DEBUG=0");
        expect(execLog).toContain("export PI_SESSION_DIR=/home/node/.pi/agent/sessions");
        expect(execLog).toContain("export PI_BRIDGE_STATE_DIR=/tmp/orkestrator-pi-state");
        expect(execLog).not.toContain("PI_BRIDGE_PROJECT_RESOURCES");
        expect(execLog).toContain("setsid bun /opt/pi-bridge/dist/index.js");
        expect(execLog).toContain("umask 077");
        // Both starts, the reused one too, hand over the host login access-only.
        const pushes = (await fs.readFile(importedAuth, "utf8")).trim().split("\n");
        expect(pushes).toHaveLength(2);
        for (const push of pushes) {
          expect(JSON.parse(push)).toEqual({
            logins: {
              anthropic: expect.objectContaining({ access: "pi-access", refresh: "" }),
            },
            accessOnly: ["anthropic"],
          });
        }
        expect(execLog).not.toContain("SENTINEL");

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
      if (previousHostHome === undefined) delete process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
      else process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = previousHostHome;
      if (previousImportedAuth === undefined) delete process.env.FAKE_PI_IMPORTED_AUTH;
      else process.env.FAKE_PI_IMPORTED_AUTH = previousImportedAuth;
    }
  });

  test("a Pi stop by full container ID waits for a start issued by an abbreviated one", async () => {
    const hostPort = await reserveFreePort();
    const dir = await createTempDir("ork-pi-bridge-queue-");
    const fullId = "container-pi-queue-0123456789abcdef";
    const environment = createEnvironment({
      id: "env-container-pi-queue",
      environmentType: "containerized",
      containerId: fullId,
      status: "running",
    });
    const { context } = createContext(environment, {
      globalConfig: { enabledAgentPlatforms: ["pi"] },
    });
    context.runtimeFlavor = "agent-test";
    context.credentialSources = new Set(["pi"]);
    const hostHome = path.join(dir, "host");
    const hostAuth = path.join(hostHome, ".pi", "agent", "auth.json");
    await fs.mkdir(path.dirname(hostAuth), { recursive: true });
    await fs.writeFile(
      hostAuth,
      JSON.stringify({
        anthropic: {
          type: "oauth",
          access: "pi-access",
          refresh: "SENTINEL-HOST-REFRESH",
          expires: Date.now() + 8 * 3600_000,
        },
      }),
    );
    const files = {
      FAKE_BRIDGE_HOST_PORT: String(hostPort),
      FAKE_BRIDGE_PID_FILE: path.join(dir, "pid"),
      FAKE_BRIDGE_TOKEN_FILE: path.join(dir, "token"),
      FAKE_PI_SYNC_STARTED: path.join(dir, "sync-started"),
      FAKE_PI_SYNC_RELEASE: path.join(dir, "sync-release"),
      FAKE_PI_ORDER: path.join(dir, "order"),
      FAKE_APP_LABEL: DOCKER_LABEL_APP_VALUE,
      FAKE_FULL_ID: fullId,
      ORKESTRATOR_AGENT_TEST_HOST_HOME: hostHome,
    };
    const previous = Object.fromEntries(Object.keys(files).map((key) => [key, process.env[key]]));
    Object.assign(process.env, files);
    const commands = createCommandRegistry();

    // The abbreviated ID passes the registry's ownership probe as an unlabelled
    // container whose full ID an environment references. The login push blocks
    // until released, holding the start inside the queue.
    const dockerScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect)
    case "$*" in
      *".Id"*) printf '<no value>\\trunning\\t%s\\t%s\\n' "$FAKE_APP_LABEL" "$FAKE_FULL_ID" ;;
      *) printf 'running\\n' ;;
    esac
    exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"/home/node/.pi/agent/auth.json"*)
        cat > /dev/null
        : > "$FAKE_PI_SYNC_STARTED"
        while [ ! -f "$FAKE_PI_SYNC_RELEASE" ]; do sleep 0.02; done
        printf 'sync\\n' >> "$FAKE_PI_ORDER"
        exit 0 ;;
      *"cat /tmp/pi-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *pkill*)
        printf 'stop\\n' >> "$FAKE_PI_ORDER"
        rm -f "$FAKE_BRIDGE_TOKEN_FILE"
        pid=$(cat "$FAKE_BRIDGE_PID_FILE" 2>/dev/null || true)
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
        exit 0 ;;
    esac
    printf 'launch\\n' >> "$FAKE_PI_ORDER"
    token=$(printf '%s' "$*" | sed -n "s/.*PI_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    bun -e 'require("node:http").createServer((q,s)=>{s.writeHead(q.url==="/global/health"?200:404,{"content-type":"application/json"});s.end("{}")}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async () => {
        process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = hostHome;
        const start = commands.get("start_pi_server")?.(
          { containerId: "container-pi-queue" },
          context,
        );
        await waitForCondition(() => existsSync(files.FAKE_PI_SYNC_STARTED), "the login push");
        const stop = commands.get("stop_pi_server")?.({ containerId: fullId }, context);
        // Both resolve to the persisted ID, so the stop queues behind the start.
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(await fs.readFile(files.FAKE_PI_ORDER, "utf8").catch(() => "")).toBe("");
        await fs.writeFile(files.FAKE_PI_SYNC_RELEASE, "");
        await expect(start).resolves.toMatchObject({ hostPort, wasRunning: false });
        await stop;
        expect((await fs.readFile(files.FAKE_PI_ORDER, "utf8")).trim().split("\n")).toEqual([
          "sync",
          "launch",
          "stop",
        ]);
      });
    } finally {
      const pid = await fs.readFile(files.FAKE_BRIDGE_PID_FILE, "utf8").catch(() => "");
      if (pid) {
        try {
          process.kill(Number(pid));
        } catch {
          // already gone
        }
      }
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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
      *"cat /tmp/cursor-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/orkestrator-ai/cursor-api-key-fingerprint"*)
        cat "$FAKE_CURSOR_FINGERPRINT_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/cursor-bridge.log"*)
        printf 'cursor bridge log\\n'; exit 0 ;;
      *pkill*)
        rm -f "$FAKE_BRIDGE_TOKEN_FILE"
        pid=$(cat "$FAKE_BRIDGE_PID_FILE" 2>/dev/null || true)
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
        exit 0 ;;
      *"rm -f /tmp/orkestrator-ai/cursor-api-key"*)
        rm -f "$FAKE_CURSOR_KEY_CAPTURE"
        exit 0 ;;
      *"rm -f /tmp/orkestrator-ai/cursor-sdk-auth.json"*)
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*CURSOR_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    fingerprint=$(printf '%s' "$*" | sed -n "s#.*printf '%s' '\\([a-z][a-z]*:[0-9a-f]*\\)' > /tmp/orkestrator-ai/cursor-api-key-fingerprint.*#\\1#p")
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
          `sdk:${createHash("sha256").update("").digest("hex")}`,
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

  test("a changed Cursor key waits for a busy container bridge to go idle", async () => {
    // Rotating the key used to restart the bridge on the next start request,
    // which ended a running turn (seen live, 2026-10-23). A busy bridge now
    // keeps its key, and the first start after it goes idle applies the new one.
    const hostPort = await reserveFreePort();
    const pidFile = path.join(await createTempDir("ork-cursor-rotation-pid-"), "pid");
    const environment = createEnvironment({
      id: "env-container-cursor-rotation",
      environmentType: "containerized",
      containerId: "container-cursor-rotation",
      status: "running",
    });
    const globalConfig: Record<string, unknown> = { cursorApiKey: "first-cursor-key" };
    const { context } = createContext(environment, { globalConfig });
    let busy = false;
    const liveWorkChecks: Array<[string, string]> = [];
    (context as { nativeAgents?: unknown }).nativeAgents = {
      hasObservedLiveWork: async (environmentId: string, agent: string) => {
        liveWorkChecks.push([environmentId, agent]);
        return busy;
      },
    };
    const commands = createCommandRegistry();

    const names = [
      "FAKE_BRIDGE_HOST_PORT",
      "FAKE_BRIDGE_PID_FILE",
      "FAKE_BRIDGE_TOKEN_FILE",
      "FAKE_CURSOR_FINGERPRINT_FILE",
      "FAKE_CURSOR_KEY_CAPTURE",
      "FAKE_CURSOR_DIR_MARKER",
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    const scratch = path.dirname(pidFile);
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    process.env.FAKE_BRIDGE_PID_FILE = pidFile;
    process.env.FAKE_BRIDGE_TOKEN_FILE = path.join(scratch, "token");
    process.env.FAKE_CURSOR_FINGERPRINT_FILE = path.join(scratch, "cursor-fingerprint");
    process.env.FAKE_CURSOR_KEY_CAPTURE = path.join(scratch, "cursor-key");
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
      *setsid*) ;;
      *"cat /tmp/cursor-bridge-token"*)
        cat "$FAKE_BRIDGE_TOKEN_FILE" 2>/dev/null || true
        exit 0 ;;
      *"cat /tmp/orkestrator-ai/cursor-api-key-fingerprint"*)
        cat "$FAKE_CURSOR_FINGERPRINT_FILE" 2>/dev/null || true
        exit 0 ;;
      *pkill*)
        rm -f "$FAKE_BRIDGE_TOKEN_FILE"
        pid=$(cat "$FAKE_BRIDGE_PID_FILE" 2>/dev/null || true)
        if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; fi
        exit 0 ;;
      *".cursor-api-key.XXXXXX"*)
        cat > "$FAKE_CURSOR_KEY_CAPTURE"
        exit 0 ;;
      *"rm -f /tmp/orkestrator-ai/cursor-sdk-auth.json"*)
        exit 0 ;;
    esac
    token=$(printf '%s' "$*" | sed -n "s/.*CURSOR_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
    printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
    fingerprint=$(printf '%s' "$*" | sed -n "s#.*printf '%s' '\\([a-z][a-z]*:[0-9a-f]*\\)' > /tmp/orkestrator-ai/cursor-api-key-fingerprint.*#\\1#p")
    if [ -n "$fingerprint" ] && [ -e "$FAKE_CURSOR_DIR_MARKER" ]; then
      printf '%s' "$fingerprint" > "$FAKE_CURSOR_FINGERPRINT_FILE"
    fi
    bun -e 'require("node:http").createServer((q,s)=>{s.writeHead(q.url==="/global/health"?200:404,{"content-type":"application/json"});s.end("{}")}).listen(Number(process.env.FAKE_BRIDGE_HOST_PORT),"127.0.0.1")' >/dev/null 2>&1 &
    printf '%s' "$!" > "$FAKE_BRIDGE_PID_FILE"
    exit 0 ;;
esac
exit 0
`;
    const fingerprint = (key: string) => `sdk:${createHash("sha256").update(key).digest("hex")}`;
    const start = () =>
      commands.get("start_cursor_server")?.(
        { containerId: "container-cursor-rotation" },
        context,
      ) as Promise<ServerStart>;

    try {
      await withFakeDocker(dockerScript, async (logs) => {
        const launches = async () =>
          (await fs.readFile(logs.exec, "utf8"))
            .split("\n")
            .filter((line) => line.startsWith("exec -d ")).length;
        const first = await start();
        expect(first).toMatchObject({ hostPort, wasRunning: false });
        expect(await fs.readFile(process.env.FAKE_CURSOR_FINGERPRINT_FILE!, "utf8")).toBe(
          fingerprint("first-cursor-key"),
        );

        // Rotated while a turn runs: the key file is updated for the next
        // launch, but the busy bridge and its token stay.
        globalConfig.cursorApiKey = "rotated-cursor-key";
        busy = true;
        const whileBusy = await start();
        expect(whileBusy).toMatchObject({ hostPort, wasRunning: true });
        expect(whileBusy.authToken).toBe(first.authToken);
        expect(await launches()).toBe(1);
        expect(await fs.readFile(logs.exec, "utf8")).not.toContain("pkill");
        expect(await fs.readFile(process.env.FAKE_CURSOR_KEY_CAPTURE!, "utf8")).toBe(
          "rotated-cursor-key",
        );
        expect(liveWorkChecks).toContainEqual(["env-container-cursor-rotation", "cursor"]);

        // Idle: the next start replaces the bridge with the rotated key.
        busy = false;
        const idle = await start();
        expect(idle).toMatchObject({ hostPort, wasRunning: false });
        expect(idle.authToken).not.toBe(first.authToken);
        expect(await launches()).toBe(2);
        expect(await fs.readFile(process.env.FAKE_CURSOR_FINGERPRINT_FILE!, "utf8")).toBe(
          fingerprint("rotated-cursor-key"),
        );
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
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("Claude bridge start uses the persisted queue key, reconciles first, then restricts an unusable login before launch", async () => {
    const hostPort = await reserveFreePort();
    const dir = await createTempDir("ork-claude-login-start-");
    const marker = path.join(dir, "account-marker");
    const healthy = path.join(dir, "healthy");
    const token = path.join(dir, "bridge-token");
    const accountId = "11111111-2222-4333-8444-555555555555";
    const accountHome = path.join(dir, "agent-accounts", "claude", accountId);
    await fs.mkdir(accountHome, { recursive: true });
    await fs.writeFile(
      path.join(accountHome, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "expired", refreshToken: "NEVER-DELIVER", expiresAt: 1 },
      }),
    );
    await fs.writeFile(path.join(accountHome, ".claude.json"), "{}");
    const environment = createEnvironment({
      id: "env-login-start",
      environmentType: "containerized",
      containerId: "container-claude-login-start-full",
      status: "running",
    });
    const { context } = createContext(environment, {
      dataDir: dir,
      globalConfig: { enabledAgentPlatforms: ["claude"] },
    });
    context.storage.agentAccounts.loadAgentAccounts = (async () => ({
      version: 1,
      accounts: [],
      active: { claude: accountId },
    })) as never;
    const bridge = await startAuthenticatedContainerServer(hostPort, {
      isHealthy: () => existsSync(healthy),
      isAuthorized: (request) =>
        request.headers["x-orkestrator-claude-token"] === readTestCredential(token),
    });
    const commands = createCommandRegistry();
    const released = Promise.withResolvers<void>();
    const locked = Promise.withResolvers<void>();
    const held = enqueueContainerBridgeOperation(
      context,
      "claude",
      environment.containerId!,
      async () => {
        locked.resolve();
        await released.promise;
      },
    );
    // Paths are private generated fixture paths; no credentials are in argv/logs.
    const dockerScript = `#!/bin/sh
case "$1" in
  inspect)
    case "$*" in *'{{.Id}}'*) printf '<no value>\\trunning\\torkestrator-v2\\tcontainer-claude-login-start-full\\n'; exit 0 ;; esac
    printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:${hostPort}\\n'; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/orkestrator-claude-account"*) cat '${marker}' 2>/dev/null || true; exit 0 ;;
      *"printf '%s' '${accountId}'"*) printf '%s' '${accountId}' > '${marker}'; exit 0 ;;
      *"cat /tmp/claude-bridge-token"*) cat '${token}' 2>/dev/null || true; exit 0 ;;
      *"cat /tmp/orkestrator-ai/claude-github-env-fingerprint"*) printf '%s' '${commandTesting.CLAUDE_GITHUB_ENV_FINGERPRINT}'; exit 0 ;;
    esac
    if [ "$2" = "-d" ]; then
      value=$(printf '%s' "$*" | sed -n "s/.*CLAUDE_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
      printf '%s' "$value" > '${token}'
      : > '${healthy}'
    fi
    exit 0 ;;
esac
exit 0
`;
    try {
      await locked.promise;
      await withFakeDocker(dockerScript, async (logs) => {
        const start = commands.get("start_claude_server")!(
          { containerId: "container-claude-login-start" },
          context,
        ) as Promise<ServerStart>;
        // The shortened ID must wait behind the full persisted ID's queue.
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(await fs.readFile(logs.exec, "utf8").catch(() => "")).toBe("");
        released.resolve();
        const result = await start;
        expect(result).toMatchObject({ hostPort, wasRunning: false });
        const log = await fs.readFile(logs.exec, "utf8");
        const reconcile = log.indexOf("rm -f /home/node/.claude/.credentials.json");
        const stamp = log.indexOf(`printf '%s' '${accountId}'`);
        const restrict = log.indexOf("let changed = false");
        const launch = log.indexOf("setsid bun /opt/claude-bridge/dist/index.js");
        expect(reconcile).toBeGreaterThanOrEqual(0);
        expect(stamp).toBeGreaterThan(reconcile);
        expect(restrict).toBeGreaterThan(stamp);
        expect(launch).toBeGreaterThan(restrict);
        expect(log).not.toContain("NEVER-DELIVER");
        expect(log).not.toContain("exec -i container-claude-login-start bash");
      });
    } finally {
      released.resolve();
      await held;
      await bridge.close();
    }
  });

  test.each([
    ["the CLI default", undefined, undefined],
    ["a configured", 8, "export BASH_MAX_TIMEOUT_MS='28800000'"],
  ])(
    "keeps the in-container Claude bridge on its bun entrypoint with %s background command limit",
    async (_label, limitHours, expectedExport) => {
      const hostPort = await reserveFreePort();
      const pidFile = path.join(await createTempDir("ork-claude-bridge-pid-"), "pid");
      const environment = createEnvironment({
        id: "env-container-claude",
        environmentType: "containerized",
        containerId: "container-claude",
        status: "running",
      });
      const { context } = createContext(environment, {
        globalConfig: { claudeBackgroundCommandLimitHours: limitHours },
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
    # Only the bridge launch starts a server; credential syncs run first.
    case "$*" in *setsid*) ;; *) exit 0 ;; esac
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
          // No CWD: discovery uses the process's own working directory, the
          // container's workspace (claudeWorkspaceCwd).
          expect(execLog).toContain("cd /workspace");
          expect(execLog).not.toContain("export CWD=");
          expect(execLog).toContain("/tmp/claude-bridge-token");
          expect(execLog).toContain("export CLAUDE_BRIDGE_TOKEN=");
          expect(execLog).toContain("export ORKESTRATOR_BRIDGE_DEBUG=0");
          expect(execLog).toContain(
            "export ORKESTRATOR_GITHUB_CREDENTIAL_FILE='/tmp/orkestrator-ai/github-token'",
          );
          expect(execLog).toContain("unset GITHUB_TOKEN GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN");
          if (expectedExport) expect(execLog).toContain(expectedExport);
          else expect(execLog).not.toContain("BASH_MAX_TIMEOUT_MS");
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
    },
  );

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
    const { context } = createContext(environment, {
      globalConfig: { enabledAgentPlatforms: ["opencode"] },
    });
    context.runtimeFlavor = "agent-test";
    context.credentialSources = new Set(["opencode"]);
    const importedAuth = path.join(stateDir, "imported-auth.jsonl");
    const hostAuth = path.join(stateDir, "xdg-data", "opencode", "auth.json");
    await fs.mkdir(path.dirname(hostAuth), { recursive: true });
    await fs.writeFile(
      hostAuth,
      JSON.stringify({
        "opencode-go": { type: "api", key: "go-key" },
        openai: {
          type: "oauth",
          access: "oc-access",
          refresh: "SENTINEL-HOST-REFRESH",
          expires: Date.now() + 3600_000,
        },
      }),
    );
    const commands = createCommandRegistry();
    const previous = {
      xdgDataHome: process.env.XDG_DATA_HOME,
      importedAuth: process.env.FAKE_OPENCODE_IMPORTED_AUTH,
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
    process.env.XDG_DATA_HOME = path.join(stateDir, "xdg-data");
    process.env.FAKE_OPENCODE_IMPORTED_AUTH = importedAuth;

    const statusReads: Array<{ url: string; authorized: boolean }> = [];
    const bridge = await startAuthenticatedContainerServer(hostPort, {
      isHealthy: () => existsSync(healthyFile),
      isAuthorized: (request) =>
        request.headers.authorization ===
        `Basic ${Buffer.from(`opencode:${readTestCredential(liveTokenFile)}`).toString("base64")}`,
      statusReads,
    });
    const dockerScript = `#!/bin/sh
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"/home/node/.local/share/opencode/auth.json"*)
        cat >> "$FAKE_OPENCODE_IMPORTED_AUTH"
        printf '\n' >> "$FAKE_OPENCODE_IMPORTED_AUTH"
        exit 0 ;;
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

        // Each fresh server loads /workspace with its own credential before
        // the start returns, so a prompt's first status read does not pay for
        // OpenCode's plugin install in a new container layer. The reused
        // server is not warmed again.
        expect(statusReads).toEqual(
          Array.from({ length: 4 }, () => ({
            url: "/session/status?directory=%2Fworkspace",
            authorized: true,
          })),
        );

        const execLog = await fs.readFile(logs.exec, "utf8");
        expect(execLog.split("\n").filter((line) => line.startsWith("exec -d "))).toHaveLength(4);
        expect(execLog).toContain("pkill -f '[o]pencode serve'");
        // A container connection names no directory, so the server's own cwd,
        // the container's workspace, scopes `command.list`.
        expect(execLog).toMatch(/cd \/workspace\n[\s\S]*opencode serve --port/);
        expect(execLog).toContain("/home/node/.config/opencode/plugins/orkestrator-github-env.js");
        expect(execLog).not.toContain("OPENCODE_CONFIG_CONTENT");
        expect(execLog).toContain("unset GITHUB_TOKEN GH_TOKEN GITHUB_PERSONAL_ACCESS_TOKEN");
        // Every start, the reused one too, hands over the host login access-only.
        const pushes = (await fs.readFile(importedAuth, "utf8")).trim().split("\n");
        expect(pushes).toHaveLength(5);
        expect(JSON.parse(pushes[4]!)).toEqual({
          logins: {
            "opencode-go": { type: "api", key: "go-key" },
            openai: expect.objectContaining({ access: "oc-access", refresh: "" }),
          },
          accessOnly: ["openai"],
        });
        expect(execLog).not.toContain("SENTINEL");
      });
    } finally {
      await bridge.close();
      for (const [key, value] of Object.entries(previous)) {
        const envName = {
          xdgDataHome: "XDG_DATA_HOME",
          importedAuth: "FAKE_OPENCODE_IMPORTED_AUTH",
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

  test.each([24, 2])(
    "reuses an authenticated Claude bridge after changing its limit to %s hours until a fresh start",
    async (updatedLimitHours) => {
      const hostPort = await reserveFreePort();
      const stateDir = await createTempDir("ork-claude-limit-reuse-");
      const tokenFile = path.join(stateDir, "token");
      const healthyFile = path.join(stateDir, "healthy");
      const globalConfig = { claudeBackgroundCommandLimitHours: 8 };
      const environment = createEnvironment({
        id: "env-container-claude-limit",
        environmentType: "containerized",
        containerId: "container-claude-limit",
        status: "running",
      });
      const { context } = createContext(environment, { globalConfig });
      const commands = createCommandRegistry();
      const previous = {
        FAKE_BRIDGE_HOST_PORT: process.env.FAKE_BRIDGE_HOST_PORT,
        FAKE_BRIDGE_TOKEN_FILE: process.env.FAKE_BRIDGE_TOKEN_FILE,
        FAKE_BRIDGE_HEALTHY_FILE: process.env.FAKE_BRIDGE_HEALTHY_FILE,
      };
      process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
      process.env.FAKE_BRIDGE_TOKEN_FILE = tokenFile;
      process.env.FAKE_BRIDGE_HEALTHY_FILE = healthyFile;

      const bridge = await startAuthenticatedContainerServer(hostPort, {
        isHealthy: () => existsSync(healthyFile),
        isAuthorized: (request) =>
          request.headers["x-orkestrator-claude-token"] === readTestCredential(tokenFile),
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
      *"cat /tmp/orkestrator-ai/claude-github-env-fingerprint"*)
        printf '%s' '${commandTesting.CLAUDE_GITHUB_ENV_FINGERPRINT}'
        exit 0 ;;
      *pkill*)
        rm -f "$FAKE_BRIDGE_HEALTHY_FILE" "$FAKE_BRIDGE_TOKEN_FILE"
        exit 0 ;;
    esac
    if [ "$2" = "-d" ]; then
      token=$(printf '%s' "$*" | sed -n "s/.*CLAUDE_BRIDGE_TOKEN='\\([^']*\\)'.*/\\1/p")
      printf '%s' "$token" > "$FAKE_BRIDGE_TOKEN_FILE"
      : > "$FAKE_BRIDGE_HEALTHY_FILE"
    fi
    exit 0 ;;
esac
exit 0
`;

      try {
        await withFakeDocker(dockerScript, async (logs) => {
          const start = () =>
            commands.get("start_claude_server")!(
              { containerId: environment.containerId },
              context,
            ) as Promise<{ hostPort: number; wasRunning: boolean; authToken: string }>;
          const first = await start();
          expect(first).toMatchObject({ hostPort, wasRunning: false });
          const initialLog = await fs.readFile(logs.exec, "utf8");
          expect(initialLog).toContain("export BASH_MAX_TIMEOUT_MS='28800000'");
          expect(initialLog.split("\n").filter((line) => line.startsWith("exec -d "))).toHaveLength(
            1,
          );

          globalConfig.claudeBackgroundCommandLimitHours = updatedLimitHours;
          expect(await start()).toEqual({ ...first, wasRunning: true });
          const reuseLog = await fs.readFile(logs.exec, "utf8");
          expect(reuseLog.split("\n").filter((line) => line.startsWith("exec -d "))).toHaveLength(
            1,
          );
          expect(reuseLog).not.toContain("pkill");
          expect(reuseLog.slice(initialLog.length)).not.toContain("BASH_MAX_TIMEOUT_MS");

          // Only an explicit stop ends this bridge. A later start uses the
          // current setting, including returning to the CLI's default.
          await commands.get("stop_claude_server")!(
            { containerId: environment.containerId },
            context,
          );
          expect(existsSync(healthyFile)).toBe(false);
          const beforeRestart = await fs.readFile(logs.exec, "utf8");
          const restarted = await start();
          expect(restarted).toMatchObject({ hostPort, wasRunning: false });
          expect(restarted.authToken).not.toBe(first.authToken);
          const restartLog = (await fs.readFile(logs.exec, "utf8")).slice(beforeRestart.length);
          expect(restartLog.split("\n").filter((line) => line.startsWith("exec -d "))).toHaveLength(
            1,
          );
          if (updatedLimitHours === 2) expect(restartLog).not.toContain("BASH_MAX_TIMEOUT_MS");
          else expect(restartLog).toContain("export BASH_MAX_TIMEOUT_MS='86400000'");
        });
      } finally {
        await bridge.close();
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    },
  );

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

  test(
    "defaults a malformed in-container Codex thread limit before shell interpolation",
    async () => {
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
    },
    ASYNC_TEST_BUDGET_MS,
  );

  test(
    "replaces an in-container Codex bridge that has no usable persisted token",
    async () => {
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
    },
    ASYNC_TEST_BUDGET_MS,
  );

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
        const failure = await Promise.resolve(
          commands.get("start_codex_server")?.(
            { containerId: "container-codex-redaction" },
            context,
          ),
        ).then(
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

  // Cursor, Grok and Pi get the agent tools connection per session, so their
  // bridge start fires a background container → host reachability probe. The
  // probe is evidence only: a rejecting or hung probe must neither fail nor
  // delay the start. The bridge is modelled as already running with a valid
  // token, so the start takes its short reuse path.
  for (const provider of ["cursor", "grok", "pi"] as const) {
    test(`fires a background agent tools probe without blocking the ${provider} bridge start`, async () => {
      const containerId = `container-${provider}-reachability`;
      const hostPort = await reserveFreePort();
      const bridge = await startControllableHealthServer(hostPort, () => true);
      const token = "t".repeat(43);
      const environment = createEnvironment({
        id: `env-${provider}-reachability`,
        environmentType: "containerized",
        containerId,
        status: "running",
      });
      const { context } = createContext(environment, {
        globalConfig: {},
        dataDir: await createTempDir(`ork-${provider}-reachability-data-`),
      });
      const probes: Array<"reject" | "hang"> = [];
      const checkEnvironmentContainer = mock((_containerId: string, _options: unknown) => {
        const behaviour = probes.shift();
        return behaviour === "hang"
          ? new Promise<never>(() => undefined)
          : Promise.reject(new Error("container cannot reach the agent tools server"));
      });
      context.containerHostReachability = {
        checkEnvironmentContainer,
      } as unknown as CommandContext["containerHostReachability"];
      const commands = createCommandRegistry();
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);

      const previous = {
        hostPort: process.env.FAKE_BRIDGE_HOST_PORT,
        token: process.env.FAKE_BRIDGE_TOKEN,
        fingerprint: process.env.FAKE_CURSOR_FINGERPRINT,
      };
      process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
      process.env.FAKE_BRIDGE_TOKEN = token;
      // No Cursor key is configured, so the expected fingerprint is sha256("").
      process.env.FAKE_CURSOR_FINGERPRINT = `sdk:${createHash("sha256").update("").digest("hex")}`;

      const dockerScript = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  inspect) printf 'running\\n'; exit 0 ;;
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    printf '%s\\n' "$*" >> "$FAKE_DOCKER_EXEC_LOG"
    case "$*" in
      *"cat /tmp/cursor-bridge-token"*|*"cat /tmp/grok-acp-bridge-token"*|*"cat /tmp/pi-bridge-token"*)
        printf '%s' "$FAKE_BRIDGE_TOKEN"; exit 0 ;;
      *"cat /tmp/orkestrator-ai/cursor-api-key-fingerprint"*)
        printf '%s' "$FAKE_CURSOR_FINGERPRINT"; exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

      try {
        await withFakeDocker(dockerScript, async (logs) => {
          const start = async () => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              return await Promise.race([
                commands.get(`start_${provider}_server`)?.({ containerId }, context),
                new Promise((_, reject) => {
                  timer = setTimeout(
                    () => reject(new Error(`start_${provider}_server waited on the probe`)),
                    ASYNC_TEST_WAIT_TIMEOUT_MS,
                  );
                }),
              ]);
            } finally {
              clearTimeout(timer);
            }
          };

          probes.push("reject");
          await expect(start()).resolves.toEqual({
            hostPort,
            wasRunning: true,
            authToken: token,
          });

          probes.push("hang");
          await expect(start()).resolves.toEqual({
            hostPort,
            wasRunning: true,
            authToken: token,
          });

          expect(checkEnvironmentContainer).toHaveBeenCalledTimes(2);
          for (const call of checkEnvironmentContainer.mock.calls) {
            expect(call).toEqual([containerId, { prepare: true, reason: "bridge-start" }]);
          }
          // The reuse path never relaunches the bridge.
          const execLog = await fs.readFile(logs.exec, "utf8").catch(() => "");
          expect(execLog.split("\n").filter((line) => line.startsWith("exec -d "))).toHaveLength(0);
        });
        // Let a rejection that escaped the probe's catch surface.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(unhandled).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        await bridge.close();
        for (const [name, value] of [
          ["FAKE_BRIDGE_HOST_PORT", previous.hostPort],
          ["FAKE_BRIDGE_TOKEN", previous.token],
          ["FAKE_CURSOR_FINGERPRINT", previous.fingerprint],
        ] as const) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });
  }

  test("starts a container bridge without a reachability service", async () => {
    // The service is optional on the command context; its absence must not
    // turn the fire-and-forget probe into a TypeError.
    const hostPort = await reserveFreePort();
    const bridge = await startControllableHealthServer(hostPort, () => true);
    const environment = createEnvironment({
      id: "env-pi-no-reachability",
      environmentType: "containerized",
      containerId: "container-pi-no-reachability",
      status: "running",
    });
    const { context } = createContext(environment);
    expect(context.containerHostReachability).toBeUndefined();
    const commands = createCommandRegistry();
    const previousHostPort = process.env.FAKE_BRIDGE_HOST_PORT;
    process.env.FAKE_BRIDGE_HOST_PORT = String(hostPort);
    const token = "p".repeat(43);

    const dockerScript = `#!/bin/sh
case "$1" in
  port) printf '127.0.0.1:%s\\n' "$FAKE_BRIDGE_HOST_PORT"; exit 0 ;;
  exec)
    case "$*" in
      *"cat /tmp/pi-bridge-token"*) printf '%s' '${token}'; exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
`;

    try {
      await withFakeDocker(dockerScript, async () => {
        await expect(
          commands.get("start_pi_server")?.(
            { containerId: "container-pi-no-reachability" },
            context,
          ),
        ).resolves.toEqual({ hostPort, wasRunning: true, authToken: token });
      });
    } finally {
      await bridge.close();
      if (previousHostPort === undefined) delete process.env.FAKE_BRIDGE_HOST_PORT;
      else process.env.FAKE_BRIDGE_HOST_PORT = previousHostPort;
    }
  });
});
