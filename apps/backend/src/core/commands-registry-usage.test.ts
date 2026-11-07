import { afterEach, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UsageHistoryReport } from "@orkestrator/protocol/usage-history";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
import { storageInternals } from "./storage-test-support.js";
import { StorageService, createProject } from "./storage.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "ork-usage-command-"));
  directories.push(root);
  const storage = new StorageService(path.join(root, "data"));
  await storage.init();
  const project = await storage.addProject(createProject("remote", path.join(root, "checkout")));
  await storage.addEnvironment({
    id: "env-1",
    projectId: project.id,
    name: "Feature branch",
    branch: "feature",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    worktreePath: path.join(root, "env-1"),
    setupScriptsComplete: true,
  });
  const commands = createCommandRegistry();
  const context = { storage } as unknown as CommandContext;
  const read = (args: Record<string, unknown> = {}) =>
    commands.get("get_usage_history")!(args, context) as Promise<UsageHistoryReport>;
  return { storage, read, project, root };
}

test("names the environment a usage row came from, and leaves a deleted one unnamed", async () => {
  const { storage, read, project } = await fixture();
  storage.recordAgentUsageTurns({
    sessionKey: "env-1:claude:tab-1",
    environmentId: "env-1",
    platform: "claude",
    turns: [{ turnId: "t1", inputTokens: 10, outputTokens: 5, costUsd: 0.5, modelId: "opus" }],
  });
  storage.recordAgentUsageTurns({
    sessionKey: "env-gone:codex:tab-1",
    environmentId: "env-gone",
    platform: "codex",
    turns: [{ turnId: "t2", inputTokens: 1_000, modelId: "gpt-6.1" }],
  });

  const report = await read({ days: 7 });
  const named = report.environments.find((entry) => entry.environmentId === "env-1");
  expect(named).toMatchObject({ name: "Feature branch", projectName: project.name });
  expect(named?.deleted).toBeUndefined();
  const removed = report.environments.find((entry) => entry.environmentId === "env-gone");
  expect(removed?.name).toBeUndefined();
  expect(removed?.deleted).toBe(true);
  expect(removed?.totals.totalTokens).toBe(1_000);
});

test("a deleted environment keeps the names it had when it was deleted", async () => {
  const { storage, read, project } = await fixture();
  storage.recordAgentUsageTurns({
    sessionKey: "env-1:claude:tab-1",
    environmentId: "env-1",
    platform: "claude",
    turns: [{ turnId: "t1", inputTokens: 10, outputTokens: 5, costUsd: 0.5, modelId: "opus" }],
  });
  await storage.removeEnvironment("env-1");
  // The project going too must not take the stamped project name with it.
  await storage.removeProject(project.id);

  const report = await read({ days: 7 });
  expect(report.environments).toEqual([
    expect.objectContaining({
      environmentId: "env-1",
      name: "Feature branch",
      projectName: project.name,
      deleted: true,
    }),
  ]);
});

test("an environment deleted before names were kept falls back to its PR tombstone", async () => {
  const { storage, read, project } = await fixture();
  await storage.updateEnvironment("env-1", {
    prUrl: "https://github.com/example/repo/pull/1",
    prState: "merged",
  });
  await storage.removeEnvironment("env-1");
  // Recorded after the deletion, so nothing stamped the row.
  storage.recordAgentUsageTurns({
    sessionKey: "env-1:claude:tab-1",
    environmentId: "env-1",
    platform: "claude",
    turns: [{ turnId: "t1", inputTokens: 10, outputTokens: 5, costUsd: 0.5, modelId: "opus" }],
  });

  const [entry] = (await read({ days: 7 })).environments;
  expect(entry).toMatchObject({
    name: "Feature branch",
    projectName: project.name,
    deleted: true,
  });
});

// A defined command drops an unknown argument (§11.4, plan item 7008); it refused it before.
test("clamps the range and drops an unknown argument", async () => {
  const { read } = await fixture();
  const report = await read({ days: 100_000 });
  expect(report.days.length).toBeLessThanOrEqual(401);
  expect((await read({ days: 7, nonsense: true })).days).toHaveLength(7);
});

