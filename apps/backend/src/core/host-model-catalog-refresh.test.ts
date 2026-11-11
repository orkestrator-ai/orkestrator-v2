import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { BackendRuntime } from "./backend-runtime.js";
import type { CommandContext } from "./commands-context.js";
import { withShortLivedBridge, __testing as refreshTesting } from "./host-model-catalog-refresh.js";
import { HOST_ACP_MODEL_FETCH_TIMEOUT_MS } from "./commands-servers.js";
import { FakeOpenCode2Server, fakeOpenCode2Model } from "./opencode2/fake-server.test-support.js";
import { spawnCommand } from "./shell.js";
import { StorageService } from "./storage.js";

type ProbeSpawn = {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  detached?: boolean;
};

type FakeChild = ChildProcessWithoutNullStreams & { exited: boolean };

let appRoot = "";
let storage: StorageService;
let spawns: ProbeSpawn[] = [];
let servers: Server[] = [];
let children: FakeChild[] = [];
let nextPid = 510_000;
/** The backend under test; its spawn delegates to `spawnImpl`. */
let runtime: BackendRuntime;
let spawnImpl: typeof spawnCommand = spawnCommand;

function createFakeChild(): FakeChild {
  const emitter = new EventEmitter() as unknown as FakeChild;
  const stream = () => Object.assign(new EventEmitter(), { resume: () => undefined });
  Object.assign(emitter, {
    pid: nextPid++,
    exitCode: null,
    signalCode: null,
    killed: false,
    exited: false,
    stdout: stream(),
    stderr: stream(),
    kill: () => true,
  });
  return emitter;
}

async function listenAsBridge(
  port: number,
  route?: (url: string, response: import("node:http").ServerResponse) => boolean,
): Promise<Server> {
  const server = createServer((request, response) => {
    if (request.url === "/global/health") {
      response.writeHead(200).end();
      return;
    }
    if (route?.(request.url ?? "", response)) return;
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  servers.push(server);
  return server;
}

function stubBridgeSpawn(respond: (spawned: ProbeSpawn, child: FakeChild) => unknown): void {
  spawnImpl = ((
    command: string,
    args: string[] = [],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean } = {},
  ) => {
    const spawned = {
      command,
      args,
      cwd: options.cwd,
      env: options.env ?? {},
      detached: options.detached,
    };
    spawns.push(spawned);
    const child = createFakeChild();
    children.push(child);
    void Promise.resolve(respond(spawned, child));
    return child;
  }) as never;
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    appRoot,
    resourceRoot: appRoot,
    toolchainBinDir: path.join(appRoot, "bin"),
    storage,
    emit: () => undefined,
    runtime,
    ...overrides,
  } as CommandContext;
}

beforeEach(async () => {
  appRoot = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-host-catalog-"));
  for (const bridge of ["claude-bridge", "codex-bridge", "acp-bridge", "cursor-bridge"]) {
    const directory = path.join(appRoot, "bridges", bridge, "dist");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "index.js"), "");
  }
  await fs.mkdir(path.join(appRoot, "bin"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "bin", "cursor-agent"), "");
  await fs.writeFile(path.join(appRoot, "bin", "grok"), "");
  storage = new StorageService(path.join(appRoot, "data"));
  await storage.init();
  spawns = [];
  servers = [];
  children = [];
  spawnImpl = spawnCommand;
  runtime = new BackendRuntime({
    emit: () => undefined,
    localServers: {
      spawn: (...args) => spawnImpl(...args),
      terminateProcessTree: mock(async (child: { pid?: number }) => {
        const target = children.find((candidate) => candidate.pid === child.pid);
        if (target) target.exited = true;
        return true;
      }) as never,
    },
  });
});

afterEach(async () => {
  delete process.env.CURSOR_API_KEY;
  delete process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
  delete process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR;
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  expect(runtime.localServers.hasEnvironmentOperations()).toBe(false);
  runtime.shutdown();
  await fs.rm(appRoot, { recursive: true, force: true });
});

