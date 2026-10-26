import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { StorageService } from "./storage.js";
import { STORAGE_DATABASE_FILE } from "./storage-database.js";
import {
  LEGACY_JSON_DIRECTORY,
  LEGACY_JSON_RETENTION_MS,
  databaseStoreForPath,
  hasLegacyJsonStore,
  openBackendDatabase,
  pruneRemovedContent,
  retireLegacyJsonStores,
  scrubLegacyJsonStore,
} from "./storage-stores.js";
import { storageInternals } from "./storage-test-support.js";

const directories: string[] = [];

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-storage-import-"));
  directories.push(directory);
  return directory;
}

async function writeJson(directory: string, name: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true });
  await fs.writeFile(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function archived(directory: string): Promise<string[]> {
  const root = path.join(directory, LEGACY_JSON_DIRECTORY);
  const files: string[] = [];
  const walk = async (current: string, prefix: string) => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory())
        await walk(path.join(current, entry.name), `${prefix}${entry.name}/`);
      else files.push(`${prefix}${entry.name}`);
    }
  };
  for (const stamp of await fs.readdir(root).catch(() => [] as string[])) {
    await walk(path.join(root, stamp), "");
  }
  return files.sort();
}

function environment(id: string, projectId: string) {
  return {
    id,
    projectId,
    name: id,
    branch: "main",
    containerId: null,
    status: "stopped",
    prUrl: null,
    prState: null,
    hasMergeConflicts: null,
    createdAt: new Date(0).toISOString(),
    debugMode: false,
    order: 0,
  };
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("legacy JSON import", () => {
  test("maps exactly the database stores and keeps configuration files as files", () => {
    expect(databaseStoreForPath("kanban.json")).toBe("kanban");
    expect(databaseStoreForPath("public-operations/index.json")).toBe("public-operations/index");
    expect(databaseStoreForPath("public-operations/ns-1234567890123-abcdef01.json")).toBe(
      "public-operations/ns-1234567890123-abcdef01",
    );
    // Read and written by the Electron main process and the toolchain installer.
    expect(databaseStoreForPath("config.json")).toBeNull();
    expect(databaseStoreForPath("agent-platforms.json")).toBeNull();
    expect(databaseStoreForPath("environment-cleanup-ledger.json")).toBe(
      "environment-cleanup-ledger",
    );
    expect(databaseStoreForPath("workflow-results.json")).toBe("workflow-results");
    // Terminal history and design records stay file-per-record engines.
    expect(databaseStoreForPath("design-canvases/index.json")).toBeNull();
    expect(databaseStoreForPath("public-operations/other.json")).toBeNull();
  });

  test("imports every store once and archives the files it replaced", async () => {
    const directory = await dataDir();
    await writeJson(directory, "projects.json", [
      { id: "p1", name: "One", gitUrl: "", localPath: null, addedAt: "x", order: 0 },
    ]);
    await writeJson(directory, "environments.json", [environment("e1", "p1")]);
    await writeJson(directory, "kanban.json", [
      { id: "t1", projectId: "p1", title: "Ticket", order: 0 },
    ]);
    await writeJson(directory, "project-notes.json", [
      { projectId: "p1", content: "notes", updatedAt: "x" },
    ]);
    await writeJson(directory, "agent-mail.json", {
      version: 1,
      revision: 3,
      mailboxes: {},
      idempotency: {},
      pendingInject: [],
      counterparts: {},
    });
    await writeJson(directory, "public-operations/index.json", {
      version: 1,
      namespaces: [],
      retired: [],
    });
    await writeJson(directory, "config.json", { schemaVersion: 2, global: {}, repositories: {} });
    await fs.writeFile(path.join(directory, "projects.json.bak.1"), "[]");
    await fs.writeFile(path.join(directory, "projects.json.lock"), "token");
    await fs.writeFile(path.join(directory, ".kanban.json.0000.tmp"), "partial");
    await fs.mkdir(path.join(directory, "project-creation-locks"));
    await fs.writeFile(path.join(directory, "project-creation-locks", "abc.lock"), "x");

    const storage = new StorageService(directory);
    await storage.init();

    expect((await storage.loadProjects()).map((project) => project.name)).toEqual(["One"]);
    expect((await storage.getEnvironment("e1"))?.projectId).toBe("p1");
    expect((await storage.kanban.getKanbanTasks("p1")).map((task) => task.title)).toEqual([
      "Ticket",
    ]);
    expect((await storage.kanban.getProjectNotes("p1")).content).toBe("notes");
    expect(
      await storageInternals(storage).repos.publicOperations.loadPublicOperationIndex(),
    ).toEqual({
      version: 1,
      namespaces: [],
      retired: [],
    });

    // Configuration stays where the desktop process reads it.
    await fs.access(path.join(directory, "config.json"));
    for (const replaced of [
      "projects.json",
      "environments.json",
      "kanban.json",
      "agent-mail.json",
      "public-operations",
      "project-creation-locks",
    ]) {
      await expect(fs.access(path.join(directory, replaced))).rejects.toThrow();
    }
    expect(await archived(directory)).toEqual([
      ".kanban.json.0000.tmp",
      "agent-mail.json",
      "environments.json",
      "kanban.json",
      "project-notes.json",
      "projects.json",
      "projects.json.bak.1",
      "projects.json.lock",
      "public-operations/index.json",
    ]);
    const archiveStat = await fs.stat(path.join(directory, LEGACY_JSON_DIRECTORY));
    expect(archiveStat.mode & 0o777).toBe(0o700);
    storage.close();
  });

  test("recovers an unreadable or empty primary from the newest readable backup", async () => {
    const directory = await dataDir();
    await fs.writeFile(path.join(directory, "projects.json"), "{ torn");
    await fs.writeFile(path.join(directory, "projects.json.bak.1"), "  \n");
    await writeJson(directory, "projects.json.bak.2", [
      { id: "p1", name: "From backup", gitUrl: "", localPath: null, addedAt: "x", order: 0 },
    ]);
    await fs.writeFile(path.join(directory, "sessions.json"), "");
    await writeJson(directory, "sessions.json.bak.1", [
      {
        id: "s1",
        environmentId: "e1",
        containerId: "c",
        tabId: "t",
        sessionType: "plain",
        status: "connected",
        createdAt: "x",
        lastActivityAt: "x",
        order: 0,
      },
    ]);

    const storage = new StorageService(directory);
    expect((await storage.loadProjects()).map((project) => project.name)).toEqual(["From backup"]);
    expect((await storage.getSessionsByEnvironment("e1")).map((session) => session.id)).toEqual([
      "s1",
    ]);
    storage.close();
  });

  test("carries an unrepairable file forward as present but unreadable", async () => {
    const directory = await dataDir();
    await fs.writeFile(path.join(directory, "pane-layouts.json"), "{ torn");
    await fs.writeFile(path.join(directory, "kanban.json"), "{ torn");
    await fs.mkdir(path.join(directory, "public-operations"));
    await fs.writeFile(path.join(directory, "public-operations", "index.json"), "{ torn");

    const storage = new StorageService(directory);
    // Destructive reconciliation must not mistake corruption for "no tabs".
    expect(await storage.loadPaneLayoutsForReconciliation()).toEqual({
      available: false,
      layouts: {},
    });
    // Lenient stores read as empty, exactly like a corrupt file without backups.
    expect(await storage.kanban.getKanbanTasks("p1")).toEqual([]);
    // The public operation ledger refuses admission instead of looking empty.
    await expect(
      storageInternals(storage).repos.publicOperations.loadPublicOperationIndex(),
    ).rejects.toThrow("unreadable");

    // The next write replaces the unreadable value.
    await storage.kanban.addKanbanTask("p1", "Recovered", "");
    expect((await storage.kanban.getKanbanTasks("p1")).map((task) => task.title)).toEqual([
      "Recovered",
    ]);
    storage.close();
  });

  test("refuses to open when a legacy file exists but cannot be read", async () => {
    if (process.getuid?.() === 0) return;
    const directory = await dataDir();
    await writeJson(directory, "projects.json", []);
    await fs.chmod(path.join(directory, "projects.json"), 0o000);
    try {
      expect(() => openBackendDatabase(directory)).toThrow();
      // Nothing was committed: a later open retries the whole import.
      await fs.chmod(path.join(directory, "projects.json"), 0o600);
      const database = openBackendDatabase(directory);
      expect(database.readStore("projects")?.value).toEqual([]);
      database.close();
    } finally {
      await fs.chmod(path.join(directory, "projects.json"), 0o600).catch(() => undefined);
    }
  });

  test("never imports JSON written after the migration, but archives it with a warning", async () => {
    const directory = await dataDir();
    const first = new StorageService(directory);
    await first.init();
    await first.kanban.addKanbanTask("p1", "Current", "");
    first.close();

    // An older backend sharing the directory writes the file it still knows.
    await writeJson(directory, "kanban.json", [{ id: "stale", projectId: "p1", title: "Stale" }]);
    const warn = spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const second = new StorageService(directory);
      expect((await second.kanban.getKanbanTasks("p1")).map((task) => task.title)).toEqual([
        "Current",
      ]);
      second.close();
      expect(warn.mock.calls.some(([message]) => String(message).includes("not imported"))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
    expect(await archived(directory)).toEqual(["kanban.json"]);
  });

  test("imports once when two backends open a fresh directory together", async () => {
    const directory = await dataDir();
    await writeJson(directory, "kanban.json", [{ id: "t1", projectId: "p1", title: "Once" }]);
    const first = new StorageService(directory);
    const second = new StorageService(directory);
    await Promise.all([first.init(), second.init()]);
    await first.kanban.addKanbanTask("p1", "Added", "");
    expect((await second.kanban.getKanbanTasks("p1")).map((task) => task.title)).toEqual([
      "Once",
      "Added",
    ]);
    first.close();
    second.close();
  });

  test("removes archived JSON after the retention window", async () => {
    const directory = await dataDir();
    const old = Date.now() - LEGACY_JSON_RETENTION_MS - 60_000;
    await writeJson(directory, "kanban.json", []);
    retireLegacyJsonStores(directory, old);
    await writeJson(directory, "sessions.json", []);
    retireLegacyJsonStores(directory, Date.now());
    expect(await archived(directory)).toEqual(["sessions.json"]);
  });

  test("creates a private database file", async () => {
    const directory = await dataDir();
    const storage = new StorageService(directory);
    await storage.init();
    const stat = await fs.stat(path.join(directory, STORAGE_DATABASE_FILE));
    expect(stat.mode & 0o777).toBe(0o600);
    storage.close();
  });
});

describe("retired JSON archive scrubbing", () => {
  test("pruning returns the archived value itself when nothing was removed", () => {
    const archived = { draft: { text: "old" }, list: [{ id: "m1", body: "old" }, "tag"], count: 1 };
    const next = {
      draft: { text: "new", extra: true },
      list: ["tag", { id: "m1", body: "new" }, { id: "m2" }],
      count: 2,
      added: {},
    };
    expect(pruneRemovedContent(archived, next)).toBe(archived);
  });

  test("pruning drops removed content and keeps every other archived value", () => {
    const archived = {
      gone: { secret: "s1" },
      cleared: { secret: "s2" },
      unset: 1,
      kept: { text: "archived", nested: { gone: "s3", stays: "archived" } },
      messages: [
        { id: "m1", body: "archived" },
        { id: "m2", body: "s4" },
      ],
      pending: [
        { mailboxId: "a", messageId: "m1" },
        { mailboxId: "b", messageId: "m2" },
      ],
    };
    const original = structuredClone(archived);
    const next = {
      cleared: null,
      unset: undefined,
      kept: { text: "current", nested: { stays: "current" } },
      messages: [{ id: "m1", body: "current" }],
      // Items without an id match by content, whatever the key order.
      pending: [{ messageId: "m1", mailboxId: "a" }],
    };
    expect(pruneRemovedContent(archived, next)).toEqual({
      cleared: null,
      kept: { text: "archived", nested: { stays: "archived" } },
      messages: [{ id: "m1", body: "archived" }],
      pending: [{ mailboxId: "a", messageId: "m1" }],
    });
    expect(archived).toEqual(original);
  });

  test.each([
    [[{ secret: "deleted" }], { kept: {} }],
    [{ secret: "deleted" }, []],
    [{ nested: [{ secret: "deleted" }] }, { nested: {} }],
    [{ nested: { secret: "deleted" } }, { nested: [] }],
    [{ nested: { secret: "deleted" } }, { nested: "scalar" }],
    ["malformed root", {}],
  ])("clears incompatible archive shapes (%j -> %j)", (archived, next) => {
    expect(JSON.stringify(pruneRemovedContent(archived, next))).not.toContain("deleted");
    expect(pruneRemovedContent(archived, next)).not.toBe(archived);
  });

  test("leaves a copy the transform does not change byte-identical", async () => {
    const directory = await dataDir();
    await writeJson(directory, "compose-drafts.json", { a: { text: "x" } });
    await writeJson(directory, "compose-drafts.json.bak.1", {
      a: { text: "x" },
      b: { text: "secret" },
    });
    retireLegacyJsonStores(directory);
    const [stamp] = await fs.readdir(path.join(directory, LEGACY_JSON_DIRECTORY));
    const archive = path.join(directory, LEGACY_JSON_DIRECTORY, stamp!);
    const primary = await fs.readFile(path.join(archive, "compose-drafts.json"), "utf8");

    scrubLegacyJsonStore(directory, "compose-drafts", (value) =>
      pruneRemovedContent(value, { a: { text: "y" } }),
    );
    expect(await fs.readFile(path.join(archive, "compose-drafts.json"), "utf8")).toBe(primary);
    expect(
      JSON.parse(await fs.readFile(path.join(archive, "compose-drafts.json.bak.1"), "utf8")),
    ).toEqual({ a: { text: "x" } });

    expect(hasLegacyJsonStore(directory, "compose-drafts")).toBe(true);
    scrubLegacyJsonStore(directory, "compose-drafts");
    expect(hasLegacyJsonStore(directory, "compose-drafts")).toBe(false);
  });
});
