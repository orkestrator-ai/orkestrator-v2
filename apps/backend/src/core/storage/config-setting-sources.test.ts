import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  RESETTABLE_GLOBAL_SETTING_KEYS,
  type ResettableGlobalSettingKey,
} from "@orkestrator/protocol/setting-sources";
import { BackendRuntime } from "../backend-runtime.js";
import { createCommandRegistry } from "../commands/registry.js";
import type { CommandContext } from "../commands/context.js";
import { StorageService } from "./service.js";

async function withStorage(
  run: (storage: StorageService, dataDir: string) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-setting-sources-"));
  try {
    const storage = new StorageService(dataDir);
    await storage.init();
    await run(storage, dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function storedOnDisk(dataDir: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(path.join(dataDir, "config.json"), "utf8");
  return (JSON.parse(raw) as { global: Record<string, unknown> }).global;
}

/** A valid value for every resettable key that differs from its default. */
const NON_DEFAULT_VALUES: Record<ResettableGlobalSettingKey, unknown> = {
  autoSteer: true,
  preferredEditor: "cursor",
  defaultProjectsDirectory: "/tmp/ork-projects",
  sshAgentSocketPath: "/tmp/ork-agent.sock",
  autoMergeRequireChecks: false,
  claudeBackgroundCommandLimitHours: 2,
  sessionTitleGeneration: "off",
  terminalLinkDefaultTarget: "browser-tab",
  reviewInstruction: "Look for missing tests.",
  reviewLensPresets: [{ id: "only", label: "Only", instruction: "Look at one thing." }],
  coordinatorWebResearch: "search-and-mcp",
  coordinatorResearchMcpServers: [{ name: "research", url: "https://research.example/mcp" }],
  experimentalGraphs: true,
  experimentalScheduling: true,
  experimentalSelfImprovement: true,
  experimentalTmux: true,
  localWindowGatewayTransport: false,
  debugLogging: true,
};

describe("global setting sources", () => {
  test("names stored keys from the file, never credentials, and null without a command node", async () => {
    await withStorage(async (storage) => {
      await storage.setGitHubToken("ghp_secret");
      await storage.patchGlobalConfig({ terminalScrollback: 4321 });
      const sources = await storage.globalSettingSources();
      expect(sources.storedKeys).toContain("terminalScrollback");
      expect(sources.storedKeys).not.toContain("githubToken");
      expect(sources.storedKeys).not.toContain("githubTokenConfigured");
      expect(sources.inheritedKeys).toBeNull();
      expect([...sources.storedKeys].sort()).toEqual(sources.storedKeys);
    });
  });

  test("an install that never saved stores nothing", async () => {
    await withStorage(async (_storage, dataDir) => {
      await fs.rm(path.join(dataDir, "config.json"), { force: true });
      const fresh = new StorageService(dataDir);
      expect((await fresh.globalSettingSources()).storedKeys).toEqual([]);
    });
  });

  test("normalization and unrelated saves do not turn defaults into overrides", async () => {
    await withStorage(async (storage, dataDir) => {
      await storage.patchGlobalConfig({ terminalScrollback: 4321 });
      expect((await storage.globalSettingSources()).storedKeys).not.toContain("debugLogging");
      await storage.patchGlobalConfig({ debugLogging: false });
      await storage.patchGlobalConfig({ terminalScrollback: 4322 });
      expect((await new StorageService(dataDir).globalSettingSources()).storedKeys).toContain(
        "debugLogging",
      );
    });
  });

  test("equal-to-default values from older files stay ambiguous until explicitly set", async () => {
    await withStorage(async (storage, dataDir) => {
      const config = await storage.loadOwnConfig();
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        JSON.stringify({
          ...config,
          global: { ...config.global, debugLogging: false, terminalScrollback: 4321 },
        }),
      );
      const reloaded = new StorageService(dataDir);
      await reloaded.init();
      await reloaded.patchGlobalConfig({ terminalScrollback: 4322 });
      expect(await reloaded.globalSettingSources()).toMatchObject({
        storedKeys: expect.arrayContaining(["terminalScrollback"]),
        unknownKeys: expect.arrayContaining(["debugLogging"]),
      });
      expect((await reloaded.globalSettingSources()).storedKeys).not.toContain("debugLogging");
      await reloaded.patchGlobalConfig({ debugLogging: false });
      expect((await reloaded.globalSettingSources()).storedKeys).toContain("debugLogging");
      expect((await reloaded.globalSettingSources()).unknownKeys ?? []).not.toContain(
        "debugLogging",
      );
    });
  });

  test("marks only the sound switch edited, including when it returns to its default", async () => {
    await withStorage(async (storage) => {
      const settings = (await storage.loadConfig()).global.notificationSounds;
      await storage.updateNotificationSoundSettings({ ...settings, prMerged: false });
      await storage.updateNotificationSoundSettings({ ...settings, prMerged: true });
      expect((await storage.globalSettingSources()).storedFields).toEqual([
        "notificationSounds.prMerged",
      ]);
    });
  });

  test("reports the keys taken from the command node this machine follows", async () => {
    await withStorage(async (storage) => {
      storage.inheritedGlobalSettings = () => ({ terminalScrollback: 9000, autoSteer: true });
      expect((await storage.globalSettingSources()).inheritedKeys).toEqual([
        "autoSteer",
        "terminalScrollback",
      ]);
    });
  });
});

describe("resetting global settings", () => {
  test.each(RESETTABLE_GLOBAL_SETTING_KEYS.map((key) => [key]))(
    "%s stays reset through a later unrelated save",
    async (key) => {
      await withStorage(async (storage, dataDir) => {
        await storage.patchGlobalConfig({ [key]: NON_DEFAULT_VALUES[key] });
        const stored = (await storage.loadOwnConfig()).global as unknown as Record<string, unknown>;
        expect(stored[key]).toBeDefined();
        const result = await storage.resetGlobalSettings(
          [key],
          [{ key, present: true, value: stored[key] }],
        );
        expect(result.status).toBe("reset");
        expect(await storedOnDisk(dataDir)).not.toHaveProperty(key);
        // The form saves something else; the reset key must not come back.
        await storage.patchGlobalConfig({ terminalScrollback: key.length + 1000 });
        expect(await storedOnDisk(dataDir)).not.toHaveProperty(key);
        expect((await storage.globalSettingSources()).storedKeys).not.toContain(key);
      });
    },
  );

  test("refuses to remove a parked value when a controller owns the effective setting", async () => {
    await withStorage(async (storage, dataDir) => {
      await storage.patchGlobalConfig({ autoSteer: true });
      storage.inheritedGlobalSettings = () => ({ autoSteer: false });
      const reset = await storage.resetGlobalSettings(
        ["autoSteer"],
        [{ key: "autoSteer", present: true, value: true }],
      );
      expect(reset).toMatchObject({ status: "conflict", conflicts: ["autoSteer"] });
      expect(reset.config.global.autoSteer).toBe(false);
      expect((await storedOnDisk(dataDir)).autoSteer).toBe(true);
    });
  });

  test("removes nothing when a value changed after the preview", async () => {
    await withStorage(async (storage, dataDir) => {
      await storage.patchGlobalConfig({ debugLogging: true, autoSteer: true });
      const result = await storage.resetGlobalSettings(
        ["debugLogging", "autoSteer"],
        [
          { key: "debugLogging", present: true, value: false },
          { key: "autoSteer", present: true, value: true },
        ],
      );
      expect(result.status).toBe("conflict");
      expect(result.conflicts).toEqual(["debugLogging"]);
      expect(result.config.global.debugLogging).toBe(true);
      expect(await storedOnDisk(dataDir)).toMatchObject({ debugLogging: true, autoSteer: true });
    });
  });

  test("a key expected absent that is now set is a conflict", async () => {
    await withStorage(async (storage) => {
      await storage.patchGlobalConfig({ autoSteer: true });
      const result = await storage.resetGlobalSettings(
        ["autoSteer"],
        [{ key: "autoSteer", present: false }],
      );
      expect(result.status).toBe("conflict");
    });
  });

  test("the command refuses credentials and other keys, and keeps a stored credential", async () => {
    await withStorage(async (storage) => {
      await storage.setGitHubToken("ghp_keep");
      await storage.patchGlobalConfig({ autoSteer: true });
      const registry = createCommandRegistry();
      const reset = registry.get("reset_global_settings")!;
      const sources = registry.get("get_global_setting_sources")!;
      const runtime = new BackendRuntime({ emit: () => undefined });
      const context = { storage, runtime } as CommandContext;
      try {
        await storage.patchGlobalConfig({ webClientEnabled: false });
        await expect(
          reset(
            {
              keys: ["webClientEnabled"],
              expect: [{ key: "webClientEnabled", present: true, value: false }],
            },
            context,
          ),
        ).rejects.toThrow("cannot be reset");
        expect((await storage.loadConfig()).global.webClientEnabled).toBe(false);
        await expect(
          reset(
            { keys: ["githubToken"], expect: [{ key: "githubToken", present: false }] },
            context,
          ),
        ).rejects.toThrow("cannot be reset");
        await expect(
          reset(
            {
              keys: ["enabledAgentPlatforms"],
              expect: [{ key: "enabledAgentPlatforms", present: false }],
            },
            context,
          ),
        ).rejects.toThrow("cannot be reset");
        await expect(reset({ keys: ["autoSteer"], expect: [] }, context)).rejects.toThrow(
          "expectation",
        );
        const result = (await reset(
          {
            keys: ["autoSteer"],
            expect: [{ key: "autoSteer", present: true, value: true }],
          },
          context,
        )) as { status: string; config: { global: Record<string, unknown> } };
        expect(result.status).toBe("reset");
        expect(result.config.global.githubToken).toBeUndefined();
        expect(result.config.global.githubTokenConfigured).toBe(true);
        const read = (await sources({}, context)) as { storedKeys: string[] };
        expect(read.storedKeys).not.toContain("autoSteer");
      } finally {
        runtime.shutdown();
      }
      expect((await storage.loadOwnConfig()).global.githubToken).toBe("ghp_keep");
    });
  });
});
