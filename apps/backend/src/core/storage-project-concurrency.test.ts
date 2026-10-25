import { describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Project } from "./models.js";
import { StorageService } from "./storage.js";
import { openBackendDatabase } from "./storage-stores.js";
import { storageDatabase, storageInternals } from "./storage-test-support.js";

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

const CREATION_LEASE_PREFIX = "project-creation-locks/";

function creationLeaseName(canonicalPath: string): string {
  return `${CREATION_LEASE_PREFIX}${createHash("sha256").update(canonicalPath).digest("hex")}`;
}

/** Names of the held creation leases, read through a separate connection. */
function creationLeases(dataDir: string): string[] {
  const database = openBackendDatabase(dataDir);
  try {
    const rows = database.db
      .query("SELECT name FROM leases WHERE substr(name, 1, ?) = ? ORDER BY name")
      .all(CREATION_LEASE_PREFIX.length, CREATION_LEASE_PREFIX) as Array<{ name: string }>;
    return rows.map((row) => row.name);
  } finally {
    database.close();
  }
}

function hasLease(dataDir: string, name: string): boolean {
  const database = openBackendDatabase(dataDir);
  try {
    return database.db.query("SELECT 1 FROM leases WHERE name = ?").get(name) !== null;
  } finally {
    database.close();
  }
}

/**
 * Takes `name` from another backend's connection. With `heartbeatAgeMs` the
 * holder then stops heartbeating, as a crashed or stalled backend would.
 */
async function holdLease(
  dataDir: string,
  name: string,
  heartbeatAgeMs?: number,
): Promise<{ release: () => Promise<void>; crash: () => void }> {
  const database = openBackendDatabase(dataDir);
  const release = await database.acquireLease(name, "test");
  if (heartbeatAgeMs !== undefined) {
    database.db
      .query("UPDATE leases SET heartbeat_at = ? WHERE name = ?")
      .run(Date.now() - heartbeatAgeMs, name);
  }
  return {
    release: async () => {
      await release();
      database.close();
    },
    crash: () => {
      // Closing first leaves the row behind; the release only stops the timer.
      database.close();
      void release();
    },
  };
}

/** Reaches the private queue map so its cleanup can be asserted directly. */
function creationQueueSize(storage: StorageService): number {
  const tails = (storage as unknown as { context: { mutationTails: Map<string, unknown> } }).context
    .mutationTails;
  return [...tails.keys()].filter((key) => key.startsWith(CREATION_LEASE_PREFIX)).length;
}

/** The queue drops a settled tail in a follow-up microtask. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Freezes the clock for the first `frozenCalls` reads and then jumps past an
 * acquire deadline, so a wait on a live holder times out without sleeping.
 */
