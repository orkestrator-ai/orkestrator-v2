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
  await storage.addEnvironment({
    id: "e1", name: "Env", projectId: "proj-1", status: "running",
    environmentType: "local", branch: "main", order: 0,
    containerId: null, prUrl: null, prState: null, hasMergeConflicts: null,
    networkAccessMode: "restricted", createdAt: new Date(0).toISOString(),
  });
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

  test("atomically claims the expected queue head", async () => {
    await withCommands(async (invoke) => {
      const candidateMessages = [{ id: "m1" }, { id: "m2" }];
      await expect(invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "m1",
        candidateMessages,
      })).resolves.toMatchObject({
        claimed: { id: "m1" },
        queue: { messages: [{ id: "m2" }], revision: 1 },
      });

      await expect(invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "m1",
        candidateMessages,
      })).resolves.toMatchObject({
        claimed: null,
        queue: { messages: [{ id: "m2" }], revision: 1 },
      });
    });
  });

  test("rejects malformed atomic-claim arguments", async () => {
    await withCommands(async (invoke) => {
      await expect(invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "",
        candidateMessages: [],
      })).rejects.toThrow();
      await expect(invoke("claim_prompt_queue_head", {
        queueKey: KEY,
        environmentId: "e1",
        expectedMessageId: "m1",
        candidateMessages: "bad",
      })).rejects.toThrow("must be an array");
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

describe("set_environment_agent_activity", () => {
  test("persists agent activity and rejects malformed command arguments", async () => {
    await withCommands(async (invoke) => {
      const occurredAt = "2026-07-27T12:00:00.000Z";
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "working",
        occurredAt,
      })).resolves.toMatchObject({
        agentActivityState: "working",
        agentActivityUpdatedAt: occurredAt,
      });

      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "busy",
        occurredAt,
      })).rejects.toThrow("state must be idle, working, or waiting");

      await expect(invoke("set_environment_agent_activity", {
        environmentId: 42,
        state: "working",
        occurredAt,
      })).rejects.toThrow("Expected environmentId to be a string");
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: 42,
        occurredAt,
      })).rejects.toThrow("Expected state to be a string");
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "working",
        occurredAt: 42,
      })).rejects.toThrow("Expected occurredAt to be a string");
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "working",
        occurredAt: "invalid",
      })).rejects.toThrow("occurredAt must be a valid ISO timestamp");
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "e1",
        state: "working",
        occurredAt: "+275760-09-13T00:00:00.000Z",
      })).rejects.toThrow("occurredAt must not be more than 5 minutes in the future");
      await expect(invoke("set_environment_agent_activity", {
        environmentId: "missing",
        state: "working",
        occurredAt,
      })).rejects.toThrow("Environment not found: missing");
    });
  });
});

describe("set_environment_unread", () => {
  async function seedEnvironment(storage: StorageService): Promise<void> {
    if (!await storage.getProject("proj-1")) {
      await storage.addProject({
        id: "proj-1", name: "Project", gitUrl: "https://example.com/repo.git",
        localPath: null, order: 0, addedAt: new Date().toISOString(),
      });
    }
    if (!await storage.getEnvironment("e1")) {
      await storage.addEnvironment({
        id: "e1", name: "Env", projectId: "proj-1", status: "running",
        environmentType: "local", branch: "main", order: 0,
        containerId: null, prUrl: null, prState: null, hasMergeConflicts: null,
        networkAccessMode: "restricted", createdAt: new Date().toISOString(),
      });
    }
  }

  test("sets and clears the badge on the environment record", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);

      await expect(invoke("set_environment_unread", { environmentId: "e1", unread: true }))
        .resolves.toMatchObject({ id: "e1", hasUnreadWork: true });
      await expect(invoke("set_environment_unread", {
        environmentId: "e1", unread: false, expectedLastActivityAt: null,
      }))
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

  test("does not let a delayed clear erase a newer completion", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      const first = "2026-01-01T00:00:00.000Z";
      const second = "2026-01-01T00:00:01.000Z";

      await expect(invoke("record_environment_completion", {
        environmentId: "e1", occurredAt: first,
      })).resolves.toMatchObject({ lastActivityAt: first, hasUnreadWork: true });

      await expect(invoke("record_environment_completion", {
        environmentId: "e1", occurredAt: second,
      })).resolves.toMatchObject({ lastActivityAt: second, hasUnreadWork: true });

      await expect(invoke("set_environment_unread", {
        environmentId: "e1",
        unread: false,
        expectedLastActivityAt: first,
      })).resolves.toMatchObject({ lastActivityAt: second, hasUnreadWork: true });
    });
  });

  test("guards an absent activity token with explicit null", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      const completion = "2026-01-01T00:00:00.000Z";

      await invoke("record_environment_completion", {
        environmentId: "e1", occurredAt: completion,
      });
      await expect(invoke("set_environment_unread", {
        environmentId: "e1",
        unread: false,
        expectedLastActivityAt: null,
      })).resolves.toMatchObject({ lastActivityAt: completion, hasUnreadWork: true });
    });
  });

  test("rejects a malformed clear token instead of clearing without a guard", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      await invoke("set_environment_unread", { environmentId: "e1", unread: true });

      await expect(invoke("set_environment_unread", {
        environmentId: "e1",
        unread: false,
        expectedLastActivityAt: 42,
      })).rejects.toThrow("Expected expectedLastActivityAt to be a string");
      expect(await storage.getEnvironment("e1")).toMatchObject({ hasUnreadWork: true });
    });
  });

  test("ignores a stale completion without raising a new badge", async () => {
    await withCommands(async (invoke, storage) => {
      await seedEnvironment(storage);
      const newest = "2026-01-01T00:00:01.000Z";
      await invoke("record_environment_completion", {
        environmentId: "e1", occurredAt: newest,
      });
      await invoke("set_environment_unread", {
        environmentId: "e1", unread: false, expectedLastActivityAt: newest,
      });

      await expect(invoke("record_environment_completion", {
        environmentId: "e1", occurredAt: "2026-01-01T00:00:00.000Z",
      })).resolves.toMatchObject({ lastActivityAt: newest, hasUnreadWork: false });
    });
  });
});
