import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createCommandRegistry,
  type CommandContext,
} from "./commands.js";
import type { Environment } from "./models.js";
import { StorageService } from "./storage.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";

function environment(overrides: Partial<Environment> = {}): Environment {
  return {
    id: "e1",
    projectId: "p1",
    name: "Environment",
    branch: "main",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
    ...overrides,
  };
}

async function withDeleteCommand<T>(
  seed: (storage: StorageService) => Promise<void>,
  run: (
    invokeDelete: () => Promise<void>,
    storage: StorageService,
    context: CommandContext,
  ) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-delete-state-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  await seed(storage);
  const commands = createCommandRegistry();
  const context = {
    storage,
    appRoot: "",
    resourceRoot: "",
    toolchainBinDir: "",
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    emit: () => undefined,
  } as CommandContext;
  const invokeDelete = async () => {
    const command = commands.get("delete_environment");
    if (!command) throw new Error("delete_environment is not registered");
    await command({ environmentId: "e1" }, context);
  };
  try {
    return await run(invokeDelete, storage, context);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("delete_environment durable child-state cleanup", () => {
  test("revokes the environment's project-scoped agent-tools credential", async () => {
    await withDeleteCommand(
      async (storage) => storage.addEnvironment(environment()).then(() => undefined),
      async (invokeDelete, storage, context) => {
        const revokeEnvironment = mock(() => undefined);
        context.agentTools = {
          connection: mock(() => ({
            url: "http://127.0.0.1:43210/mcp",
            token: "test-token",
          })),
          revokeEnvironment,
        };

        await invokeDelete();
        expect(revokeEnvironment).toHaveBeenCalledWith("e1");
        expect(await storage.getEnvironment("e1")).toBeNull();
      },
    );
  });

  test("retains a deleting environment when pipeline cleanup fails", async () => {
    await withDeleteCommand(
      async (storage) => storage.addEnvironment(environment()).then(() => undefined),
      async (invokeDelete, storage) => {
        const original = storage.deleteBuildPipelinesByEnvironment.bind(storage);
        storage.deleteBuildPipelinesByEnvironment = mock(async () => {
          throw new Error("pipeline cleanup failed");
        });

        await expect(invokeDelete()).rejects.toThrow("pipeline cleanup failed");
        expect(await storage.getEnvironment("e1")).toMatchObject({
          id: "e1",
          deletionRequestedAt: expect.any(String),
        });

        storage.deleteBuildPipelinesByEnvironment = original;
        await expect(invokeDelete()).resolves.toBeUndefined();
        expect(await storage.getEnvironment("e1")).toBeNull();
      },
    );
  });

  test("retains a deleting environment when prompt cleanup fails", async () => {
    await withDeleteCommand(
      async (storage) => storage.addEnvironment(environment()).then(() => undefined),
      async (invokeDelete, storage) => {
        const original = storage.deletePromptQueuesByEnvironment.bind(storage);
        storage.deletePromptQueuesByEnvironment = mock(async () => {
          throw new Error("prompt cleanup failed");
        });

        await expect(invokeDelete()).rejects.toThrow("prompt cleanup failed");
        expect(await storage.getEnvironment("e1")).toMatchObject({
          id: "e1",
          deletionRequestedAt: expect.any(String),
        });

        storage.deletePromptQueuesByEnvironment = original;
        await expect(invokeDelete()).resolves.toBeUndefined();
        expect(await storage.getEnvironment("e1")).toBeNull();
      },
    );
  });

  test("retains a deleting environment when handoff cleanup fails", async () => {
    await withDeleteCommand(
      async (storage) => storage.addEnvironment(environment()).then(() => undefined),
      async (invokeDelete, storage) => {
        const original = storage.deleteAgentHandoffsByEnvironment.bind(storage);
        storage.deleteAgentHandoffsByEnvironment = mock(async () => {
          throw new Error("handoff cleanup failed");
        });

        await expect(invokeDelete()).rejects.toThrow("handoff cleanup failed");
        expect(await storage.getEnvironment("e1")).toMatchObject({
          id: "e1",
          deletionRequestedAt: expect.any(String),
        });

        storage.deleteAgentHandoffsByEnvironment = original;
        await expect(invokeDelete()).resolves.toBeUndefined();
        expect(await storage.getEnvironment("e1")).toBeNull();
      },
    );
  });

  test("deletes the environment-linked pipeline whose stored environment id is blank", async () => {
    await withDeleteCommand(
      async (storage) => {
        await storage.saveBuildPipeline(
          "pipeline-1",
          "p1",
          "",
          1,
          { id: "pipeline-1" },
        );
        await storage.addEnvironment(environment({ buildPipelineId: "pipeline-1" }));
      },
      async (invokeDelete, storage) => {
        await invokeDelete();
        expect(await storage.getBuildPipeline("pipeline-1")).toBeNull();
      },
    );
  });

  test("rejects delayed saves once deletion is marked and then sweeps older saves", async () => {
    await withDeleteCommand(
      async (storage) => {
        await storage.addEnvironment(environment({ buildPipelineId: "pipeline-1" }));
        await storage.saveBuildPipeline(
          "pipeline-1",
          "p1",
          "e1",
          1,
          { id: "pipeline-1" },
        );
        await storage.savePromptQueue(
          "claude env-e1:tab-1",
          "e1",
          [{ id: "m1" }],
        );
        await storage.saveAgentHandoff(
          "handoff-1",
          "e1",
          1,
          { messages: [{ id: "m1" }] },
        );
      },
      async (invokeDelete, storage) => {
        let releaseCleanup!: () => void;
        let cleanupStarted!: () => void;
        const gate = new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        });
        const started = new Promise<void>((resolve) => {
          cleanupStarted = resolve;
        });
        const original = storage.deleteBuildPipelinesByEnvironment.bind(storage);
        storage.deleteBuildPipelinesByEnvironment = async (environmentId, linkedPipelineId) => {
          cleanupStarted();
          await gate;
          return original(environmentId, linkedPipelineId);
        };

        const deletion = invokeDelete();
        await started;
        await expect(storage.savePromptQueue(
          "claude env-e1:tab-1",
          "e1",
          [{ id: "late" }],
        )).rejects.toThrow("being deleted");
        await expect(storage.saveBuildPipeline(
          "pipeline-1",
          "p1",
          "e1",
          1,
          { id: "pipeline-1", phase: "late" },
        )).rejects.toThrow("being deleted");
        await expect(storage.saveAgentHandoff(
          "handoff-late",
          "e1",
          1,
          { messages: [] },
        )).rejects.toThrow("being deleted");

        releaseCleanup();
        await deletion;
        expect(await storage.getEnvironment("e1")).toBeNull();
        expect(await storage.getBuildPipeline("pipeline-1")).toBeNull();
        expect(await storage.getPromptQueue("claude env-e1:tab-1")).toBeNull();
        expect(await storage.getAgentHandoff("handoff-1")).toBeNull();
      },
    );
  });
});
