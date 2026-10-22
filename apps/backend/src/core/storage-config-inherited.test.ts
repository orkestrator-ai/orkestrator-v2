import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { InheritedGlobalSettings } from "@orkestrator/protocol/controller-settings";

import { StorageService } from "./storage.js";

async function withStorage(run: (storage: StorageService) => Promise<void>): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-inherited-settings-"));
  try {
    const storage = new StorageService(dataDir);
    await storage.init();
    await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("settings inherited from a command node", () => {
  test("lay the command node's values over this node's own while it is a leaf", async () => {
    await withStorage(async (storage) => {
      const own = await storage.loadConfig();
      await storage.updateGlobalConfig({
        ...own.global,
        terminalScrollback: 1_000,
        agentSettings: { defaultAgent: "claude" },
      });

      let inherited: InheritedGlobalSettings | null = {
        terminalScrollback: 5_000,
        agentSettings: { defaultAgent: "codex" },
      };
      storage.inheritedGlobalSettings = () => inherited;

      const effective = await storage.loadConfig();
      expect(effective.global.terminalScrollback).toBe(5_000);
      expect(effective.global.agentSettings?.defaultAgent).toBe("codex");
      expect((await storage.loadOwnConfig()).global.terminalScrollback).toBe(1_000);

      // Detached: this node's own settings come back.
      inherited = null;
      expect((await storage.loadConfig()).global.terminalScrollback).toBe(1_000);
      expect((await storage.loadConfig()).global.agentSettings?.defaultAgent).toBe("claude");
    });
  });

  test("a whole-config save that echoes inherited values keeps this node's own", async () => {
    await withStorage(async (storage) => {
      const own = await storage.loadConfig();
      await storage.updateGlobalConfig({ ...own.global, terminalScrollback: 1_000 });
      storage.inheritedGlobalSettings = () => ({ terminalScrollback: 5_000 });

      // A client edits a machine-specific value and echoes the rest.
      const effective = await storage.loadConfig();
      const saved = await storage.updateGlobalConfig({
        ...effective.global,
        allowedDomains: ["example.com"],
      });

      expect(saved.global.terminalScrollback).toBe(5_000);
      const stored = await storage.loadOwnConfig();
      expect(stored.global.allowedDomains).toEqual(["example.com"]);
      expect(stored.global.terminalScrollback).toBe(1_000);
    });
  });

  test("a changed inherited value is stored as this node's own and stays overridden", async () => {
    await withStorage(async (storage) => {
      storage.inheritedGlobalSettings = () => ({ terminalScrollback: 5_000 });
      const effective = await storage.loadConfig();
      await storage.updateGlobalConfig({ ...effective.global, terminalScrollback: 2_000 });

      expect((await storage.loadOwnConfig()).global.terminalScrollback).toBe(2_000);
      expect((await storage.loadConfig()).global.terminalScrollback).toBe(5_000);
    });
  });

  test("other writers never persist inherited values", async () => {
    await withStorage(async (storage) => {
      const own = await storage.loadConfig();
      await storage.updateGlobalConfig({ ...own.global, terminalScrollback: 1_000 });
      storage.inheritedGlobalSettings = () => ({ terminalScrollback: 5_000 });

      const returned = await storage.setGitHubCliReminderDismissed(true);
      expect(returned.global.terminalScrollback).toBe(5_000);
      expect((await storage.loadOwnConfig()).global.terminalScrollback).toBe(1_000);
    });
  });
});
