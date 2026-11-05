import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readStorageDatabaseStore } from "@orkestrator/protocol/node/storage-database";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Project, Session } from "./models.js";
import { createProject, StorageService } from "./storage.js";
import {
  seedStore,
  seedUnreadableStore,
  storageDatabase,
  storageInternals,
} from "./storage-test-support.js";

const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ork-session-project-rows-"));
  directories.push(directory);
  return directory;
}

async function service(directory: string): Promise<StorageService> {
  const storage = new StorageService(directory);
  services.push(storage);
  await storage.init();
  return storage;
}

/** Records every row of `store` this connection writes. */
function countRowWrites(
  storage: StorageService,
  store: string,
): { keys: () => string[]; reset: () => void } {
  const { db } = storageDatabase(storage);
  const table = `${store}_row_writes`;
  db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${table} (key TEXT NOT NULL)`);
  for (const [name, event, row] of [
    ["insert", "INSERT", "new"],
    ["update", "UPDATE", "new"],
    ["delete", "DELETE", "old"],
  ] as const) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${store}_row_write_${name}
      AFTER ${event} ON main.store_rows WHEN ${row}.store = '${store}'
      BEGIN INSERT INTO ${table} VALUES (${row}.key); END`);
  }
  return {
    keys: () =>
      (db.query(`SELECT key FROM ${table}`).all() as Array<{ key: string }>).map((row) => row.key),
    reset: () => db.exec(`DELETE FROM ${table}`),
  };
}

/** Runs `run` while no whole-store read or write of `store` may happen. */
async function withoutWholeStoreAccess<T>(
  storage: StorageService,
  store: string,
  run: () => Promise<T>,
): Promise<T> {
  const database = storageDatabase(storage);
  const reads = spyOn(database, "readStore");
  const writes = spyOn(database, "writeStoreInTransaction");
  try {
    const result = await run();
    expect(reads.mock.calls.filter(([name]) => name === store)).toEqual([]);
    expect(writes.mock.calls.filter(([name]) => name === store)).toEqual([]);
    return result;
  } finally {
    reads.mockRestore();
    writes.mockRestore();
  }
}

function session(id: string, environmentId: string, order: number): Session {
  return {
    id,
    environmentId,
    containerId: "container",
    tabId: `tab-${id}`,
    sessionType: "plain",
    status: "connected",
    createdAt: `2026-11-01T00:00:${String(order).padStart(2, "0")}.000Z`,
    lastActivityAt: "2026-11-01T00:00:00.000Z",
    order,
  };
}

function project(index: number): Project {
  return {
    id: `project-${index}`,
    name: `project-${index}`,
    gitUrl: `https://example.com/project-${index}.git`,
    localPath: `/checkouts/project-${index}`,
    addedAt: "2026-11-01T00:00:00.000Z",
    order: index,
  };
}

function seedSessions(directory: string, count = 4): void {
  seedStore(
    directory,
    "sessions.json",
    Array.from({ length: count * 2 }, (_, index) =>
      session(`session-${index}`, `environment-${index % 2}`, Math.floor(index / 2)),
    ),
  );
}

