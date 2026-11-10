import { expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseLogRecordLine, resetLogger } from "@orkestrator/protocol/logger";
import { OrkestratorBackend } from "./index.js";
import { BackendRuntime } from "./backend-runtime.js";
import { StorageService } from "./storage.js";
import { lifecycleEnvironment } from "../../tests/container-lifecycle-fixtures.js";
import { installStandaloneBackendLogging } from "../standalone-logging.js";
import {
  nativeFetch,
  spawnBridge,
  stopChild,
} from "../../../../bridges/acp-bridge/src/acp-test-harness.js";

// A real backend, config listener, standalone writer, discovery and bridge HTTP
// route. The bridge uses its isolated fake ACP agent; no vendor credential runs.
test("backend init/save/shutdown owns live saving and delivery to a running local bridge", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-log-policy-backend-"));
  const storage = new StorageService(dataDir, { snapshots: false });
  await storage.init();
  const initial = await storage.loadConfig();
  await storage.saveConfig({
    ...initial,
    global: {
      ...initial.global,
      debugLogging: false,
      logDetail: { level: "info", areaLevels: {} },
    },
  });
  const logging = installStandaloneBackendLogging({ dataDir, runtimeFlavor: "production" }, {});
  const runtime = new BackendRuntime({ emit: () => undefined });
  const backend = new OrkestratorBackend({
    dataDir,
    runtime,
    applicationLogging: logging,
    runtimeFlavor: "agent-test",
    toolchainBinDir: "",
    appRoot: "",
    resourceRoot: "",
    emit: () => undefined,
    agentTools: {
      start: async () => undefined,
      stop: async () => undefined,
      revokeEnvironment: () => undefined,
      connection: () => ({ url: "http://127.0.0.1:1/mcp", token: "unused" }),
    },
    startupReapers: { localServers: async () => [], claudeTmuxRuntimes: async () => [] },
  });
  let bridge: Awaited<ReturnType<typeof spawnBridge>> | undefined;
  try {
    expect(runtime.logPolicy).toBeNull();
    const backendStorage = (backend as unknown as { context: { storage: StorageService } }).context
      .storage;
    await backend.init();
    expect(runtime.logPolicy).not.toBeNull();
    expect(logging!.settings().enabled).toBe(false);
    bridge = await spawnBridge({
      env: {
        ORKESTRATOR_BRIDGE_DEBUG: "0",
        ORKESTRATOR_BRIDGE_LOG_RELAY: "1",
        ORKESTRATOR_LOG_LEVEL: "",
      },
    });
    const chunks: string[] = [];
    bridge.child.stdout.on("data", (chunk) => chunks.push(String(chunk)));
    const records = () =>
      chunks
        .join("")
        .split("\n")
        .flatMap((line) => parseLogRecordLine(line) ?? []);
    // Lifecycle is written at the default level; the per-minute look is what detail adds.
    const heartbeats = () =>
      records().filter(
        (record) => record.area === "bridge.diagnostics" && record.event === "heartbeat",
      );
    await storage.addEnvironment(
      lifecycleEnvironment({
        id: "log-fixture",
        environmentType: "local",
        worktreePath: dataDir,
        localGrokPort: Number(new URL(bridge.base).port),
      }),
    );
    runtime.localServers.adoptProcess("grok:log-fixture", bridge.child);
    runtime.localServers.recordBridgeToken(
      "grok",
      "log-fixture",
      bridge.headers.authorization!.slice("Bearer ".length),
    );
    expect(
      (
        await nativeFetch(`${bridge.base}/session/create`, {
          method: "POST",
          headers: bridge.headers,
        })
      ).status,
    ).toBe(201);
    const lifecycleDeadline = Date.now() + 5_000;
    const lifecycle = () =>
      records().find(
        (record) => record.area === "bridge.diagnostics" && record.event === "send-started",
      );
    while (!lifecycle() && Date.now() < lifecycleDeadline) await Bun.sleep(10);
    expect(lifecycle()).toMatchObject({ level: "info", event: "send-started" });
    expect(heartbeats()).toEqual([]);

    const save = async (enabled: boolean, level: "info" | "debug") => {
      const config = await storage.loadConfig();
      await backend.invoke("update_global_config", {
        global: {
          ...config.global,
          debugLogging: enabled,
          logDetail: { level: "info", areaLevels: { bridge: level } },
        },
      });
    };
    await save(true, "debug");
    const deadline = Date.now() + 5000;
    while (heartbeats().length === 0 && Date.now() < deadline) await Bun.sleep(10);
    expect(heartbeats().length).toBeGreaterThan(0);
    expect(logging!.settings().enabled).toBe(true);
    await logging!.flush();
    const files = (await fs.readdir(logging!.logDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const saved = (
      await Promise.all(
        files.map((file) => fs.readFile(path.join(logging!.logDirectory, file), "utf8")),
      )
    ).join("");
    expect(saved).toContain("policy.changed");
    expect(saved).toContain("saving=true");
    await save(false, "info");
    expect(logging!.settings().enabled).toBe(false);
    runtime.localServers.releaseOwnership("grok:log-fixture", bridge.child);
    const service = runtime.logPolicy!;
    const changed = spyOn(service, "configChanged");
    await backend.shutdown();
    const stopped = await storage.loadConfig();
    await backendStorage.saveConfig({
      ...stopped,
      global: { ...stopped.global, debugLogging: true },
    });
    expect(changed).not.toHaveBeenCalled();
    expect(logging!.settings().enabled).toBe(false); // listener was removed
    service.configChanged();
    changed.mockRestore();
    expect(logging!.settings().enabled).toBe(false); // service itself was stopped
  } finally {
    if (bridge) {
      runtime.localServers.releaseOwnership("grok:log-fixture", bridge.child);
      await stopChild(bridge.child);
    }
    await backend.shutdown();
    await logging?.stop();
    resetLogger();
    storage.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);
