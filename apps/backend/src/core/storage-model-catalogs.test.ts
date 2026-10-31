import { describe, expect, test } from "bun:test";
import { StorageService } from "./storage.js";
import type { ClaudeModelCatalogEntry, CodexModelCatalogEntry } from "./models.js";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import {
  readStoredValue,
  seedStore,
  storageInternals,
  withTemporaryStorage,
} from "./storage-test-support.js";

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

  test("persists a normalized catalogue in the backend store", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const snapshot = await storage.cacheOpenCodeModelCatalog(projectId, models);

      expect(snapshot.schemaVersion).toBe(2);
      expect(snapshot.projectId).toBe(projectId);
      expect(snapshot.models.map((model) => model.id)).toEqual([
        "anthropic/claude-sonnet",
        "openrouter/openai/gpt-5",
      ]);
      expect(await storage.getOpenCodeModelCatalog(projectId)).toEqual(snapshot);
      expect(readStoredValue(dataDir, "opencode-model-catalog.json")).toEqual({
        schemaVersion: 2,
        catalogs: { [projectId]: snapshot },
      });
    });
  });

  test("keeps cache versions stable per project until its discovered models change", async () => {
    await withTemporaryStorage(async (storage) => {
      const initial = await storage.cacheOpenCodeModelCatalog(projectId, models);
      const unchanged = await storage.cacheOpenCodeModelCatalog(projectId, [...models].reverse());
      expect(unchanged).toEqual(initial);

      const updated = await storage.cacheOpenCodeModelCatalog(projectId, [
        ...models,
        {
          id: "openrouter/google/gemini",
          name: "Gemini",
          provider: "openrouter",
        },
      ]);
      expect(updated.catalogVersion).not.toBe(initial.catalogVersion);
      expect(updated.models).toHaveLength(3);
    });
  });

  test("persists the connected providers beside the catalogue", async () => {
    await withTemporaryStorage(async (storage) => {
      const initial = await storage.cacheOpenCodeModelCatalog(projectId, models, [
        "openrouter",
        "openrouter",
        " anthropic ",
      ]);
      expect(initial.connectedProviderIds).toEqual(["anthropic", "openrouter"]);
      expect(Date.parse(initial.connectedProvidersCheckedAt ?? "")).not.toBeNaN();
      expect(await storage.getOpenCodeModelCatalog(projectId)).toEqual(initial);

      // The same models with new connectivity still rewrites the snapshot, but
      // keeps the catalogue identity.
      const reconnected = await storage.cacheOpenCodeModelCatalog(projectId, models, [
        "openrouter",
      ]);
      expect(reconnected.connectedProviderIds).toEqual(["openrouter"]);
      expect(reconnected.catalogVersion).toBe(initial.catalogVersion);
      expect(reconnected.updatedAt).toBe(initial.updatedAt);

      // A source without a connectivity report cannot erase the last one.
      const widened = await storage.cacheOpenCodeModelCatalog(projectId, [
        ...models,
        { id: "openrouter/google/gemini", name: "Gemini", provider: "openrouter" },
      ]);
      expect(widened.models).toHaveLength(3);
      expect(widened.connectedProviderIds).toEqual(["openrouter"]);
      expect(widened.connectedProvidersCheckedAt).toBe(reconnected.connectedProvidersCheckedAt);
    });
  });

  test("isolates project catalogues in one scoped store", async () => {
    await withTemporaryStorage(async (storage) => {
      const first = await storage.cacheOpenCodeModelCatalog("project-a", models);
      const second = await storage.cacheOpenCodeModelCatalog("project-b", [
        {
          id: "local/model",
          name: "Local",
          provider: "local",
        },
      ]);

      expect(await storage.getOpenCodeModelCatalog("project-a")).toEqual(first);
      expect(await storage.getOpenCodeModelCatalog("project-b")).toEqual(second);
      expect(await storage.getOpenCodeModelCatalog("project-c")).toBeNull();

      const prototypeNamed = await storage.cacheOpenCodeModelCatalog("constructor", models);
      expect(await storage.getOpenCodeModelCatalog("constructor")).toEqual(prototypeNamed);
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
      await expect(storage.cacheOpenCodeModelCatalog("", models)).rejects.toThrow(
        "projectId must be a non-blank string",
      );
      await expect(storage.cacheOpenCodeModelCatalog(projectId, [])).rejects.toThrow(
        "must contain at least one model",
      );
      await expect(
        storage.cacheOpenCodeModelCatalog(projectId, [{ id: "", name: "", provider: "" }]),
      ).rejects.toThrow("must contain at least one model");
    });
  });

  test("repairs stored dates, versions, and normalized model data while reading", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      seedStore(dataDir, "opencode-model-catalog.json", {
        schemaVersion: 2,
        catalogs: {
          " project-a ": {
            schemaVersion: 999,
            projectId: "wrong-project",
            catalogVersion: "not-the-content-digest",
            updatedAt: "not-a-date",
            models: [
              {
                id: " provider/model ",
                name: " Model ",
                provider: " provider ",
                variants: ["z", "a", "z"],
              },
            ],
          },
          malformed: { models: [{ id: "missing-fields" }] },
        },
      });

      const snapshot = await storage.getOpenCodeModelCatalog(projectId);
      expect(snapshot).not.toBeNull();
      expect(snapshot?.schemaVersion).toBe(2);
      expect(snapshot?.projectId).toBe(projectId);
      expect(snapshot?.updatedAt).toBe(new Date(0).toISOString());
      expect(snapshot?.catalogVersion).toHaveLength(64);
      expect(snapshot?.catalogVersion).not.toBe("not-the-content-digest");
      expect(snapshot?.models).toEqual([
        {
          id: "provider/model",
          name: "Model",
          provider: "provider",
          variants: ["a", "z"],
        },
      ]);
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
      const file = "opencode-model-catalog.json";
      seedStore(dataDir, file, legacy);

      expect(await storage.getOpenCodeModelCatalog(projectId)).toBeNull();
      expect(readStoredValue(dataDir, file)).toEqual(legacy);

      const scoped = await storage.cacheOpenCodeModelCatalog(projectId, models);
      expect(readStoredValue(dataDir, file)).toEqual({
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
          storage.cacheOpenCodeModelCatalog(`project-${index}`, [
            {
              id: `provider/model-${index}`,
              name: `Model ${index}`,
              provider: "provider",
            },
          ]),
        ),
      );

      for (let index = 0; index < 12; index += 1) {
        expect((await storage.getOpenCodeModelCatalog(`project-${index}`))?.models[0]?.id).toBe(
          `provider/model-${index}`,
        );
      }
    });
  });

  test("recovers the mutation queue after a failed write", async () => {
    await withTemporaryStorage(async (storage) => {
      const internals = storageInternals(storage).context;
      const saveJson = internals.saveJson.bind(internals);
      let failNext = true;
      internals.saveJson = async (filePath, value) => {
        if (failNext) {
          failNext = false;
          throw new Error("injected cache write failure");
        }
        await saveJson(filePath, value);
      };

      await expect(storage.cacheOpenCodeModelCatalog("project-failed", models)).rejects.toThrow(
        "injected cache write failure",
      );
      const recovered = await storage.cacheOpenCodeModelCatalog("project-recovered", models);
      expect(recovered.projectId).toBe("project-recovered");
      expect(await storage.getOpenCodeModelCatalog("project-failed")).toBeNull();
    });
  });

  test("a read concurrent with a write sees one coherent snapshot", async () => {
    await withTemporaryStorage(async (storage) => {
      const first = await storage.cacheOpenCodeModelCatalog(projectId, models);

      // Reads deliberately skip the mutation lock, so they rely on the write
      // being atomic. A torn read would surface as a null or a partial model
      // list rather than one of the two whole snapshots.
      const [, ...reads] = await Promise.all([
        storage.cacheOpenCodeModelCatalog(projectId, [
          ...models,
          { id: "provider/added", name: "Added", provider: "provider" },
        ]),
        ...Array.from({ length: 24 }, () => storage.getOpenCodeModelCatalog(projectId)),
      ]);

      const second = await storage.getOpenCodeModelCatalog(projectId);
      expect(second?.models).toHaveLength(3);
      for (const read of reads) {
        expect(read).not.toBeNull();
        expect([first.catalogVersion, second?.catalogVersion]).toContain(read?.catalogVersion);
        expect(read?.models).toEqual(
          read?.catalogVersion === first.catalogVersion ? first.models : second!.models,
        );
      }
    });
  });

  test("serializes separate StorageService instances sharing a data directory", async () => {
    await withTemporaryStorage(async (first, dataDir) => {
      const second = new StorageService(dataDir);
      await second.init();
      await Promise.all([
        first.cacheOpenCodeModelCatalog("project-a", models),
        second.cacheOpenCodeModelCatalog("project-b", [
          {
            id: "provider/second",
            name: "Second",
            provider: "provider",
          },
        ]),
      ]);

      expect(await first.getOpenCodeModelCatalog("project-a")).not.toBeNull();
      expect(await first.getOpenCodeModelCatalog("project-b")).not.toBeNull();
    });
  });
});