describe("host model catalogue refresh", () => {
  test.each([false, true])(
    "passes bridge detail=%s to every short-lived bridge process, whatever saving says",
    async (enabled) => {
      const config = await storage.loadConfig();
      await storage.updateGlobalConfig({
        ...config.global,
        debugLogging: !enabled,
        logDetail: {
          level: "info",
          areaLevels: enabled ? { bridge: "debug" } : {},
        },
      });
      stubBridgeSpawn((spawned) =>
        listenAsBridge(Number(spawned.env.PORT), (url, response) => {
          if (url !== "/global/models") return false;
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ source: "app-server", models: [{ id: "gpt-5" }] }));
          return true;
        }),
      );
      const refresh = refreshTesting.createHostModelCatalogRefresher({
        fetchClaudeCatalog: mock(async () => ({
          source: "sdk",
          models: [{ id: "claude-opus", name: "Claude Opus" }],
        })) as never,
        fetchAcpModels: mock(async () => [
          { platform: "grok", id: "grok-4", label: "Grok 4" },
        ]) as never,
      });

      await refresh(context(), "claude");
      await refresh(context(), "codex");
      await refresh(context(), "grok");

      expect(spawns).toHaveLength(3);
      expect(spawns.map((spawned) => spawned.env.ORKESTRATOR_BRIDGE_DEBUG)).toEqual(
        Array.from({ length: 3 }, () => (enabled ? "1" : "0")),
      );
    },
  );

  test("single-flights a live Codex probe and always releases its child", async () => {
    stubBridgeSpawn((spawned) =>
      listenAsBridge(Number(spawned.env.PORT), (url, response) => {
        if (url !== "/global/models") return false;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ source: "app-server", models: [{ id: "gpt-5" }] }));
        return true;
      }),
    );
    const refresh = refreshTesting.createHostModelCatalogRefresher();

    const [first, second] = await Promise.all([
      refresh(context(), "codex"),
      refresh(context(), "codex"),
    ]);

    expect(first).toEqual({ agent: "codex", models: [{ id: "gpt-5" }] });
    expect(second).toEqual(first);
    expect(spawns).toHaveLength(1);
    expect(children[0]?.exited).toBe(true);
    expect(runtime.localServers.processCount()).toBe(0);
  });

  test("rejects a non-live Codex catalogue without leaking the probe", async () => {
    stubBridgeSpawn((spawned) =>
      listenAsBridge(Number(spawned.env.PORT), (url, response) => {
        if (url !== "/global/models") return false;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ source: "fallback", models: [{ id: "gpt-5" }] }));
        return true;
      }),
    );

    await expect(
      refreshTesting.createHostModelCatalogRefresher()(context(), "codex"),
    ).rejects.toThrow(/live app-server catalogue/);
    expect(children[0]?.exited).toBe(true);
    expect(runtime.localServers.processCount()).toBe(0);
  });

  test("tears down a child that exits during startup", async () => {
    stubBridgeSpawn((_spawned, child) => {
      queueMicrotask(() => child.emit("exit", 1, null));
    });

    await expect(
      refreshTesting.createHostModelCatalogRefresher()(context(), "codex"),
    ).rejects.toThrow(/exited before becoming healthy/);
    expect(children[0]?.exited).toBe(true);
    expect(runtime.localServers.processCount()).toBe(0);
  });

  test("rechecks shutdown admission after registering the probe", async () => {
    stubBridgeSpawn(() => {
      runtime.localServers.closeAdmission();
    });

    await expect(
      refreshTesting.createHostModelCatalogRefresher()(context(), "codex"),
    ).rejects.toThrow(/shutting down/);
    expect(spawns).toHaveLength(1);
    expect(children[0]?.exited).toBe(true);
    expect(runtime.localServers.processCount()).toBe(0);
  });

  test("rejects Claude fallback data and applies agent-test host credentials", async () => {
    const hostHome = path.join(appRoot, "host-home");
    const configDir = path.join(hostHome, ".claude");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "host-oauth-token" } }),
    );
    process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = hostHome;
    process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR = configDir;
    // An agent-test profile spawns only the Claude its own toolchain holds.
    await fs.mkdir(path.join(appRoot, "bin"), { recursive: true });
    await fs.writeFile(path.join(appRoot, "bin", "claude"), "");
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const profileConfigDir = path.join(appRoot, "profile-claude");
    process.env.CLAUDE_CONFIG_DIR = profileConfigDir;
    stubBridgeSpawn((spawned) => listenAsBridge(Number(spawned.env.PORT)));
    const refresh = refreshTesting.createHostModelCatalogRefresher({
      fetchClaudeCatalog: mock(async () => ({ source: "fallback", models: [] })) as never,
    });

    try {
      await expect(
        refresh(
          context({ runtimeFlavor: "agent-test", credentialSources: new Set(["claude"]) }),
          "claude",
        ),
      ).rejects.toThrow(/bundled catalogue/);
    } finally {
      if (previousClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
    }
    // Read for the login only: the probe keeps the profile's own config dir.
    expect(spawns[0]?.env.CLAUDE_CONFIG_DIR).toBe(profileConfigDir);
    expect(spawns[0]?.env.CLAUDE_CLI_PATH).toBe(path.join(appRoot, "bin", "claude"));
    expect(spawns[0]?.env.ANTHROPIC_AUTH_TOKEN).toBe("host-oauth-token");
    expect(children[0]?.exited).toBe(true);
  });

  test("uses the long host budget and the Cursor SDK bridge credentials", async () => {
    process.env.CURSOR_API_KEY = "cursor-test-key";
    const observedBudgets: Array<number | undefined> = [];
    stubBridgeSpawn((spawned) => listenAsBridge(Number(spawned.env.PORT)));
    const refresh = refreshTesting.createHostModelCatalogRefresher({
      fetchAcpModels: mock(async (_port, _token, _kind, timeoutMs, maximumTimeoutMs) => {
        observedBudgets.push(timeoutMs, maximumTimeoutMs);
        return [{ platform: "cursor", id: "cursor-1", label: "Cursor 1" }];
      }) as never,
    });

    await refresh(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["cursor"]) }),
      "cursor",
    );

    expect(observedBudgets).toEqual([
      HOST_ACP_MODEL_FETCH_TIMEOUT_MS,
      HOST_ACP_MODEL_FETCH_TIMEOUT_MS,
    ]);
    expect(spawns[0]?.cwd).toBe(path.join(appRoot, "bridges", "cursor-bridge"));
    expect(spawns[0]?.env.CURSOR_BRIDGE_TOKEN).toBeTruthy();
    expect(spawns[0]?.env.CURSOR_BRIDGE_AUTH_FILE).toBe(
      path.join(storage.getDataDir(), "cursor-sdk", "auth.json"),
    );
    expect(spawns[0]?.env.CURSOR_API_KEY).toBe("cursor-test-key");
    expect(spawns[0]?.env.ACP_PROVIDER).toBeUndefined();
  });

  test("reads the OpenCode catalogue from a 2.x server, allowlisted providers first", async () => {
    const config = await storage.loadConfig();
    await storage.updateGlobalConfig({ ...config.global, openCodeModelProviders: ["opencode-go"] });
    const fake = new FakeOpenCode2Server();
    try {
      fake.models = [
        fakeOpenCode2Model("openai", "gpt-5", ["low", "high"]),
        fakeOpenCode2Model("opencode-go", "beam", []),
      ];
      const signals: Array<AbortSignal | undefined> = [];
      const withOpenCode2Server = mock(
        async (_context: unknown, use: (client: never) => unknown) => {
          const client = fake.client();
          return use({
            api: (
              method: string,
              path: string,
              operation: string,
              options: { signal?: AbortSignal },
            ) => {
              signals.push(options.signal);
              return client.api(method, path, operation, options as never);
            },
          } as never);
        },
      );
      const refresh = refreshTesting.createHostModelCatalogRefresher({
        withOpenCode2Server: withOpenCode2Server as never,
      });

      const result = await refresh(context(), "opencode");

      expect(result.agent).toBe("opencode");
      if (result.agent !== "opencode") throw new Error("Expected an OpenCode catalogue");
      // Not narrowed by the allowlist: the durable cache serves a later change.
      expect(result.models.map((model) => model.id)).toEqual(["opencode-go/beam", "openai/gpt-5"]);
      expect(result.models[1]!.reasoning?.map((option) => option.id)).toEqual([
        "default",
        "low",
        "high",
      ]);
      expect(withOpenCode2Server).toHaveBeenCalledTimes(1);
      expect(signals.length).toBeGreaterThan(0);
      for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
      // No 1.x process is started for it.
      expect(spawns).toEqual([]);
    } finally {
      fake.stop();
    }
  });

  test("an empty OpenCode catalogue is a failed refresh", async () => {
    const fake = new FakeOpenCode2Server();
    try {
      fake.models = [];
      const refresh = refreshTesting.createHostModelCatalogRefresher({
        withOpenCode2Server: (async (_context: unknown, use: (client: never) => unknown) =>
          use(fake.client() as never)) as never,
      });
      await expect(refresh(context(), "opencode")).rejects.toThrow(
        "OpenCode returned an empty model catalogue",
      );
    } finally {
      fake.stop();
    }
  });

  test("aborts a stalled OpenCode model request", async () => {
    const refresh = refreshTesting.createHostModelCatalogRefresher({
      openCodeModelListTimeoutMs: 25,
      withOpenCode2Server: (async (_context: unknown, use: (client: never) => unknown) =>
        use({
          api: (
            _method: string,
            _path: string,
            _operation: string,
            options: { signal?: AbortSignal },
          ) =>
            new Promise((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
                once: true,
              });
            }),
        } as never)) as never,
    });

    await expect(refresh(context(), "opencode")).rejects.toThrow();
  });
});

