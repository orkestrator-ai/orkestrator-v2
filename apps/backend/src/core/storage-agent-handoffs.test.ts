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

async function readStoredHandoffs(
  filePath: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
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
        2,
        { sourceProvider: "codex", messages: [] },
      );
      // The id is the idempotency key: once committed, a retry cannot replace
      // either the version or snapshot with conflicting caller data.
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

  test("rejects malformed envelopes and non-serializable snapshots", async () => {
    await withStorage(async (storage) => {
      await expect(storage.getAgentHandoff(" ")).rejects.toThrow("must not be blank");
      await expect(
        storage.saveAgentHandoff("", "e1", 1, {}),
      ).rejects.toThrow("ID must not be blank");
      await expect(
        storage.saveAgentHandoff("h1", "", 1, {}),
      ).rejects.toThrow("environment ID must not be blank");
      await expect(
        storage.saveAgentHandoff("h1", "e1", 0, {}),
      ).rejects.toThrow("positive integer");
      await expect(
        storage.saveAgentHandoff("h1", "e1", 1, []),
      ).rejects.toThrow("must be an object");
      await expect(
        storage.saveAgentHandoff("h1", "missing", 1, {}),
      ).rejects.toThrow("environment not found");
      await expect(
        storage.deleteAgentHandoff("", "e1"),
      ).rejects.toThrow("ID must not be blank");
      await expect(
        storage.deleteAgentHandoff("h1", ""),
      ).rejects.toThrow("environment ID must not be blank");

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      await expect(
        storage.saveAgentHandoff("h1", "e1", 1, circular),
      ).rejects.toThrow("JSON serializable");
    });
  });

  test("deletes one owned handoff and scrubs every sensitive backup", async () => {
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

      await expect(
        storage.deleteAgentHandoff("h1", "e2"),
      ).rejects.toThrow("another environment");
      await expect(storage.deleteAgentHandoff("h1", "e1")).resolves.toBe(true);
      await expect(storage.getAgentHandoff("h1")).resolves.toBeNull();
      await expect(storage.getAgentHandoff("h2")).resolves.not.toBeNull();
      await expect(storage.deleteAgentHandoff("h1", "e1")).resolves.toBe(false);

      const primary = path.join(storage.getDataDir(), "agent-handoffs.json");
      for (const candidate of [
        primary,
        ...Array.from(
          { length: 5 },
          (_, index) => `${primary}.bak.${index + 1}`,
        ),
      ]) {
        const stat = await fs.stat(candidate).catch(() => null);
        if (!stat) continue;
        expect(stat.mode & 0o777).toBe(0o600);
        const stored = await readStoredHandoffs(candidate);
        expect(stored.h1).toBeUndefined();
        expect(JSON.stringify(stored)).not.toContain("secret-h1");
      }
    });
  });

  test("deletes a malformed primary entry and removes corrupt backups", async () => {
    await withStorage(async (storage) => {
      await storage.saveAgentHandoff("h1", "e1", 1, {
        messages: [{ text: "malformed-secret" }],
      });
      await storage.saveAgentHandoff("h2", "e2", 1, { messages: [] });

      const primary = path.join(storage.getDataDir(), "agent-handoffs.json");
      const stored = await readStoredHandoffs(primary);
      stored.h1 = {
        environmentId: "e1",
        snapshot: { messages: [{ text: "malformed-secret" }] },
        createdAt: "not-a-date",
      };
      await fs.writeFile(primary, `${JSON.stringify(stored, null, 2)}\n`);
      const corruptBackup = `${primary}.bak.1`;
      await fs.writeFile(corruptBackup, "{malformed-secret", { mode: 0o600 });

      await expect(storage.getAgentHandoff("h1")).resolves.toBeNull();
      await expect(storage.deleteAgentHandoff("h1", "e2"))
        .rejects.toThrow("another environment");
      await expect(storage.deleteAgentHandoff("h1", "e1")).resolves.toBe(true);
      expect(JSON.stringify(await readStoredHandoffs(primary)))
        .not.toContain("malformed-secret");
      expect(await fs.stat(`${primary}.bak.2`).catch(() => null)).toBeNull();
      await expect(storage.getAgentHandoff("h2")).resolves.not.toBeNull();
    });
  });

  test("enforces ownership when only a retained backup contains the handoff", async () => {
    await withStorage(async (storage) => {
      await storage.saveAgentHandoff("h1", "e1", 1, {
        messages: [{ text: "backup-only-secret" }],
      });
      await storage.saveAgentHandoff("h2", "e2", 1, { messages: [] });

      const primary = path.join(storage.getDataDir(), "agent-handoffs.json");
      const stored = await readStoredHandoffs(primary);
      delete stored.h1;
      await fs.writeFile(primary, `${JSON.stringify(stored, null, 2)}\n`, {
        mode: 0o600,
      });

      await expect(storage.deleteAgentHandoff("h1", "e2"))
        .rejects.toThrow("another environment");
      await expect(storage.deleteAgentHandoff("h1", "e1")).resolves.toBe(false);
      for (let index = 1; index <= 5; index += 1) {
        const backup = `${primary}.bak.${index}`;
        if (!await fs.stat(backup).catch(() => null)) continue;
        expect(JSON.stringify(await readStoredHandoffs(backup)))
          .not.toContain("backup-only-secret");
      }
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
      const primary = path.join(storage.getDataDir(), "agent-handoffs.json");
      const stored = await readStoredHandoffs(primary);
      stored.h1 = {
        environmentId: "e1",
        snapshot: { messages: [{ text: "secret-e1" }] },
        createdAt: "invalid",
      };
      await fs.writeFile(primary, `${JSON.stringify(stored, null, 2)}\n`);

      expect(await storage.deleteAgentHandoffsByEnvironment("e1")).toEqual(["h1"]);
      expect(await storage.getAgentHandoff("h1")).toBeNull();
      expect(await storage.getAgentHandoff("h2")).not.toBeNull();

      expect(JSON.stringify(await readStoredHandoffs(primary)))
        .not.toContain("secret-e1");
      for (let index = 1; index <= 5; index += 1) {
        const backup = `${primary}.bak.${index}`;
        if (!await fs.stat(backup).catch(() => null)) continue;
        expect(JSON.stringify(await readStoredHandoffs(backup)))
          .not.toContain("secret-e1");
      }
    });
  });
});
