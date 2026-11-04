import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readStorageDatabaseStore } from "@orkestrator/protocol/node/storage-database";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { STORAGE_DATABASE_FILE, StorageDatabase } from "./storage-database.js";
import { createEnvironment, StorageService } from "./storage.js";
import { LEGACY_JSON_DIRECTORY, STORAGE_MIGRATIONS, storeLayout } from "./storage-stores.js";
import { storageDatabase, storageFilesContain } from "./storage-test-support.js";

const directories: string[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ork-environment-rows-"));
  directories.push(directory);
  return directory;
}

async function service(directory: string): Promise<StorageService> {
  const storage = new StorageService(directory);
  services.push(storage);
  await storage.init();
  return storage;
}

/** Records every row of the environment store this connection writes. */
function countRowWrites(storage: StorageService): { keys: () => string[]; reset: () => void } {
  const { db } = storageDatabase(storage);
  db.exec("CREATE TEMP TABLE IF NOT EXISTS environment_row_writes (key TEXT NOT NULL)");
  for (const [name, event, row] of [
    ["insert", "INSERT", "new"],
    ["update", "UPDATE", "new"],
    ["delete", "DELETE", "old"],
  ] as const) {
    db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS environment_row_write_${name}
      AFTER ${event} ON main.store_rows WHEN ${row}.store = 'environments'
      BEGIN INSERT INTO environment_row_writes VALUES (${row}.key); END`);
  }
  return {
    keys: () =>
      (db.query("SELECT key FROM environment_row_writes").all() as Array<{ key: string }>).map(
        (row) => row.key,
      ),
    reset: () => db.exec("DELETE FROM environment_row_writes"),
  };
}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function storedEnvironmentKeys(directory: string): Promise<string[]> {
  const stored = readStorageDatabaseStore(directory, "environments") as Array<{ id: string }>;
  return stored.map((environment) => environment.id);
}

describe("environment row writes", () => {
  test("one field writes one row and reads and writes nothing else", async () => {
    const storage = await service(await dataDir());
    const target = await storage.addEnvironment(createEnvironment("project-1"));
    const other = await storage.addEnvironment(createEnvironment("project-1"));
    const database = storageDatabase(storage);
    const otherRow = database.db
      .query("SELECT * FROM store_rows WHERE store = 'environments' AND key = ?")
      .get(other.id);
    const writes = countRowWrites(storage);
    const wholeReads = spyOn(database, "readStore");
    const wholeWrites = spyOn(database, "writeStoreInTransaction");
    try {
      await storage.updateEnvironment(target.id, { name: "renamed" });
      expect(wholeReads.mock.calls.filter(([store]) => store === "environments")).toEqual([]);
      expect(wholeWrites.mock.calls.filter(([store]) => store === "environments")).toEqual([]);
    } finally {
      wholeReads.mockRestore();
      wholeWrites.mockRestore();
    }
    expect(writes.keys()).toEqual([target.id]);
    expect(
      database.db
        .query("SELECT * FROM store_rows WHERE store = 'environments' AND key = ?")
        .get(other.id),
    ).toEqual(otherRow);
    expect((await storage.getEnvironment(target.id))?.name).toBe("renamed");

    // An update that changes nothing writes nothing at all.
    writes.reset();
    const revision = database.storeRevision("environments");
    await storage.updateEnvironment(target.id, { name: "renamed" });
    expect(writes.keys()).toEqual([]);
    expect(database.storeRevision("environments")).toBe(revision);
  });

  test("every single-environment writer writes only its own row", async () => {
    const storage = await service(await dataDir());
    const target = createEnvironment("project-1");
    target.prUrl = "https://example.com/pr/1";
    target.prState = "open";
    target.hasMergeConflicts = true;
    target.startupAgentSession = {
      providerSessionId: "provider",
      startedAt: "2026-11-01T00:00:00.000Z",
    } as NonNullable<typeof target.startupAgentSession>;
    await storage.addEnvironment(target);
    const other = await storage.addEnvironment(createEnvironment("project-1"));
    const intent = {
      tabId: "tab-1",
      kind: "terminal",
      createdAt: "2026-11-01T00:00:00.000Z",
    } as Parameters<StorageService["setTabTeardownIntent"]>[1];
    const start = Date.now();
    const at = (second: number) => new Date(start + second * 1_000).toISOString();
    const writers: Array<[string, () => Promise<unknown>]> = [
      ["setTabTeardownIntent", () => storage.setTabTeardownIntent(target.id, intent)],
      [
        "recordTabTeardownSessionId",
        () => storage.recordTabTeardownSessionId(target.id, "tab-1", intent.createdAt, "resume-1"),
      ],
      [
        "clearTabTeardownIntent",
        () => storage.clearTabTeardownIntent(target.id, "tab-1", intent.createdAt),
      ],
      ["armPrRecheck", () => storage.armPrRecheckAfterAgentCompletion(target.id)],
      [
        "acknowledgeStartupAgentSession",
        () => storage.acknowledgeStartupAgentSession(target.id, undefined, undefined),
      ],
      ["recordEnvironmentActivity", () => storage.recordEnvironmentActivity(target.id, at(1))],
      [
        "setEnvironmentAgentActivity",
        () => storage.setEnvironmentAgentActivity(target.id, "working", at(2), "native-agent"),
      ],
      ["recordEnvironmentCompletion", () => storage.recordEnvironmentCompletion(target.id, at(3))],
      [
        "recordEnvironmentSessionCompletion",
        () => storage.recordEnvironmentSessionCompletion(target.id, at(4)),
      ],
      [
        "recordEnvironmentAgentAttention",
        () => storage.recordEnvironmentAgentAttention(target.id, ["question-1"], at(5)),
      ],
      ["setEnvironmentUnread", () => storage.setEnvironmentUnread(target.id, false)],
      [
        "patchEnvironmentSettingsAtRevision",
        () =>
          storage.publicOperations.patchEnvironmentSettingsAtRevision(
            target.id,
            undefined,
            (current) => ({ ...current, allowedDomains: ["example.com"] }),
          ),
      ],
    ];
    const writes = countRowWrites(storage);
    const database = storageDatabase(storage);
    const wholeWrites = spyOn(database, "writeStoreInTransaction");
    try {
      for (const [name, write] of writers) {
        writes.reset();
        await write();
        expect({ name, keys: writes.keys() }).toEqual({ name, keys: [target.id] });
      }
      expect(wholeWrites.mock.calls.filter(([store]) => store === "environments")).toEqual([]);
    } finally {
      wholeWrites.mockRestore();
    }
    expect((await storage.getEnvironment(other.id))?.name).toBe(other.name);
  });

  test("an insert and a removal each write one row and keep the others' order", async () => {
    const directory = await dataDir();
    const storage = await service(directory);
    const first = await storage.addEnvironment(createEnvironment("project-1"));
    const middle = await storage.addEnvironment(createEnvironment("project-2"));
    const writes = countRowWrites(storage);
    const last = await storage.addEnvironment(createEnvironment("project-1"));
    expect(writes.keys()).toEqual([last.id]);
    expect(last.order).toBe(1);
    expect(await storedEnvironmentKeys(directory)).toEqual([first.id, middle.id, last.id]);

    writes.reset();
    await storage.removeEnvironment(middle.id);
    expect(writes.keys()).toEqual([middle.id]);
    expect(await storedEnvironmentKeys(directory)).toEqual([first.id, last.id]);
    expect((await storage.getEnvironmentsByProject("project-1")).map((item) => item.id)).toEqual([
      first.id,
      last.id,
    ]);
  });

  test("a project's control request still converges on one row", async () => {
    const storage = await service(await dataDir());
    const request = createEnvironment("project-1");
    request.controlRequestId = "request-1";
    const created = await storage.addEnvironment(request);
    const retried = createEnvironment("project-1");
    retried.controlRequestId = "request-1";
    expect((await storage.addEnvironment(retried)).id).toBe(created.id);
    // The same request id in another project is another request.
    const elsewhere = createEnvironment("project-2");
    elsewhere.controlRequestId = "request-1";
    expect((await storage.addEnvironment(elsewhere)).id).toBe(elsewhere.id);
    expect((await storage.loadEnvironments()).map((item) => item.id).sort()).toEqual(
      [created.id, elsewhere.id].sort(),
    );
    await expect(
      storage.addEnvironment({ ...createEnvironment("project-1"), id: created.id }),
    ).rejects.toThrow("Environment exists");
  });

  test("a reorder writes only the rows it moved, all together", async () => {
    const storage = await service(await dataDir());
    const a = await storage.addEnvironment(createEnvironment("project-1"));
    const b = await storage.addEnvironment(createEnvironment("project-1"));
    const c = await storage.addEnvironment(createEnvironment("project-1"));
    const elsewhere = await storage.addEnvironment(createEnvironment("project-2"));
    const writes = countRowWrites(storage);
    const reordered = await storage.reorderEnvironments("project-1", [b.id, a.id]);
    expect(reordered.map((item) => item.id)).toEqual([b.id, a.id, c.id]);
    expect(writes.keys().sort()).toEqual([a.id, b.id].sort());
    expect((await storage.getEnvironmentsByProject("project-1")).map((item) => item.id)).toEqual([
      b.id,
      a.id,
      c.id,
    ]);
    expect((await storage.getEnvironment(elsewhere.id))?.order).toBe(0);

    // One row refused by the database rolls the other rows back with it.
    const { db } = storageDatabase(storage);
    db.exec(`CREATE TEMP TRIGGER refuse_row BEFORE UPDATE ON main.store_rows
      WHEN new.store = 'environments' AND new.key = '${b.id}'
      BEGIN SELECT RAISE(ABORT, 'row refused'); END`);
    await expect(storage.reorderEnvironments("project-1", [c.id, a.id, b.id])).rejects.toThrow(
      "row refused",
    );
    db.exec("DROP TRIGGER refuse_row");
    expect((await storage.getEnvironmentsByProject("project-1")).map((item) => item.id)).toEqual([
      b.id,
      a.id,
      c.id,
    ]);
  });

  test("a whole-store sweep writes only the environments it changes", async () => {
    const storage = await service(await dataDir());
    const inContainer = () => ({
      ...createEnvironment("project-1"),
      containerId: "container-1",
    });
    const shared = await storage.addEnvironment(inContainer());
    const sibling = await storage.addEnvironment(inContainer());
    const idle = await storage.addEnvironment(createEnvironment("project-1"));
    const writes = countRowWrites(storage);
    await storage.setAllEnvironmentStatusesForContainer("container-1", "error");
    expect(writes.keys().sort()).toEqual([shared.id, sibling.id].sort());
    expect((await storage.getEnvironment(shared.id))?.status).toBe("error");
    expect((await storage.getEnvironment(idle.id))?.status).toBe(idle.status);

    writes.reset();
    const now = new Date().toISOString();
    await storage.setEnvironmentAgentActivity(idle.id, "working", now, "frontend", "observer-1");
    writes.reset();
    expect(await storage.clearFrontendAgentActivity()).toEqual([idle.id]);
    expect(writes.keys()).toEqual([idle.id]);
    writes.reset();
    expect(await storage.clearFrontendAgentActivity()).toEqual([]);
    expect(writes.keys()).toEqual([]);

    await storage.setEnvironmentAgentActivity(sibling.id, "working", now, "frontend", "observer-2");
    writes.reset();
    const expired = await storage.expireFrontendAgentActivityLeases(Date.now() + 3_600_000);
    expect(expired).toEqual([sibling.id]);
    expect(writes.keys()).toEqual([sibling.id]);
  });

  test("two connections' concurrent updates of one row lose nothing", async () => {
    const directory = await dataDir();
    const first = await service(directory);
    const second = await service(directory);
    const environment = await first.addEnvironment(createEnvironment("project-1"));
    const other = await first.addEnvironment(createEnvironment("project-1"));
    // Both hold the store cached, so a stale copy would show as a lost field.
    await first.loadEnvironments();
    await second.loadEnvironments();
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => {
        const writer = index % 2 === 0 ? first : second;
        return index % 3 === 0
          ? writer.setEnvironmentUnread(environment.id, true)
          : index % 3 === 1
            ? writer.updateEnvironment(environment.id, { name: `name-${index}` })
            : writer.updateEnvironment(other.id, { branch: `branch-${index}` });
      }),
    );
    for (const reader of [first, second]) {
      const [reloaded, sibling] = await Promise.all([
        reader.getEnvironment(environment.id),
        reader.getEnvironment(other.id),
      ]);
      expect(reloaded?.hasUnreadWork).toBe(true);
      expect(reloaded?.name).toStartWith("name-");
      expect(sibling?.branch).toStartWith("branch-");
      expect(sibling?.hasUnreadWork).toBeFalsy();
    }
  });

  test("the shared snapshot follows row writes on either connection", async () => {
    const directory = await dataDir();
    const first = await service(directory);
    const second = await service(directory);
    const environment = await first.addEnvironment(createEnvironment("project-1"));
    expect((await first.readEnvironmentsSnapshot()).map((item) => item.name)).toEqual([
      environment.name,
    ]);
    await first.updateEnvironment(environment.id, { name: "local-write" });
    expect((await first.readEnvironmentsSnapshot())[0]?.name).toBe("local-write");
    await second.updateEnvironment(environment.id, { name: "foreign-write" });
    expect((await first.readEnvironmentsSnapshot())[0]?.name).toBe("foreign-write");
    await second.removeEnvironment(environment.id);
    expect(await first.readEnvironmentsSnapshot()).toEqual([]);
  });
});

describe("environment deletion fences under a concurrent update", () => {
  async function connections() {
    const directory = await dataDir();
    const updater = await service(directory);
    const deleter = await service(directory);
    const environment = await updater.addEnvironment(createEnvironment("project-1"));
    return { directory, updater, deleter, environment };
  }

  /** An update holding the environment lease until `release` opens. */
  async function stalledUpdate(
    storage: StorageService,
    environmentId: string,
    updates: Record<string, unknown>,
  ) {
    const entered = gate();
    const release = gate();
    const update = storage.updateEnvironment(environmentId, updates, async () => {
      entered.open();
      await release.opened;
      return true;
    });
    await entered.opened;
    return { update, release };
  }

  test("a stalled update neither loses nor overtakes the deletion tombstone", async () => {
    const { updater, deleter, environment } = await connections();
    const { update, release } = await stalledUpdate(updater, environment.id, { name: "renamed" });
    const requestedAt = new Date().toISOString();
    const tombstone = deleter.updateEnvironment(environment.id, {
      deletionRequestedAt: requestedAt,
    });
    await Bun.sleep(100);
    // The tombstone waits for the lease the update still holds.
    expect((await deleter.getEnvironment(environment.id))?.deletionRequestedAt).toBeUndefined();
    release.open();
    await Promise.all([update, tombstone]);
    for (const reader of [updater, deleter]) {
      expect(await reader.getEnvironment(environment.id)).toMatchObject({
        name: "renamed",
        deletionRequestedAt: requestedAt,
      });
    }
    // Every fence reads the tombstone from the row that was written.
    await expect(
      updater.runWithLiveEnvironment(environment.id, "Test", async () => undefined),
    ).rejects.toThrow("being deleted");
    await expect(
      updater.publicOperations.patchEnvironmentSettingsAtRevision(
        environment.id,
        undefined,
        (current) => current,
      ),
    ).rejects.toThrow("being deleted");
    // A later update of another field keeps it.
    await updater.updateEnvironment(environment.id, { branch: "later" });
    expect((await deleter.getEnvironment(environment.id))?.deletionRequestedAt).toBe(requestedAt);
  });

  test("a native session create checks the tombstone in its own commit", async () => {
    const { updater, deleter, environment } = await connections();
    // A whole-store copy cached by the checking connection must not hide it.
    await updater.loadEnvironments();
    await deleter.updateEnvironment(environment.id, {
      deletionRequestedAt: new Date().toISOString(),
    });
    await expect(
      updater.getOrCreateNativeAgentSession(
        {
          key: "session-1",
          environmentId: environment.id,
          agent: "opencode",
          logicalSessionKey: `env-${environment.id}:startup-agent`,
        },
        async () => "provider-1",
      ),
    ).rejects.toThrow("being deleted");
    expect(await updater.getNativeAgentSession("session-1")).toBeNull();
  });

  test("a stalled update commits before a queued removal, which still removes the row", async () => {
    const { directory, updater, deleter, environment } = await connections();
    const { update, release } = await stalledUpdate(updater, environment.id, { name: "renamed" });
    const removal = deleter.removeEnvironment(environment.id);
    await Bun.sleep(100);
    expect(await deleter.getEnvironment(environment.id)).not.toBeNull();
    release.open();
    await Promise.all([update, removal]);
    expect(await storedEnvironmentKeys(directory)).toEqual([]);
    expect(await updater.getEnvironment(environment.id)).toBeNull();
  });

  test("an update queued behind a removal fails and cannot bring the row back", async () => {
    const { directory, updater, deleter, environment } = await connections();
    const removal = deleter.removeEnvironment(environment.id);
    const update = updater.updateEnvironment(environment.id, { name: "too late" });
    const outcomes = await Promise.allSettled([removal, update]);
    expect(outcomes[0].status).toBe("fulfilled");
    // Lease order decides which ran first; either way the row is gone.
    if (outcomes[1].status === "rejected") {
      expect(String(outcomes[1].reason)).toContain("Environment not found");
    }
    expect(await storedEnvironmentKeys(directory)).toEqual([]);
    await expect(updater.setEnvironmentUnread(environment.id, true)).rejects.toThrow(
      "Environment not found",
    );
    expect(await storedEnvironmentKeys(directory)).toEqual([]);
  });

  test("a row removed behind a stale lease holder stays removed", async () => {
    const { directory, updater, environment } = await connections();
    // A stolen lease is the one way a writer can miss a removal: the holder
    // stalled past the stale window and another backend took it.
    const foreign = new StorageDatabase(directory, {
      layoutFor: storeLayout,
      migrations: STORAGE_MIGRATIONS,
    });
    const { update, release } = await stalledUpdate(updater, environment.id, { name: "renamed" });
    foreign.updateStoreRow("environments", environment.id, () => ({
      result: undefined,
      delete: true,
    }));
    foreign.close();
    release.open();
    await expect(update).rejects.toThrow("Environment not found");
    expect(await storedEnvironmentKeys(directory)).toEqual([]);
  });

  test("the project removal fence still orders against a create", async () => {
    const { updater, deleter } = await (async () => {
      const directory = await dataDir();
      return { updater: await service(directory), deleter: await service(directory) };
    })();
    await deleter.fenceEmptyProjectForRemoval("project-gone");
    await expect(updater.addEnvironment(createEnvironment("project-gone"))).rejects.toThrow(
      "Project is being removed",
    );
    const created = await updater.addEnvironment(createEnvironment("project-kept"));
    await expect(deleter.fenceEmptyProjectForRemoval("project-kept")).rejects.toThrow();
    await updater.removeEnvironment(created.id);
    await deleter.fenceEmptyProjectForRemoval("project-kept");
  });
});

describe("environment archive scrubs under row writes", () => {
  const secret = "ARCHIVED-ATTACHMENT-CRASH";

  async function migrated() {
    const directory = await dataDir();
    const environment = createEnvironment("project-1");
    environment.initialPromptAttachments = [
      { id: "image", name: "private.png", base64Data: secret },
    ];
    const kept = createEnvironment("project-1");
    kept.name = "unrelated-archive-data";
    const raw = JSON.stringify([environment, kept]);
    await fs.writeFile(path.join(directory, "environments.json"), raw);
    await fs.writeFile(path.join(directory, "environments.json.bak.1"), raw);
    const storage = await service(directory);
    const [stamp] = await fs.readdir(path.join(directory, LEGACY_JSON_DIRECTORY));
    const archive = path.join(directory, LEGACY_JSON_DIRECTORY, stamp!);
    return { directory, storage, environment, kept, archive };
  }

  async function copies(archive: string): Promise<string[]> {
    return Promise.all(
      ["environments.json", "environments.json.bak.1"].map((name) =>
        fs.readFile(path.join(archive, name), "utf8"),
      ),
    );
  }

  /**
   * Runs one environment mutation in another process and kills that process
   * with SIGKILL at its first archive rewrite, after the mutation's commit and
   * before the scrub it journaled has touched any copy.
   */
  async function crashDuring(directory: string, mutation: string, environmentId: string) {
    const storageModule = path.join(import.meta.dir, "storage.ts");
    const script = `
      import syncFs from "node:fs";
      import { StorageService } from ${JSON.stringify(storageModule)};
      const storage = new StorageService(${JSON.stringify(directory)});
      await storage.init();
      const write = syncFs.writeFileSync;
      syncFs.writeFileSync = (file, ...rest) => {
        if (String(file).endsWith(".scrub.tmp")) process.kill(process.pid, "SIGKILL");
        return write(file, ...rest);
      };
      ${mutation.replace("$ID", JSON.stringify(environmentId))};
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: path.join(import.meta.dir, "..", ".."),
      env: { ...process.env, NODE_ENV: "test" },
      stdout: "ignore",
      stderr: "ignore",
    });
    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
  }

  function journalAfterCrash(directory: string): unknown {
    const db = new Database(path.join(directory, STORAGE_DATABASE_FILE), { readonly: true });
    try {
      return (
        db
          .query("SELECT document FROM stores WHERE name = 'storage-legacy-json-cleanups'")
          .get() as { document: string } | null
      )?.document;
    } finally {
      db.close();
    }
  }

  test.each([
    ["removal", "await storage.removeEnvironment($ID)"],
    [
      "attachment clear",
      "await storage.updateEnvironment($ID, { initialPromptAttachments: null })",
    ],
  ])(
    "a crash between the %s commit and its scrub replays on reopen",
    async (kind, mutation) => {
      const { directory, storage, environment, kept, archive } = await migrated();
      storage.close();

      await crashDuring(directory, mutation, environment.id);

      // The row change committed, the archive was not touched, and the commit
      // left an intent naming the row and holding none of its content.
      const journal = journalAfterCrash(directory);
      expect(journal).toEqual(expect.stringContaining(environment.id));
      expect(journal).not.toEqual(expect.stringContaining(secret));
      for (const copy of await copies(archive)) expect(copy).toContain(secret);

      const reopened = await service(directory);

      const reloaded = await reopened.getEnvironment(environment.id);
      if (kind === "removal") expect(reloaded).toBeNull();
      else expect(reloaded?.initialPromptAttachments).toBeUndefined();
      expect(await reopened.getEnvironment(kept.id)).not.toBeNull();
      expect(journalAfterCrash(directory)).toBeUndefined();
      for (const copy of await copies(archive)) {
        expect(copy).not.toContain(secret);
        expect(copy).toContain(kept.name);
        if (kind === "removal") expect(copy).not.toContain(environment.id);
        else expect(copy).toContain(environment.id);
      }
      expect(storageFilesContain(directory, secret)).toBe(false);
    },
    30_000,
  );

  test("a failed scrub leaves the row committed and finishes on the next environment write", async () => {
    const { storage, environment, kept, archive } = await migrated();
    const syncFs = (await import("node:fs")).default;
    const original = syncFs.renameSync;
    const rename = spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
      if (String(from).endsWith(".scrub.tmp")) throw new Error("archive rename failed");
      return original(from, to);
    });
    try {
      await expect(storage.removeEnvironment(environment.id)).rejects.toThrow(
        "archive rename failed",
      );
    } finally {
      rename.mockRestore();
    }
    expect(await storage.getEnvironment(environment.id)).toBeNull();
    for (const copy of await copies(archive)) expect(copy).toContain(secret);

    await storage.updateEnvironment(kept.id, { name: "unrelated-write" });

    for (const copy of await copies(archive)) {
      expect(copy).not.toContain(secret);
      expect(copy).toContain(kept.id);
    }
  });

  test("a routine row write leaves the archive and the journal alone", async () => {
    const { directory, storage, environment, archive } = await migrated();
    const before = await copies(archive);
    await storage.updateEnvironment(environment.id, { name: "renamed", status: "running" });
    await storage.setEnvironmentUnread(environment.id, true);
    expect(await copies(archive)).toEqual(before);
    expect(storageDatabase(storage).hasStore("storage-legacy-json-cleanups")).toBe(false);
    expect(journalAfterCrash(directory)).toBeUndefined();
  });

  test("a copy this cleanup cannot attribute is removed rather than kept", async () => {
    const { storage, environment, archive } = await migrated();
    await fs.writeFile(
      path.join(archive, "environments.json.bak.1"),
      JSON.stringify({ [environment.id]: { base64Data: secret } }),
    );
    await storage.removeEnvironment(environment.id);
    expect(await fs.readdir(archive)).toEqual(["environments.json"]);
    expect(await fs.readFile(path.join(archive, "environments.json"), "utf8")).not.toContain(
      secret,
    );
  });
});