describe("short-lived probe ownership", () => {
  const probe = (args: string[] | (() => string[]) = []) => ({
    kind: "codex" as const,
    command: "codex-bridge",
    args,
    cwd: appRoot,
    env: {},
    token: "fixture-token",
    headers: {},
  });

  test("a probe whose spawn throws leaves nothing owned", async () => {
    spawnImpl = () => {
      throw new Error("spawn refused");
    };
    await expect(
      withShortLivedBridge(runtime.localServers, probe(), async () => undefined),
    ).rejects.toThrow("spawn refused");
    expect(runtime.localServers.processCount()).toBe(0);
  });

  test("a probe stops its child when shutdown begins during spawn", async () => {
    stubBridgeSpawn(() => runtime.localServers.closeAdmission());
    const read = mock(async () => undefined);
    await expect(withShortLivedBridge(runtime.localServers, probe(), read)).rejects.toThrow(
      "shutting down",
    );
    expect(spawns).toHaveLength(1);
    expect(children[0]?.exited).toBe(true);
    expect(read).not.toHaveBeenCalled();
    expect(runtime.localServers.processCount()).toBe(0);
  });

  test("a probe refuses to spawn once shutdown has begun", async () => {
    const spawn = mock(() => {
      throw new Error("must not spawn");
    });
    spawnImpl = spawn;
    runtime.localServers.closeAdmission();
    await expect(
      withShortLivedBridge(runtime.localServers, probe(), async () => undefined),
    ).rejects.toThrow("shutting down");
    expect(spawn).not.toHaveBeenCalled();
  });
});
