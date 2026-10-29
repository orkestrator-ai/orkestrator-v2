import { expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnvironment, StorageService } from "./storage.js";

const override = { ref: "refs/heads/main", commit: "a".repeat(40), subject: "Chosen base" };

test("real storage normalizes, rejects malformed overrides, restarts, and persists explicit clearing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ork-diff-base-storage-"));
  let storage = new StorageService(dir);
  try {
    await storage.init();
    const environment = await storage.addEnvironment(createEnvironment("project"));
    await storage.updateEnvironment(environment.id, {
      diffBaseOverride: {
        ...override,
        commit: override.commit.toUpperCase(),
        subject: "  Chosen base  ",
      },
    });
    expect((await storage.getEnvironment(environment.id))?.diffBaseOverride).toEqual(override);
    for (const malformed of [
      { ref: "main", commit: override.commit },
      { ref: override.ref, commit: "bad" },
      { ref: "refs/heads/a b", commit: override.commit },
      5,
    ]) {
      await expect(
        storage.updateEnvironment(environment.id, { diffBaseOverride: malformed }),
      ).rejects.toThrow();
      expect((await storage.getEnvironment(environment.id))?.diffBaseOverride).toEqual(override);
    }
    storage.close();
    storage = new StorageService(dir);
    await storage.init();
    expect((await storage.getEnvironment(environment.id))?.diffBaseOverride).toEqual(override);
    await storage.updateEnvironment(environment.id, { diffBaseOverride: null });
    storage.close();
    storage = new StorageService(dir);
    await storage.init();
    expect((await storage.getEnvironment(environment.id))?.diffBaseOverride).toBeNull();
    await storage.updateEnvironment(environment.id, {
      worktreePath: "/old",
      diffBaseOverride: override,
    });
    await storage.updateEnvironment(environment.id, { worktreePath: "/old" });
    expect((await storage.getEnvironment(environment.id))?.diffBaseOverride).toEqual(override);
    await storage.updateEnvironment(environment.id, { worktreePath: "/replacement" });
    // Moving the existing checkout retains its readable base. Replacement callers
    // explicitly clear the override, as exercised by the lifecycle integration test.
    expect((await storage.getEnvironment(environment.id))?.diffBaseOverride).toEqual(override);
  } finally {
    storage.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
