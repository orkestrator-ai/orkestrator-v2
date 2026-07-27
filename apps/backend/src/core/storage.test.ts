import { describe, expect, expectTypeOf, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultConfig,
  defaultRepositoryConfig,
  StorageService,
} from "./storage.js";
import type { AppConfig } from "./models.js";
import { MAX_CODEX_CONCURRENT_THREADS } from "./constants.js";

async function withTemporaryStorage<T>(
  run: (storage: StorageService, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-backend-storage-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  try {
    return await run(storage, dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

// The default model ids here are the backend source of truth used whenever a
// user has no persisted config. They must stay in sync with the renderer
// defaults (see apps/web/src/stores/configStore.test.ts) and the offered model catalogs.
describe("defaultConfig", () => {
  test("returns the current default model selection", () => {
    const { global } = defaultConfig();
    expect(global.opencodeModel).toBe("opencode/claude-sonnet-5");
    expect(global.claudeModel).toBe("claude-sonnet-5");
    expect(global.codexModel).toBe("gpt-5.4");
    expect(global.codexReasoningEffort).toBe("medium");
  });

  test("keeps the existing web client behavior enabled by default", () => {
    expect(defaultConfig().global.webClientEnabled).toBe(true);
  });

  test("allows five concurrent Codex subagent threads by default", () => {
    expect(defaultConfig().global.codexMaxConcurrentThreads).toBe(5);
    expectTypeOf<AppConfig["global"]["codexMaxConcurrentThreads"]>().toEqualTypeOf<number>();
  });

  test("uses the built-in shared review instruction until one is saved", () => {
    expect(defaultConfig().global.reviewInstruction).toBeUndefined();
    expectTypeOf<AppConfig["global"]["reviewInstruction"]>().toEqualTypeOf<string | undefined>();
  });

  test("does not point defaults at any retired model id", () => {
    const { global } = defaultConfig();
    const selected = [global.opencodeModel, global.claudeModel, global.codexModel];
    for (const retired of [
      "opencode/grok-code",
      "claude-sonnet-4-6",
      "gpt-5.3-codex",
    ]) {
      expect(selected).not.toContain(retired);
    }
  });

  test("returns a fresh object each call (no shared mutable state)", () => {
    const a = defaultConfig();
    const b = defaultConfig();
    expect(a).not.toBe(b);
    expect(a.global.allowedDomains).not.toBe(b.global.allowedDomains);
    a.global.allowedDomains.push("mutated.example.com");
    expect(b.global.allowedDomains).not.toContain("mutated.example.com");
  });

  test("defaultRepositoryConfig uses main as the default and PR base branch", () => {
    expect(defaultRepositoryConfig()).toEqual({
      defaultBranch: "main",
      prBaseBranch: "main",
    });
  });
});

describe("Codex max concurrent thread config storage", () => {
  test.each([
    ["missing", undefined],
    ["numeric string", "8"],
    ["zero", 0],
    ["negative", -1],
    ["fraction", 1.5],
    ["null", null],
    ["root-slot overflow", Number.MAX_SAFE_INTEGER],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1],
  ])("normalizes the persisted %s value to the default", async (_label, value) => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const config = defaultConfig();
      const persisted = structuredClone(config) as unknown as Record<string, unknown>;
      const global = persisted.global as Record<string, unknown>;
      if (value === undefined) {
        delete global.codexMaxConcurrentThreads;
      } else {
        global.codexMaxConcurrentThreads = value;
      }
      await fs.writeFile(
        path.join(dataDir, "config.json"),
        `${JSON.stringify(persisted)}\n`,
        "utf8",
      );

      expect((await storage.loadConfig()).global.codexMaxConcurrentThreads).toBe(5);
    });
  });

  test("preserves valid persisted boundary values", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      for (const value of [1, MAX_CODEX_CONCURRENT_THREADS]) {
        const config = defaultConfig();
        config.global.codexMaxConcurrentThreads = value;
        await fs.writeFile(
          path.join(dataDir, "config.json"),
          `${JSON.stringify(config)}\n`,
          "utf8",
        );
        expect((await storage.loadConfig()).global.codexMaxConcurrentThreads).toBe(value);
      }
    });
  });

  test("rejects invalid values when saving the full config", async () => {
    await withTemporaryStorage(async (storage) => {
      const config = defaultConfig();
      (config.global as unknown as Record<string, unknown>).codexMaxConcurrentThreads = "8";

      await expect(storage.saveConfig(config)).rejects.toThrow(
        `codexMaxConcurrentThreads must be an integer between 1 and ${MAX_CODEX_CONCURRENT_THREADS}.`,
      );
    });
  });

  test("rejects missing values when saving the full config", async () => {
    await withTemporaryStorage(async (storage) => {
      const config = defaultConfig();
      delete (config.global as unknown as Record<string, unknown>).codexMaxConcurrentThreads;

      await expect(storage.saveConfig(config)).rejects.toThrow(
        `codexMaxConcurrentThreads must be an integer between 1 and ${MAX_CODEX_CONCURRENT_THREADS}.`,
      );
    });
  });

  test("saves valid full configs at both boundaries", async () => {
    await withTemporaryStorage(async (storage) => {
      for (const value of [1, MAX_CODEX_CONCURRENT_THREADS]) {
        const config = defaultConfig();
        config.global.codexMaxConcurrentThreads = value;
        await storage.saveConfig(config);
        expect((await storage.loadConfig()).global.codexMaxConcurrentThreads).toBe(value);
      }
    });
  });

  test("rejects invalid global updates without changing stored state", async () => {
    await withTemporaryStorage(async (storage) => {
      const config = defaultConfig();
      config.global.codexMaxConcurrentThreads = 7;
      await storage.saveConfig(config);

      const invalidGlobal = {
        ...config.global,
        codexMaxConcurrentThreads: Number.POSITIVE_INFINITY,
      };
      await expect(storage.updateGlobalConfig(invalidGlobal)).rejects.toThrow(
        `codexMaxConcurrentThreads must be an integer between 1 and ${MAX_CODEX_CONCURRENT_THREADS}.`,
      );
      expect((await storage.loadConfig()).global.codexMaxConcurrentThreads).toBe(7);
    });
  });

  test("saves valid global updates at both boundaries", async () => {
    await withTemporaryStorage(async (storage) => {
      for (const value of [1, MAX_CODEX_CONCURRENT_THREADS]) {
        const updated = await storage.updateGlobalConfig({
          ...defaultConfig().global,
          codexMaxConcurrentThreads: value,
        });
        expect(updated.global.codexMaxConcurrentThreads).toBe(value);
        expect((await storage.loadConfig()).global.codexMaxConcurrentThreads).toBe(value);
      }
    });
  });
});

describe("session buffer deletion", () => {
  test("removes an existing buffer and is idempotent when it is already absent", async () => {
    await withTemporaryStorage(async (storage) => {
      await storage.saveSessionBuffer("session-delete", "sensitive terminal output");
      expect(await storage.loadSessionBuffer("session-delete")).toBe(
        "sensitive terminal output",
      );

      await storage.deleteSessionBuffer("session-delete");
      await storage.deleteSessionBuffer("session-delete");

      expect(await storage.loadSessionBuffer("session-delete")).toBeNull();
    });
  });
});
