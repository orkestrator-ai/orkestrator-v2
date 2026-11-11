import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requestKey, type PublicOperationRecord } from "./public-api/operation-ledger.js";
import { StorageDatabase } from "./storage-database.js";
import {
  mapNamespaceDocumentRecord,
  namespaceDocumentRows,
  PUBLIC_OPERATION_ROWS_VERSION,
} from "./storage-public-operation-rows.js";
import {
  LEGACY_JSON_DIRECTORY,
  STORAGE_MIGRATIONS,
  openBackendDatabase,
  storeLayout,
} from "./storage-stores.js";
import { StorageService } from "./storage.js";
import { storageDatabase, storageInternals } from "./storage-test-support.js";

const directories: string[] = [];
const databases: StorageDatabase[] = [];
const services: StorageService[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const service of services.splice(0)) await service.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "ork-public-operation-rows-"));
  directories.push(directory);
  return directory;
}

const NAMESPACE = "ns-1762819200000-0123abcd";
const STORE = `public-operations/${NAMESPACE}`;

function record(index: number, namespace = NAMESPACE): PublicOperationRecord {
  const requestId = `request-${index}`;
  return {
    version: 1,
    operationId: `op-${namespace.slice(3)}-${index.toString(16).padStart(18, "0")}`,
    namespace,
    requestId,
    requestKey: requestKey("operator", "project.add", "global", requestId),
    authority: "operator",
    action: "project.add",
    scope: "global",
    fingerprint: createHash("sha256").update(requestId).digest("hex"),
    state: "admitted",
    stage: "admitted",
    resources: {},
    generation: "generation-1",
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
  } as PublicOperationRecord;
}

/** A database at the schema before this migration, with namespaces held whole. */
function databaseBeforeRows(directory: string): StorageDatabase {
  return new StorageDatabase(directory, {
    layoutFor: (store) =>
      store.startsWith("public-operations/") ? { kind: "document" } : storeLayout(store),
    migrations: STORAGE_MIGRATIONS.filter(
      (migration) => migration.version < PUBLIC_OPERATION_ROWS_VERSION,
    ),
  });
}

describe("namespaceDocumentRows", () => {
  test("keys a version-1 document's records by operation id, in order", () => {
    const records = [record(1), record(2)];
    const rows = namespaceDocumentRows({ version: 1, namespace: NAMESPACE, operations: records });
    expect(Object.keys(rows!)).toEqual(records.map((entry) => entry.operationId));
    expect(Object.values(rows!)).toEqual(records);
  });

  test("refuses a document whose records cannot be keyed", () => {
    expect(namespaceDocumentRows({ operations: [record(1), record(1)] })).toBeNull();
    expect(namespaceDocumentRows({ operations: [{ state: "admitted" }] })).toBeNull();
    expect(namespaceDocumentRows({ operations: [null] })).toBeNull();
    expect(namespaceDocumentRows({ [record(1).operationId]: record(1) })).toBeNull();
    expect(namespaceDocumentRows([record(1)])).toBeNull();
  });

  test("refuses operation ids that are not well formed, __proto__ included", () => {
    for (const operationId of ["__proto__", "constructor", "op-not-an-id", ""]) {
      const malformed = { ...record(2), operationId };
      expect(namespaceDocumentRows({ operations: [record(1), malformed] })).toBeNull();
      expect(namespaceDocumentRows({ operations: [malformed] })).toBeNull();
    }
    // A JSON-parsed document, where `__proto__` is an own key of the record.
    const parsed = JSON.parse(
      JSON.stringify({ operations: [{ ...record(1), operationId: "__proto__" }] }),
    ) as unknown;
    expect(namespaceDocumentRows(parsed)).toBeNull();
  });
});

describe("mapNamespaceDocumentRecord", () => {
  const document = { version: 1, namespace: NAMESPACE, operations: [record(1), record(2)] };

  test("replaces or drops only the named record, and returns an unchanged copy as it was", () => {
    const id = record(2).operationId;
    const replaced = mapNamespaceDocumentRecord(document, id, (entry) => ({ ...entry, x: 1 }));
    expect(replaced).toEqual({ ...document, operations: [record(1), { ...record(2), x: 1 }] });
    expect(mapNamespaceDocumentRecord(document, id, () => undefined)).toEqual({
      ...document,
      operations: [record(1)],
    });
    expect(mapNamespaceDocumentRecord(document, id, (entry) => entry)).toBe(document);
    expect(mapNamespaceDocumentRecord(document, "op-missing", () => undefined)).toBe(document);
  });

  test("is undefined for anything but a version-1 document", () => {
    expect(mapNamespaceDocumentRecord({ [record(1).operationId]: record(1) }, "x", () => 1)).toBe(
      undefined,
    );
    expect(mapNamespaceDocumentRecord([record(1)], "x", () => 1)).toBeUndefined();
  });
});