describe("owner-scoped session compatibility", () => {
  test("single removal retains the second owner's duplicate and shared buffer", async () => {
    const directory = await dataDir();
    const other = session("shared", "B", 1);
    seedStore(directory, "sessions.json", [session("shared", "A", 0), other]);
    const storage = await service(directory);
    await storage.saveSessionBuffer("shared", "buffer");
    await storage.removeSession("shared");
    expect(readStorageDatabaseStore(directory, "sessions")).toEqual([other]);
    expect(await storage.loadSessionBuffer("shared")).toBe("buffer");
  });

  for (const operation of ["disconnect", "reorder"] as const) {
    test(operation + " retains distinct same-owner duplicates", async () => {
      const directory = await dataDir();
      const entries = [
        { ...session("shared", "A", 3), name: "first", tabId: "one" },
        { ...session("shared", "A", 7), name: "second", tabId: "two" },
      ];
      seedStore(directory, "sessions.json", entries);
      const storage = await service(directory);
      if (operation === "disconnect") await storage.disconnectEnvironmentSessions("A");
      else await storage.reorderSessions("A", ["shared"]);
      const stored = readStorageDatabaseStore(directory, "sessions") as Session[];
      expect(stored.map(({ name, tabId }) => ({ name, tabId }))).toEqual(
        entries.map(({ name, tabId }) => ({ name, tabId })),
      );
      expect(
        stored.map((entry) => (operation === "disconnect" ? entry.status : entry.order)),
      ).toEqual(operation === "disconnect" ? ["disconnected", "disconnected"] : [0, 7]);
    });
  }

  for (const operation of ["create", "disconnect", "reorder", "remove", "single-remove"] as const) {
    test(operation + " refuses an unreadable sessions document without replacing it", async () => {
      const directory = await dataDir();
      const storage = await service(directory);
      seedUnreadableStore(directory, "sessions.json");
      const db = storageDatabase(storage);
      const before = db.readStoreHeader("sessions");
      const run = () => {
        if (operation === "create") return storage.createSession("A", "c", "t", "plain");
        if (operation === "disconnect") return storage.disconnectEnvironmentSessions("A");
        if (operation === "reorder") return storage.reorderSessions("A", []);
        if (operation === "single-remove") return storage.removeSession("shared");
        return storage.removeSessionsByEnvironment("A");
      };
      await expect(run()).rejects.toThrow();
      expect(db.readStoreHeader("sessions")).toEqual(before);
    });
  }
  for (const operation of ["remove", "disconnect", "reorder"] as const) {
    test(operation + " preserves another owner's duplicate ID", async () => {
      const directory = await dataDir();
      const other = { ...session("shared", "B", 7), name: "preserve every field" };
      seedStore(directory, "sessions.json", [
        other,
        session("shared", "A", 3),
        session("unique", "A", 0),
      ]);
      const storage = await service(directory);
      expect(storageDatabase(storage).readStoreHeader("sessions")?.mode).toBe("document");
      if (operation === "remove") {
        await storage.saveSessionBuffer("shared", "retained buffer");
        await storage.removeSessionsByEnvironment("A");
        expect(await storage.loadSessionBuffer("shared")).toBe("retained buffer");
      }
      if (operation === "disconnect") await storage.disconnectEnvironmentSessions("A");
      if (operation === "reorder") await storage.reorderSessions("A", ["shared", "unique"]);
      const stored = readStorageDatabaseStore(directory, "sessions") as Session[];
      expect(stored.filter((item) => item.environmentId === "B")).toEqual([other]);
      const own = stored.filter((item) => item.environmentId === "A");
      if (operation === "remove") expect(own).toEqual([]);
      if (operation === "disconnect")
        expect(own.every((item) => item.status === "disconnected")).toBe(true);
      if (operation === "reorder") expect(own.map((item) => item.order)).toEqual([0, 1]);
    });
  }

  for (const operation of ["remove", "disconnect", "reorder", "create"] as const) {
    test(operation + " refuses damaged rows in the target environment", async () => {
      const directory = await dataDir();
      seedSessions(directory);
      const storage = await service(directory);
      const db = storageDatabase(storage);
      db.db
        .query("UPDATE store_rows SET value = '{' WHERE store = 'sessions' AND key = 'session-0'")
        .run();
      const before = db.db.query("SELECT * FROM store_rows WHERE store = 'sessions'").all();
      const run = () => {
        if (operation === "remove") return storage.removeSessionsByEnvironment("environment-0");
        if (operation === "disconnect")
          return storage.disconnectEnvironmentSessions("environment-0");
        if (operation === "reorder") return storage.reorderSessions("environment-0", ["session-2"]);
        return storage.createSession("environment-0", "container", "new", "plain");
      };
      await expect(run()).rejects.toThrow();
      expect(db.db.query("SELECT * FROM store_rows WHERE store = 'sessions'").all()).toEqual(
        before,
      );
    });
  }
});

