import { describe, expect, mock, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import type { Environment } from "./models.js";
import { StorageService } from "./storage.js";
import { EnvironmentLifecycleTaskTracker } from "./environment-lifecycle-tasks.js";
import {
  ENVIRONMENT_CLEANUP_LEDGER_FILE,
  environmentCleanupLedger,
} from "./environment-cleanup-ledger.js";
import { reconcileEnvironmentCleanup } from "./environment-cleanup-reconciler.js";
import { environmentStateDirectories } from "./environment-state-paths.js";

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
  const dataDir = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "orkestrator-delete-state-")),
  );
  const worktreeDir = path.join(dataDir, "workspaces");
  const storage = new StorageService(dataDir);
  await storage.init();
  await seed(storage);
  const commands = createCommandRegistry();
  const context = {
    storage,
    appRoot: "",
    resourceRoot: "",
    toolchainBinDir: "",
    worktreeDir,
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
    await fs.chmod(worktreeDir, 0o700).catch(() => undefined);
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false,
  );
}

/** A worktree leftover inside the workspaces root, with no project checkout. */
async function seedWorktree(storage: StorageService): Promise<string> {
  const worktreePath = path.join(storage.getDataDir(), "workspaces", "project-e1");
  await fs.mkdir(path.join(worktreePath, "bridges"), { recursive: true });
  await storage.addEnvironment(environment({ worktreePath }));
  return worktreePath;
}

describe("delete_environment host cleanup", () => {
  test("removes the worktree and every bridge state directory", async () => {
    let worktreePath = "";
    await withDeleteCommand(
      async (storage) => {
        worktreePath = await seedWorktree(storage);
        for (const directory of environmentStateDirectories(storage.getDataDir(), "e1")) {
          await fs.mkdir(directory, { recursive: true });
          await fs.writeFile(path.join(directory, "checkpoints.ndjson"), "{}\n");
        }
      },
      async (invokeDelete, storage) => {
        await invokeDelete();
        expect(await storage.getEnvironment("e1")).toBeNull();
        expect(await exists(worktreePath)).toBe(false);
        for (const directory of environmentStateDirectories(storage.getDataDir(), "e1")) {
          expect(await exists(directory)).toBe(false);
        }
        expect(await environmentCleanupLedger(storage.getDataDir()).list()).toEqual([]);
      },
    );
  });

  test("keeps a failed worktree removal in the ledger and the reconciler finishes it", async () => {
    // Root ignores directory permissions, so the failure cannot be staged.
    if (process.getuid?.() === 0) return;
    let worktreePath = "";
    await withDeleteCommand(
      async (storage) => {
        worktreePath = await seedWorktree(storage);
      },
      async (invokeDelete, storage, context) => {
        const workspaces = path.dirname(worktreePath);
        await fs.chmod(workspaces, 0o500);
        await invokeDelete();
        // The environment record is still removed on time.
        expect(await storage.getEnvironment("e1")).toBeNull();
        expect(await exists(worktreePath)).toBe(true);
        const ledger = environmentCleanupLedger(storage.getDataDir());
        expect(await ledger.get("e1")).toMatchObject({ pending: ["worktree"] });

        await fs.chmod(workspaces, 0o700);
        const later = new Date(Date.now() + 60 * 60_000);
        await reconcileEnvironmentCleanup(context, { now: () => later });
        expect(await exists(worktreePath)).toBe(false);
        expect(await ledger.get("e1")).toBeNull();
      },
    );
  });

  test("records cleanup before removing anything, and keeps the environment if it cannot", async () => {
    let worktreePath = "";
    await withDeleteCommand(
      async (storage) => {
        worktreePath = await seedWorktree(storage);
        // A directory where the ledger file belongs makes the write fail.
        await fs.mkdir(path.join(storage.getDataDir(), ENVIRONMENT_CLEANUP_LEDGER_FILE));
      },
      async (invokeDelete, storage) => {
        await expect(invokeDelete()).rejects.toThrow();
        expect(await exists(worktreePath)).toBe(true);
        expect(await storage.getEnvironment("e1")).toMatchObject({
          id: "e1",
          deletionRequestedAt: expect.any(String),
        });
      },
    );
  });
});

describe("delete_environment durable child-state cleanup", () => {
  test("purges agent mail before removing the environment", async () => {
    await withDeleteCommand(
      async (storage) => storage.addEnvironment(environment()).then(() => undefined),
      async (invokeDelete, storage) => {
        const original = storage.deleteAgentMailByEnvironment.bind(storage);
        const purge = mock(async (environmentId: string) => original(environmentId));
        storage.deleteAgentMailByEnvironment = purge;

        await invokeDelete();
        expect(purge).toHaveBeenCalledWith("e1");
        expect(await storage.getEnvironment("e1")).toBeNull();
      },
    );
  });

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

  test("deletes the environment even when a native session record is unreadable", async () => {
    await withDeleteCommand(
      async (storage) => {
        await storage.addEnvironment(environment());
        // A record written by a newer build. Nothing in this delete path can
        // read it, and refusing to finish here would strand the environment
        // itself — leaving the user no way to clear the record at all.
        await fs.writeFile(
          path.join(storage.getDataDir(), "native-agent-sessions.json"),
          JSON.stringify({
            "poisoned-key": {
              version: 2,
              key: "poisoned-key",
              environmentId: "e2",
              agent: "codex",
              logicalSessionKey: "env-e2:tab-1",
              providerSessionId: "future-provider-session",
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            },
          }),
        );
      },
      async (invokeDelete, storage) => {
        await expect(invokeDelete()).resolves.toBeUndefined();
        expect(await storage.getEnvironment("e1")).toBeNull();
        const remaining = JSON.parse(
          await fs.readFile(path.join(storage.getDataDir(), "native-agent-sessions.json"), "utf8"),
        );
        expect(remaining["poisoned-key"]).toMatchObject({ version: 2 });
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
        await storage.saveBuildPipeline("pipeline-1", "p1", "", 1, { id: "pipeline-1" });
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
        await storage.saveBuildPipeline("pipeline-1", "p1", "e1", 1, { id: "pipeline-1" });
        await storage.savePromptQueue("claude env-e1:tab-1", "e1", [{ id: "m1" }]);
        await storage.saveAgentHandoff("handoff-1", "e1", 1, { messages: [{ id: "m1" }] });
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
        await expect(
          storage.savePromptQueue("claude env-e1:tab-1", "e1", [{ id: "late" }]),
        ).rejects.toThrow("being deleted");
        await expect(
          storage.saveBuildPipeline("pipeline-1", "p1", "e1", 1, {
            id: "pipeline-1",
            phase: "late",
          }),
        ).rejects.toThrow("being deleted");
        await expect(
          storage.saveAgentHandoff("handoff-late", "e1", 1, { messages: [] }),
        ).rejects.toThrow("being deleted");

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
