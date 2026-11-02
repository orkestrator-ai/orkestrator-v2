import { describe, expect, test } from "bun:test";
import { nativeAgentSessionStorageKey } from "./native-agent-service-shared.js";
import { FrozenStoreSnapshot } from "./storage-frozen-snapshot.js";
import {
  readStoredValue,
  seedStore,
  seedUnreadableStore,
  storageInternals,
  withTemporaryStorage,
} from "./storage-test-support.js";
import type { Environment, StorageService } from "./storage.js";

function environment(id: string, order: number, name = id): Environment {
  return {
    id,
    projectId: "p1",
    name,
    branch: "main",
    containerId: null,
    status: "running",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    networkAccessMode: "restricted",
    order,
    environmentType: "local",
    setupScriptsComplete: true,
  };
}

async function seedEnvironments(storage: StorageService): Promise<void> {
  const dataDir = storage.getDataDir();
  await storage.addProject({
    id: "p1",
    name: "p1",
    gitUrl: "https://example.invalid/p1.git",
    localPath: null,
    addedAt: new Date(0).toISOString(),
    order: 0,
  });
  // Stored out of display order, without the normalized setup fields.
  seedStore(dataDir, "environments.json", [
    environment("e2", 2),
    environment("e1", 1),
    environment("e3", 3),
  ]);
}

describe("frozen store snapshots", () => {
  test("environments read as loadEnvironments reads them, shared and frozen per revision", async () => {
    await withTemporaryStorage(async (storage) => {
      await seedEnvironments(storage);
      const loaded = await storage.loadEnvironments();
      const first = await storage.readEnvironmentsSnapshot();
      expect(first).toEqual(loaded);
      expect(first.map((item) => item.id)).toEqual(["e1", "e2", "e3"]);

      const second = await storage.readEnvironmentsSnapshot();
      // A fresh array each call, the same decoded records while the revision holds.
      expect(second).not.toBe(first);
      second.reverse();
      expect((await storage.readEnvironmentsSnapshot()).map((item) => item.id)).toEqual([
        "e1",
        "e2",
        "e3",
      ]);
      expect(second[0]).toBe(first[2]!);
      expect(Object.isFrozen(first[0])).toBe(true);
      expect(() => {
        (first[0] as { name: string }).name = "changed";
      }).toThrow(TypeError);
      // The mutable copy is independent and unaffected.
      loaded[0]!.name = "local edit";
      expect((await storage.readEnvironmentsSnapshot())[0]!.name).toBe("e1");
    });
  });

  test("a write moves the revision; only the changed row is decoded again", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await seedEnvironments(storage);
      // The first whole-store write also persists every row's normalized fields.
      await storage.updateEnvironment("e2", { name: "warm" });
      const before = await storage.readEnvironmentsSnapshot();
      await storage.updateEnvironment("e2", { name: "renamed" });
      const after = await storage.readEnvironmentsSnapshot();
      expect(after.map((item) => item.name)).toEqual(["e1", "renamed", "e3"]);
      expect(after[0]).toBe(before[0]!);
      expect(after[2]).toBe(before[2]!);
      expect(after[1]).not.toBe(before[1]!);

      // Another connection (another backend process) moves the revision too.
      const stored = readStoredValue<Environment[]>(dataDir, "environments.json")!;
      seedStore(
        dataDir,
        "environments.json",
        stored.map((item) => (item.id === "e3" ? { ...item, name: "foreign" } : item)),
      );
      const foreign = await storage.readEnvironmentsSnapshot();
      expect(foreign.map((item) => item.name)).toEqual(["e1", "renamed", "foreign"]);
      expect(foreign[0]).toBe(before[0]!);
      expect(foreign).toEqual(await storage.loadEnvironments());
    });
  });

  test("an unreadable store reads as the repository's loader reads it", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      seedUnreadableStore(dataDir, "environments.json");
      expect(await storage.readEnvironmentsSnapshot()).toEqual(await storage.loadEnvironments());
      expect(await storage.readEnvironmentsSnapshot()).toEqual([]);
    });
  });

  test("native sessions read as listNativeAgentSessions reads them, without unreadable records", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await seedEnvironments(storage);
      const key = nativeAgentSessionStorageKey("e1", "codex", "env-e1:tab-1");
      await storage.getOrCreateNativeAgentSession(
        { key, environmentId: "e1", agent: "codex", logicalSessionKey: "env-e1:tab-1" },
        async () => "provider-1",
      );
      const stored = readStoredValue<Record<string, unknown>>(
        dataDir,
        "native-agent-sessions.json",
      )!;
      seedStore(dataDir, "native-agent-sessions.json", { ...stored, opaque: { from: "newer" } });

      const sessions = await storage.readNativeAgentSessionsSnapshot();
      expect(sessions).toEqual(await storage.listNativeAgentSessions());
      expect(sessions.map((session) => session.key)).toEqual([key]);
      expect(Object.isFrozen(sessions[0]!.interactionPolicy)).toBe(true);
      expect((await storage.readNativeAgentSessionsSnapshot())[0]).toBe(sessions[0]!);
    });
  });

  test("reads buffered writes inside atomically and discards rolled-back snapshots", async () => {
    await withTemporaryStorage(async (storage) => {
      await seedEnvironments(storage);
      const before = await storage.readEnvironmentsSnapshot();
      const { context } = storageInternals(storage);
      await expect(
        context.atomically(async () => {
          await storage.updateEnvironment("e1", { name: "buffered" });
          const snapshot = await storage.readEnvironmentsSnapshot();
          expect(snapshot).toEqual(await storage.loadEnvironments());
          expect(snapshot[0]!.name).toBe("buffered");
          expect(Object.isFrozen(snapshot[0])).toBe(true);
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect(await storage.readEnvironmentsSnapshot()).toEqual(before);
      await context.atomically(async () => {
        await storage.updateEnvironment("e1", { name: "committed" });
        expect((await storage.readEnvironmentsSnapshot())[0]!.name).toBe("committed");
      });
      expect((await storage.readEnvironmentsSnapshot())[0]!.name).toBe("committed");
    });
  });

  test("a valid document-mode store falls back to the loader", async () => {
    await withTemporaryStorage(async (storage, dataDir) => {
      await seedEnvironments(storage);
      await storage.readEnvironmentsSnapshot();
      seedUnreadableStore(
        dataDir,
        "environments.json",
        JSON.stringify([environment("document", 0)]),
      );
      const snapshot = await storage.readEnvironmentsSnapshot();
      expect(snapshot).toEqual(await storage.loadEnvironments());
      expect(snapshot[0]!.id).toBe("document");
      expect(Object.isFrozen(snapshot[0])).toBe(true);
    });
  });

  test("a store over the retained bound is decoded but not kept", async () => {
    await withTemporaryStorage(async (storage) => {
      await seedEnvironments(storage);
      const { context } = storageInternals(storage);
      const read = (maxRetainedLength: number) =>
        new FrozenStoreSnapshot(context, {
          filePath: context.file("environments.json"),
          build: (rows) => rows.map((row) => row.decoded),
          load: async () => [],
          maxRetainedLength,
        });
      const unbounded = read(Number.MAX_SAFE_INTEGER);
      expect((await unbounded.read())[0]).toBe((await unbounded.read())[0]);
      const bounded = read(0);
      const first = await bounded.read();
      expect(first).toHaveLength(3);
      expect(Object.isFrozen(first[0])).toBe(true);
      expect((await bounded.read())[0]).not.toBe(first[0]);
    });
  });
});