describe("environment row writes and older builds", () => {
  test("row writes change neither the schema nor what an older reader or writer sees", async () => {
    const directory = await dataDir();
    const storage = await service(directory);
    const a = await storage.addEnvironment(createEnvironment("project-1"));
    const b = await storage.addEnvironment(createEnvironment("project-1"));
    const database = storageDatabase(storage);
    const schema = () =>
      database.db.query("SELECT type, name, sql FROM sqlite_master ORDER BY name").all();
    const version = database.schemaVersion();
    const before = schema();

    await storage.updateEnvironment(a.id, { name: "renamed" });
    await storage.removeEnvironment(a.id);
    const c = await storage.addEnvironment(createEnvironment("project-1"));

    expect(database.schemaVersion()).toBe(version);
    expect(version).toBe(Math.max(...STORAGE_MIGRATIONS.map((migration) => migration.version)));
    expect(schema()).toEqual(before);
    // The layout an older build's assembly reads: rows, array, in stored order.
    expect(database.readStoreHeader("environments")).toMatchObject({
      layout: "array",
      mode: "rows",
      document: null,
    });
    expect(await storedEnvironmentKeys(directory)).toEqual([b.id, c.id]);

    // An older build opens with the same migrations and writes the store whole.
    await storage.close();
    const older = new StorageDatabase(directory, {
      layoutFor: storeLayout,
      migrations: STORAGE_MIGRATIONS,
    });
    expect(older.schemaVersion()).toBe(version);
    const whole = older.readStore("environments")?.value as Array<{ id: string; name: string }>;
    expect(whole.map((environment) => environment.id)).toEqual([b.id, c.id]);
    whole[0]!.name = "older-build-write";
    older.writeStore("environments", whole);
    older.close();

    const reopened = await service(directory);
    expect((await reopened.getEnvironment(b.id))?.name).toBe("older-build-write");
    await reopened.updateEnvironment(c.id, { name: "newer-again" });
    expect(await storedEnvironmentKeys(directory)).toEqual([b.id, c.id]);
  });
});
