import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig } from "./storage-shared.js";
import { StorageService } from "./storage.js";

describe("StorageService config migration", () => {
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
});