describe("the public-operation-rows migration", () => {
  test("rewrites a namespace document as one row per record and keeps what it cannot key", async () => {
    const directory = await dataDir();
    const before = databaseBeforeRows(directory);
    const records = [record(1), record(2), record(3)];
    before.writeStore(STORE, { version: 1, namespace: NAMESPACE, operations: records });
    const duplicate = `public-operations/ns-1762819200000-0123abce`;
    const duplicated = {
      version: 1,
      namespace: duplicate.slice(18),
      operations: [record(1), record(1)],
    };
    before.writeStore(duplicate, duplicated);
    const unreadable = `public-operations/ns-1762819200000-0123abcf`;
    before.transaction(() => before.writeRawDocumentInTransaction(unreadable, "{ torn"));
    before.writeStore("public-operations/index", { version: 1, namespaces: [], retired: [] });
    before.close();

    const after = openBackendDatabase(directory);
    databases.push(after);
    expect(after.schemaVersion()).toBeGreaterThanOrEqual(PUBLIC_OPERATION_ROWS_VERSION);
    expect(after.readStoreHeader(STORE)).toMatchObject({ layout: "record", mode: "rows" });
    const value = after.readStore(STORE)!.value as Record<string, PublicOperationRecord>;
    expect(Object.keys(value)).toEqual(records.map((entry) => entry.operationId));
    expect(Object.values(value)).toEqual(records);
    // Left exactly as they were: the reader refuses them, as it did before.
    expect(after.readStore(duplicate)?.value).toEqual(duplicated);
    expect(after.readStoreHeader(unreadable)).toMatchObject({
      mode: "document",
      document: "{ torn",
    });
    expect(after.readStoreHeader("public-operations/index")).toMatchObject({ layout: "document" });
  });

  test("leaves a document with a __proto__ operation id whole, so admissions stay refused", async () => {
    const directory = await dataDir();
    const before = databaseBeforeRows(directory);
    const document = {
      version: 1,
      namespace: NAMESPACE,
      operations: [record(1), { ...record(2), operationId: "__proto__" }],
    };
    before.writeStore(STORE, document);
    before.close();

    const storage = new StorageService(directory);
    services.push(storage);
    await storage.init();
    const database = storageDatabase(storage);
    expect(database.readStoreHeader(STORE)).toMatchObject({ mode: "document" });
    expect(database.readStore(STORE)?.value).toEqual(document);
    // Read without consulting the index, so only the namespace's own content
    // decides: a no-op update loads it strictly.
    await expect(
      storage.publicOperations.updatePublicOperation(record(1).operationId, () => null),
    ).rejects.toThrow("malformed");
    await expect(
      storage.publicOperations.updatePublicOperation(record(1).operationId, (current) => ({
        ...current,
        state: "succeeded",
      })),
    ).rejects.toThrow("malformed");
    expect(database.readStore(STORE)?.value).toEqual(document);
  });

  test("converts a namespace the legacy JSON import brought in", async () => {
    const directory = await dataDir();
    await fs.mkdir(path.join(directory, "public-operations"));
    const records = [record(4), record(5)];
    await fs.writeFile(
      path.join(directory, "public-operations", `${NAMESPACE}.json`),
      JSON.stringify({ version: 1, namespace: NAMESPACE, operations: records }),
    );
    const database = openBackendDatabase(directory);
    databases.push(database);
    expect(Object.values(database.readStore(STORE)!.value as object)).toEqual(records);
    expect(database.readStoreHeader(STORE)).toMatchObject({ layout: "record", mode: "rows" });
  });
});

