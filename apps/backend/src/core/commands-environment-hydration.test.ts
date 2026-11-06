import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  LIST_ENVIRONMENT_HYDRATION_COMMAND,
  MAX_ENVIRONMENT_HYDRATION_IDS,
  type EnvironmentHydrationBatch,
} from "@orkestrator/protocol/environment-hydration";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { StorageService } from "./storage.js";
import { BackendRuntime } from "./backend-runtime.js";

const KEY = "claude env-e1:tab-1";

async function withRegistry<T>(
  run: (
    invoke: (args: Record<string, unknown>) => Promise<EnvironmentHydrationBatch>,
    storage: StorageService,
  ) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-env-hydration-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  for (const [order, id] of ["e1", "e2"].entries()) {
    await storage.addEnvironment({
      id,
      name: id,
      projectId: "proj-1",
      status: "running",
      environmentType: "local",
      branch: "main",
      order,
      containerId: null,
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      networkAccessMode: "restricted",
      createdAt: new Date(0).toISOString(),
    } as Parameters<StorageService["addEnvironment"]>[0]);
  }
  const commands = createCommandRegistry();
  const context = {
    appRoot: "",
    resourceRoot: "",
    toolchainBinDir: "",
    emit: () => undefined,
    storage,
    runtime: new BackendRuntime({ emit: () => undefined }),
  } as unknown as CommandContext;
  const handler = commands.get(LIST_ENVIRONMENT_HYDRATION_COMMAND);
  if (!handler) throw new Error("list_environment_hydration is not registered");
  try {
    return await run(
      async (args) => (await handler(args, context)) as EnvironmentHydrationBatch,
      storage,
    );
  } finally {
    context.runtime.shutdown();
    await context.runtime.terminals.history.settled();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("list_environment_hydration", () => {
  test("answers every environment's prompt queues and workflows in one call", async () => {
    await withRegistry(async (invoke, storage) => {
      await storage.enqueuePromptQueueMessage(KEY, "e1", { id: "m1" });
      await storage.saveMultiReviewWorkflow("workflow-1", "e2", 1, {
        id: "workflow-1",
        phase: "reviewing",
        controllerFence: "snapshot-token",
      });

      const batch = await invoke({ environmentIds: ["e1", "e2", "e1"] });

      expect(batch.environments.map((entry) => entry.environmentId)).toEqual(["e1", "e2"]);
      const [first, second] = batch.environments;
      expect(first?.promptQueues).toMatchObject({ status: "ok", records: [{ queueKey: KEY }] });
      expect(first?.multiReviewWorkflows).toEqual({ status: "ok", records: [] });
      expect(second?.promptQueues).toEqual({ status: "ok", records: [] });
      expect(second?.multiReviewWorkflows.status).toBe("ok");
      const workflows =
        second?.multiReviewWorkflows.status === "ok" ? second.multiReviewWorkflows.records : [];
      expect(workflows).toHaveLength(1);
      // The same renderer-safe projection `list_multi_review_workflows` returns.
      expect((workflows[0] as { snapshot: object }).snapshot).not.toHaveProperty("controllerFence");
    });
  });

  test("a failed read fails only that environment's list", async () => {
    await withRegistry(async (invoke, storage) => {
      const real = storage.listPromptQueues.bind(storage);
      const spy = spyOn(storage, "listPromptQueues").mockImplementation(async (id: string) => {
        if (id === "broken") throw new Error("store unavailable");
        return real(id);
      });
      try {
        const batch = await invoke({ environmentIds: ["broken", "e1"] });
        expect(batch.environments).toEqual([
          {
            environmentId: "broken",
            promptQueues: { status: "failed" },
            multiReviewWorkflows: { status: "ok", records: [] },
          },
          {
            environmentId: "e1",
            promptQueues: { status: "ok", records: [] },
            multiReviewWorkflows: { status: "ok", records: [] },
          },
        ]);
      } finally {
        spy.mockRestore();
      }
    });
  });

  test("refuses an empty, oversized or malformed id list", async () => {
    await withRegistry(async (invoke) => {
      await expect(invoke({})).rejects.toThrow("non-empty array");
      await expect(invoke({ environmentIds: [] })).rejects.toThrow("non-empty array");
      await expect(
        invoke({
          environmentIds: Array.from(
            { length: MAX_ENVIRONMENT_HYDRATION_IDS + 1 },
            (_, i) => `e${i}`,
          ),
        }),
      ).rejects.toThrow("at most");
      await expect(invoke({ environmentIds: ["e1", 7] })).rejects.toThrow("environment ids");
      await expect(invoke({ environmentIds: [" "] })).rejects.toThrow("environment ids");
    });
  });
});
