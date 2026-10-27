import { describe, expect, test } from "bun:test";
import { createCommandRegistry } from "./commands.js";
import type { CommandContext } from "./commands-context.js";
import { withDefaultBranches } from "./commands-registry-projects.js";
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

  test("withDefaultBranches tolerates a config without repositories", () => {
    expect(withDefaultBranches(projects, {} as never)).toEqual(projects);
  });
});