describe("public operation records in rows", () => {
  /** Records every row of the namespace this connection writes. */
  function countRowWrites(storage: StorageService): () => string[] {
    const { db } = storageDatabase(storage);
    db.exec("CREATE TEMP TABLE namespace_row_writes (key TEXT NOT NULL)");
    for (const [name, event, row] of [
      ["insert", "INSERT", "new"],
      ["update", "UPDATE", "new"],
      ["delete", "DELETE", "old"],
    ] as const) {
      db.exec(`CREATE TEMP TRIGGER namespace_row_write_${name}
        AFTER ${event} ON main.store_rows WHEN substr(${row}.store, 1, 21) = 'public-operations/ns-'
        BEGIN INSERT INTO namespace_row_writes VALUES (${row}.key); END`);
    }
    return () =>
      (db.query("SELECT key FROM namespace_row_writes").all() as Array<{ key: string }>).map(
        (row) => row.key,
      );
  }

  test("an admission and a state change each write only their own row", async () => {
    const directory = await dataDir();
    const storage = new StorageService(directory);
    services.push(storage);
    await storage.init();
    const operations = storage.publicOperations;
    const admit = (index: number) =>
      operations.admitPublicOperation({
        authority: "operator",
        action: "project.add",
        scope: "global",
        requestId: `request-${index}`,
        requestKey: requestKey("operator", "project.add", "global", `request-${index}`),
        fingerprint: createHash("sha256").update(`request-${index}`).digest("hex"),
        generation: "generation-1",
      });
    const admitted: PublicOperationRecord[] = [];
    for (let index = 0; index < 20; index += 1) admitted.push((await admit(index)).record);

    const writes = countRowWrites(storage);
    const next = await admit(20);
    expect(next.replayed).toBe(false);
    expect(writes()).toEqual([next.record.operationId]);

    const target = admitted[7]!;
    const updated = await operations.updatePublicOperation(target.operationId, (current) => ({
      ...current,
      state: "succeeded",
      stage: "completed",
    }));
    expect(updated?.state).toBe("succeeded");
    expect(writes()).toEqual([next.record.operationId, target.operationId]);

    // Reads see the change, keep admission order and hand out copies.
    const found = await operations.getPublicOperation(target.operationId);
    expect(found).toMatchObject({ status: "found", record: { state: "succeeded" } });
    if (found.status === "found") found.record.state = "failed";
    expect(await operations.getPublicOperation(target.operationId)).toMatchObject({
      record: { state: "succeeded" },
    });
    const active = await operations.listActivePublicOperations();
    expect(active.map((entry) => entry.operationId)).toEqual(
      [...admitted, next.record]
        .filter((entry) => entry.operationId !== target.operationId)
        .map((entry) => entry.operationId),
    );
    // A replay finds the record without writing anything.
    const replay = await admit(3);
    expect(replay).toMatchObject({
      replayed: true,
      record: { operationId: admitted[3]!.operationId },
    });
    expect(writes()).toHaveLength(2);
  });
});

describe("retired copies of a namespace imported as a document", () => {
  const SECRET = "PRIVATE-OPERATION-ERROR";

  async function importedNamespace(): Promise<{ directory: string }> {
    const directory = await dataDir();
    await fs.mkdir(path.join(directory, "public-operations"));
    const failing = { ...record(1), error: { code: "internal-error", message: SECRET } };
    const raw = JSON.stringify({
      version: 1,
      namespace: NAMESPACE,
      operations: [failing, record(2)],
    });
    for (const suffix of ["", ".bak.1"]) {
      await fs.writeFile(
        path.join(directory, "public-operations", `${NAMESPACE}.json${suffix}`),
        raw,
      );
    }
    return { directory };
  }

  async function archivedCopies(directory: string): Promise<string[]> {
    const root = path.join(directory, LEGACY_JSON_DIRECTORY);
    const stamps = await fs.readdir(root);
    const copies: string[] = [];
    for (const stamp of stamps) {
      const folder = path.join(root, stamp, "public-operations");
      for (const name of await fs.readdir(folder)) copies.push(path.join(folder, name));
    }
    return copies;
  }

  test("an update that removes a field prunes it from every archived document", async () => {
    const { directory } = await importedNamespace();
    const storage = new StorageService(directory);
    services.push(storage);
    await storage.init();
    const copies = await archivedCopies(directory);
    expect(copies).toHaveLength(2);
    for (const copy of copies) expect(await fs.readFile(copy, "utf8")).toContain(SECRET);

    const updated = await storage.publicOperations.updatePublicOperation(
      record(1).operationId,
      (current) => {
        delete current.error;
        return current;
      },
    );
    expect(updated?.error).toBeUndefined();

    for (const copy of copies) {
      const archived = JSON.parse(await fs.readFile(copy, "utf8")) as {
        operations: PublicOperationRecord[];
      };
      expect(JSON.stringify(archived)).not.toContain(SECRET);
      // Everything else stays as archived: the other record and the edited
      // record's remaining fields.
      expect(archived.operations.map((entry) => entry.operationId)).toEqual([
        record(1).operationId,
        record(2).operationId,
      ]);
      expect(archived.operations[1]).toEqual(record(2));
      expect(archived.operations[0]).toMatchObject({ requestId: record(1).requestId });
    }
  });

  test("a committed cleanup that did not reach the archive is replayed on reopen", async () => {
    const { directory } = await importedNamespace();
    const first = openBackendDatabase(directory);
    // The intent a row update commits with its write, left behind as if the
    // process stopped before scrubbing the archive.
    first.writeStore("storage-legacy-json-cleanups", [
      { store: STORE, kind: "prune-row", key: record(1).operationId, next: record(1) },
      { store: STORE, kind: "delete-row", key: record(2).operationId },
    ]);
    first.close();
    const copies = await archivedCopies(directory);
    for (const copy of copies) expect(await fs.readFile(copy, "utf8")).toContain(SECRET);

    const reopened = openBackendDatabase(directory);
    databases.push(reopened);
    expect(reopened.hasStore("storage-legacy-json-cleanups")).toBe(false);
    for (const copy of copies) {
      const archived = JSON.parse(await fs.readFile(copy, "utf8")) as {
        operations: PublicOperationRecord[];
      };
      expect(JSON.stringify(archived)).not.toContain(SECRET);
      expect(archived.operations).toEqual([record(1)]);
    }
  });
});

