import { describe, expect, expectTypeOf, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createEnvironment,
  defaultConfig,
  defaultRepositoryConfig,
  StorageService,
} from "./storage.js";
import type {
  AppConfig,
  ClaudeModelCatalogEntry,
  CodexModelCatalogEntry,
} from "./models.js";
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

  test("uses host GitHub CLI credentials by default", () => {
    expect(defaultConfig().global.useHostGitHubCredentials).toBe(true);
    expectTypeOf<AppConfig["global"]["useHostGitHubCredentials"]>()
      .toEqualTypeOf<boolean | undefined>();
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

describe("PR completion refresh intent", () => {
  test("rejects missing environments and ignores every ineligible PR state", async () => {
    await withTemporaryStorage(async (storage) => {
      await expect(storage.armPrRecheckAfterAgentCompletion("missing"))
        .rejects.toThrow("Environment not found: missing");

      for (const [index, metadata] of ([
        { prUrl: null, prState: null, hasMergeConflicts: null },
        { prUrl: "https://github.com/acme/repo/pull/1", prState: "closed", hasMergeConflicts: true },
        { prUrl: "https://github.com/acme/repo/pull/1", prState: "open", hasMergeConflicts: false },
        { prUrl: "https://github.com/acme/repo/pull/1", prState: "open", hasMergeConflicts: null },
      ] as const).entries()) {
        const environment = { ...createEnvironment("project-1"), id: `env-${index}`, ...metadata };
        await storage.addEnvironment(environment);
        expect((await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt)
          .toBeNull();
      }
    });
  });

  test("survives restart and token-safe rollback preserves a newer arm", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-arm",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
      };
      await storage.addEnvironment(environment);
      const first = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;

      const restarted = new StorageService(dataDir);
      await restarted.init();
      expect((await restarted.getEnvironment(environment.id))
        ?.prRecheckAfterAgentCompletionArmedAt).toBe(first);

      const second = (await restarted.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;
      expect(second).not.toBe(first);
      expect((await restarted.disarmPrRecheckAfterAgentCompletion(environment.id, first))
        .prRecheckAfterAgentCompletionArmedAt).toBe(second);
      expect((await restarted.disarmPrRecheckAfterAgentCompletion(environment.id, second))
        .prRecheckAfterAgentCompletionArmedAt).toBeUndefined();
      await expect(restarted.disarmPrRecheckAfterAgentCompletion("missing", second))
        .rejects.toThrow("Environment not found: missing");
    });
  });

  test("returns no token when a later arm is refused without exposing the existing token", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-refused-rearm",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
      };
      await storage.addEnvironment(environment);
      const first = await storage.armPrRecheckAfterAgentCompletion(environment.id);
      await storage.updateEnvironment(environment.id, { hasMergeConflicts: null });

      const refused = await storage.armPrRecheckAfterAgentCompletion(environment.id);

      expect(first.armedAt).toEqual(expect.any(String));
      expect(refused.armedAt).toBeNull();
      expect(refused.environment.prRecheckAfterAgentCompletionArmedAt).toBe(first.armedAt!);
    });
  });

  test("generates strictly increasing arm tokens in the same millisecond and after clock rollback", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-monotonic-arm",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
      };
      await storage.addEnvironment(environment);
      const now = spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      try {
        const first = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;
        const second = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;
        now.mockReturnValue(1_700_000_000_000);
        const third = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt!;

        expect(Date.parse(second)).toBe(Date.parse(first) + 1);
        expect(Date.parse(third)).toBe(Date.parse(second) + 1);
      } finally {
        now.mockRestore();
      }
    });
  });

  test("replaces an unparseable stored arm token", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-invalid-arm",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
        prRecheckAfterAgentCompletionArmedAt: "not-a-date",
      };
      await storage.addEnvironment(environment);

      const armedAt = (await storage.armPrRecheckAfterAgentCompletion(environment.id)).armedAt;

      expect(armedAt).toEqual(expect.any(String));
      expect(Number.isFinite(Date.parse(armedAt!))).toBe(true);
    });
  });

  test("serializes monitor state ahead of a concurrent stale arm", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = {
        ...createEnvironment("project-1"),
        id: "env-pr-race",
        prUrl: "https://github.com/acme/repo/pull/1",
        prState: "open" as const,
        hasMergeConflicts: true,
      };
      await storage.addEnvironment(environment);

      const stateUpdate = storage.updateEnvironment(environment.id, {
        hasMergeConflicts: false,
        prRecheckAfterAgentCompletionArmedAt: undefined,
      });
      const staleArm = storage.armPrRecheckAfterAgentCompletion(environment.id);
      await Promise.all([stateUpdate, staleArm]);

      expect(await storage.getEnvironment(environment.id)).toMatchObject({
        hasMergeConflicts: false,
      });
      expect((await storage.getEnvironment(environment.id))
        ?.prRecheckAfterAgentCompletionArmedAt).toBeUndefined();
    });
  });
});

