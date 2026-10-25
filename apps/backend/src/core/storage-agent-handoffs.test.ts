import { describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";
import { STORAGE_DATABASE_FILE } from "./storage-database.js";
import {
  hasStore,
  readStoredValue,
  seedStore,
  storageFilesContain,
  storageDatabase,
} from "./storage-test-support.js";

async function withStorage<T>(run: (storage: StorageService) => Promise<T>): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-agent-handoffs-"));
  const storage = new StorageService(dataDir);
  await storage.init();
  for (const id of ["e1", "e2"]) {
    await storage.addEnvironment({
      id,
      projectId: "proj-1",
      name: id,
      branch: "main",
      containerId: null,
      status: "running",
      prUrl: null,
      prState: null,
      hasMergeConflicts: null,
      createdAt: new Date(0).toISOString(),
      networkAccessMode: "restricted",
      order: 0,
      environmentType: "local",
    });
  }
  try {
    return await run(storage);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

const HANDOFFS = "agent-handoffs.json";

function readStoredHandoffs(dataDir: string): Record<string, unknown> {
  return readStoredValue<Record<string, unknown>>(dataDir, HANDOFFS) ?? {};
}

describe("StorageService agent handoffs", () => {
  test("persists sensitive immutable snapshots and reads them by id", async () => {
    await withStorage(async (storage) => {
      const snapshot = { sourceProvider: "claude", messages: [{ id: "m1", text: "secret" }] };
      const saved = await storage.saveAgentHandoff("h1", "e1", 1, snapshot);
      expect(saved).toMatchObject({
        id: "h1",
        environmentId: "e1",
        version: 1,
        snapshot,
      });
      expect(await storage.getAgentHandoff("h1")).toEqual(saved);

      const databaseFile = path.join(storage.getDataDir(), STORAGE_DATABASE_FILE);
      const mode = (await fs.stat(databaseFile)).mode & 0o777;
      expect(mode).toBe(0o600);

      const retried = await storage.saveAgentHandoff("h1", "e1", 2, {
        sourceProvider: "codex",
        messages: [],
      });
      // The id is the idempotency key: once committed, a retry cannot replace
      // either the version or snapshot with conflicting caller data.
      expect(retried).toEqual(saved);
    });
  });

  test("validates ownership, environment lifecycle and size", async () => {
    await withStorage(async (storage) => {
      await storage.saveAgentHandoff("h1", "e1", 1, { messages: [] });
      await expect(storage.saveAgentHandoff("h1", "e2", 1, { messages: [] })).rejects.toThrow(
        "another environment",
      );
      await storage.updateEnvironment("e2", {
        deletionRequestedAt: new Date().toISOString(),
      });
      await expect(storage.saveAgentHandoff("h2", "e2", 1, { messages: [] })).rejects.toThrow(
        "being deleted",
      );
      await expect(
        storage.saveAgentHandoff("h3", "e1", 1, {
          messages: ["x".repeat(32 * 1024 * 1024)],
        }),
      ).rejects.toThrow("32 MB");
    });
  });

  test("rejects malformed envelopes and non-serializable snapshots", async () => {
    await withStorage(async (storage) => {
      await expect(storage.getAgentHandoff(" ")).rejects.toThrow("must not be blank");
      await expect(storage.saveAgentHandoff("", "e1", 1, {})).rejects.toThrow(
        "ID must not be blank",
      );
      await expect(storage.saveAgentHandoff("h1", "", 1, {})).rejects.toThrow(
        "environment ID must not be blank",
      );
      await expect(storage.saveAgentHandoff("h1", "e1", 0, {})).rejects.toThrow("positive integer");
      await expect(storage.saveAgentHandoff("h1", "e1", 1, [])).rejects.toThrow(
        "must be an object",
      );
      await expect(storage.saveAgentHandoff("h1", "missing", 1, {})).rejects.toThrow(
        "environment not found",
      );
      await expect(storage.deleteAgentHandoff("", "e1")).rejects.toThrow("ID must not be blank");
      await expect(storage.deleteAgentHandoff("h1", "")).rejects.toThrow(
        "environment ID must not be blank",
      );

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(storage.saveAgentHandoff("h1", "e1", 1, circular)).rejects.toThrow(
        "JSON serializable",
      );
    });
  });

  test("deletes one owned handoff and scrubs superseded copies", async () => {
    await withStorage(async (storage) => {
      await storage.saveAgentHandoff("h1", "e1", 1, {
        messages: [{ text: "secret-h1" }],
      });
      await storage.saveAgentHandoff("h2", "e1", 1, {
        messages: [{ text: "keep-h2" }],
      });
      await storage.saveAgentHandoff("h3", "e1", 1, {
        messages: [{ text: "keep-h3" }],
      });

      const dataDir = storage.getDataDir();
      expect(storageFilesContain(dataDir, "secret-h1")).toBe(true);

      await expect(storage.deleteAgentHandoff("h1", "e2")).rejects.toThrow("another environment");
      await expect(storage.deleteAgentHandoff("h1", "e1")).resolves.toBe(true);
      await expect(storage.getAgentHandoff("h1")).resolves.toBeNull();
      await expect(storage.getAgentHandoff("h2")).resolves.not.toBeNull();
      await expect(storage.deleteAgentHandoff("h1", "e1")).resolves.toBe(false);

      expect(readStoredHandoffs(dataDir).h1).toBeUndefined();
      expect(storageFilesContain(dataDir, "secret-h1")).toBe(false);
      expect(storageFilesContain(dataDir, "keep-h2")).toBe(true);
      expect(storageFilesContain(dataDir, "keep-h3")).toBe(true);
    });
  });

  test("deletes a malformed stored entry and scrubs its content", async () => {
    await withStorage(async (storage) => {
      await storage.saveAgentHandoff("h1", "e1", 1, {
        messages: [{ text: "malformed-secret" }],
      });
      await storage.saveAgentHandoff("h2", "e2", 1, { messages: [] });

      const dataDir = storage.getDataDir();
      const stored = readStoredHandoffs(dataDir);
      stored.h1 = {
        environmentId: "e1",
        snapshot: { messages: [{ text: "malformed-secret" }] },
        createdAt: "not-a-date",
      };
      seedStore(dataDir, HANDOFFS, stored);

      await expect(storage.getAgentHandoff("h1")).resolves.toBeNull();
      await expect(storage.deleteAgentHandoff("h1", "e2")).rejects.toThrow("another environment");
      await expect(storage.deleteAgentHandoff("h1", "e1")).resolves.toBe(true);
      expect(JSON.stringify(readStoredHandoffs(dataDir))).not.toContain("malformed-secret");
      expect(storageFilesContain(dataDir, "malformed-secret")).toBe(false);
      await expect(storage.getAgentHandoff("h2")).resolves.not.toBeNull();
    });
  });

  test("serializes concurrent writers sharing one data directory", async () => {
    await withStorage(async (storage) => {
      const second = new StorageService(storage.getDataDir());
      await second.init();
      await Promise.all([
        storage.saveAgentHandoff("h1", "e1", 1, { messages: [{ id: "m1" }] }),
        second.saveAgentHandoff("h2", "e1", 1, { messages: [{ id: "m2" }] }),
      ]);
      await expect(storage.getAgentHandoff("h1")).resolves.not.toBeNull();
      await expect(storage.getAgentHandoff("h2")).resolves.not.toBeNull();
    });
  });

  test("deletes only one environment's handoffs", async () => {
    await withStorage(async (storage) => {
      await storage.saveAgentHandoff("h1", "e1", 1, {
        messages: [{ text: "secret-e1" }],
      });
      await storage.saveAgentHandoff("h2", "e2", 1, { messages: [] });
      const dataDir = storage.getDataDir();
      const stored = readStoredHandoffs(dataDir);
      stored.h1 = {
        environmentId: "e1",
        snapshot: { messages: [{ text: "secret-e1" }] },
        createdAt: "invalid",
      };
      seedStore(dataDir, HANDOFFS, stored);

      expect(await storage.deleteAgentHandoffsByEnvironment("e1")).toEqual(["h1"]);
      expect(await storage.getAgentHandoff("h1")).toBeNull();
      expect(await storage.getAgentHandoff("h2")).not.toBeNull();

      expect(JSON.stringify(readStoredHandoffs(dataDir))).not.toContain("secret-e1");
      expect(storageFilesContain(dataDir, "secret-e1")).toBe(false);
    });
  });

  test("deleting a stale reference leaves no store when the feature was never used", async () => {
    await withStorage(async (storage) => {
      const dataDir = storage.getDataDir();
      expect(hasStore(dataDir, HANDOFFS)).toBe(false);

      await expect(storage.deleteAgentHandoff("never-existed", "e1")).resolves.toBe(false);

      // The "always rewrite" recovery path only makes sense for a primary that
      // exists and may be corrupt. Creating one here would leave a trace on an
      // installation that never transferred a conversation.
      expect(hasStore(dataDir, HANDOFFS)).toBe(false);
    });
  });

  test("prunes handoffs the layout no longer references, per environment", async () => {
    await withStorage(async (storage) => {
      await storage.saveAgentHandoff("kept", "e1", 1, {
        messages: [{ text: "still-referenced" }],
      });
      await storage.saveAgentHandoff("orphan", "e1", 1, {
        messages: [{ text: "orphan-secret" }],
      });
      await storage.saveAgentHandoff("other-env", "e2", 1, {
        messages: [{ text: "other-env-secret" }],
      });

      // A record whose delete was dropped is indistinguishable from a live one
      // by id alone; only the layout's reference set can tell them apart.
      expect(await storage.pruneAgentHandoffs("e1", ["kept"])).toEqual(["orphan"]);
      expect(await storage.getAgentHandoff("kept")).not.toBeNull();
      expect(await storage.getAgentHandoff("orphan")).toBeNull();
      expect(await storage.getAgentHandoff("other-env")).not.toBeNull();

      const dataDir = storage.getDataDir();
      const serialized = JSON.stringify(readStoredHandoffs(dataDir));
      expect(serialized).not.toContain("orphan-secret");
      expect(serialized).toContain("still-referenced");
      expect(storageFilesContain(dataDir, "orphan-secret")).toBe(false);
      expect(storageFilesContain(dataDir, "other-env-secret")).toBe(true);

      // Idempotent, and a no-op prune must not rewrite anything.
      const write = spyOn(storageDatabase(storage), "writeStore");
      expect(await storage.pruneAgentHandoffs("e1", ["kept"])).toEqual([]);
      expect(write).not.toHaveBeenCalled();
      write.mockRestore();
      expect(await storage.getAgentHandoff("kept")).not.toBeNull();
    });
  });

  test("pruning an environment with no referenced ids removes all of its handoffs", async () => {
    await withStorage(async (storage) => {
      await storage.saveAgentHandoff("h1", "e1", 1, { messages: [{ text: "gone" }] });
      await storage.saveAgentHandoff("h2", "e2", 1, { messages: [{ text: "kept" }] });

      expect(await storage.pruneAgentHandoffs("e1", [])).toEqual(["h1"]);
      expect(await storage.getAgentHandoff("h1")).toBeNull();
      expect(await storage.getAgentHandoff("h2")).not.toBeNull();

      await expect(storage.pruneAgentHandoffs("", ["h1"])).rejects.toThrow(
        "environment ID must not be blank",
      );
    });
  });

  test("prunes a malformed entry that cannot be proven still referenced", async () => {
    await withStorage(async (storage) => {
      await storage.saveAgentHandoff("h1", "e1", 1, { messages: [{ text: "malformed" }] });
      const dataDir = storage.getDataDir();
      const stored = readStoredHandoffs(dataDir);
      stored.h1 = {
        environmentId: "e1",
        snapshot: { messages: [{ text: "malformed-prune-secret" }] },
        createdAt: "not-a-date",
      };
      seedStore(dataDir, HANDOFFS, stored);

      expect(await storage.pruneAgentHandoffs("e1", [])).toEqual(["h1"]);
      expect(JSON.stringify(readStoredHandoffs(dataDir))).not.toContain("malformed");
      expect(storageFilesContain(dataDir, "malformed-prune-secret")).toBe(false);
    });
  });
});
