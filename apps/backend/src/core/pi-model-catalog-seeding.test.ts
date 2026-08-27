import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  discoverHostPiModelCatalog,
  resetPiModelCatalogSeedingState,
  PI_CATALOG_EMPTY_PROBE_BACKOFF_MS,
} from "./pi-model-catalog-seeding.js";
import {
  acpModelFetchTimeoutMs,
  fetchAcpNormalizedModelsAtResult,
  HOST_ACP_MODEL_FETCH_TIMEOUT_MS,
} from "./commands-servers.js";
import { __testing as commandTesting } from "./commands.js";
import { setLocalServerShutdownRequested } from "./commands-runtime-state.js";
import type { CommandContext } from "./commands-context.js";

/**
 * The catalogue probe is the one path that spawns a bridge with no environment
 * behind it, so its trust boundary is drawn entirely by the environment it
 * hands the child and by the guarantee that the child always dies. Both are
 * exercised here against the real spawn/teardown seams rather than a stub of
 * the module itself.
 */

type ProbeSpawn = {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  detached?: boolean;
};

type FakeChild = ChildProcessWithoutNullStreams & { exited: boolean };

let appRoot = "";
let spawns: ProbeSpawn[] = [];
let servers: Server[] = [];
let children: FakeChild[] = [];

function createFakeChild(): FakeChild {
  const emitter = new EventEmitter() as unknown as FakeChild;
  const stream = () => Object.assign(new EventEmitter(), { resume: () => undefined });
  Object.assign(emitter, {
    pid: 424_242,
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

/** Serves the two routes the probe reads, behind the bearer token it minted. */
async function listenAsBridge(
  port: number,
  token: string,
  models: unknown | (() => Promise<unknown>),
  options: { unhealthy?: boolean } = {},
): Promise<Server> {
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }
    if (request.url === "/global/health") {
      response.writeHead(options.unhealthy ? 503 : 200).end();
      return;
    }
    if (request.url === "/global/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ models: typeof models === "function" ? await models() : models }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  servers.push(server);
  return server;
}

/**
 * Installs a spawn stub that stands a real HTTP server up on the port the probe
 * allocated, so the health wait, the bearer header and the JSON normalization
 * all run for real.
 */
function stubBridgeSpawn(respond: (spawned: ProbeSpawn) => unknown): void {
  commandTesting.setSpawnLocalServerCommand(((
    command: string,
    args: string[] = [],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean } = {},
  ) => {
    const spawned: ProbeSpawn = {
      command,
      args,
      cwd: options.cwd,
      env: options.env ?? {},
      detached: options.detached,
    };
    spawns.push(spawned);
    const child = createFakeChild();
    children.push(child);
    void Promise.resolve(respond(spawned));
    return child;
  }) as never);
}

function context(overrides: Record<string, unknown> = {}): CommandContext {
  return {
    appRoot,
    resourceRoot: appRoot,
    toolchainBinDir: "",
    ...overrides,
  } as unknown as CommandContext;
}

beforeEach(async () => {
  appRoot = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-pi-seed-"));
  await fs.mkdir(path.join(appRoot, "bridges", "pi-bridge", "dist"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "bridges", "pi-bridge", "dist", "index.js"), "");
  spawns = [];
  servers = [];
  children = [];
  resetPiModelCatalogSeedingState();
  commandTesting.setTerminateProcessTree(
    mock(async (child: { pid?: number }) => {
      const target = children.find((candidate) => candidate.pid === child.pid);
      if (target) target.exited = true;
      return true;
    }) as never,
  );
});

afterEach(async () => {
  for (const server of servers) await new Promise((resolve) => server.close(resolve));
  commandTesting.resetLocalServerLifecycle();
  resetPiModelCatalogSeedingState();
  setLocalServerShutdownRequested(false);
  await fs.rm(appRoot, { recursive: true, force: true });
});

describe("discoverHostPiModelCatalog", () => {
  test("reads the live catalogue and always tears the probe down", async () => {
    stubBridgeSpawn(async (spawned) =>
      listenAsBridge(Number(spawned.env.PORT), spawned.env.PI_BRIDGE_TOKEN ?? "", [
        { id: "openai-codex/gpt-5.4", label: "GPT-5.4", providerLabel: "OpenAI Codex" },
      ]),
    );

    const models = await discoverHostPiModelCatalog(context());

    expect(models).toEqual([
      {
        platform: "pi",
        id: "openai-codex/gpt-5.4",
        label: "GPT-5.4",
        providerLabel: "OpenAI Codex",
        supportsSpeed: false,
        supportsMode: false,
      },
    ]);
    expect(children[0]?.exited).toBe(true);
    // Released on the way out, so shutdown does not try to terminate it twice.
    expect(commandTesting.getLocalServerProcess("pi:catalog-seed:1")).toBeUndefined();
  });

  test("hands the probe a scrubbed environment and its own process group", async () => {
    process.env.PI_BRIDGE_STATE_DIR = "/leaked/state";
    process.env.PI_SESSION_DIR = "/leaked/sessions";
    process.env.PI_AGENT_DIR = "/leaked/agent";
    process.env.PI_BRIDGE_PROJECT_RESOURCES = "1";
    try {
      stubBridgeSpawn(async (spawned) =>
        listenAsBridge(Number(spawned.env.PORT), spawned.env.PI_BRIDGE_TOKEN ?? "", []),
      );

      await discoverHostPiModelCatalog(context());

      const spawned = spawns[0]!;
      // A probe owns no conversation, so it must not restore or create bridge
      // or session state, and a `.pi/` extension is arbitrary TypeScript that
      // an ambient variable must not be able to switch back on.
      expect(spawned.env.PI_BRIDGE_STATE_DIR).toBeUndefined();
      expect(spawned.env.PI_SESSION_DIR).toBeUndefined();
      expect(spawned.env.PI_AGENT_DIR).toBeUndefined();
      expect(spawned.env.PI_BRIDGE_PROJECT_RESOURCES).toBe("0");
      expect(spawned.env.HOSTNAME).toBe("127.0.0.1");
      expect(spawned.env.PI_BRIDGE_TOKEN?.length).toBeGreaterThanOrEqual(32);
      // Spawned from the bridge's own package directory, never a worktree.
      expect(spawned.cwd).toBe(path.join(appRoot, "bridges", "pi-bridge"));
      // Matches every other bridge launch so shutdown reaches descendants.
      expect(spawned.detached).toBe(process.platform !== "win32");
    } finally {
      delete process.env.PI_BRIDGE_STATE_DIR;
      delete process.env.PI_SESSION_DIR;
      delete process.env.PI_AGENT_DIR;
      delete process.env.PI_BRIDGE_PROJECT_RESOURCES;
    }
  });

  test("registers the probe so a concurrent shutdown can terminate it", async () => {
    let observed: ChildProcessWithoutNullStreams | undefined;
    stubBridgeSpawn(async (spawned) => {
      // Registration is the statement after the spawn returns, so read it from
      // a microtask: the probe must own its child before its first await, not
      // only once it has finished.
      await Promise.resolve();
      observed = commandTesting.getLocalServerProcess("pi:catalog-seed:1");
      await listenAsBridge(Number(spawned.env.PORT), spawned.env.PI_BRIDGE_TOKEN ?? "", []);
    });

    await discoverHostPiModelCatalog(context());

    expect(observed).toBe(children[0]!);
  });

  test("keeps a fetched catalogue when the probe refuses to exit", async () => {
    commandTesting.setTerminateProcessTree(mock(async () => false) as never);
    stubBridgeSpawn(async (spawned) =>
      listenAsBridge(Number(spawned.env.PORT), spawned.env.PI_BRIDGE_TOKEN ?? "", [
        { id: "anthropic/claude-opus-5", label: "Opus 5" },
      ]),
    );

    // A stubborn child is a process problem, not a provider problem: the
    // models were read, so throwing here would discard them.
    const models = await discoverHostPiModelCatalog(context());
    expect(models.map((model) => model.id)).toEqual(["anthropic/claude-opus-5"]);
  });

  test("reports the original failure rather than a teardown failure", async () => {
    commandTesting.setTerminateProcessTree(mock(async () => false) as never);
    // No server ever binds; the child dying is what ends the health wait.
    stubBridgeSpawn(() => {
      queueMicrotask(() => children[children.length - 1]?.emit("exit", 1, null));
    });

    // The startup failure is the diagnostic worth keeping. A `finally` that
    // throws would replace it with "process tree did not exit", which says
    // nothing about why the bridge never came up.
    await expect(discoverHostPiModelCatalog(context())).rejects.toThrow(
      /exited before becoming healthy/,
    );
  });

  test("coalesces concurrent probes into one bridge", async () => {
    stubBridgeSpawn(async (spawned) =>
      listenAsBridge(Number(spawned.env.PORT), spawned.env.PI_BRIDGE_TOKEN ?? "", [
        { id: "openai-codex/gpt-5.4" },
      ]),
    );

    const [first, second] = await Promise.all([
      discoverHostPiModelCatalog(context()),
      discoverHostPiModelCatalog(context()),
    ]);

    expect(spawns).toHaveLength(1);
    expect(first).toEqual(second);
  });

  test("queues a fresh forced probe behind an in-flight automatic probe", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let generation = 0;
    stubBridgeSpawn(async (spawned) => {
      generation += 1;
      return listenAsBridge(
        Number(spawned.env.PORT),
        spawned.env.PI_BRIDGE_TOKEN ?? "",
        generation === 1
          ? async () => {
              await firstGate;
              return [{ id: "provider/old" }];
            }
          : [{ id: "provider/fresh" }],
      );
    });

    const automatic = discoverHostPiModelCatalog(context());
    const forced = discoverHostPiModelCatalog(context(), true);
    releaseFirst();

    expect((await automatic)[0]?.id).toBe("provider/old");
    expect((await forced)[0]?.id).toBe("provider/fresh");
    expect(spawns).toHaveLength(2);
  });

  test("does not re-probe within the backoff after an empty catalogue", async () => {
    stubBridgeSpawn(async (spawned) =>
      listenAsBridge(Number(spawned.env.PORT), spawned.env.PI_BRIDGE_TOKEN ?? "", []),
    );

    expect(await discoverHostPiModelCatalog(context())).toEqual([]);
    expect(await discoverHostPiModelCatalog(context())).toEqual([]);
    expect(await discoverHostPiModelCatalog(context())).toEqual([]);

    // "No models" is an ordinary steady state for an installation that has
    // never run `/login`, and it costs a full bridge start to discover.
    expect(spawns).toHaveLength(1);
    expect(PI_CATALOG_EMPTY_PROBE_BACKOFF_MS).toBeGreaterThan(0);
  });

  test("does not re-probe within the backoff after a failed probe", async () => {
    await fs.rm(path.join(appRoot, "bridges", "pi-bridge", "dist", "index.js"));
    stubBridgeSpawn(() => undefined);

    await expect(discoverHostPiModelCatalog(context())).rejects.toThrow();
    // The error reached the first caller; the retries inside the window are
    // dropped rather than repeating an equally expensive failure.
    expect(await discoverHostPiModelCatalog(context())).toEqual([]);
    expect(spawns).toHaveLength(0);
  });

  test("probes again once the backoff is cleared", async () => {
    stubBridgeSpawn(async (spawned) =>
      listenAsBridge(Number(spawned.env.PORT), spawned.env.PI_BRIDGE_TOKEN ?? "", []),
    );

    await discoverHostPiModelCatalog(context());
    resetPiModelCatalogSeedingState();
    await discoverHostPiModelCatalog(context());

    expect(spawns).toHaveLength(2);
  });

  test("refuses to admit a probe once shutdown has been requested", async () => {
    stubBridgeSpawn(async (spawned) =>
      listenAsBridge(Number(spawned.env.PORT), spawned.env.PI_BRIDGE_TOKEN ?? "", [
        { id: "openai-codex/gpt-5.4" },
      ]),
    );
    setLocalServerShutdownRequested(true);

    expect(await discoverHostPiModelCatalog(context())).toEqual([]);
    // Shutdown closes admission before it snapshots the children it owns, so a
    // bridge started after that point would never be drained.
    expect(spawns).toHaveLength(0);
  });

  test("fails without probing when the bridge is not installed", async () => {
    await fs.rm(path.join(appRoot, "bridges", "pi-bridge"), { recursive: true, force: true });
    stubBridgeSpawn(() => undefined);

    await expect(discoverHostPiModelCatalog(context())).rejects.toThrow(/pi bridge/);
    expect(spawns).toHaveLength(0);
  });

  test("declines an agent-test probe with no authorized Pi credential source", async () => {
    stubBridgeSpawn(() => undefined);

    const models = await discoverHostPiModelCatalog(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["claude"]) }),
    );

    expect(models).toEqual([]);
    expect(spawns).toHaveLength(0);
  });

  test("points an authorized agent-test probe at the host Pi directory", async () => {
    const hostHome = path.join(appRoot, "host-home");
    process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME = hostHome;
    try {
      stubBridgeSpawn(async (spawned) =>
        listenAsBridge(Number(spawned.env.PORT), spawned.env.PI_BRIDGE_TOKEN ?? "", []),
      );

      await discoverHostPiModelCatalog(
        context({ runtimeFlavor: "agent-test", credentialSources: new Set(["pi"]) }),
      );

      expect(spawns[0]?.env.PI_AGENT_DIR).toBe(path.join(hostHome, ".pi", "agent"));
    } finally {
      delete process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
    }
  });

  test("declines an agent-test probe with no host home to read", async () => {
    delete process.env.ORKESTRATOR_AGENT_TEST_HOST_HOME;
    stubBridgeSpawn(() => undefined);

    const models = await discoverHostPiModelCatalog(
      context({ runtimeFlavor: "agent-test", credentialSources: new Set(["pi"]) }),
    );

    expect(models).toEqual([]);
    expect(spawns).toHaveLength(0);
  });
});

