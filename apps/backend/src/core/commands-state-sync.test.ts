import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCommandRegistry, type CommandContext } from "./commands.js";
import { StorageService } from "./storage.js";

/**
 * Registry-level coverage for the commands that back the backend-owned state
 * introduced with the change feed. These run against a real StorageService
 * because the argument coercion in the registry is exactly what decides whether
 * storage's own validation is reachable.
 */

async function withCommands<T>(
  run: (
    invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>,
    storage: StorageService,
  ) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-state-sync-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  const commands = createCommandRegistry();
  const context = {
    appRoot: "",
    resourceRoot: "",
    toolchainBinDir: "",
    emit: () => undefined,
    storage,
  } as unknown as CommandContext;

  const invoke = async (command: string, args: Record<string, unknown>) => {
    const handler = commands.get(command);
    if (!handler) throw new Error(`Command not registered: ${command}`);
    return await handler(args, context);
  };

  try {
    return await run(invoke, storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const KEY = "claude env-e1:tab-1";

describe("prompt queue commands", () => {
  test("saves and reads back a queue", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("save_prompt_queue", {
        queueKey: KEY, environmentId: "e1", messages: [{ id: "m1" }],
      })).resolves.toMatchObject({ queueKey: KEY, revision: 1 });

      await expect(invoke("get_prompt_queue", { queueKey: KEY }))
        .resolves.toMatchObject({ messages: [{ id: "m1" }] });
      await expect(invoke("list_prompt_queues", { environmentId: "e1" }))
        .resolves.toHaveLength(1);
    });
  });

  test("rejects a malformed message list rather than emptying the queue", async () => {
    // Coercing a bad payload to [] would turn a malformed request into a
    // deletion that also bumps the revision every other client compares against.
    await withCommands(async (invoke, storage) => {
      await invoke("save_prompt_queue", {
        queueKey: KEY, environmentId: "e1", messages: [{ id: "m1" }],
      });

      await expect(invoke("save_prompt_queue", {
        queueKey: KEY, environmentId: "e1", messages: "not-an-array", expectedRevision: 1,
      })).rejects.toThrow("must be an array");

      const stored = await storage.getPromptQueue(KEY);
      expect(stored).toMatchObject({ messages: [{ id: "m1" }], revision: 1 });
    });
  });

  test("rejects a missing message list rather than emptying the queue", async () => {
    await withCommands(async (invoke, storage) => {
      await invoke("save_prompt_queue", {
        queueKey: KEY, environmentId: "e1", messages: [{ id: "m1" }],
      });

      await expect(invoke("save_prompt_queue", {
        queueKey: KEY, environmentId: "e1", expectedRevision: 1,
      })).rejects.toThrow("must be an array");

      expect(await storage.getPromptQueue(KEY)).toMatchObject({ revision: 1 });
    });
  });

  test("still accepts an explicitly emptied queue", async () => {
    await withCommands(async (invoke) => {
      await invoke("save_prompt_queue", {
        queueKey: KEY, environmentId: "e1", messages: [{ id: "m1" }],
      });

      await expect(invoke("save_prompt_queue", {
        queueKey: KEY, environmentId: "e1", messages: [], expectedRevision: 1,
      })).resolves.toMatchObject({ messages: [], revision: 2 });
    });
  });

  test("forwards the compare-and-swap expectation so a stale write loses", async () => {
    await withCommands(async (invoke) => {
      await invoke("save_prompt_queue", {
        queueKey: KEY, environmentId: "e1", messages: [{ id: "m1" }],
      });

      await expect(invoke("save_prompt_queue", {
        queueKey: KEY, environmentId: "e1", messages: [], expectedRevision: 0,
      })).rejects.toThrow("revision conflict");
    });
  });

  test("rejects blank identifiers", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("save_prompt_queue", {
        queueKey: "", environmentId: "e1", messages: [],
      })).rejects.toThrow();
      await expect(invoke("get_prompt_queue", { queueKey: "" })).rejects.toThrow();
      await expect(invoke("list_prompt_queues", { environmentId: "" })).rejects.toThrow();
    });
  });
});

describe("build pipeline commands", () => {
  const snapshot = { id: "p1", phase: "building" };

  test("saves, lists and deletes a pipeline", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("save_build_pipeline", {
        pipelineId: "p1", projectId: "proj-1", environmentId: "e1", version: 1, snapshot,
      })).resolves.toMatchObject({ id: "p1", revision: 1 });

      await expect(invoke("list_build_pipelines", { projectId: "proj-1" }))
        .resolves.toHaveLength(1);

      await invoke("delete_build_pipeline", { pipelineId: "p1" });
      await expect(invoke("get_build_pipeline", { pipelineId: "p1" })).resolves.toBeNull();
    });
  });

  test("accepts the blank environment id a not-yet-created pipeline carries", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("save_build_pipeline", {
        pipelineId: "p1", projectId: "proj-1", version: 1, snapshot,
      })).resolves.toMatchObject({ environmentId: "" });
    });
  });

  test("rejects a snapshot that is not an object", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("save_build_pipeline", {
        pipelineId: "p1", projectId: "proj-1", environmentId: "e1", version: 1,
        snapshot: "not-an-object",
      })).rejects.toThrow("must be a JSON object");
    });
  });

  test("rejects a non-numeric version", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("save_build_pipeline", {
        pipelineId: "p1", projectId: "proj-1", environmentId: "e1",
        version: "one", snapshot,
      })).rejects.toThrow();
    });
  });

  test("forwards the compare-and-swap expectation", async () => {
    await withCommands(async (invoke) => {
      await invoke("save_build_pipeline", {
        pipelineId: "p1", projectId: "proj-1", environmentId: "e1", version: 1, snapshot,
      });

      await expect(invoke("save_build_pipeline", {
        pipelineId: "p1", projectId: "proj-1", environmentId: "e1", version: 1, snapshot,
        expectedRevision: 0,
      })).rejects.toThrow("revision conflict");
    });
  });
});

describe("set_environment_unread", () => {
  async function seedEnvironment(storage: StorageService): Promise<void> {
    await storage.addProject({
      id: "proj-1", name: "Project", gitUrl: "https://example.com/repo.git",
      localPath: null, order: 0, createdAt: new Date().toISOString(),
    } as never);
    await storage.addEnvironment({
      id: "e1", name: "Env", projectId: "proj-1", status: "running",
      environmentType: "local", branch: "main", order: 0,
      createdAt: new Date().toISOString(),
    } as never);
  }

  test("sets and clears the badge on the environment record", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);

      await expect(invoke("set_environment_unread", { environmentId: "e1", unread: true }))
        .resolves.toMatchObject({ id: "e1", hasUnreadWork: true });
      await expect(invoke("set_environment_unread", { environmentId: "e1", unread: false }))
        .resolves.toMatchObject({ id: "e1", hasUnreadWork: false });
    });
  });

  test("treats a non-boolean flag as read rather than marking unread", async () => {
    // asBoolean falls back to false, so a malformed request can only ever clear
    // the badge — never raise one the user has not been given a reason for.
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      await invoke("set_environment_unread", { environmentId: "e1", unread: true });

      await expect(invoke("set_environment_unread", { environmentId: "e1", unread: "yes" }))
        .resolves.toMatchObject({ hasUnreadWork: false });
    });
  });

  test("rejects an unknown environment", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("set_environment_unread", { environmentId: "missing", unread: true }))
        .rejects.toThrow("not found");
    });
  });
});
