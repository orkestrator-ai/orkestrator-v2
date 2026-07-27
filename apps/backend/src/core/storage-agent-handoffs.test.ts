import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";

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

      const handoffFile = path.join(storage.getDataDir(), "agent-handoffs.json");
      const mode = (await fs.stat(handoffFile)).mode & 0o777;
      expect(mode).toBe(0o600);

      const retried = await storage.saveAgentHandoff(
        "h1",
        "e1",
        1,
        { sourceProvider: "codex", messages: [] },
      );
      expect(retried).toEqual(saved);
    });
  });

  test("validates ownership, environment lifecycle and size", async () => {
    await withStorage(async (storage) => {
      await storage.saveAgentHandoff("h1", "e1", 1, { messages: [] });
      await expect(
        storage.saveAgentHandoff("h1", "e2", 1, { messages: [] }),
      ).rejects.toThrow("another environment");
      await storage.updateEnvironment("e2", {
        deletionRequestedAt: new Date().toISOString(),
      });
      await expect(
        storage.saveAgentHandoff("h2", "e2", 1, { messages: [] }),
      ).rejects.toThrow("being deleted");
      await expect(
        storage.saveAgentHandoff("h3", "e1", 1, {
          messages: ["x".repeat(32 * 1024 * 1024)],
        }),
      ).rejects.toThrow("32 MB");
    });
  });

  test("deletes only one environment's handoffs", async () => {
    await withStorage(async (storage) => {
      await storage.saveAgentHandoff("h1", "e1", 1, { messages: [] });
      await storage.saveAgentHandoff("h2", "e2", 1, { messages: [] });
      expect(await storage.deleteAgentHandoffsByEnvironment("e1")).toEqual(["h1"]);
      expect(await storage.getAgentHandoff("h1")).toBeNull();
      expect(await storage.getAgentHandoff("h2")).not.toBeNull();
    });
  });
});
