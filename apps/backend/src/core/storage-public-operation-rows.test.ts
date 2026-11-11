import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { requestKey, type PublicOperationRecord } from "./public-api/operation-ledger.js";
import { StorageDatabase } from "./storage-database.js";
import {
  namespaceDocumentRows,
  PUBLIC_OPERATION_ROWS_VERSION,
} from "./storage-public-operation-rows.js";
import { STORAGE_MIGRATIONS, openBackendDatabase, storeLayout } from "./storage-stores.js";
import { StorageService } from "./storage.js";
import { storageDatabase } from "./storage-test-support.js";

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

function record(index: number): PublicOperationRecord {
  const requestId = `request-${index}`;
  return {
    version: 1,
    operationId: `op-${NAMESPACE.slice(3)}-${index.toString(16).padStart(18, "0")}`,
    namespace: NAMESPACE,
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