describe("Pi catalogue fetch outcomes", () => {
  test("distinguishes empty success from failure and narrows the timeout", async () => {
    const originalFetch = globalThis.fetch;
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const observedTimeouts: number[] = [];
    AbortSignal.timeout = ((milliseconds: number) => {
      observedTimeouts.push(milliseconds);
      return new AbortController().signal;
    }) as typeof AbortSignal.timeout;

    try {
      globalThis.fetch = mock(async () =>
        Response.json({ models: [] }, { status: 200 }),
      ) as unknown as typeof fetch;
      await expect(fetchAcpNormalizedModelsAtResult(4099, "token", "pi", 12_345)).resolves.toEqual({
        status: "ok",
        models: [],
      });

      globalThis.fetch = mock(
        async () => new Response(null, { status: 503 }),
      ) as unknown as typeof fetch;
      await expect(fetchAcpNormalizedModelsAtResult(4099, "token", "pi", 99_999)).resolves.toEqual({
        status: "failed",
        models: [],
      });

      globalThis.fetch = mock(async () =>
        Response.json({ models: [] }, { status: 200 }),
      ) as unknown as typeof fetch;
      await expect(
        fetchAcpNormalizedModelsAtResult(
          4099,
          "token",
          "cursor",
          HOST_ACP_MODEL_FETCH_TIMEOUT_MS,
          HOST_ACP_MODEL_FETCH_TIMEOUT_MS,
        ),
      ).resolves.toEqual({ status: "ok", models: [] });

      expect(observedTimeouts).toEqual([
        12_345,
        acpModelFetchTimeoutMs("pi"),
        HOST_ACP_MODEL_FETCH_TIMEOUT_MS,
      ]);
    } finally {
      globalThis.fetch = originalFetch;
      AbortSignal.timeout = originalTimeout;
    }
  });
});
