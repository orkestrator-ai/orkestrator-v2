import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  INHERITED_GLOBAL_SETTING_KEYS,
  type InheritedGlobalSettings,
} from "@orkestrator/protocol/controller-settings";

import { BackendRuntime } from "./backend-runtime.js";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
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
  test("complete snapshots reset absent preferences without changing the leaf's stored overrides", async () => {
    await withStorage(async (storage) => {
      const own = await storage.loadOwnConfig();
      await storage.updateGlobalConfig({
        ...own.global,
        reviewInstruction: "Leaf instruction",
        terminalScrollback: 1234,
      });
      let inherited: InheritedGlobalSettings = { reviewInstruction: "Controller instruction" };
      storage.inheritedGlobalSettings = () => inherited;
      expect((await storage.loadConfig()).global.reviewInstruction).toBe("Controller instruction");
      inherited = {};
      const effective = await storage.loadConfig();
      expect(effective.global.reviewInstruction).toBeUndefined();
      expect(effective.global.terminalScrollback).toBe(own.global.terminalScrollback);
      await storage.updateGlobalConfig({ ...effective.global, allowedDomains: ["leaf.test"] });
      expect((await storage.loadOwnConfig()).global.reviewInstruction).toBe("Leaf instruction");
      expect((await storage.loadOwnConfig()).global.terminalScrollback).toBe(1234);
    });
  });

  test("coerces inherited default agents to the leaf's enabled platforms", async () => {
    await withStorage(async (storage) => {
      const own = await storage.loadOwnConfig();
      await storage.updateGlobalConfig({
        ...own.global,
        enabledAgentPlatforms: ["claude"],
        allowedDomains: ["leaf.test"],
      });
      storage.inheritedGlobalSettings = () => ({ agentSettings: { defaultAgent: "codex" } });
      const effective = await storage.loadConfig();
      expect(effective.global.agentSettings?.defaultAgent).toBe("claude");
      expect(effective.global.enabledAgentPlatforms).toEqual(["claude"]);
      expect(effective.global.allowedDomains).toEqual(["leaf.test"]);
    });
  });
  test("machine-only saves preserve own preferences even after an intervening controller sync", async () => {
    await withStorage(async (storage) => {
      const own = await storage.loadOwnConfig();
      await storage.updateGlobalConfig({
        ...own.global,
        terminalScrollback: 1234,
        reviewInstruction: "Leaf review",
      });
      storage.inheritedGlobalSettings = () => ({ terminalScrollback: 9000 });
      const update = createCommandRegistry().get("update_global_config")!;
      // The save applies terminal-history retention to the backend's runtime.
      const runtime = new BackendRuntime({ emit: () => undefined });
      const context = { storage, runtime } as CommandContext;
      try {
        await update(
          {
            global: { ...own.global, terminalScrollback: 5000, allowedDomains: ["leaf.test"] },
            preserveInheritedSettings: true,
          },
          context,
        );
        await expect(
          update({ global: own.global, preserveInheritedSettings: "yes" }, context),
        ).rejects.toThrow("preserveInheritedSettings");
      } finally {
        runtime.shutdown();
      }
      const stored = await storage.loadOwnConfig();
      expect(stored.global.terminalScrollback).toBe(1234);
      expect(stored.global.reviewInstruction).toBe("Leaf review");
      expect(stored.global.allowedDomains).toEqual(["leaf.test"]);
      expect((await storage.loadConfig()).global.terminalScrollback).toBe(9000);
    });
  });
  test("machine-only saves accept a payload without the inherited preferences", async () => {
    await withStorage(async (storage) => {
      const own = await storage.loadOwnConfig();
      await storage.updateGlobalConfig({ ...own.global, codexMaxConcurrentThreads: 7 });
      storage.inheritedGlobalSettings = () => ({ codexMaxConcurrentThreads: 3 });
      // The command-node window routes preferences to the command node and
      // strips them from the leaf's machine save.
      const machineOnly = { ...own.global, allowedDomains: ["leaf.test"] } as Record<
        string,
        unknown
      >;
      for (const key of INHERITED_GLOBAL_SETTING_KEYS) delete machineOnly[key];
      await storage.updateGlobalConfig(machineOnly as unknown as typeof own.global, {
        preserveInheritedSettings: true,
      });
      const stored = await storage.loadOwnConfig();
      expect(stored.global.allowedDomains).toEqual(["leaf.test"]);
      expect(stored.global.codexMaxConcurrentThreads).toBe(7);
      expect((await storage.loadConfig()).global.codexMaxConcurrentThreads).toBe(3);
    });
  });

  test("machine-only saves ignore malformed inherited preferences and preserve stored values", async () => {
    await withStorage(async (storage) => {
      const own = await storage.loadOwnConfig();
      await storage.updateGlobalConfig({
        ...own.global,
        reviewInstruction: "Leaf review",
        codexMaxConcurrentThreads: 7,
      });
      storage.inheritedGlobalSettings = () => ({
        reviewInstruction: "Controller review",
        codexMaxConcurrentThreads: 3,
      });
      const malformed = {
        ...(await storage.loadConfig()).global,
        reviewInstruction: { invalid: true },
        codexMaxConcurrentThreads: "invalid",
        allowedDomains: ["leaf.test"],
      } as unknown as typeof own.global;

      const saved = await storage.updateGlobalConfig(malformed, {
        preserveInheritedSettings: true,
      });

      const stored = await storage.loadOwnConfig();
      expect(stored.global.allowedDomains).toEqual(["leaf.test"]);
      expect(stored.global.reviewInstruction).toBe("Leaf review");
      expect(stored.global.codexMaxConcurrentThreads).toBe(7);
      expect(saved.global.reviewInstruction).toBe("Controller review");
      expect(saved.global.codexMaxConcurrentThreads).toBe(3);
    });
  });

  test("machine-only saves reject invalid machine settings without changing stored config", async () => {
    await withStorage(async (storage) => {
      const own = await storage.loadOwnConfig();
      await storage.updateGlobalConfig({
        ...own.global,
        reviewInstruction: "Leaf review",
        sshAgentSocketPath: "/tmp/leaf-agent.sock",
      });
      storage.inheritedGlobalSettings = () => ({ reviewInstruction: "Controller review" });
      const stored = await storage.loadOwnConfig();

      await expect(
        storage.updateGlobalConfig(
          {
            ...(await storage.loadConfig()).global,
            sshAgentSocketPath: "relative/agent.sock",
            allowedDomains: ["changed.test"],
          },
          { preserveInheritedSettings: true },
        ),
      ).rejects.toThrow("SSH agent socket path must be an absolute path.");

      expect(await storage.loadOwnConfig()).toEqual(stored);
    });
  });
});
