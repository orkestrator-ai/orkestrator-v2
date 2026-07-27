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

describe("OpenCode model catalogue cache", () => {
  const projectId = "project-a";
  const models = [
    {
      id: "openrouter/openai/gpt-5",
      name: "GPT-5",
      provider: "openrouter",
      variants: ["low", "high"],
      contextWindow: 400_000,
    },
    {
      id: "anthropic/claude-sonnet",
      name: "Claude Sonnet",
      provider: "anthropic",
    },
  ];

  test("persists a normalized catalogue in the application config folder", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const snapshot = await storage.cacheOpenCodeModelCatalog(projectId, models);

      expect(snapshot.schemaVersion).toBe(2);
      expect(snapshot.projectId).toBe(projectId);
      expect(snapshot.models.map((model) => model.id)).toEqual([
        "anthropic/claude-sonnet",
        "openrouter/openai/gpt-5",
      ]);
      expect(await storage.getOpenCodeModelCatalog(projectId)).toEqual(snapshot);
      expect(
        JSON.parse(
          await fs.readFile(
            path.join(dataDir, "opencode-model-catalog.json"),
            "utf8",
          ),
        ),
      ).toEqual({
        schemaVersion: 2,
        catalogs: { [projectId]: snapshot },
      });
    });
  });

  test("keeps cache versions stable per project until its discovered models change", async () => {
    await withTemporaryStorage(async (storage) => {
      const initial = await storage.cacheOpenCodeModelCatalog(projectId, models);
      const unchanged = await storage.cacheOpenCodeModelCatalog(
        projectId,
        [...models].reverse(),
      );
      expect(unchanged).toEqual(initial);

      const updated = await storage.cacheOpenCodeModelCatalog(
        projectId,
        [
          ...models,
          {
            id: "openrouter/google/gemini",
            name: "Gemini",
            provider: "openrouter",
          },
        ],
      );
      expect(updated.catalogVersion).not.toBe(initial.catalogVersion);
      expect(updated.models).toHaveLength(3);
    });
  });

  test("isolates project catalogues in one scoped store", async () => {
    await withTemporaryStorage(async (storage) => {
      const first = await storage.cacheOpenCodeModelCatalog("project-a", models);
      const second = await storage.cacheOpenCodeModelCatalog("project-b", [{
        id: "local/model",
        name: "Local",
        provider: "local",
      }]);

      expect(await storage.getOpenCodeModelCatalog("project-a")).toEqual(first);
      expect(await storage.getOpenCodeModelCatalog("project-b")).toEqual(second);
      expect(await storage.getOpenCodeModelCatalog("project-c")).toBeNull();

      const prototypeNamed = await storage.cacheOpenCodeModelCatalog(
        "constructor",
        models,
      );
      expect(await storage.getOpenCodeModelCatalog("constructor")).toEqual(
        prototypeNamed,
      );
    });
  });

  test("normalizes whitespace, variants, duplicates, and optional numeric boundaries", async () => {
    await withTemporaryStorage(async (storage) => {
      const snapshot = await storage.cacheOpenCodeModelCatalog(projectId, [
        {
          id: " provider/model ",
          name: " Model ",
          provider: " provider ",
          variants: [" high ", "", "low", "high", "   "],
          inputCost: 0,
          outputCost: Number.MAX_VALUE,
          contextWindow: Number.MAX_SAFE_INTEGER,
        },
        {
          id: "provider/model",
          name: "Z model",
          provider: "provider",
          inputCost: -1,
          outputCost: Number.POSITIVE_INFINITY,
          contextWindow: 1.5,
        },
        {
          id: "provider/invalid-numerics",
          name: "Invalid numerics",
          provider: "provider",
          variants: [" ", ""],
          inputCost: -1,
          outputCost: Number.POSITIVE_INFINITY,
          contextWindow: 1.5,
        },
        ...([
          null,
          {},
          { id: "blank/name", name: " ", provider: "provider" },
          { id: "blank/provider", name: "Name", provider: " " },
        ] as unknown as typeof models),
      ]);

      expect(snapshot.models).toEqual([
        {
          id: "provider/invalid-numerics",
          name: "Invalid numerics",
          provider: "provider",
        },
        {
          id: "provider/model",
          name: "Model",
          provider: "provider",
          variants: ["high", "low"],
          inputCost: 0,
          outputCost: Number.MAX_VALUE,
          contextWindow: Number.MAX_SAFE_INTEGER,
        },
      ]);
    });
  });

  test("rejects blank scopes and empty or all-invalid catalogues", async () => {
    await withTemporaryStorage(async (storage) => {
      await expect(storage.getOpenCodeModelCatalog(" \t")).rejects.toThrow(
        "projectId must be a non-blank string",
      );
      await expect(
        storage.cacheOpenCodeModelCatalog("", models),
      ).rejects.toThrow("projectId must be a non-blank string");
      await expect(
        storage.cacheOpenCodeModelCatalog(projectId, []),
      ).rejects.toThrow("must contain at least one model");
      await expect(
        storage.cacheOpenCodeModelCatalog(
          projectId,
          [{ id: "", name: "", provider: "" }],
        ),
      ).rejects.toThrow("must contain at least one model");
    });
  });

  test("repairs stored dates, versions, and normalized model data while reading", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await fs.writeFile(
        path.join(dataDir, "opencode-model-catalog.json"),
        JSON.stringify({
          schemaVersion: 2,
          catalogs: {
            " project-a ": {
              schemaVersion: 999,
              projectId: "wrong-project",
              catalogVersion: "not-the-content-digest",
              updatedAt: "not-a-date",
              models: [{
                id: " provider/model ",
                name: " Model ",
                provider: " provider ",
                variants: ["z", "a", "z"],
              }],
            },
            malformed: { models: [{ id: "missing-fields" }] },
          },
        }),
      );

      const snapshot = await storage.getOpenCodeModelCatalog(projectId);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.schemaVersion).toBe(2);
      expect(snapshot?.projectId).toBe(projectId);
      expect(snapshot?.updatedAt).toBe(new Date(0).toISOString());
      expect(snapshot?.catalogVersion).toHaveLength(64);
      expect(snapshot?.catalogVersion).not.toBe("not-the-content-digest");
      expect(snapshot?.models).toEqual([{
        id: "provider/model",
        name: "Model",
        provider: "provider",
        variants: ["a", "z"],
      }]);
      expect(await storage.getOpenCodeModelCatalog("malformed")).toBeNull();
    });
  });

  test("does not assign the legacy host-global cache to a requesting project", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const legacy = {
        schemaVersion: 1,
        catalogVersion: "legacy",
        updatedAt: new Date().toISOString(),
        models,
      };
      const file = path.join(dataDir, "opencode-model-catalog.json");
      await fs.writeFile(file, JSON.stringify(legacy));

      expect(await storage.getOpenCodeModelCatalog(projectId)).toBeNull();
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(legacy);

      const scoped = await storage.cacheOpenCodeModelCatalog(projectId, models);
      expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
        schemaVersion: 2,
        catalogs: { [projectId]: scoped },
        legacyUnscoped: legacy,
      });
    });
  });

  test("serializes overlapping writes and preserves every project", async () => {
    await withTemporaryStorage(async (storage) => {
      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          storage.cacheOpenCodeModelCatalog(`project-${index}`, [{
            id: `provider/model-${index}`,
            name: `Model ${index}`,
            provider: "provider",
          }])
        ),
      );

      for (let index = 0; index < 12; index += 1) {
        expect(
          (await storage.getOpenCodeModelCatalog(`project-${index}`))?.models[0]?.id,
        ).toBe(`provider/model-${index}`);
      }
    });
  });

  test("recovers the mutation queue after a failed write", async () => {
    await withTemporaryStorage(async (storage) => {
      const internals = storage as unknown as {
        saveJson: (filePath: string, value: unknown) => Promise<void>;
      };
      const saveJson = internals.saveJson.bind(storage);
      let failNext = true;
      internals.saveJson = async (filePath, value) => {
        if (failNext) {
          failNext = false;
          throw new Error("injected cache write failure");
        }
        await saveJson(filePath, value);
      };

      await expect(
        storage.cacheOpenCodeModelCatalog("project-failed", models),
      ).rejects.toThrow("injected cache write failure");
      const recovered = await storage.cacheOpenCodeModelCatalog(
        "project-recovered",
        models,
      );
      expect(recovered.projectId).toBe("project-recovered");
      expect(await storage.getOpenCodeModelCatalog("project-failed")).toBeNull();
    });
  });

  test("serializes separate StorageService instances sharing a data directory", async () => {
    await withTemporaryStorage(async (first, dataDir) => {
      const second = new StorageService(dataDir);
      await second.init();
      await Promise.all([
        first.cacheOpenCodeModelCatalog("project-a", models),
        second.cacheOpenCodeModelCatalog("project-b", [{
          id: "provider/second",
          name: "Second",
          provider: "provider",
        }]),
      ]);

      expect(await first.getOpenCodeModelCatalog("project-a")).not.toBeNull();
      expect(await first.getOpenCodeModelCatalog("project-b")).not.toBeNull();
    });
  });
});
