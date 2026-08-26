import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCommandRegistry } from "./commands-registry.js";
import type { CommandContext } from "./commands-context.js";
import { createProject, StorageService } from "./storage.js";

describe("create_environment control request idempotency", () => {
  test("atomically converges concurrent retries on one environment", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-control-environment-"));
    const storage = new StorageService(dataDir);
    const secondStorage = new StorageService(dataDir);
    await Promise.all([storage.init(), secondStorage.init()]);
    const project = await storage.addProject(createProject("https://example.invalid/repo.git"));
    const command = createCommandRegistry().get("create_environment");
    if (!command) throw new Error("create_environment was not registered");
    const context = {
      storage,
      emit: () => undefined,
      environmentLifecycleTasks: {},
    } as unknown as CommandContext;
    const secondContext = {
      ...context,
      storage: secondStorage,
    } as unknown as CommandContext;

    try {
      const input = {
        projectId: project.id,
        name: "Control launch",
        environmentType: "containerized",
        controlRequestId: "environment-request-1",
      };
      const results = (await Promise.all([
        command(input, context),
        command(input, secondContext),
      ])) as Array<{ id: string }>;

      expect(results[1]!.id).toBe(results[0]!.id);
      expect(await storage.getEnvironmentsByProject(project.id)).toHaveLength(1);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("rejects oversized request IDs before persistence", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "ork-control-environment-limit-"));
    const storage = new StorageService(dataDir);
    await storage.init();
    const project = await storage.addProject(createProject("https://example.invalid/repo.git"));
    const command = createCommandRegistry().get("create_environment");
    if (!command) throw new Error("create_environment was not registered");
    const context = { storage, emit: () => undefined } as unknown as CommandContext;

    try {
      await expect(
        command(
          {
            projectId: project.id,
            environmentType: "containerized",
            controlRequestId: "x".repeat(257),
          },
          context,
        ),
      ).rejects.toThrow("at most 256 characters");
      expect(await storage.getEnvironmentsByProject(project.id)).toHaveLength(0);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
