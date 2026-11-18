import { registrarFrom } from "./commands-registry-contracts.js";
import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createCommandRegistry } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { registerProjectCommands, withDefaultBranches } from "./commands-registry-projects.js";
import { HostCatalogSeeds } from "./host-catalog-seeds.js";
import type { Project } from "./models.js";

import { captureLogs } from "@orkestrator/protocol/testing/log-capture";
import { agentAccountLoginKey } from "./agent-accounts-store.js";
import { BackendRuntime } from "./backend-runtime.js";
import * as agentBridges from "./commands-servers.js";
import { persistHostCatalog } from "./host-model-catalog-seed.js";
import type { HostCatalog } from "./host-model-catalog-refresh.js";
import { seedStore, withTemporaryStorage } from "./storage-test-support.js";

afterEach(() => mock.restore());

const projects: Project[] = [
  {
    id: "p1",
    name: "telegram-scraper",
    gitUrl: "git@github.com:acme/telegram-scraper.git",
    localPath: "/code/telegram-scraper",
    addedAt: "2026-01-01T00:00:00.000Z",
    order: 0,
  },
  {
    id: "p2",
    name: "docs",
    gitUrl: "https://github.com/acme/docs.git",
    localPath: null,
    addedAt: "2026-01-01T00:00:00.000Z",
    order: 1,
  },
] as Project[];

const repositories = {
  p1: { defaultBranch: " develop " },
  p2: { defaultBranch: "" },
} as never;

describe("get_projects includeDefaultBranch", () => {
  const registry = createCommandRegistry();
  const context = {
    storage: {
      loadProjects: async () => projects,
      loadConfig: async () => ({ repositories }),
    },
  } as unknown as CommandContext;
  const invoke = (args: Record<string, unknown>) => {
    const handler = registry.get("get_projects");
    if (!handler) throw new Error("get_projects is not registered");
    return Promise.resolve().then(() => handler(args, context));
  };

  test("adds each configured default branch and leaves the rest unchanged", async () => {
    const result = (await invoke({ includeDefaultBranch: true })) as Array<
      Project & { defaultBranch?: string }
    >;
    expect(result.map((project) => project.defaultBranch)).toEqual(["develop", undefined]);
    expect(result[1]).toBe(projects[1]!);
  });

  test("the plain read is unchanged", async () => {
    expect(await invoke({})).toEqual(projects);
    expect(await invoke({ includeDefaultBranch: false })).toEqual(projects);
  });

  test("rejects a non-boolean flag and a conditional read with the flag", async () => {
    await expect(invoke({ includeDefaultBranch: "yes" })).rejects.toThrow("includeDefaultBranch");
    await expect(
      invoke({
        includeDefaultBranch: true,
        knownManifestGeneration: "g",
        knownResourceRevision: 1,
      }),
    ).rejects.toThrow("conditional");
  });

  test("returns projects without enrichment if config cannot be read", async () => {
    const handler = registry.get("get_projects")!;
    const failingContext = {
      storage: {
        loadProjects: async () => projects,
        loadConfig: async () => {
          throw new Error("config unavailable");
        },
      },
    } as unknown as CommandContext;
    expect(await handler({ includeDefaultBranch: true }, failingContext)).toBe(projects);
  });

  test("does not hide a project read failure behind optional config enrichment", async () => {
    const handler = registry.get("get_projects")!;
    const failingContext = {
      storage: {
        loadProjects: async () => {
          throw new Error("projects unavailable");
        },
      },
    } as unknown as CommandContext;
    await expect(handler({ includeDefaultBranch: true }, failingContext)).rejects.toThrow(
      "projects unavailable",
    );
  });

  test("withDefaultBranches tolerates a config without repositories", () => {
    expect(withDefaultBranches(projects, {} as never)).toEqual(projects);
  });
});