async function withClockJump<T>(frozenCalls: number, jumpMs: number, run: () => Promise<T>) {
  const originalNow = Date.now;
  const startedAt = originalNow();
  let calls = 0;
  Date.now = () => {
    calls += 1;
    return calls <= frozenCalls ? startedAt : startedAt + jumpMs;
  };
  try {
    return await run();
  } finally {
    Date.now = originalNow;
  }
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
      expect(creationLeases(dataDir)).toEqual([]);
    });
  });

  test("releases the creation lease and queue entry after success", async () => {
    await withSharedStorage(async (first, _second, dataDir) => {
      await first.withProjectCreationLock("/canonical/clean", async () => {
        expect(creationLeases(dataDir)).toEqual([creationLeaseName("/canonical/clean")]);
      });

      // A leaked lease would silently stall the next creation until the stale
      // threshold expired, and a leaked queue entry would grow forever.
      expect(creationLeases(dataDir)).toEqual([]);
      await settle();
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
      await settle();
      expect(creationQueueSize(first)).toBe(0);
    });
  });

  test("recovers a creation lock abandoned by a crashed backend", async () => {
    await withSharedStorage(async (first, _second, dataDir) => {
      // Older than the creation lock's 90s stale threshold, which is deliberately
      // longer than the default because the critical section spans CLI work.
      const holder = await holdLease(dataDir, creationLeaseName("/canonical/abandoned"), 100_000);
      holder.crash();

      await expect(
        first.withProjectCreationLock("/canonical/abandoned", async () => "taken"),
      ).resolves.toBe("taken");
      expect(creationLeases(dataDir)).toEqual([]);
    });
  });

  test("does not steal a creation lock that is merely older than the default threshold", async () => {
    await withSharedStorage(async (first, _second, dataDir) => {
      const holder = await holdLease(dataDir, creationLeaseName("/canonical/slow"), 30_000);

      let entered = false;
      const attempt = first.withProjectCreationLock("/canonical/slow", async () => {
        entered = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      // 30s exceeds the 15s default but not the creation lock's 90s threshold,
      // so a holder stalled mid-`gh` keeps its lock.
      expect(entered).toBe(false);

      await holder.release();
      await attempt;
      expect(entered).toBe(true);
    });
  });

  test("a longer acquire timeout lets a waiter outlast a nested path-wait-plus-clone interval", async () => {
    await withSharedStorage(async (first, second) => {
      let releaseFirst!: () => void;
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let markFirstEntered!: () => void;
      const firstEntered = new Promise<void>((resolve) => {
        markFirstEntered = resolve;
      });

      const holder = first.withProjectCreationLock("git-url:https://example.invalid/a.git", () =>
        first.withProjectCreationLock("/canonical/busy-path", async () => {
          markFirstEntered();
          await firstGate;
        }),
      );
      await firstEntered;

      let waiterEntered = false;
      const waiter = second.withProjectCreationLock(
        "git-url:https://example.invalid/a.git",
        async () => {
          waiterEntered = true;
        },
        { acquireTimeoutMs: 400 },
      );

      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(waiterEntered).toBe(false);
      const stillWaiting = await Promise.race([
        waiter.then(
          () => false,
          () => false,
        ),
        new Promise<true>((resolve) => setTimeout(() => resolve(true), 20)),
      ]);
      expect(stillWaiting).toBe(true);

      releaseFirst();
      await Promise.all([holder, waiter]);
      expect(waiterEntered).toBe(true);
    });
  });

  test("times out rather than entering a creation lock another backend holds", async () => {
    await withSharedStorage(async (first, _second, dataDir) => {
      // A live holder keeps heartbeating, so acquisition runs to the deadline
      // instead of taking the lease over.
      const holder = await holdLease(dataDir, creationLeaseName("/canonical/busy"));
      let entered = false;
      try {
        // The deadline and the first claim read the frozen clock; the deadline
        // check after that sees the 660s default timeout elapsed.
        await withClockJump(2, 660_001, async () => {
          await expect(
            first.withProjectCreationLock("/canonical/busy", async () => {
              entered = true;
            }),
          ).rejects.toThrow("Timed out waiting for project creation lock");
        });
        expect(entered).toBe(false);
        expect(creationLeases(dataDir)).toEqual([creationLeaseName("/canonical/busy")]);
      } finally {
        await holder.release();
      }
    });
  });
});

describe("StorageService project storage lock", () => {
  test("recovers a project lock abandoned by a crashed backend", async () => {
    await withSharedStorage(async (first, _second, dataDir) => {
      // Past the default 15s stale threshold.
      const holder = await holdLease(dataDir, "projects.json", 20_000);
      holder.crash();

      await expect(first.addProject(project("recovered"))).resolves.toMatchObject({
        id: "recovered",
      });
      expect(hasLease(dataDir, "projects.json")).toBe(false);
    });
  });

  test("times out while another backend holds the project lock", async () => {
    await withSharedStorage(async (first, _second, dataDir) => {
      const holder = await holdLease(dataDir, "projects.json");
      try {
        await withClockJump(2, 20_001, async () => {
          await expect(first.addProject(project("blocked"))).rejects.toThrow(
            "Timed out waiting for project storage lock",
          );
        });
      } finally {
        await holder.release();
      }
      expect(await first.loadProjects()).toEqual([]);
    });
  });

  test("propagates a database failure while claiming the project lock", async () => {
    await withSharedStorage(async (first) => {
      const database = storageDatabase(first);
      const transaction = spyOn(database, "transaction").mockImplementationOnce(() => {
        throw new Error("disk I/O error");
      });
      try {
        await expect(first.addProject(project("denied"))).rejects.toThrow("disk I/O error");
      } finally {
        transaction.mockRestore();
      }
      // The failed claim must not wedge the queue for the next mutation.
      await expect(first.addProject(project("after"))).resolves.toMatchObject({ id: "after" });
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
      storageInternals(first).context.changes.announce = (_kind, id) => {
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