for (const failure of ["stamping", "project loading"] as const) {
  test(`environment deletion completes when usage ${failure} fails`, async () => {
    const { storage, read, project, root } = await fixture();
    const other = { ...(await storage.loadEnvironments())[0]!, id: "env-2" };
    await storage.addEnvironment(other);
    storage.recordAgentUsageTurns({
      sessionKey: "env-1:claude:tab-1",
      environmentId: "env-1",
      platform: "claude",
      turns: [{ turnId: "t1", inputTokens: 10, outputTokens: 5, costUsd: 0.5 }],
    });
    const { repos } = storageInternals(storage);
    const fault =
      failure === "stamping"
        ? spyOn(repos.sessions, "labelAgentUsageEnvironment").mockImplementationOnce(() => {
            throw new Error("label write failed");
          })
        : spyOn(repos.projects, "loadProjects").mockRejectedValueOnce(
            new Error("project read failed"),
          );
    const changes: unknown[] = [];
    const unsubscribe = storage.addResourceChangeListener((change) => changes.push(change));
    try {
      await storage.removeEnvironment("env-1");
      expect(fault).toHaveBeenCalledTimes(1);
      expect(await storage.loadEnvironments()).toEqual([other]);
      expect(changes).toContainEqual(
        expect.objectContaining({
          resource: "environment",
          id: "env-1",
          projectId: project.id,
          deleted: true,
        }),
      );
      const reopened = new StorageService(path.join(root, "data"));
      await reopened.init();
      expect((await reopened.loadEnvironments()).map((entry) => entry.id)).toEqual(["env-2"]);
      const report = await read();
      expect(report.environments).toEqual([
        expect.objectContaining({
          environmentId: "env-1",
          deleted: true,
          totals: expect.objectContaining({ turns: 1, totalTokens: 15, costUsd: 0.5 }),
        }),
      ]);
    } finally {
      fault.mockRestore();
      unsubscribe();
    }
  });
}

for (const label of [{ environmentName: "Saved environment" }, { projectName: "Saved project" }]) {
  test(`PR lookup failure preserves partial label ${JSON.stringify(label)} and usage`, async () => {
    const { storage, read } = await fixture();
    await storage.removeEnvironment("env-1");
    storage.recordAgentUsageTurns({
      sessionKey: "env-1:claude:tab-1",
      environmentId: "env-1",
      platform: "claude",
      turns: [{ turnId: "t1", inputTokens: 10, outputTokens: 5, costUsd: 0.5 }],
    });
    storageInternals(storage).repos.sessions.labelAgentUsageEnvironment("env-1", label);
    const lookup = spyOn(storage, "getFinalEnvironmentPr").mockRejectedValueOnce(
      new Error("unreadable tombstone"),
    );
    try {
      const [entry] = (await read()).environments;
      expect(lookup).toHaveBeenCalledWith("env-1");
      expect(entry).toMatchObject({
        environmentId: "env-1",
        deleted: true,
        totals: expect.objectContaining({ turns: 1, totalTokens: 15, costUsd: 0.5 }),
      });
      expect(entry?.name).toBe(label.environmentName);
      expect(entry?.projectName).toBe(label.projectName);
    } finally {
      lookup.mockRestore();
    }
  });

  test(`partial saved label ${JSON.stringify(label)} merges with PR fallback`, async () => {
    const { storage, read, project } = await fixture();
    await storage.updateEnvironment("env-1", {
      prUrl: "https://github.com/example/repo/pull/1",
      prState: "merged",
    });
    await storage.removeEnvironment("env-1");
    storage.recordAgentUsageTurns({
      sessionKey: "env-1:claude:tab-1",
      environmentId: "env-1",
      platform: "claude",
      turns: [{ turnId: "t1", inputTokens: 10, outputTokens: 5 }],
    });
    storageInternals(storage).repos.sessions.labelAgentUsageEnvironment("env-1", label);
    expect((await read()).environments).toEqual([
      expect.objectContaining({
        name: label.environmentName ?? "Feature branch",
        projectName: label.projectName ?? project.name,
        deleted: true,
        totals: expect.objectContaining({ turns: 1, totalTokens: 15 }),
      }),
    ]);
  });
}