describe("GitHub credential source config migration", () => {
  test.each([
    ["missing source without a PAT", undefined, undefined, true],
    ["missing source with an empty PAT", undefined, "   ", true],
    ["missing source with a legacy PAT", undefined, "legacy-pat", false],
    ["explicit host source with a legacy PAT", true, "legacy-pat", true],
    ["explicit PAT source without a PAT", false, undefined, false],
  ] as const)(
    "%s",
    async (_label, source, githubToken, expected) => {
      await withTemporaryStorage(async (storage, dataDir) => {
        const config = defaultConfig();
        if (source === undefined) {
          delete config.global.useHostGitHubCredentials;
        } else {
          config.global.useHostGitHubCredentials = source;
        }
        if (githubToken === undefined) {
          delete config.global.githubToken;
        } else {
          config.global.githubToken = githubToken;
        }
        await fs.writeFile(
          path.join(dataDir, "config.json"),
          `${JSON.stringify(config)}\n`,
          "utf8",
        );

        const loaded = await storage.loadConfig();
        expect(loaded.global.useHostGitHubCredentials).toBe(expected);
        expect(loaded.global.githubToken).toBe(githubToken);
      });
    },
  );
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

describe("hot store read caching", () => {
  test("serves repeated environment reads from the cache and re-validates by stat", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const environmentsPath = path.join(dataDir, "environments.json");

      const readSpy = spyOn(fs, "readFile");
      const environmentReads = () =>
        readSpy.mock.calls.filter(([file]) => String(file).endsWith("environments.json")).length;
      try {
        await storage.loadEnvironments();
        const readsAfterFirstLoad = environmentReads();

        // Steady state: no further reads of the file, only stats.
        await storage.loadEnvironments();
        await storage.getEnvironment(environment.id);
        await storage.getEnvironmentsByProject("project-1");
        expect(environmentReads()).toBe(readsAfterFirstLoad);

        // Mutating a returned value must not poison the cache: reads hand
        // out clones precisely because every mutation path edits in place.
        (await storage.loadEnvironments())[0]!.name = "mutated-by-caller";
        expect((await storage.getEnvironment(environment.id))!.name)
          .toBe(environment.name);

        // A save through this process invalidates the cached parse.
        await storage.updateEnvironment(environment.id, { name: "renamed" });
        expect((await storage.getEnvironment(environment.id))!.name).toBe("renamed");

        // A foreign in-place write (another backend process) is observed via
        // the stat fingerprint even though this process never wrote.
        const foreign = JSON.parse(
          await fs.readFile(environmentsPath, "utf8"),
        ) as Array<Record<string, unknown>>;
        foreign[0]!.name = "foreign-writer";
        await fs.writeFile(environmentsPath, JSON.stringify(foreign));
        expect((await storage.getEnvironment(environment.id))!.name)
          .toBe("foreign-writer");
      } finally {
        readSpy.mockRestore();
      }
    });
  });

  test("refreshes one recovery backup for volatile writes without rotating history", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const backupPath = path.join(dataDir, "environments.json.bak.1");

      await storage.setEnvironmentAgentActivity(
        environment.id,
        "working",
        new Date(Date.now() + 1_000).toISOString(),
        "frontend",
        "renderer-token",
      );
      await storage.recordEnvironmentActivity(
        environment.id,
        new Date(Date.now() + 2_000).toISOString(),
      );
      // Activity-only writes keep one current recovery point without shifting
      // five timestamp-only copies through the historical backup chain.
      await fs.access(backupPath);
      await expect(fs.access(path.join(dataDir, "environments.json.bak.2")))
        .rejects.toThrow();

      // A structural mutation still pays for the rotation.
      await storage.updateEnvironment(environment.id, { name: "renamed" });
      await fs.access(path.join(dataDir, "environments.json.bak.2"));
    });
  });

  test("recovers the latest structural state after later activity-only writes", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      await storage.updateEnvironment(environment.id, { name: "structurally-renamed" });
      const occurredAt = new Date(Date.now() + 1_000).toISOString();
      await storage.recordEnvironmentActivity(environment.id, occurredAt);

      await fs.writeFile(path.join(dataDir, "environments.json"), "{corrupt", "utf8");
      const recovered = await new StorageService(dataDir).getEnvironment(environment.id);
      expect(recovered).toMatchObject({
        id: environment.id,
        name: "structurally-renamed",
        lastActivityAt: occurredAt,
      });
    });
  });

  test("invalidates project and config caches after external writes", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await storage.addProject({
        id: "project-cache",
        name: "Before",
        gitUrl: "https://example.invalid/cache.git",
        localPath: null,
        addedAt: new Date(0).toISOString(),
        order: 0,
      });
      const config = defaultConfig();
      await storage.saveConfig(config);
      await storage.loadProjects();
      await storage.loadConfig();

      const projectsPath = path.join(dataDir, "projects.json");
      const projects = JSON.parse(await fs.readFile(projectsPath, "utf8")) as Array<{
        name: string;
      }>;
      projects[0]!.name = "After!";
      await fs.writeFile(projectsPath, `${JSON.stringify(projects)}\n`, "utf8");

      const configPath = path.join(dataDir, "config.json");
      const foreignConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as AppConfig;
      foreignConfig.global.webClientEnabled = false;
      await fs.writeFile(configPath, `${JSON.stringify(foreignConfig)}\n`, "utf8");

      expect((await storage.loadProjects())[0]!.name).toBe("After!");
      expect((await storage.loadConfig()).global.webClientEnabled).toBe(false);
    });
  });

  test("recovers from backup when the store cannot be stat'd", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      // The second write is what puts a full record into the rotated backup:
      // the first found no primary file to copy.
      await storage.updateEnvironment(environment.id, { name: "renamed" });

      const environmentsPath = path.join(dataDir, "environments.json");
      const realStat = fs.stat.bind(fs);
      const statSpy = spyOn(fs, "stat").mockImplementation((async (
        target: Parameters<typeof fs.stat>[0],
      ) => {
        if (String(target) === environmentsPath) {
          throw Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" });
        }
        return realStat(target);
      }) as typeof fs.stat);
      try {
        expect((await storage.loadEnvironments()).map((item) => item.id))
          .toEqual([environment.id]);
      } finally {
        statSpy.mockRestore();
      }
    });
  });

  test("surfaces an unreadable store instead of presenting it as empty", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const environmentsPath = path.join(dataDir, "environments.json");
      const stored = createEnvironment("project-1");
      // Written directly so no backup exists to recover from.
      await fs.writeFile(environmentsPath, `${JSON.stringify([stored])}\n`, "utf8");

      const realStat = fs.stat.bind(fs);
      const statSpy = spyOn(fs, "stat").mockImplementation((async (
        target: Parameters<typeof fs.stat>[0],
      ) => {
        if (String(target) === environmentsPath) {
          throw Object.assign(new Error("EIO: i/o error, stat"), { code: "EIO" });
        }
        return realStat(target);
      }) as typeof fs.stat);
      try {
        await expect(storage.loadEnvironments()).rejects.toThrow("EIO");
        // The empty view was never the real damage: the next mutation would
        // have appended to that empty list and written it back over the
        // user's intact data.
        await expect(storage.addEnvironment(createEnvironment("project-1")))
          .rejects.toThrow("EIO");
      } finally {
        statSpy.mockRestore();
      }

      expect((await storage.loadEnvironments()).map((item) => item.id)).toEqual([stored.id]);
    });
  });

  test("skips the lease sweep without the cross-process lock when no leases exist", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await storage.addEnvironment(createEnvironment("project-1"));
      const lockPath = path.join(dataDir, "environments.json.lock");
      // A fresh foreign lock blocks the mutation path for its full 20s
      // timeout; the sweep must not need it when nothing can expire.
      await fs.writeFile(lockPath, "held-by-another-process");
      try {
        await expect(storage.expireFrontendAgentActivityLeases()).resolves.toEqual([]);
      } finally {
        await fs.rm(lockPath, { force: true });
      }
    });
  });
});

