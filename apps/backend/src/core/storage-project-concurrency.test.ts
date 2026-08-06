import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Project } from "./models.js";
import { StorageService } from "./storage.js";

function project(id: string): Project {
  return {
    id,
    name: id,
    gitUrl: `https://example.invalid/${id}.git`,
    localPath: `/projects/${id}`,
    addedAt: new Date(0).toISOString(),
    order: 0,
  };
}

async function withSharedStorage<T>(
  run: (first: StorageService, second: StorageService) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-project-storage-lock-"));
  const first = new StorageService(dataDir);
  const second = new StorageService(dataDir);
  await Promise.all([first.init(), second.init()]);
  try {
    return await run(first, second);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

describe("StorageService project mutation serialization", () => {
  test("does not lose concurrent additions from backend instances sharing a data directory", async () => {
    await withSharedStorage(async (first, second) => {
      const projects = Array.from({ length: 24 }, (_, index) => project(`project-${index}`));
      await Promise.all(projects.map((candidate, index) => (
        (index % 2 === 0 ? first : second).addProject(candidate)
      )));

      const stored = await first.loadProjects();
      expect(stored.map((candidate) => candidate.id).sort()).toEqual(
        projects.map((candidate) => candidate.id).sort(),
      );
      expect(new Set(stored.map((candidate) => candidate.order)).size).toBe(projects.length);
    });
  });

  test("serializes add, update, reorder, and remove through the same project lock", async () => {
    await withSharedStorage(async (first, second) => {
      await first.addProject(project("first"));
      await first.addProject(project("second"));

      await Promise.all([
        first.updateProject("first", { name: "renamed" }),
        second.addProject(project("third")),
      ]);
      await Promise.all([
        first.removeProject("second"),
        second.reorderProjects(["third", "first"]),
      ]);

      await expect(first.loadProjects()).resolves.toMatchObject([
        { id: "third", order: 0 },
        { id: "first", name: "renamed", order: 1 },
      ]);
    });
  });

  test("coordinates the same creation path across StorageService instances", async () => {
    await withSharedStorage(async (first, second) => {
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
      let markFirstEntered!: () => void;
      const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
      let secondEntered = false;

      const firstOperation = first.withProjectCreationLock("/canonical/project", async () => {
        markFirstEntered();
        await firstGate;
      });
      await firstEntered;
      const secondOperation = second.withProjectCreationLock("/canonical/project", async () => {
        secondEntered = true;
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(secondEntered).toBe(false);
      releaseFirst();
      await Promise.all([firstOperation, secondOperation]);
      expect(secondEntered).toBe(true);
    });
  });
});
