import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ScriptedModel } from "../../../../../scripts/opencode2-steer-probe.js";
import { stopLocalServerUnlocked } from "../commands-local-server-lifecycle.js";
import type { CommandContext } from "../commands-context.js";
import { LocalServerRuntime } from "../local-server-runtime.js";
import type { OpenCodeProvider } from "../opencode-provider.js";
import { ensureOpenCode2HostServer, peekOpenCode2HostServer } from "../opencode2-host-server.js";
import { OPENCODE2_CAPABILITY_LIMITS, OpenCodeRoutingProvider } from "./routing-provider.js";

/**
 * The host 2.x server supervisor and the routing provider against the real
 * pinned 2.x binary and a scripted local model (no credentials, no remote
 * calls). HOME and the XDG directories point into a temporary root while the
 * server starts, so nothing reads or writes the user's own OpenCode state.
 * Run with RUN_LIVE_OPENCODE2=1 and OPENCODE2_CLI_PATH.
 */
const binary = process.env.OPENCODE2_CLI_PATH?.trim();
const liveTest = process.env.RUN_LIVE_OPENCODE2 === "1" && binary ? test : test.skip;

const ISOLATED = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"];
let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

liveTest(
  "a new 2.x session runs on the environment's own 2.x server, which stops with OpenCode",
  async () => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "ork-opencode2-route-")));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const dirs = Object.fromEntries(
      ["home", "config", "data", "state", "cache", "work", "bin", "orkestrator"].map((name) => [
        name,
        path.join(root, name),
      ]),
    ) as Record<
      "home" | "config" | "data" | "state" | "cache" | "work" | "bin" | "orkestrator",
      string
    >;
    await Promise.all(Object.values(dirs).map((dir) => mkdir(dir, { recursive: true })));
    await symlink(binary!, path.join(dirs.bin, "opencode2"));
    const model = new ScriptedModel();
    const modelUrl = model.start();
    cleanup.push(() => model.stop());
    await writeFile(
      path.join(dirs.work, "opencode.json"),
      JSON.stringify({
        provider: {
          fixture: {
            npm: "@ai-sdk/openai-compatible",
            name: "Local fixture",
            options: { baseURL: `${modelUrl}/v1`, apiKey: "test-key" },
            models: { fixture: { name: "Fixture", limit: { context: 16000, output: 2000 } } },
          },
        },
        model: "fixture/fixture",
      }),
    );

    const localServers = new LocalServerRuntime();
    cleanup.push(() => localServers.shutdown());
    const context = {
      runtime: {
        localServers,
        environments: { fence: { assertNotMoving() {} }, assertNotDeleting() {} },
      },
      storage: {
        getEnvironment: async () => ({
          id: "env-1",
          environmentType: "local",
          worktreePath: dirs.work,
        }),
        getDataDir: () => dirs.orkestrator,
        updateEnvironment: async () => undefined,
      },
      toolchainBinDir: dirs.bin,
      resourceRoot: path.join(root, "none"),
      appRoot: path.join(root, "none"),
    } as unknown as CommandContext;

    const saved = Object.fromEntries(ISOLATED.map((name) => [name, process.env[name]]));
    const restore = () => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    };
    cleanup.push(restore);
    process.env.HOME = dirs.home;
    process.env.XDG_CONFIG_HOME = dirs.config;
    process.env.XDG_DATA_HOME = dirs.data;
    process.env.XDG_STATE_HOME = dirs.state;
    process.env.XDG_CACHE_HOME = dirs.cache;
    const connection = await ensureOpenCode2HostServer(context, "env-1");
    restore();
    expect(connection.directory).toBe(dirs.work);

    const legacy = {
      interactions: {
        listPendingInteractions: async () => ({}),
        resolveInteraction: async () => ({}),
      },
      modelCatalog: async () => [],
      observationStreamLive: () => true,
      dispose: async () => undefined,
    } as unknown as OpenCodeProvider;
    const router = new OpenCodeRoutingProvider(legacy, {
      connection: async ({ start }) =>
        start
          ? ensureOpenCode2HostServer(context, "env-1")
          : peekOpenCode2HostServer(context, "env-1"),
      persistedProtocol: async () => undefined,
    });
    cleanup.push(() => router.dispose());

    const sessionId = await router.createSession("build", "live", {
      openCodeProtocol: "v2",
      model: "fixture/fixture",
    });
    expect(await router.steerSupported(sessionId)).toBe(true);
    await router.send(sessionId, "hello from orkestrator", { requestId: "req-live-1" });
    expect(await router.dispatchStatus(sessionId, "req-live-1")).toBe("dispatched");
    let snapshot = await router.interactiveSnapshot(sessionId);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        snapshot.status === "idle" &&
        snapshot.messages.some((row) => (row as { role?: string }).role === "assistant")
      )
        break;
      await Bun.sleep(100);
      snapshot = await router.interactiveSnapshot(sessionId);
    }
    expect(snapshot.capabilityLimits).toEqual(OPENCODE2_CAPABILITY_LIMITS);
    expect(snapshot.messages[0]).toMatchObject({ role: "user", content: "hello from orkestrator" });
    expect(snapshot.messages.at(-1)).toMatchObject({ role: "assistant" });
    expect(String((snapshot.messages.at(-1) as { content?: string }).content)).toContain("ack:");
    expect(await router.turnTerminalError(sessionId, "req-live-1")).toBeNull();

    // The second ensure reuses the server; stopping OpenCode stops it.
    expect(await ensureOpenCode2HostServer(context, "env-1")).toEqual(connection);
    await stopLocalServerUnlocked("env-1", context, "opencode");
    expect(peekOpenCode2HostServer(context, "env-1")).toBeUndefined();
    expect(await router.activity(sessionId)).toBe("idle");
  },
  180_000,
);