describe("session row writes", () => {
  test("one field writes one row and reads and writes nothing else", async () => {
    const directory = await dataDir();
    seedSessions(directory);
    const storage = await service(directory);
    const writes = countRowWrites(storage, "sessions");
    const database = storageDatabase(storage);
    const other = database.db
      .query("SELECT * FROM store_rows WHERE store = 'sessions' AND key = 'session-1'")
      .get();

    const updated = await withoutWholeStoreAccess(storage, "sessions", () =>
      storage.updateSession("session-0", { name: "renamed" }),
    );

    expect(updated).toMatchObject({ id: "session-0", name: "renamed", order: 0 });
    expect(writes.keys()).toEqual(["session-0"]);
    expect(
      database.db
        .query("SELECT * FROM store_rows WHERE store = 'sessions' AND key = 'session-1'")
        .get(),
    ).toEqual(other);
    expect((await storage.getSession("session-0"))?.name).toBe("renamed");

    // An update that changes nothing writes nothing at all.
    writes.reset();
    const revision = database.storeRevision("sessions");
    await storage.updateSession("session-0", { name: "renamed" });
    expect(writes.keys()).toEqual([]);
    expect(database.storeRevision("sessions")).toBe(revision);
  });

  test("a missing session is refused and writes nothing", async () => {
    const directory = await dataDir();
    seedSessions(directory);
    const storage = await service(directory);
    const writes = countRowWrites(storage, "sessions");
    await expect(storage.updateSession("absent", { name: "x" })).rejects.toThrow(
      "Session not found: absent",
    );
    await expect(storage.removeSession("absent")).rejects.toThrow("Session not found: absent");
    expect(writes.keys()).toEqual([]);
  });

  test("every writer touches only the rows it changes", async () => {
    const directory = await dataDir();
    seedSessions(directory);
    const storage = await service(directory);
    const writes = countRowWrites(storage, "sessions");

    const created = await withoutWholeStoreAccess(storage, "sessions", () =>
      storage.createSession("environment-0", "container", "new-tab", "plain"),
    );
    expect(created.order).toBe(4);
    expect(writes.keys()).toEqual([created.id]);

    writes.reset();
    await withoutWholeStoreAccess(storage, "sessions", () => storage.removeSession(created.id));
    expect(writes.keys()).toEqual([created.id]);

    writes.reset();
    const disconnected = await withoutWholeStoreAccess(storage, "sessions", () =>
      storage.disconnectEnvironmentSessions("environment-1"),
    );
    expect(disconnected.map((row) => row.id).toSorted()).toEqual(
      ["session-1", "session-3", "session-5", "session-7"].toSorted(),
    );
    expect(writes.keys().toSorted()).toEqual(disconnected.map((row) => row.id).toSorted());

    // Disconnecting again finds nothing to change.
    writes.reset();
    expect(await storage.disconnectEnvironmentSessions("environment-1")).toEqual([]);
    expect(writes.keys()).toEqual([]);

    // A swap writes two rows; an id from another environment changes nothing.
    writes.reset();
    const reordered = await withoutWholeStoreAccess(storage, "sessions", () =>
      storage.reorderSessions("environment-0", [
        "session-2",
        "session-0",
        "session-1",
        "session-4",
        "session-6",
      ]),
    );
    expect(reordered.map((row) => [row.id, row.order])).toEqual([
      ["session-2", 0],
      ["session-0", 1],
      ["session-4", 3],
      ["session-6", 4],
    ]);
    expect((await storage.getSession("session-1"))?.order).toBe(0);
    expect(writes.keys().toSorted()).toEqual(
      ["session-0", "session-2", "session-4", "session-6"].toSorted(),
    );

    writes.reset();
    const removed = await withoutWholeStoreAccess(storage, "sessions", () =>
      storage.removeSessionsByEnvironment("environment-1"),
    );
    expect(removed.toSorted()).toEqual(
      ["session-1", "session-3", "session-5", "session-7"].toSorted(),
    );
    expect(writes.keys().toSorted()).toEqual(removed.toSorted());
    expect(await storage.getSessionsByEnvironment("environment-0")).toHaveLength(4);
  });

  test("a full environment evicts its oldest disconnected session in the same commit", async () => {
    const directory = await dataDir();
    const stored = Array.from({ length: 20 }, (_, index) =>
      session(`full-${index}`, "environment-0", index),
    );
    stored[7]!.status = "disconnected";
    stored[3]!.status = "disconnected";
    seedStore(directory, "sessions.json", [...stored, session("other", "environment-1", 0)]);
    const storage = await service(directory);
    const writes = countRowWrites(storage, "sessions");

    const created = await storage.createSession("environment-0", "container", "new", "plain");

    expect(await storage.getSession("full-3")).toBeNull();
    expect(await storage.getSession("full-7")).not.toBeNull();
    expect(created.order).toBe(20);
    expect(writes.keys().toSorted()).toEqual(["full-3", created.id].toSorted());
  });

  test("a store written whole by an older build keeps working, and is read by one", async () => {
    const directory = await dataDir();
    seedSessions(directory);
    const storage = await service(directory);
    await storage.updateSession("session-0", { name: "row write" });
    // An older backend's whole-value write on the same database.
    storageDatabase(storage).updateStore(
      "sessions",
      (): Session[] => [],
      (sessions) => {
        sessions.find((row) => row.id === "session-1")!.name = "older write";
      },
    );
    await storage.updateSession("session-2", { name: "second row write" });

    const stored = readStorageDatabaseStore(directory, "sessions") as Session[];
    expect(stored.map((row) => row.id)).toEqual(
      Array.from({ length: 8 }, (_, index) => `session-${index}`),
    );
    expect(stored.find((row) => row.id === "session-0")?.name).toBe("row write");
    expect(stored.find((row) => row.id === "session-1")?.name).toBe("older write");
    expect(stored.find((row) => row.id === "session-2")?.name).toBe("second row write");
  });

  test("arrangements preserve distinct metadata of duplicate projects", async () => {
    const directory = await dataDir();
    const entries = [
      project(0),
      { ...project(0), name: "second", localPath: "/second" },
      project(1),
    ];
    seedStore(directory, "projects.json", entries);
    const storage = await service(directory);
    await storage.reorderProjects(["project-1", "project-0"]);
    await storage.arrangeProjects(["project-0", "project-1"], { "project-0": "folder" });
    await storage.arrangeProjectsByIntent({
      kind: "add-to-folder",
      projectId: "project-0",
      folder: "new-folder",
    });
    const stored = readStorageDatabaseStore(directory, "projects") as Project[];
    expect(
      stored
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map(({ name, gitUrl, localPath }) => ({ name, gitUrl, localPath })),
    ).toEqual(
      entries
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map(({ name, gitUrl, localPath }) => ({ name, gitUrl, localPath })),
    );
  });

  test("a store held whole falls back without losing an item", async () => {
    const directory = await dataDir();
    const duplicate = session("twin", "environment-0", 0);
    seedStore(directory, "sessions.json", [duplicate, { ...duplicate }, session("x", "e", 1)]);
    const storage = await service(directory);
    expect(storageDatabase(storage).readStoreHeader("sessions")?.mode).toBe("document");

    await storage.updateSession("x", { name: "renamed" });

    const stored = readStorageDatabaseStore(directory, "sessions") as Session[];
    expect(stored.map((row) => row.id)).toEqual(["twin", "twin", "x"]);
    expect(stored[2]?.name).toBe("renamed");
  });

  test("one damaged row no longer costs every other session", async () => {
    const directory = await dataDir();
    seedSessions(directory);
    const storage = await service(directory);
    const { db } = storageDatabase(storage);
    db.query("UPDATE store_rows SET value = '{ not json' WHERE store = 'sessions' AND key = ?").run(
      "session-3",
    );
    db.query("UPDATE stores SET revision = revision + 1 WHERE name = 'sessions'").run();

    await storage.updateSession("session-0", { name: "renamed" });
    await storage.createSession("environment-0", "container", "new", "plain");

    expect((await storage.getSession("session-0"))?.name).toBe("renamed");
    expect(await storage.getSession("session-2")).not.toBeNull();
    expect(
      db
        .query("SELECT value FROM store_rows WHERE store = 'sessions' AND key = ?")
        .get("session-3"),
    ).toEqual({ value: "{ not json" });
  });
});

