import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UsageHistoryReport } from "@orkestrator/protocol/usage-history";
import type { CommandContext } from "./commands-context.js";
import { createCommandRegistry } from "./commands-registry.js";
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
  return { storage, read, project };
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
  const removed = report.environments.find((entry) => entry.environmentId === "env-gone");
  expect(removed?.name).toBeUndefined();
  expect(removed?.totals.totalTokens).toBe(1_000);
});

test("clamps the range and refuses an unknown argument", async () => {
  const { read } = await fixture();
  const report = await read({ days: 100_000 });
  expect(report.days.length).toBeLessThanOrEqual(401);
  await expect(read({ nonsense: true })).rejects.toThrow();
});