describe("the parsed namespace cache", () => {
  type Cached = { namespaceCache: Map<string, unknown> };

  test("evicts past its bound and reads an evicted namespace afresh", async () => {
    const directory = await dataDir();
    const seed = openBackendDatabase(directory);
    const namespaces = Array.from(
      { length: 34 },
      (_, index) => `ns-1762819200000-${index.toString(16).padStart(8, "0")}`,
    );
    for (const namespace of namespaces) {
      const entry = record(1, namespace);
      seed.writeStore(`public-operations/${namespace}`, { [entry.operationId]: entry });
    }
    seed.close();

    const storage = new StorageService(directory);
    services.push(storage);
    await storage.init();
    const operations = storage.publicOperations;
    // A no-op update reads a namespace without consulting the index.
    const read = (operationId: string) => operations.updatePublicOperation(operationId, () => null);
    for (const namespace of namespaces) {
      expect(await read(record(1, namespace).operationId)).toEqual(record(1, namespace));
    }
    const cache = (operations as unknown as Cached).namespaceCache;
    expect(cache.size).toBe(32);
    expect(cache.has(namespaces[0]!)).toBe(false);
    expect(cache.has(namespaces.at(-1)!)).toBe(true);

    // Changed while out of the cache: the next read parses the new row.
    const first = record(1, namespaces[0]!);
    storageDatabase(storage).writeStore(`public-operations/${namespaces[0]}`, {
      [first.operationId]: { ...first, state: "succeeded", stage: "completed" },
    });
    expect(await read(first.operationId)).toMatchObject({ state: "succeeded" });
    expect(cache.size).toBe(32);
    expect(cache.has(namespaces[0]!)).toBe(true);
  });

  test("inside an atomic scope that wrote the namespace, reads the buffered rows", async () => {
    const directory = await dataDir();
    const storage = new StorageService(directory);
    services.push(storage);
    await storage.init();
    const operations = storage.publicOperations;
    const admitted = await operations.admitPublicOperation({
      authority: "operator",
      action: "project.add",
      scope: "global",
      requestId: "request-atomic",
      requestKey: requestKey("operator", "project.add", "global", "request-atomic"),
      fingerprint: createHash("sha256").update("request-atomic").digest("hex"),
      generation: "generation-1",
    });
    const id = admitted.record.operationId;
    const cache = (operations as unknown as Cached).namespaceCache;
    await operations.getPublicOperation(id);
    const cachedBefore = cache.get(admitted.record.namespace);
    expect(cachedBefore).toBeDefined();

    await storageInternals(storage).context.atomically(async () => {
      await operations.updatePublicOperation(id, (current) => ({ ...current, state: "running" }));
      // The store is buffered in the scope: the read sees the uncommitted row,
      // and the shared cache is neither used nor replaced.
      expect(await operations.getPublicOperation(id)).toMatchObject({
        record: { state: "running" },
      });
      expect(cache.get(admitted.record.namespace)).toBe(cachedBefore);
    });
    expect(await operations.getPublicOperation(id)).toMatchObject({
      record: { state: "running" },
    });
    expect(cache.get(admitted.record.namespace)).not.toBe(cachedBefore);
  });
});