describe("project row writes", () => {
  async function projectStorage(count = 4): Promise<{
    directory: string;
    storage: StorageService;
    writes: ReturnType<typeof countRowWrites>;
  }> {
    const directory = await dataDir();
    seedStore(
      directory,
      "projects.json",
      Array.from({ length: count }, (_, index) => project(index)),
    );
    const storage = await service(directory);
    return { directory, storage, writes: countRowWrites(storage, "projects") };
  }

  test("one field writes one row and reads and writes nothing else", async () => {
    const { storage, writes } = await projectStorage();
    const database = storageDatabase(storage);
    const other = database.db
      .query("SELECT * FROM store_rows WHERE store = 'projects' AND key = 'project-1'")
      .get();

    const updated = await withoutWholeStoreAccess(storage, "projects", () =>
      storage.updateProject("project-0", { name: "renamed" }),
    );

    expect(updated).toMatchObject({ id: "project-0", name: "renamed", order: 0 });
    expect(writes.keys()).toEqual(["project-0"]);
    expect(
      database.db
        .query("SELECT * FROM store_rows WHERE store = 'projects' AND key = 'project-1'")
        .get(),
    ).toEqual(other);

    writes.reset();
    const revision = database.storeRevision("projects");
    await storage.updateProject("project-0", { name: "renamed" });
    expect(writes.keys()).toEqual([]);
    expect(database.storeRevision("projects")).toBe(revision);
  });

  test("a read of one project reads one row", async () => {
    const { storage } = await projectStorage();
    const found = await withoutWholeStoreAccess(storage, "projects", () =>
      storage.getProject("project-2"),
    );
    expect(found?.name).toBe("project-2");
    expect(await storage.getProject("absent")).toBeNull();
    // Each read is its own copy.
    found!.name = "changed by a caller";
    expect((await storage.getProject("project-2"))?.name).toBe("project-2");
  });

  test("a new remote is still checked against every other project", async () => {
    const { storage, writes } = await projectStorage();
    await expect(
      storage.updateProject("project-0", { gitUrl: "https://example.com/project-1.git" }),
    ).rejects.toThrow("Duplicate project URL");
    expect(writes.keys()).toEqual([]);

    await storage.updateProject("project-0", { gitUrl: "https://example.com/moved.git" });
    expect(writes.keys()).toEqual(["project-0"]);
    // Sending its own remote back is not a change to check.
    await withoutWholeStoreAccess(storage, "projects", () =>
      storage.updateProject("project-0", { gitUrl: "https://example.com/moved.git", name: "n" }),
    );
  });

  test("add, remove and arrange write only the rows they change", async () => {
    const { directory, storage, writes } = await projectStorage();
    const added = await storage.addProject(createProject("https://example.com/new.git"));
    expect(added.order).toBe(4);
    expect(writes.keys()).toEqual([added.id]);

    writes.reset();
    await storage.removeProject(added.id);
    expect(writes.keys()).toEqual([added.id]);
    await expect(storage.removeProject(added.id)).rejects.toThrow("Project not found");

    // Swapping the first two leaves the others alone.
    writes.reset();
    const arranged = await storage.reorderProjects([
      "project-1",
      "project-0",
      "project-2",
      "project-3",
    ]);
    expect(arranged.map((item) => item.id)).toEqual([
      "project-1",
      "project-0",
      "project-2",
      "project-3",
    ]);
    expect(writes.keys().toSorted()).toEqual(["project-0", "project-1"]);

    // A gesture that changes nothing writes nothing.
    writes.reset();
    await storage.arrangeProjectsByIntent({ kind: "remove-from-folder", projectId: "project-0" });
    expect(writes.keys()).toEqual([]);

    const stored = readStorageDatabaseStore(directory, "projects") as Project[];
    expect(stored.map((item) => item.id).toSorted()).toEqual(
      ["project-0", "project-1", "project-2", "project-3"].toSorted(),
    );
    expect((await storage.loadProjects()).map((item) => item.id)).toEqual([
      "project-1",
      "project-0",
      "project-2",
      "project-3",
    ]);
  });

  test("the revision-checked edit writes one row and keeps its conflict checks", async () => {
    const { storage, writes } = await projectStorage();
    const updated = await withoutWholeStoreAccess(storage, "projects", () =>
      storage.publicOperations.updateProjectAtRevision("project-0", undefined, { name: "api" }),
    );
    expect(updated.name).toBe("api");
    expect(writes.keys()).toEqual(["project-0"]);

    writes.reset();
    await expect(
      storage.publicOperations.updateProjectAtRevision("project-0", undefined, {
        gitUrl: "https://example.com/project-1.git",
      }),
    ).rejects.toThrow("already uses that remote URL");
    await expect(
      storage.publicOperations.updateProjectAtRevision("project-0", undefined, {
        localPath: "/checkouts/project-1",
      }),
    ).rejects.toThrow("already uses that checkout path");
    await expect(
      storage.publicOperations.updateProjectAtRevision("project-0", "stale", { name: "x" }),
    ).rejects.toThrow("changed since it was read");
    await expect(
      storage.publicOperations.updateProjectAtRevision("absent", undefined, { name: "x" }),
    ).rejects.toThrow("Project not found");
    expect(writes.keys()).toEqual([]);
  });

  test("a row write refuses a project gone since the read", async () => {
    const { storage } = await projectStorage();
    const stale = (await storage.getProject("project-0"))!;
    await storage.removeProject("project-0");
    // A holder whose lease was taken over cannot bring back a removed project.
    expect(() => storageInternals(storage).repos.projects.saveProject(stale)).toThrow(
      "Project not found",
    );
    expect(await storage.getProject("project-0")).toBeNull();
  });

  test("a store held whole falls back without losing an item", async () => {
    const directory = await dataDir();
    seedStore(directory, "projects.json", [project(0), project(0), project(1)]);
    const storage = await service(directory);
    expect(storageDatabase(storage).readStoreHeader("projects")?.mode).toBe("document");
    await storage.updateProject("project-1", { name: "renamed" });
    const stored = readStorageDatabaseStore(directory, "projects") as Project[];
    expect(stored.map((item) => item.id)).toEqual(["project-0", "project-0", "project-1"]);
    expect(stored[2]?.name).toBe("renamed");
  });
});

