import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION } from "@orkestrator/protocol/coordinator";
import { defaultConfig, normalizePersistedConfig } from "./storage-shared.js";
import { StorageService } from "./storage.js";

describe("StorageService config migration", () => {
  test("adds default notification settings to persisted legacy config", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-sound-settings-migration-"));
    try {
      const legacy = defaultConfig();
      delete legacy.global.notificationSounds;
      await fs.writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(legacy, null, 2)}\n`);

      const storage = new StorageService(dataDir);
      await storage.init();
      expect((await storage.loadConfig()).global.notificationSounds).toEqual({
        agentStopped: true,
        prMerged: true,
      });
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("preserves object identity when notification settings are already normalized", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-sound-settings-normalized-"));
    try {
      const storage = new StorageService(dataDir);
      await storage.init();
      const normalized = await storage.loadConfig();

      expect(normalizePersistedConfig(normalized)).toBe(normalized);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("patches notification settings atomically and normalizes malformed writes", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-sound-settings-update-"));
    try {
      const storage = new StorageService(dataDir);
      await storage.init();
      const current = await storage.loadConfig();
      const globalWrite = storage.updateGlobalConfig({
        ...current.global,
        terminalAppearance: { ...current.global.terminalAppearance, fontSize: 19 },
      });
      const soundWrite = storage.updateNotificationSoundSettings({
        agentStopped: false,
        prMerged: true,
      });

      await Promise.all([globalWrite, soundWrite]);
      const combined = await storage.loadConfig();
      expect(combined.global.terminalAppearance?.fontSize).toBe(19);
      expect(combined.global.notificationSounds).toEqual({
        agentStopped: false,
        prMerged: true,
      });

      const malformedWholeGlobal = await storage.updateGlobalConfig({
        ...combined.global,
        notificationSounds: { agentStopped: "yes", prMerged: null } as never,
      });
      expect(malformedWholeGlobal.global.notificationSounds).toEqual({
        agentStopped: true,
        prMerged: true,
      });

      const malformed = await storage.updateNotificationSoundSettings({
        agentStopped: "yes",
        prMerged: null,
      });
      expect(malformed.global.notificationSounds).toEqual({
        agentStopped: true,
        prMerged: true,
      });
      expect(malformed.global.terminalAppearance?.fontSize).toBe(19);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("migrates once under the config lock without reverting a concurrent update", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-config-migration-"));
    try {
      const current = defaultConfig();
      const { schemaVersion: _schemaVersion, ...legacy } = current;
      const { agentMessaging: _agentMessaging, ...legacyGlobal } = legacy.global;
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        `${JSON.stringify({ ...legacy, global: legacyGlobal }, null, 2)}\n`,
      );

      const migrating = new StorageService(dataDir);
      const updating = new StorageService(dataDir);
      const normalized = await updating.loadConfig();
      await Promise.all([
        migrating.init(),
        updating.updateGlobalConfig({ ...normalized.global, webClientEnabled: false }),
      ]);

      const saved = await migrating.loadConfig();
      expect(saved.schemaVersion).toBe(2);
      expect(saved.global.agentMessaging?.enabled).toBe(false);
      expect(saved.global.webClientEnabled).toBe(false);
      const afterMigration = await fs.readFile(path.join(dataDir, "config.json"), "utf8");
      await migrating.loadConfig();
      expect(await fs.readFile(path.join(dataDir, "config.json"), "utf8")).toBe(afterMigration);
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("migrates the materialized legacy coordinator default once", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-coordinator-tier-migration-"));
    try {
      const legacy = defaultConfig();
      delete legacy.global.coordinatorProviderTierDefaultVersion;
      legacy.global.coordinatorProviderTiers = "enforced";
      await fs.writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(legacy, null, 2)}\n`);

      const storage = new StorageService(dataDir);
      await storage.init();
      const migrated = await storage.loadConfig();
      expect(migrated.global.coordinatorProviderTiers).toBeUndefined();
      expect(migrated.global.coordinatorProviderTierDefaultVersion).toBe(
        COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION,
      );

      const explicitlyEnforced = await storage.updateGlobalConfig({
        ...migrated.global,
        coordinatorProviderTiers: "enforced",
      });
      expect(explicitlyEnforced.global.coordinatorProviderTiers).toBe("enforced");

      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect((await restarted.loadConfig()).global.coordinatorProviderTiers).toBe("enforced");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });

  test("preserves future migration markers and fails closed for malformed updates", async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-coordinator-tier-validation-"));
    try {
      const future = defaultConfig();
      future.global.coordinatorProviderTiers = "enforced";
      future.global.coordinatorProviderTierDefaultVersion =
        COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION + 1;
      await fs.writeFile(path.join(dataDir, "config.json"), `${JSON.stringify(future, null, 2)}\n`);

      const storage = new StorageService(dataDir);
      await storage.init();
      const loaded = await storage.loadConfig();
      expect(loaded.global.coordinatorProviderTiers).toBe("enforced");
      expect(loaded.global.coordinatorProviderTierDefaultVersion).toBe(
        COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION + 1,
      );

      const malformed = await storage.updateGlobalConfig({
        ...loaded.global,
        coordinatorProviderTiers: "provider-configred" as never,
      });
      expect(malformed.global.coordinatorProviderTiers).toBe("enforced");
      expect(malformed.global.coordinatorProviderTierDefaultVersion).toBe(
        COORDINATOR_PROVIDER_TIER_DEFAULT_VERSION + 1,
      );

      const absent = await storage.updateGlobalConfig({
        ...malformed.global,
        coordinatorProviderTiers: undefined,
      });
      expect(absent.global.coordinatorProviderTiers).toBe("provider-configured");
    } finally {
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  });
});
