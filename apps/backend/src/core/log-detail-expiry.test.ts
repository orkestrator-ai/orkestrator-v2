import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LOG_DETAIL_EXPIRY_MS } from "@orkestrator/protocol/log-policy";
import { configureLogger, resetLogger, type LogOutput } from "@orkestrator/protocol/logger";
import { LogPolicyService, startLogPolicyService } from "./log-policy-service.js";
import { StorageService } from "./storage.js";

const directories: string[] = [];
const open: StorageService[] = [];

afterEach(async () => {
  resetLogger();
  for (const storage of open.splice(0)) storage.close();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function storageIn(dataDir?: string): Promise<StorageService> {
  const dir = dataDir ?? (await mkdtemp(path.join(os.tmpdir(), "log-detail-expiry-")));
  if (!dataDir) directories.push(dir);
  const storage = new StorageService(dir, { snapshots: false });
  await storage.init();
  open.push(storage);
  return storage;
}

const bridgeDebug = { level: "info", areaLevels: { bridge: "debug" } } as const;

describe("raised log detail expires through the backend", () => {
  test("raising detail stores an expiry a day out; info stores none", async () => {
    const storage = await storageIn();
    const before = Date.now();
    const raised = await storage.patchGlobalConfig({ logDetail: bridgeDebug, debugLogging: true });
    const expiresAt = Date.parse(raised.global.logDetailExpiresAt!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + LOG_DETAIL_EXPIRY_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + LOG_DETAIL_EXPIRY_MS);
    const lowered = await storage.patchGlobalConfig({
      logDetail: { level: "info", areaLevels: {} },
    });
    expect(lowered.global.logDetailExpiresAt).toBeUndefined();
  });

  test("a client cannot set the expiry itself", async () => {
    const storage = await storageIn();
    const saved = await storage.patchGlobalConfig({
      logDetail: bridgeDebug,
      logDetailExpiresAt: "2999-01-01T00:00:00.000Z",
    });
    expect(saved.global.logDetailExpiresAt).not.toBe("2999-01-01T00:00:00.000Z");
  });

  test("the check reverts raised detail when due, and leaves saving alone", async () => {
    const storage = await storageIn();
    await storage.patchGlobalConfig({
      logDetail: { level: "debug", areaLevels: { updater: "warn", bridge: "trace" } },
      debugLogging: true,
      debugLogRetentionDays: 3,
    });
    expect(await storage.reconcileLogDetailExpiry(Date.now())).toBe("none");
    expect(await storage.reconcileLogDetailExpiry(Date.now() + LOG_DETAIL_EXPIRY_MS + 1)).toBe(
      "revert",
    );
    const { global } = await storage.loadOwnConfig();
    expect(global.logDetail).toEqual({ level: "info", areaLevels: { updater: "warn" } });
    expect(global.logDetailExpiresAt).toBeUndefined();
    expect(global.debugLogging).toBe(true);
    expect(global.debugLogRetentionDays).toBe(3);
  });

  test("the expiry survives a restart and is honoured by the next backend", async () => {
    const first = await storageIn();
    await first.patchGlobalConfig({ logDetail: bridgeDebug });
    const stored = (await first.loadOwnConfig()).global.logDetailExpiresAt;
    first.close();
    open.splice(open.indexOf(first), 1);
    const second = await storageIn(first.getDataDir());
    expect((await second.loadOwnConfig()).global.logDetailExpiresAt).toBe(stored);
    expect(await second.reconcileLogDetailExpiry(Date.parse(stored!))).toBe("revert");
  });

  test("keeping it raised stores no expiry and never reverts", async () => {
    const storage = await storageIn();
    const kept = await storage.patchGlobalConfig({
      logDetail: bridgeDebug,
      logDetailKeepRaised: true,
    });
    expect(kept.global.logDetailExpiresAt).toBeUndefined();
    expect(await storage.reconcileLogDetailExpiry(Date.now() + 30 * LOG_DETAIL_EXPIRY_MS)).toBe(
      "none",
    );
    expect((await storage.loadOwnConfig()).global.logDetail).toEqual(bridgeDebug);
    // Turning it off starts a fresh day rather than reverting at once.
    const released = await storage.patchGlobalConfig({ logDetailKeepRaised: false });
    expect(Date.parse(released.global.logDetailExpiresAt!)).toBeGreaterThan(Date.now());
  });

  test("an older client's whole save keeps the choice and still gets an expiry", async () => {
    const storage = await storageIn();
    await storage.patchGlobalConfig({ logDetail: bridgeDebug, logDetailKeepRaised: true });
    const { global } = await storage.loadOwnConfig();
    const {
      logDetailExpiresAt: _expiresAt,
      logDetailKeepRaised: _keep,
      ...older
    } = global as Record<string, unknown>;
    const saved = await storage.updateGlobalConfig({
      ...(older as typeof global),
      logDetail: { level: "debug", areaLevels: {} },
    });
    expect(saved.global.logDetailKeepRaised).toBe(true);
    expect(saved.global.logDetailExpiresAt).toBeUndefined();

    await storage.patchGlobalConfig({ logDetailKeepRaised: false });
    const afterRelease = (await storage.loadOwnConfig()).global;
    const {
      logDetailExpiresAt: _a,
      logDetailKeepRaised: _b,
      ...older2
    } = afterRelease as Record<string, unknown>;
    const raisedByOld = await storage.updateGlobalConfig({
      ...(older2 as typeof global),
      logDetail: { level: "trace", areaLevels: {} },
    });
    expect(raisedByOld.global.logDetailExpiresAt).toBeDefined();
  });

  test("a raised setting with no expiry (an older backend's) gets one at the next check", async () => {
    const storage = await storageIn();
    await storage.patchGlobalConfig({ logDetail: bridgeDebug });
    // Strip it the way an older backend's write would.
    const file = path.join(storage.getDataDir(), "config.json");
    const raw = JSON.parse(await Bun.file(file).text()) as {
      global: Record<string, unknown>;
    };
    delete raw.global.logDetailExpiresAt;
    await Bun.write(file, JSON.stringify(raw));
    const reopened = await storageIn(storage.getDataDir());
    expect(await reopened.reconcileLogDetailExpiry(Date.now())).toBe("stamp");
    expect((await reopened.loadOwnConfig()).global.logDetailExpiresAt).toBeDefined();
  });
});

describe("the policy service runs the check", () => {
  test("at start, applying a revert to this process and every running bridge", async () => {
    const storage = await storageIn();
    await storage.patchGlobalConfig({ logDetail: bridgeDebug });
    const logged: LogOutput[] = [];
    configureLogger({ sink: (output) => logged.push(output) });
    const bodies: Array<Record<string, unknown>> = [];
    const clock = Date.now() + LOG_DETAIL_EXPIRY_MS + 1;
    const lifecycle = startLogPolicyService(storage, {
      logging: null,
      env: {},
      now: () => clock,
      listRunningBridges: async () => [
        { agent: "claude", baseUrl: "http://127.0.0.1:4000", authToken: "token" },
      ],
      fetch: (async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
        return Response.json({ applied: true });
      }) as unknown as typeof fetch,
    });
    try {
      await lifecycle.service.checkLogDetailExpiry();
      for (let index = 0; index < 20; index += 1) await Bun.sleep(1);
      expect((await storage.loadOwnConfig()).global.logDetail).toEqual({
        level: "info",
        areaLevels: {},
      });
      expect(bodies.at(-1)).toMatchObject({ level: "info", areaLevels: {} });
      const events = logged.map((output) => output.record?.event);
      expect(events).toContain("policy.detail-expired");
      expect(events).toContain("policy.changed");
    } finally {
      lifecycle.stop();
    }
  });

  test("a failing check is reported once and never rejects", async () => {
    const logged: LogOutput[] = [];
    configureLogger({ sink: (output) => logged.push(output) });
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "log-detail-expiry-"));
    directories.push(dataDir);
    const service = new LogPolicyService({
      dataDir,
      logging: null,
      env: {},
      listRunningBridges: async () => [],
      checkLogDetailExpiry: async () => {
        throw new Error("config unreadable");
      },
    });
    await service.checkLogDetailExpiry();
    await service.checkLogDetailExpiry();
    expect(logged.filter((output) => output.record?.event === "policy.expiry-failed")).toHaveLength(
      1,
    );
    service.stop();
  });
});
