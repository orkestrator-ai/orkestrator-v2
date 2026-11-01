import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BackendRuntime } from "./backend-runtime.js";
import { createCommandRegistry } from "./commands-registry.js";
import { parseConfigUnsetKeys } from "./commands-registry-projects.js";
import type { CommandContext } from "./commands-context.js";
import { StorageService } from "./storage.js";

async function withStorage(run: (storage: StorageService) => Promise<void>): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-config-patch-"));
  try {
    const storage = new StorageService(dataDir);
    await storage.init();
    await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("patching the global config", () => {
  test("changes only the supplied keys and keeps another client's concurrent edit", async () => {
    await withStorage(async (storage) => {
      // Two clients loaded the same config; each changes one different field.
      await Promise.all([
        storage.patchGlobalConfig({ terminalScrollback: 4321 }),
        storage.patchGlobalConfig({ allowedDomains: ["one.test"] }),
      ]);
      const stored = (await storage.loadOwnConfig()).global;
      expect(stored.terminalScrollback).toBe(4321);
      expect(stored.allowedDomains).toEqual(["one.test"]);
    });
  });

  test("runs the whole-object validation on the merged result", async () => {
    await withStorage(async (storage) => {
      await expect(storage.patchGlobalConfig({ enabledAgentPlatforms: [] })).rejects.toThrow(
        "Select at least one agent platform",
      );
      await expect(
        storage.patchGlobalConfig({ sshAgentSocketPath: "relative/socket" }),
      ).rejects.toThrow();
      // Disabling the default agent's platform moves the default, as a full save does.
      await storage.patchGlobalConfig({ agentSettings: { defaultAgent: "codex" } });
      const updated = await storage.patchGlobalConfig({ enabledAgentPlatforms: ["claude"] });
      expect(updated.global.agentSettings?.defaultAgent).toBe("claude");
    });
  });

  test("unset removes a key, and credentials are never cleared or set by a patch", async () => {
    await withStorage(async (storage) => {
      await storage.setGitHubToken("ghp_secret");
      await storage.patchGlobalConfig({ reviewInstruction: "Look closely" });
      expect((await storage.loadOwnConfig()).global.reviewInstruction).toBe("Look closely");
      await storage.patchGlobalConfig(
        {},
        { unset: ["reviewInstruction", "githubToken"], preserveCredentials: true },
      );
      const stored = (await storage.loadOwnConfig()).global;
      expect(stored.reviewInstruction).toBeUndefined();
      expect(stored.githubToken).toBe("ghp_secret");
    });
  });

  test("an inherited key in a patch is stored as this node's own value", async () => {
    await withStorage(async (storage) => {
      storage.inheritedGlobalSettings = () => ({ terminalScrollback: 9000 });
      await storage.patchGlobalConfig({ terminalScrollback: 9000, debugLogging: true });
      const own = (await storage.loadOwnConfig()).global;
      expect(own.terminalScrollback).toBe(9000);
      expect(own.debugLogging).toBe(true);
    });
  });

  test("the command strips renderer credentials and validates its arguments", async () => {
    await withStorage(async (storage) => {
      await storage.setGitHubToken("ghp_keep");
      const patch = createCommandRegistry().get("patch_global_config")!;
      const runtime = new BackendRuntime({ emit: () => undefined });
      const context = { storage, runtime } as CommandContext;
      try {
        const result = (await patch(
          { patch: { githubToken: "ghp_forged", codexMaxConcurrentThreads: 3 } },
          context,
        )) as { global: Record<string, unknown> };
        expect(result.global.githubToken).toBeUndefined();
        await expect(patch({ patch: {}, unset: "reviewInstruction" }, context)).rejects.toThrow(
          "unset",
        );
        await expect(patch({ patch: {}, extra: true }, context)).rejects.toThrow();
      } finally {
        runtime.shutdown();
      }
      const stored = (await storage.loadOwnConfig()).global;
      expect(stored.githubToken).toBe("ghp_keep");
      expect(stored.codexMaxConcurrentThreads).toBe(3);
    });
  });

  test("parseConfigUnsetKeys bounds the list", () => {
    expect(parseConfigUnsetKeys(undefined)).toEqual([]);
    expect(parseConfigUnsetKeys(["a"])).toEqual(["a"]);
    expect(() => parseConfigUnsetKeys([""])).toThrow();
    expect(() => parseConfigUnsetKeys(Array.from({ length: 129 }, (_, i) => `k${i}`))).toThrow();
  });
});

describe("patching repository settings", () => {
  test("merges the edited fields and never takes backend-owned last-create state", async () => {
    await withStorage(async (storage) => {
      await storage.patchRepositoryConfig("p1", {
        lastEnvironmentType: "local",
        filesToCopy: [".env"],
        prBaseBranch: "develop",
      });
      await Promise.all([
        storage.patchRepositorySettings("p1", { defaultBranch: "trunk" }),
        storage.patchRepositorySettings("p1", { entryPort: 3000 }),
      ]);
      await storage.patchRepositorySettings("p1", { lastEnvironmentType: "container" } as never, [
        "filesToCopy",
        "lastEnvironmentType",
      ]);
      const repo = (await storage.loadOwnConfig()).repositories.p1!;
      expect(repo.defaultBranch).toBe("trunk");
      expect(repo.prBaseBranch).toBe("develop");
      expect(repo.entryPort).toBe(3000);
      expect(repo.filesToCopy).toBeUndefined();
      expect(repo.lastEnvironmentType).toBe("local");
    });
  });

  test("unsetting a required field falls back to its default", async () => {
    await withStorage(async (storage) => {
      await storage.patchRepositorySettings("p2", { prBaseBranch: "release" });
      await storage.patchRepositorySettings("p2", {}, ["prBaseBranch"]);
      expect((await storage.loadOwnConfig()).repositories.p2?.prBaseBranch).toBe("main");
    });
  });
});
