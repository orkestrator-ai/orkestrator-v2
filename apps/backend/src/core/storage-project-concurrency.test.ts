import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
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
  run: (first: StorageService, second: StorageService, dataDir: string) => Promise<T>,
): Promise<T> {
  const dataDir = await fs.mkdtemp(path.join(tmpdir(), "ork-project-storage-lock-"));
  const first = new StorageService(dataDir);
  const second = new StorageService(dataDir);
  await Promise.all([first.init(), second.init()]);
  try {
    return await run(first, second, dataDir);
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

function creationLockDirectory(dataDir: string): string {
  return path.join(dataDir, "project-creation-locks");
}

async function creationLockFiles(dataDir: string): Promise<string[]> {
  return fs.readdir(creationLockDirectory(dataDir)).catch(() => [] as string[]);
}

/** Reaches the private queue map so its cleanup can be asserted directly. */
function creationQueueSize(storage: StorageService): number {
  return (
    storage as unknown as {
      projectCreationMutationQueues: Map<string, unknown>;
    }
  ).projectCreationMutationQueues.size;
}

describe("StorageService project mutation serialization", () => {
  test("does not lose concurrent additions from backend instances sharing a data directory", async () => {
    await withSharedStorage(async (first, second) => {
      const projects = Array.from({ length: 24 }, (_, index) => project(`project-${index}`));
      await Promise.all(
        projects.map((candidate, index) =>
          (index % 2 === 0 ? first : second).addProject(candidate),
        ),
      );

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
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let markFirstEntered!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        markFirstEntered = resolve;
      });
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

  test("releases the creation lock when the operation throws", async () => {
    await withSharedStorage(async (first, second, dataDir) => {
      await expect(
        first.withProjectCreationLock("/canonical/fails", async () => {
          throw new Error("creation failed");
        }),
      ).rejects.toThrow("creation failed");

      // A failed attempt must not wedge the path: the retry is the whole point
      // of preserving a partially created repository.
      await expect(
        second.withProjectCreationLock("/canonical/fails", async () => "retried"),
      ).resolves.toBe("retried");
      expect(await creationLockFiles(dataDir)).toEqual([]);
    });
  });

  test("removes the creation lock file and queue entry after success", async () => {
    await withSharedStorage(async (first, _second, dataDir) => {
      await first.withProjectCreationLock("/canonical/clean", async () => {
        expect((await creationLockFiles(dataDir)).length).toBe(1);
      });

      // A leaked lock file would silently stall the next creation until the
      // stale threshold expired, and a leaked queue entry would grow forever.
      expect(await creationLockFiles(dataDir)).toEqual([]);
      expect(creationQueueSize(first)).toBe(0);
    });
  });

  test("keeps the queue entry while a successor is still waiting", async () => {
    await withSharedStorage(async (first) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const held = first.withProjectCreationLock("/canonical/queued", () => gate);
      const queued = first.withProjectCreationLock("/canonical/queued", async () => undefined);
      expect(creationQueueSize(first)).toBe(1);
      release();
      await Promise.all([held, queued]);
      expect(creationQueueSize(first)).toBe(0);
    });
  });

  test("recovers a creation lock abandoned by a crashed backend", async () => {
    await withSharedStorage(async (first, _second, dataDir) => {
      const key = createHash("sha256").update("/canonical/abandoned").digest("hex");
      await fs.mkdir(creationLockDirectory(dataDir), { recursive: true });
      const lockPath = path.join(creationLockDirectory(dataDir), `${key}.lock`);
      await fs.writeFile(lockPath, "abandoned");
      // Older than the creation lock's 90s stale threshold, which is deliberately
      // longer than the default because the critical section spans CLI work.
      const staleTime = new Date(Date.now() - 100_000);
      await fs.utimes(lockPath, staleTime, staleTime);

      await expect(
        first.withProjectCreationLock("/canonical/abandoned", async () => "taken"),
      ).resolves.toBe("taken");
    });
  });

  test("does not steal a creation lock that is merely older than the default threshold", async () => {
    await withSharedStorage(async (first, _second, dataDir) => {
      const key = createHash("sha256").update("/canonical/slow").digest("hex");
      await fs.mkdir(creationLockDirectory(dataDir), { recursive: true });
      const lockPath = path.join(creationLockDirectory(dataDir), `${key}.lock`);
      await fs.writeFile(lockPath, "held-by-a-stalled-holder");
      const recentlyStale = new Date(Date.now() - 30_000);
      await fs.utimes(lockPath, recentlyStale, recentlyStale);

      let entered = false;
      const attempt = first.withProjectCreationLock("/canonical/slow", async () => {
        entered = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // 30s exceeds the 15s default but not the creation lock's 90s threshold,
      // so a holder stalled mid-`gh` keeps its lock.
      expect(entered).toBe(false);

      await fs.rm(lockPath, { force: true });
      await attempt;
      expect(entered).toBe(true);
    });
  });

  test("times out rather than entering a creation lock another backend holds", async () => {
    await withSharedStorage(async (first, _second, dataDir) => {
      const key = createHash("sha256").update("/canonical/busy").digest("hex");
      await fs.mkdir(creationLockDirectory(dataDir), { recursive: true });
      // A lock whose mtime cannot be read never looks stale, so acquisition
      // runs to the deadline instead of taking the lock over.
      await fs.symlink(
        path.join(dataDir, "missing-lock-target"),
        path.join(creationLockDirectory(dataDir), `${key}.lock`),
      );

      const originalNow = Date.now;
      const startedAt = originalNow();
      let calls = 0;
      Date.now = () => {
        calls += 1;
        return calls === 1 ? startedAt : startedAt + 360_001;
      };
      try {
        await expect(
          first.withProjectCreationLock("/canonical/busy", async () => undefined),
        ).rejects.toThrow("Timed out waiting for project creation lock");
      } finally {
        Date.now = originalNow;
      }
    });
  });
});

describe("StorageService project storage lock", () => {
  test("recovers a project lock abandoned by a crashed backend", async () => {
    await withSharedStorage(async (first, _second, dataDir) => {
      const lockPath = path.join(dataDir, "projects.json.lock");
      await fs.writeFile(lockPath, "abandoned");
      const staleTime = new Date(Date.now() - 20_000);
      await fs.utimes(lockPath, staleTime, staleTime);

      await expect(first.addProject(project("recovered"))).resolves.toMatchObject({
        id: "recovered",
      });
      await expect(fs.access(lockPath)).rejects.toThrow();
    });
  });

  test("times out when a project lock cannot be inspected", async () => {
    await withSharedStorage(async (first, _second, dataDir) => {
      await fs.symlink(
        path.join(dataDir, "missing-lock-target"),
        path.join(dataDir, "projects.json.lock"),
      );
      const originalNow = Date.now;
      const startedAt = originalNow();
      let calls = 0;
      Date.now = () => {
        calls += 1;
        return calls === 1 ? startedAt : startedAt + 20_001;
      };
      try {
        await expect(first.addProject(project("blocked"))).rejects.toThrow(
          "Timed out waiting for project storage lock",
        );
      } finally {
        Date.now = originalNow;
      }
    });
  });

  test("propagates a non-EEXIST project lock failure", async () => {
    await withSharedStorage(async (first) => {
      const originalOpen = fs.open;
      (fs as { open: typeof fs.open }).open = (async () => {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }) as typeof fs.open;
      try {
        await expect(first.addProject(project("denied"))).rejects.toThrow("permission denied");
      } finally {
        (fs as { open: typeof fs.open }).open = originalOpen;
      }
    });
  });
});

describe("StorageService.addProject validation", () => {
  test("runs the validator inside the projects lock and rejects without writing", async () => {
    await withSharedStorage(async (first) => {
      await first.addProject(project("existing"));

      await expect(
        first.addProject(project("blocked"), async (projects) => {
          expect(projects.map((candidate) => candidate.id)).toEqual(["existing"]);
          throw new Error("A project already uses this local path");
        }),
      ).rejects.toThrow("A project already uses this local path");

      expect((await first.loadProjects()).map((candidate) => candidate.id)).toEqual(["existing"]);
    });
  });

  test("sees an insert that landed after the caller's own pre-check", async () => {
    await withSharedStorage(async (first, second) => {
      // What a caller checks before doing minutes of CLI work.
      expect(await first.loadProjects()).toEqual([]);

      await second.addProject(project("arrived-late"));

      let observed: string[] = [];
      await first.addProject(project("slow-caller"), async (projects) => {
        observed = projects.map((candidate) => candidate.id);
      });

      // The validator reads the stored set at insert time, so it catches what
      // the caller's own stale pre-check could not.
      expect(observed).toContain("arrived-late");
    });
  });

  test("does not announce a project whose mutation rejected", async () => {
    await withSharedStorage(async (first) => {
      const announced: string[] = [];
      (first as unknown as { announce: (kind: string, id: string) => void }).announce = (
        _kind,
        id,
      ) => {
        announced.push(id);
      };

      await first.addProject(project("kept"));
      await expect(first.addProject(project("kept"))).rejects.toThrow("Duplicate project URL");
      await expect(first.removeProject("absent")).rejects.toThrow("Project not found");
      await expect(first.updateProject("absent", { name: "x" })).rejects.toThrow(
        "Project not found",
      );

      expect(announced).toEqual(["kept"]);
    });
  });
});
