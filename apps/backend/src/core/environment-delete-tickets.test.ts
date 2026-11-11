import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BackendRuntime } from "./backend-runtime.js";
import { BUILD_ENVIRONMENT_DELETED_COMMENT } from "./build-pipeline-kanban-environment-deleted.js";
import { lifecycleMachine, PR_URL } from "./build-pipeline-kanban-transitions-test-support.js";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { closeEnvironmentCleanupStorage } from "./environment-cleanup-ledger.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import { StorageService } from "./storage.js";

/**
 * `delete_environment` settles the tickets of the environment's builds before
 * it deletes their pipeline records (`environment-delete.ts`, the "records"
 * step): the ending a deleted build can no longer give its ticket. The rules
 * themselves are in `build-pipeline-kanban-transitions.test.ts`; this drives
 * the real command over a real storage service.
 */

afterEach(() => closeEnvironmentCleanupStorage());

async function withEnvironmentBuild(
  run: (input: {
    storage: StorageService;
    taskId: string;
    remove: () => Promise<void>;
    life: Awaited<ReturnType<typeof lifecycleMachine>>;
    pipeline: ReturnType<Awaited<ReturnType<typeof lifecycleMachine>>["pipeline"]>;
  }) => Promise<void>,
): Promise<void> {
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "orkestrator-delete-tickets-")),
  );
  const storage = new StorageService(dataDir);
  await storage.init();
  await storage.addEnvironment({
    id: "e1",
    projectId: "p1",
    name: "Environment",
    branch: "build",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order: 0,
    environmentType: "local",
  });
  const taskId = (await storage.kanban.addKanbanTask("p1", "Ticket", "Body")).id;
  const life = await lifecycleMachine(storage, "e1", "p1");
  const pipeline = life.pipeline(taskId);
  await storage.saveBuildPipeline(pipeline.id, "p1", "e1", 1, pipeline);
  const commands = createCommandRegistry();
  const context = {
    storage,
    appRoot: "",
    resourceRoot: "",
    toolchainBinDir: "",
    worktreeDir: path.join(dataDir, "workspaces"),
    environmentLifecycleTasks: new EnvironmentLifecycleTaskTracker(),
    runtime: new BackendRuntime({ emit: () => undefined }),
    emit: () => undefined,
  } as CommandContext;
  const remove = async () => {
    const command = commands.get("delete_environment");
    if (!command) throw new Error("delete_environment is not registered");
    await command({ environmentId: "e1" }, context);
  };
  try {
    await run({ storage, taskId, remove, life, pipeline });
  } finally {
    context.runtime.shutdown();
    await context.runtime.diffStats.settled();
    storage.close?.();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("delete_environment", () => {
  test("sends the ticket of an unfinished build back to the backlog, then deletes the build", async () => {
    await withEnvironmentBuild(async ({ storage, taskId, remove, life, pipeline }) => {
      await life.started(pipeline);
      expect((await storage.kanban.getKanbanTask(taskId))?.status).toBe("in-progress");
      await remove();
      const after = await storage.kanban.getKanbanTask(taskId);
      expect(after?.status).toBe("backlog");
      expect(after?.comments.map((comment) => comment.text)).toContain(
        BUILD_ENVIRONMENT_DELETED_COMMENT,
      );
      expect(await storage.getEnvironment("e1")).toBeNull();
      expect(await storage.getBuildPipeline(pipeline.id)).toBeNull();
    });
  });

  test("closes the ticket when the environment's pull request merged", async () => {
    await withEnvironmentBuild(async ({ storage, taskId, remove, life, pipeline }) => {
      await life.started(pipeline);
      await life.prDetected(pipeline, "open");
      await storage.updateEnvironment("e1", { prUrl: PR_URL, prState: "merged" });
      await remove();
      expect(await storage.kanban.getKanbanTask(taskId)).toMatchObject({
        status: "done",
        prMergeDoneUrl: PR_URL,
      });
      expect(await storage.getBuildPipeline(pipeline.id)).toBeNull();
    });
  });
});