describe("host agent model catalogue cache", () => {
  test("round-trips host agent catalogues across storage instances", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const claudeModels: ClaudeModelCatalogEntry[] = [
        {
          id: "claude-opus-latest",
          name: "Claude Opus Latest",
          description: "Most capable",
          supportsEffort: true,
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
        },
      ];
      const codexModels: CodexModelCatalogEntry[] = [
        {
          id: "gpt-latest",
          name: "GPT Latest",
          description: "Latest coding model",
          reasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"],
          defaultReasoningEffort: "medium",
        },
      ];
      const cursorModels: AgentModel[] = [
        {
          platform: "cursor",
          id: "composer-latest",
          label: "Composer Latest",
          providerLabel: "Cursor",
          reasoning: [{ id: "high", label: "High", annotation: "Slower" }],
          defaultReasoningId: "high",
          supportsSpeed: true,
          supportsMode: true,
        },
      ];
      const grokModels: AgentModel[] = [
        {
          platform: "grok",
          id: "grok-code-latest",
          label: "Grok Code Latest",
          providerLabel: "Grok",
          supportsMode: true,
        },
      ];
      const piModels: AgentModel[] = [
        {
          platform: "pi",
          id: "openai-codex/gpt-latest",
          label: "GPT Latest",
          providerLabel: "OpenAI Codex",
          supportsSpeed: false,
          supportsMode: false,
          contextWindow: 400_000,
          supportsImageInput: false,
          // Where a Pi tab with no model starts; launch defaults read it (0172).
          sessionDefault: true,
        },
      ];

      await storage.cacheAgentModelCatalog("claude", claudeModels);
      await storage.cacheAgentModelCatalog("codex", codexModels);
      await storage.cacheAgentModelCatalog("cursor", cursorModels);
      await storage.cacheAgentModelCatalog("grok", grokModels);
      await storage.cacheAgentModelCatalog("pi", piModels);

      const reopened = new StorageService(dataDir);
      await reopened.init();
      expect(await reopened.getAgentModelCatalogCache()).toMatchObject({
        schemaVersion: 1,
        claude: { models: claudeModels },
        codex: { models: codexModels },
        cursor: { models: cursorModels },
        grok: { models: grokModels },
        pi: { models: piModels },
      });
    });
  });

  test("does not rewrite an unchanged catalogue and ignores malformed persisted entries", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const models = [{ id: "gpt-latest", name: "GPT Latest" }];
      const first = await storage.cacheAgentModelCatalog("codex", models);
      const second = await storage.cacheAgentModelCatalog("codex", models);
      expect(second.codex?.updatedAt).toBe(first.codex?.updatedAt);

      seedStore(dataDir, "agent-model-catalog.json", {
        schemaVersion: 1,
        claude: {
          updatedAt: "not-a-date",
          models: [{ id: "", name: "Broken" }],
        },
        codex: {
          updatedAt: new Date().toISOString(),
          models: [{ id: "gpt-broken", name: "Broken", reasoningEfforts: ["impossible"] }],
        },
        cursor: {
          updatedAt: new Date().toISOString(),
          models: [{ platform: "grok", id: "wrong-provider", label: "Wrong" }],
        },
        grok: {
          updatedAt: new Date().toISOString(),
          models: [{ platform: "grok", id: "broken", label: 42 }],
        },
      });
      expect(await storage.getAgentModelCatalogCache()).toEqual({
        schemaVersion: 1,
      });
    });
  });

  test("normalizes whitespace and drops duplicate or malformed model entries", async () => {
    await withTemporaryStorage(async (storage) => {
      await storage.cacheAgentModelCatalog("claude", [
        {
          id: "  claude-opus-latest  ",
          resolvedModel: "  claude-opus-20260701  ",
          name: "  Claude Opus Latest  ",
          description: "  Most capable  ",
          supportsEffort: true,
          supportedEffortLevels: ["low", "high"],
        },
        { id: "claude-opus-latest", name: "Duplicate" },
        { id: "claude-invalid-boolean", name: "Invalid", supportsEffort: "yes" },
        {
          id: "claude-invalid-effort",
          name: "Invalid",
          supportedEffortLevels: ["impossible"],
        },
        {
          id: "claude-invalid-description",
          name: "Invalid",
          description: 42,
        },
        {
          id: "claude-invalid-resolved-model",
          name: "Invalid",
          resolvedModel: false,
        },
      ] as unknown as ClaudeModelCatalogEntry[]);
      await storage.cacheAgentModelCatalog("codex", [
        {
          id: "  gpt-latest  ",
          name: "  GPT Latest  ",
          description: "  Coding model  ",
          reasoningEfforts: ["minimal", "medium", "ultra"],
          reasoningOptions: [
            {
              effort: "medium",
              label: "  Balanced  ",
              description: "  Default choice  ",
            },
          ],
          defaultReasoningEffort: "medium",
        },
        { id: "gpt-latest", name: "Duplicate" },
        {
          id: "gpt-invalid-effort",
          name: "Invalid",
          reasoningEfforts: ["impossible"],
        },
        {
          id: "gpt-invalid-option",
          name: "Invalid",
          reasoningOptions: [{ effort: "medium", label: "   " }],
        },
        {
          id: "gpt-invalid-description",
          name: "Invalid",
          description: 42,
        },
      ] as unknown as CodexModelCatalogEntry[]);

      expect(await storage.getAgentModelCatalogCache()).toMatchObject({
        claude: {
          models: [
            {
              id: "claude-opus-latest",
              resolvedModel: "claude-opus-20260701",
              name: "Claude Opus Latest",
              description: "Most capable",
              supportsEffort: true,
              supportedEffortLevels: ["low", "high"],
            },
          ],
        },
        codex: {
          models: [
            {
              id: "gpt-latest",
              name: "GPT Latest",
              description: "Coding model",
              reasoningEfforts: ["minimal", "medium", "ultra"],
              reasoningOptions: [
                {
                  effort: "medium",
                  label: "Balanced",
                  description: "Default choice",
                },
              ],
              defaultReasoningEffort: "medium",
            },
          ],
        },
      });
    });
  });

  test("retains valid models while replacing an invalid persisted timestamp", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      seedStore(dataDir, "agent-model-catalog.json", {
        schemaVersion: 1,
        codex: {
          updatedAt: "not-a-date",
          models: [
            {
              id: "gpt-valid",
              name: "GPT Valid",
              reasoningEfforts: ["medium"],
            },
          ],
        },
      });

      expect(await storage.getAgentModelCatalogCache()).toEqual({
        schemaVersion: 1,
        codex: {
          updatedAt: new Date(0).toISOString(),
          models: [
            {
              id: "gpt-valid",
              name: "GPT Valid",
              reasoningEfforts: ["medium"],
            },
          ],
        },
      });
    });
  });

  test("rejects catalogues without any valid model", async () => {
    await withTemporaryStorage(async (storage) => {
      await expect(
        storage.cacheAgentModelCatalog("claude", [{ id: "", name: "Invalid" }]),
      ).rejects.toThrow("at least one valid model");
      await expect(
        storage.cacheAgentModelCatalog("codex", [
          {
            id: "gpt-invalid",
            name: "Invalid",
            defaultReasoningEffort: "impossible",
          },
        ] as unknown as CodexModelCatalogEntry[]),
      ).rejects.toThrow("at least one valid model");
      await expect(
        storage.cacheAgentModelCatalog("cursor", [
          {
            platform: "grok",
            id: "wrong-provider",
            label: "Wrong provider",
          },
        ] as AgentModel[]),
      ).rejects.toThrow("at least one valid model");
    });
  });

  test("serializes separate storage instances without losing either agent", async () => {
    await withTemporaryStorage(async (first, dataDir) => {
      const second = new StorageService(dataDir);
      await second.init();
      await Promise.all([
        first.cacheAgentModelCatalog("claude", [
          {
            id: "claude-opus-latest",
            name: "Claude Opus Latest",
          },
        ]),
        second.cacheAgentModelCatalog("codex", [
          {
            id: "gpt-latest",
            name: "GPT Latest",
          },
        ]),
      ]);

      expect(await first.getAgentModelCatalogCache()).toMatchObject({
        claude: { models: [{ id: "claude-opus-latest" }] },
        codex: { models: [{ id: "gpt-latest" }] },
      });
    });
  });

  test("recovers the mutation queue after a failed write", async () => {
    await withTemporaryStorage(async (storage) => {
      const internals = storageInternals(storage).context;
      const saveJson = internals.saveJson.bind(internals);
      let failNext = true;
      internals.saveJson = async (filePath, value) => {
        if (failNext) {
          failNext = false;
          throw new Error("injected agent cache write failure");
        }
        await saveJson(filePath, value);
      };

      await expect(
        storage.cacheAgentModelCatalog("claude", [
          {
            id: "claude-failed",
            name: "Claude Failed",
          },
        ]),
      ).rejects.toThrow("injected agent cache write failure");
      await expect(
        storage.cacheAgentModelCatalog("codex", [
          {
            id: "gpt-recovered",
            name: "GPT Recovered",
          },
        ]),
      ).resolves.toMatchObject({
        codex: { models: [{ id: "gpt-recovered" }] },
      });
      expect(await storage.getAgentModelCatalogCache()).toEqual({
        schemaVersion: 1,
        codex: expect.objectContaining({
          models: [{ id: "gpt-recovered", name: "GPT Recovered" }],
        }),
      });
    });
  });

  test("a read concurrent with a write sees one coherent snapshot", async () => {
    await withTemporaryStorage(async (storage) => {
      await storage.cacheAgentModelCatalog("codex", [
        {
          id: "gpt-first",
          name: "GPT First",
        },
      ]);

      const [, ...reads] = await Promise.all([
        storage.cacheAgentModelCatalog("codex", [
          {
            id: "gpt-second",
            name: "GPT Second",
          },
        ]),
        ...Array.from({ length: 24 }, () => storage.getAgentModelCatalogCache()),
      ]);
      const final = await storage.getAgentModelCatalogCache();
      expect(final.codex?.models).toEqual([
        {
          id: "gpt-second",
          name: "GPT Second",
        },
      ]);
      const coherentSnapshots: CodexModelCatalogEntry[][] = [
        [{ id: "gpt-first", name: "GPT First" }],
        [{ id: "gpt-second", name: "GPT Second" }],
      ];
      for (const read of reads) {
        if (!read.codex) throw new Error("Codex catalogue disappeared during write");
        expect(coherentSnapshots).toContainEqual(read.codex.models);
      }
    });
  });
});