describe("environment completion and unread state", () => {
  test("records a newer completion and ignores stale completion timestamps", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const previousActivityAt = environment.lastActivityAt!;
      const newer = new Date(
        new Date(previousActivityAt).getTime() + 1,
      ).toISOString();
      const completed = await storage.recordEnvironmentCompletion(environment.id, newer);
      expect(completed).toMatchObject({
        lastActivityAt: newer,
        hasUnreadWork: true,
      });

      await storage.setEnvironmentUnread(environment.id, false, newer);
      const stale = await storage.recordEnvironmentCompletion(
        environment.id,
        previousActivityAt,
      );
      expect(stale).toMatchObject({
        lastActivityAt: newer,
        hasUnreadWork: false,
      });
      await expect(storage.recordEnvironmentCompletion(environment.id, "invalid"))
        .rejects.toThrow("occurredAt must be a valid ISO timestamp");
    });
  });

  test("clears unread only when the expected activity token still matches", async () => {
    await withTemporaryStorage(async (storage) => {
      const environment = await storage.addEnvironment(createEnvironment("project-1"));
      const previousActivityAt = environment.lastActivityAt!;
      const activityAt = new Date(
        new Date(previousActivityAt).getTime() + 1,
      ).toISOString();
      await storage.recordEnvironmentCompletion(environment.id, activityAt);

      const staleClear = await storage.setEnvironmentUnread(
        environment.id,
        false,
        previousActivityAt,
      );
      expect(staleClear.hasUnreadWork).toBe(true);

      const cleared = await storage.setEnvironmentUnread(
        environment.id,
        false,
        activityAt,
      );
      expect(cleared.hasUnreadWork).toBe(false);
      expect((await storage.getEnvironment(environment.id))!.hasUnreadWork).toBe(false);
      await expect(
        storage.setEnvironmentUnread(environment.id, true, 123 as never),
      ).rejects.toThrow("expectedLastActivityAt must be a string or null");
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
        ...Array.from({ length: 24 }, () =>
          storage.getOpenCodeModelCatalog(projectId)
        ),
      ]);

      const second = await storage.getOpenCodeModelCatalog(projectId);
      expect(second?.models).toHaveLength(3);
      for (const read of reads) {
        expect(read).not.toBeNull();
        expect([first.catalogVersion, second?.catalogVersion]).toContain(
          read?.catalogVersion,
        );
        expect(read?.models).toEqual(
          read?.catalogVersion === first.catalogVersion
            ? first.models
            : second!.models,
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

describe("host agent model catalogue cache", () => {
  test("round-trips Claude and Codex catalogues across storage instances", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const claudeModels: ClaudeModelCatalogEntry[] = [{
        id: "claude-opus-latest",
        name: "Claude Opus Latest",
        description: "Most capable",
        supportsEffort: true,
        supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
      }];
      const codexModels: CodexModelCatalogEntry[] = [{
        id: "gpt-latest",
        name: "GPT Latest",
        description: "Latest coding model",
        reasoningEfforts: ["low", "medium", "high", "xhigh", "ultra"],
        defaultReasoningEffort: "medium",
      }];

      await storage.cacheAgentModelCatalog("claude", claudeModels);
      await storage.cacheAgentModelCatalog("codex", codexModels);

      const reopened = new StorageService(dataDir);
      await reopened.init();
      expect(await reopened.getAgentModelCatalogCache()).toMatchObject({
        schemaVersion: 1,
        claude: { models: claudeModels },
        codex: { models: codexModels },
      });
    });
  });

  test("does not rewrite an unchanged catalogue and ignores malformed persisted entries", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      const models = [{ id: "gpt-latest", name: "GPT Latest" }];
      const first = await storage.cacheAgentModelCatalog("codex", models);
      const second = await storage.cacheAgentModelCatalog("codex", models);
      expect(second.codex?.updatedAt).toBe(first.codex?.updatedAt);

      await fs.writeFile(
        path.join(dataDir, "agent-model-catalog.json"),
        JSON.stringify({
          schemaVersion: 1,
          claude: {
            updatedAt: "not-a-date",
            models: [{ id: "", name: "Broken" }],
          },
          codex: {
            updatedAt: new Date().toISOString(),
            models: [{ id: "gpt-broken", name: "Broken", reasoningEfforts: ["impossible"] }],
          },
        }),
      );
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
          reasoningOptions: [{
            effort: "medium",
            label: "  Balanced  ",
            description: "  Default choice  ",
          }],
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
          models: [{
            id: "claude-opus-latest",
            resolvedModel: "claude-opus-20260701",
            name: "Claude Opus Latest",
            description: "Most capable",
            supportsEffort: true,
            supportedEffortLevels: ["low", "high"],
          }],
        },
        codex: {
          models: [{
            id: "gpt-latest",
            name: "GPT Latest",
            description: "Coding model",
            reasoningEfforts: ["minimal", "medium", "ultra"],
            reasoningOptions: [{
              effort: "medium",
              label: "Balanced",
              description: "Default choice",
            }],
            defaultReasoningEffort: "medium",
          }],
        },
      });
    });
  });

  test("retains valid models while replacing an invalid persisted timestamp", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await fs.writeFile(
        path.join(dataDir, "agent-model-catalog.json"),
        JSON.stringify({
          schemaVersion: 1,
          codex: {
            updatedAt: "not-a-date",
            models: [{
              id: "gpt-valid",
              name: "GPT Valid",
              reasoningEfforts: ["medium"],
            }],
          },
        }),
      );

      expect(await storage.getAgentModelCatalogCache()).toEqual({
        schemaVersion: 1,
        codex: {
          updatedAt: new Date(0).toISOString(),
          models: [{
            id: "gpt-valid",
            name: "GPT Valid",
            reasoningEfforts: ["medium"],
          }],
        },
      });
    });
  });

  test("rejects catalogues without any valid model", async () => {
    await withTemporaryStorage(async (storage) => {
      await expect(
        storage.cacheAgentModelCatalog(
          "claude",
          [{ id: "", name: "Invalid" }],
        ),
      ).rejects.toThrow("at least one valid model");
      await expect(
        storage.cacheAgentModelCatalog(
          "codex",
          [{
            id: "gpt-invalid",
            name: "Invalid",
            defaultReasoningEffort: "impossible",
          }] as unknown as CodexModelCatalogEntry[],
        ),
      ).rejects.toThrow("at least one valid model");
    });
  });

  test("serializes separate storage instances without losing either agent", async () => {
    await withTemporaryStorage(async (first, dataDir) => {
      const second = new StorageService(dataDir);
      await second.init();
      await Promise.all([
        first.cacheAgentModelCatalog("claude", [{
          id: "claude-opus-latest",
          name: "Claude Opus Latest",
        }]),
        second.cacheAgentModelCatalog("codex", [{
          id: "gpt-latest",
          name: "GPT Latest",
        }]),
      ]);

      expect(await first.getAgentModelCatalogCache()).toMatchObject({
        claude: { models: [{ id: "claude-opus-latest" }] },
        codex: { models: [{ id: "gpt-latest" }] },
      });
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
          throw new Error("injected agent cache write failure");
        }
        await saveJson(filePath, value);
      };

      await expect(
        storage.cacheAgentModelCatalog("claude", [{
          id: "claude-failed",
          name: "Claude Failed",
        }]),
      ).rejects.toThrow("injected agent cache write failure");
      await expect(
        storage.cacheAgentModelCatalog("codex", [{
          id: "gpt-recovered",
          name: "GPT Recovered",
        }]),
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
      await storage.cacheAgentModelCatalog("codex", [{
        id: "gpt-first",
        name: "GPT First",
      }]);

      const [, ...reads] = await Promise.all([
        storage.cacheAgentModelCatalog("codex", [{
          id: "gpt-second",
          name: "GPT Second",
        }]),
        ...Array.from({ length: 24 }, () =>
          storage.getAgentModelCatalogCache()
        ),
      ]);
      const final = await storage.getAgentModelCatalogCache();
      expect(final.codex?.models).toEqual([{
        id: "gpt-second",
        name: "GPT Second",
      }]);
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
