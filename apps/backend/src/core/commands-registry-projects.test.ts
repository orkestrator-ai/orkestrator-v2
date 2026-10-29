import { describe, expect, mock, test } from "bun:test";
import { createCommandRegistry } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { registerProjectCommands, withDefaultBranches } from "./commands-registry-projects.js";
import type { Project } from "./models.js";

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
    const { HOST_OPENCODE_CATALOG_SCOPE, __testing } = await import("./host-model-catalog-seed.js");
    __testing.reset();
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
    registerProjectCommands((name, handler) => commands.set(name, handler), {
      commands,
      refreshHostModelCatalog: refresh,
    } as never);
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
  await expect(handler({ summaryIcons: "yes" }, context)).rejects.toThrow("summaryIcons");
});