describe("concurrent writers", () => {
  test("two connections writing sessions and projects lose no update", async () => {
    const directory = await dataDir();
    seedSessions(directory);
    seedStore(directory, "projects.json", [project(0), project(1)]);
    const first = await service(directory);
    const second = await service(directory);

    await Promise.all(
      Array.from({ length: 10 }, (_, index) => [
        first.updateSession("session-0", { name: `name-${index}` }),
        second.updateSession("session-0", { lastActivityAt: `at-${index}` }),
        first.createSession("environment-0", "container", `first-${index}`, "plain"),
        second.createSession("environment-1", "container", `second-${index}`, "plain"),
        first.updateProject("project-0", { name: `first-${index}` }),
        second.updateProject("project-0", { folder: `folder-${index}` }),
        second.addProject(createProject(`https://example.com/added-${index}.git`)),
      ]).flat(),
    );

    const stored = (await first.getSession("session-0"))!;
    expect(stored.name).toBe("name-9");
    expect(stored.lastActivityAt).toBe("at-9");
    for (const environment of ["environment-0", "environment-1"]) {
      const rows = await second.getSessionsByEnvironment(environment);
      expect(rows).toHaveLength(14);
      expect(new Set(rows.map((row) => row.order)).size).toBe(rows.length);
    }
    const projects = await first.loadProjects();
    expect(projects).toHaveLength(12);
    expect(projects.find((item) => item.id === "project-0")).toMatchObject({
      name: "first-9",
      folder: "folder-9",
    });
    expect(new Set(projects.map((item) => item.order)).size).toBe(projects.length);
  }, 30_000);
});

describe("transaction rollback", () => {
  test("a failure inside a transaction leaves every row as it was", async () => {
    const directory = await dataDir();
    seedSessions(directory);
    const storage = await service(directory);
    const before = readStorageDatabaseStore(directory, "sessions");
    const database = storageDatabase(storage);
    const update = database.updateStoreRow.bind(database);
    let calls = 0;
    const failing = spyOn(database, "updateStoreRow").mockImplementation(((
      ...args: Parameters<typeof update>
    ) => {
      calls += 1;
      if (calls === 2) throw new Error("disk full");
      return update(...args);
    }) as typeof update);
    try {
      await expect(
        storage.reorderSessions("environment-0", [
          "session-6",
          "session-4",
          "session-2",
          "session-0",
        ]),
      ).rejects.toThrow("disk full");
    } finally {
      failing.mockRestore();
    }
    expect(readStorageDatabaseStore(directory, "sessions")).toEqual(before);
    await storage.updateSession("session-0", { name: "still works" });
    expect((await storage.getSession("session-0"))?.name).toBe("still works");
  });
});