describe("projectless bug report catalogue", () => {
  test("seeds host OpenCode models and offers only the report providers", async () => {
    const { HOST_OPENCODE_CATALOG_SCOPE } = await import("./host-model-catalog-seed.js");
    let openCode: unknown = null;
    const refresh = mock(async () => ({
      agent: "opencode",
      models: [{ platform: "opencode", id: "anthropic/claude-sonnet", label: "Sonnet" }],
    }));
    const cache = {
      claude: { models: [{ id: "sonnet", name: "Sonnet", resolvedModel: "sonnet" }] },
      codex: { models: [{ id: "gpt-5", name: "GPT-5" }] },
      cursor: { models: [{ platform: "cursor", id: "cursor", label: "Cursor" }] },
    };
    const scopes: string[] = [];
    const context = {
      runtime: { localServers: { catalogSeeds: new HostCatalogSeeds() } },
      storage: {
        getEnvironment: async () => null,
        bugReports: { getBugReport: async () => ({ id: "r1" }) },
        getAgentModelCatalogCache: async () => cache,
        loadConfig: async () => ({
          global: {
            enabledAgentPlatforms: ["claude", "codex", "opencode", "cursor"],
            openCodeModelProviders: ["anthropic"],
          },
        }),
        getOpenCodeModelCatalog: async (scope: string) => {
          scopes.push(scope);
          return openCode;
        },
        cacheOpenCodeModelCatalog: async (scope: string, models: unknown[]) => {
          scopes.push(scope);
          openCode = { models };
        },
      },
    } as unknown as CommandContext;
    const commands = new Map();
    registerProjectCommands(
      registrarFrom((name, handler) => commands.set(name, handler)),
      {
        commands,
        refreshHostModelCatalog: refresh,
      } as never,
    );
    const result = await commands.get("get_native_agent_model_catalog")(
      { environmentId: "bug-report:r1", ensureAgent: "opencode" },
      context,
    );
    expect(result.status).toBe("ready");
    expect(result.models.map((model: { platform: string }) => model.platform)).toEqual([
      "claude",
      "codex",
      "opencode",
    ]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(scopes.every((scope) => scope === HOST_OPENCODE_CATALOG_SCOPE)).toBe(true);
    const again = await commands.get("get_native_agent_model_catalog")(
      { environmentId: "bug-report:r1", ensureAgent: "opencode" },
      context,
    );
    expect(again).toEqual(result);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

test("summary reads bound icons before serialization without changing ordinary reads or storage", async () => {
  const { MAX_SUMMARY_ICON_BYTES } = await import("./nodes/project-summary-icons.js");
  const icon = `data:image/png;base64,${"A".repeat(40 * 1024)}`;
  const stored = Array.from({ length: 20 }, (_, i) => ({
    ...projects[0]!,
    id: `p${i}`,
    order: i,
    icon,
  }));
  const handler = createCommandRegistry().get("get_projects")!;
  const context = {
    storage: { loadProjects: async () => stored, loadConfig: async () => ({ repositories: {} }) },
  } as unknown as CommandContext;
  for (const includeDefaultBranch of [false, true]) {
    const response = (await handler(
      { summaryIcons: true, includeDefaultBranch },
      context,
    )) as Project[];
    expect(response).toHaveLength(20);
    expect(
      response.reduce((bytes, project) => bytes + (project.icon?.length ?? 0), 0),
    ).toBeLessThanOrEqual(MAX_SUMMARY_ICON_BYTES);
    expect(response[0]!.icon).toBe(icon);
    expect(response.at(-1)!.icon).toBeUndefined();
  }
  expect(await handler({}, context)).toEqual(stored);
  expect(stored.every((project) => project.icon === icon)).toBe(true);
  // The registry decodes the arguments before the handler runs, so the refusal is synchronous.
  await expect(
    Promise.resolve().then(() => handler({ summaryIcons: "yes" }, context)),
  ).rejects.toThrow("summaryIcons");
});

describe("host catalogue reads refresh a stale Codex list", () => {
  function registryWith(codexUpdatedAt: string) {
    const cache: Record<string, unknown> = {
      schemaVersion: 1,
      codex: { updatedAt: codexUpdatedAt, models: [{ id: "gpt-6.1-sol", name: "GPT-6.1-Sol" }] },
    };
    const downloaded = Promise.withResolvers<void>();
    const refresh = mock(async (_context: unknown, agent: string) => {
      downloaded.resolve();
      return {
        agent,
        accountLoginKey: agentAccountLoginKey(),
        models: [{ id: "gpt-6.2-sol", name: "GPT-6.2-Sol" }],
      };
    });
    const context = {
      runtime: {
        localServers: { catalogSeeds: new HostCatalogSeeds() },
        accounts: { withMutation: (run: () => Promise<unknown>) => run() },
      },
      storage: {
        agentAccounts: { loadAgentAccounts: async () => ({ active: {} }) },
        getAgentModelCatalogCache: async () => cache,
        cacheAgentModelCatalog: async (agent: string, models: unknown[]) => {
          cache[agent] = { updatedAt: new Date().toISOString(), models };
          return cache;
        },
        loadConfig: async () => ({ global: { enabledAgentPlatforms: ["codex"] } }),
      },
    } as unknown as CommandContext;
    const commands = new Map();
    registerProjectCommands(
      registrarFrom((name, handler) => commands.set(name, handler)),
      { commands, refreshHostModelCatalog: refresh } as never,
    );
    const read = (args: Record<string, unknown>) =>
      commands.get("get_agent_model_catalog_cache")(args, context);
    return { cache, refresh, downloaded: downloaded.promise, read };
  }

  const twoDaysAgo = () => new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  test("a launcher's read answers from the cache and refreshes behind it", async () => {
    const { cache, refresh, downloaded, read } = registryWith(twoDaysAgo());
    const answered = await read({});
    expect(answered.codex.models.map((model: { id: string }) => model.id)).toEqual(["gpt-6.1-sol"]);
    await downloaded;
    await Bun.sleep(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((cache.codex as { models: Array<{ id: string }> }).models[0]!.id).toBe("gpt-6.2-sol");
  });

  test("startup's seeding read waits for the refresh", async () => {
    const { refresh, read } = registryWith(twoDaysAgo());
    const answered = await read({ seed: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(answered.codex.models.map((model: { id: string }) => model.id)).toEqual(["gpt-6.2-sol"]);
  });

  test("the pre-render read and a fresh list start nothing", async () => {
    const stale = registryWith(twoDaysAgo());
    await stale.read({ seed: false });
    const fresh = registryWith(new Date().toISOString());
    await fresh.read({});
    await Bun.sleep(0);
    expect(stale.refresh).not.toHaveBeenCalled();
    expect(fresh.refresh).not.toHaveBeenCalled();
  });
});

describe("native model catalogue with a running Codex bridge", () => {
  const oldModel = { id: "gpt-saved", name: "Saved Codex" };
  const liveModel = { id: "gpt-live", name: "Live Codex" };
  const claudeModel = { id: "sonnet", name: "Sonnet" };
  const secondAccount = "9ed918b6-2ebc-4908-994c-6db338e099b8";

  async function withRegistry(
    run: (harness: {
      context: CommandContext;
      setLogin: (accountId: string | undefined, loginGeneration?: string) => Promise<void>;
      readNative: (ensureAgent?: "codex") => Promise<unknown>;
      refresh: ReturnType<typeof mock<() => Promise<HostCatalog>>>;
      useLocalBridge: (response?: () => Promise<Response>) => void;
    }) => Promise<void>,
    options: { container?: boolean; stale?: boolean } = {},
  ) {
    await withTemporaryStorage(async (storage, dataDir) => {
      const runtime = new BackendRuntime({ emit: () => undefined });
      try {
        await storage.addEnvironment({
          id: "e1",
          name: "Environment",
          projectId: "project",
          branch: "main",
          status: "running",
          createdAt: new Date(0).toISOString(),
          environmentType: options.container ? "containerized" : "local",
          containerId: options.container ? "container-1" : null,
          prUrl: null,
          prState: null,
          hasMergeConflicts: null,
          networkAccessMode: "restricted",
          order: 0,
        });
        const config = await storage.loadConfig();
        await storage.updateGlobalConfig({ ...config.global, enabledAgentPlatforms: ["codex"] });
        if (options.stale) {
          seedStore(dataDir, "agent-model-catalog.json", {
            schemaVersion: 1,
            codex: { updatedAt: new Date(0).toISOString(), models: [oldModel] },
          });
        }
        await storage.cacheAgentModelCatalog("claude", [claudeModel]);
        const context = { runtime, storage } as CommandContext;
        const refresh = mock(async (): Promise<HostCatalog> => ({
          agent: "codex",
          models: [liveModel],
          accountLoginKey: agentAccountLoginKey(),
        }));
        const registry = createCommandRegistry({ modelCatalogRefresh: refresh });
        const readNative = async (ensureAgent?: "codex") =>
          registry.get("get_native_agent_model_catalog")!(
            { environmentId: "e1", ...(ensureAgent ? { ensureAgent } : {}) },
            context,
          );
        const setLogin = (accountId: string | undefined, loginGeneration?: string) =>
          storage.agentAccounts.mutateAgentAccounts((store) => ({
            store: {
              ...store,
              accounts: [
                {
                  id: secondAccount,
                  platform: "codex",
                  label: "Second",
                  createdAt: new Date(0).toISOString(),
                },
              ],
              active: { codex: accountId },
              loginGeneration: { codex: loginGeneration },
            },
            result: undefined,
          }));
        const useLocalBridge = (
          response = async () =>
            Response.json({
              source: "app-server",
              models: [
                {
                  ...liveModel,
                  description: "",
                  reasoningOptions: [{ effort: "high", label: "High", description: "  " }],
                },
              ],
            }),
        ) => {
          const child = {} as NonNullable<ReturnType<typeof runtime.localServers.process>>;
          spyOn(runtime.localServers, "process").mockImplementation((key) =>
            key === "codex:e1" ? child : undefined,
          );
          spyOn(runtime.localServers, "launchedAccountLoginKey").mockReturnValue(
            agentAccountLoginKey(),
          );
          spyOn(agentBridges, "peekLocalAgentBridge").mockImplementation(
            async (_id, _context, kind) =>
              kind === "codex" ? { port: 43210, authToken: "fixture-token" } : null,
          );
          spyOn(globalThis, "fetch").mockImplementation(
            Object.assign(response, { preconnect: globalThis.fetch.preconnect }),
          );
        };
        await run({ context, setLogin, readNative, refresh, useLocalBridge });
      } finally {
        runtime.shutdown();
      }
    });
  }

  test("uses live rows on first use and saves them with blank descriptions omitted", async () => {
    await withRegistry(async ({ context, readNative, refresh, useLocalBridge }) => {
      useLocalBridge();
      refresh.mockImplementation(() => new Promise<never>(() => undefined));
      expect(await readNative("codex")).toMatchObject({
        status: "ready",
        models: [
          { platform: "claude", id: claudeModel.id },
          { platform: "codex", id: liveModel.id },
        ],
      });
      expect(refresh).not.toHaveBeenCalled();
      const cache = await context.storage.getAgentModelCatalogCache();
      expect(cache.codex?.models).toEqual([
        { ...liveModel, reasoningOptions: [{ effort: "high", label: "High" }] },
      ]);
    });
  });

  test("replaces a stale saved list with live rows without starting a host probe", async () => {
    await withRegistry(
      async ({ context, readNative, refresh, useLocalBridge }) => {
        useLocalBridge();
        expect(await readNative()).toMatchObject([{ id: claudeModel.id }, { id: liveModel.id }]);
        expect((await context.storage.getAgentModelCatalogCache()).codex?.models[0]?.id).toBe(
          liveModel.id,
        );
        expect(refresh).not.toHaveBeenCalled();
      },
      { stale: true },
    );
  });

  test.each(["missing", "http-failure"] as const)(
    "keeps cached and other-provider rows when the live list is %s",
    async (failure) => {
      await withRegistry(async ({ context, readNative, useLocalBridge }) => {
        await context.storage.cacheAgentModelCatalog("codex", [oldModel]);
        if (failure === "http-failure") {
          useLocalBridge(async () => new Response(null, { status: 503 }));
        }
        expect(await readNative()).toMatchObject([{ id: claudeModel.id }, { id: oldModel.id }]);
      });
    },
  );

  test("keeps serving saved rows when the container's token lookup rejects", async () => {
    await withRegistry(
      async ({ context, readNative }) => {
        await context.storage.cacheAgentModelCatalog("codex", [oldModel]);
        spyOn(agentBridges, "peekContainerAgentBridge").mockRejectedValue(
          new Error("container stopped after port lookup"),
        );
        expect(await readNative()).toMatchObject([{ id: claudeModel.id }, { id: oldModel.id }]);
      },
      { container: true },
    );
  });

  test("logs a cache write failure and still returns the live list", async () => {
    await withRegistry(async ({ context, readNative, useLocalBridge }) => {
      useLocalBridge();
      spyOn(context.storage, "cacheAgentModelCatalog").mockRejectedValueOnce(
        new Error("fixture storage failure"),
      );
      const logs = captureLogs();
      try {
        expect(await readNative()).toMatchObject([{ id: claudeModel.id }, { id: liveModel.id }]);
        expect(logs.records()).toContainEqual(
          expect.objectContaining({
            event: "cache.write-failed",
            fields: expect.objectContaining({ agent: "codex" }),
          }),
        );
      } finally {
        logs.restore();
      }
    });
  });

  test.each(["switch", "renew"] as const)(
    "keeps a busy bridge's rows in its environment after a login %s",
    async (change) => {
      await withRegistry(async ({ context, readNative, setLogin, useLocalBridge }) => {
        await context.storage.cacheAgentModelCatalog("codex", [oldModel]);
        const requested = Promise.withResolvers<void>();
        const answer = Promise.withResolvers<Response>();
        useLocalBridge(() => {
          requested.resolve();
          return answer.promise;
        });
        const read = readNative();
        await requested.promise;
        await setLogin(
          change === "switch" ? secondAccount : undefined,
          "0df598aa-7e06-4aaa-8385-f53770c2d907",
        );
        expect((await context.storage.getAgentModelCatalogCache()).codex).toBeUndefined();
        const newModel = { id: "gpt-new-login", name: "New Login" };
        const saved = await context.storage.cacheAgentModelCatalog("codex", [newModel]);
        answer.resolve(Response.json({ source: "app-server", models: [liveModel] }));
        expect(await read).toMatchObject([{ id: claudeModel.id }, { id: liveModel.id }]);
        expect((await context.storage.getAgentModelCatalogCache()).codex).toEqual(saved.codex);
        await expect(
          persistHostCatalog(context, {
            agent: "codex",
            models: [liveModel],
            accountLoginKey: agentAccountLoginKey(),
          }),
        ).rejects.toThrow("active Codex login changed");
        expect((await context.storage.getAgentModelCatalogCache()).codex?.models).toEqual([
          newModel,
        ]);
      });
    },
  );

  test("refreshes stale host rows in the background when no bridge supplies them", async () => {
    await withRegistry(
      async ({ context, readNative, refresh }) => {
        const answer = Promise.withResolvers<HostCatalog>();
        const started = Promise.withResolvers<void>();
        refresh.mockImplementation(() => {
          started.resolve();
          return answer.promise;
        });
        expect(await readNative()).toMatchObject([{ id: claudeModel.id }, { id: oldModel.id }]);
        await started.promise;
        const persisted = Promise.withResolvers<void>();
        const save = context.storage.cacheAgentModelCatalog.bind(context.storage);
        spyOn(context.storage, "cacheAgentModelCatalog").mockImplementation(
          async (_agent, models) => {
            const cache = await save("codex", models as (typeof liveModel)[]);
            persisted.resolve();
            return cache;
          },
        );
        answer.resolve({
          agent: "codex",
          models: [liveModel],
          accountLoginKey: agentAccountLoginKey(),
        });
        await persisted.promise;
        expect((await context.storage.getAgentModelCatalogCache()).codex?.models).toEqual([
          liveModel,
        ]);
      },
      { stale: true },
    );
  });
});
