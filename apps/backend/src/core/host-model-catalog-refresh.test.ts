import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { __testing as commandTesting } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { __testing as refreshTesting } from "./host-model-catalog-refresh.js";
import { setLocalServerShutdownRequested } from "./commands-runtime-state.js";
import { HOST_ACP_MODEL_FETCH_TIMEOUT_MS } from "./commands-servers.js";
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
  commandTesting.setSpawnLocalServerCommand(((
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
  }) as never);
}

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    appRoot,
    resourceRoot: appRoot,
    toolchainBinDir: path.join(appRoot, "bin"),
    storage,
    emit: () => undefined,
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
  commandTesting.setTerminateProcessTree(
    mock(async (child: { pid?: number }) => {
      const target = children.find((candidate) => candidate.pid === child.pid);
      if (target) target.exited = true;
      return true;
    }) as never,
  );
});

afterEach(async () => {
  delete process.env.CURSOR_API_KEY;
  delete process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
  delete process.env.ORKESTRATOR_AGENT_TEST_HOST_CLAUDE_CONFIG_DIR;
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  commandTesting.resetLocalServerLifecycle();
  setLocalServerShutdownRequested(false);
  await fs.rm(appRoot, { recursive: true, force: true });
});

describe("host model catalogue refresh", () => {
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
    expect(commandTesting.getLocalServerProcessCount()).toBe(0);
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
    expect(commandTesting.getLocalServerProcessCount()).toBe(0);
  });

  test("tears down a child that exits during startup", async () => {
    stubBridgeSpawn((_spawned, child) => {
      queueMicrotask(() => child.emit("exit", 1, null));
    });

    await expect(
      refreshTesting.createHostModelCatalogRefresher()(context(), "codex"),
    ).rejects.toThrow(/exited before becoming healthy/);
    expect(children[0]?.exited).toBe(true);
    expect(commandTesting.getLocalServerProcessCount()).toBe(0);
  });

  test("rechecks shutdown admission after registering the probe", async () => {
    stubBridgeSpawn(() => {
      setLocalServerShutdownRequested(true);
    });

    await expect(
      refreshTesting.createHostModelCatalogRefresher()(context(), "codex"),
    ).rejects.toThrow(/shutting down/);
    expect(spawns).toHaveLength(1);
    expect(children[0]?.exited).toBe(true);
    expect(commandTesting.getLocalServerProcessCount()).toBe(0);
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
    stubBridgeSpawn((spawned) => listenAsBridge(Number(spawned.env.PORT)));
    const refresh = refreshTesting.createHostModelCatalogRefresher({
      fetchClaudeCatalog: mock(async () => ({ source: "fallback", models: [] })) as never,
    });

    await expect(
      refresh(
        context({ runtimeFlavor: "agent-test", credentialSources: new Set(["claude"]) }),
        "claude",
      ),
    ).rejects.toThrow(/bundled catalogue/);
    expect(spawns[0]?.env.CLAUDE_CONFIG_DIR).toBe(configDir);
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
    expect(spawns[0]?.env.CURSOR_BRIDGE_PROJECT_SETTINGS).toBe("0");
    expect(spawns[0]?.env.CURSOR_API_KEY).toBe("cursor-test-key");
    expect(spawns[0]?.env.ACP_PROVIDER).toBeUndefined();
  });

  test("normalizes an OpenCode catalogue with a bounded provider request", async () => {
    const providerList = mock(async (_parameters, options: { signal?: AbortSignal }) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return {
        data: {
          all: [{ id: "openai", name: "OpenAI", models: { "gpt-5": { name: "GPT-5" } } }],
          connected: [],
        },
      };
    });
    const run = mock(async () => ({ stdout: "", stderr: "" }));
    stubBridgeSpawn((spawned) => listenAsBridge(Number(spawned.env.PORT)));
    const refresh = refreshTesting.createHostModelCatalogRefresher({
      createOpenCodeClient: mock(() => ({ provider: { list: providerList } })) as never,
      runCommand: run as never,
    });

    const result = await refresh(context(), "opencode");

    expect(result.agent).toBe("opencode");
    if (result.agent !== "opencode") throw new Error("Expected an OpenCode catalogue");
    expect(result.models.map((model) => model.id)).toContain("openai/gpt-5");
    expect(providerList).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(
      "opencode",
      ["models", "--refresh"],
      expect.objectContaining({ timeoutMs: 45_000 }),
    );
    expect(children[0]?.exited).toBe(true);
  });

  test("aborts a stalled OpenCode provider request and releases the child", async () => {
    stubBridgeSpawn((spawned) =>
      listenAsBridge(Number(spawned.env.PORT), (url) => url.startsWith("/provider")),
    );
    const refresh = refreshTesting.createHostModelCatalogRefresher({
      openCodeProviderListTimeoutMs: 25,
      runCommand: mock(async () => ({ stdout: "", stderr: "" })) as never,
    });

    await expect(refresh(context(), "opencode")).rejects.toThrow();
    expect(children[0]?.exited).toBe(true);
    expect(commandTesting.getLocalServerProcessCount()).toBe(0);
  });
});
