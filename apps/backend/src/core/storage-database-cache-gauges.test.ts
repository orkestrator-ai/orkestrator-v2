import { afterEach, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { RecurringDiagnosticsRegistry } from "./recurring-diagnostics.js";
import { RecurringWorkMetrics } from "./recurring-work-metrics.js";
import { StorageDatabase, type StoreLayout } from "./storage-database.js";
import { openBackendDatabase } from "./storage-stores.js";
import { recurringWorkDiagnostics } from "./recurring-diagnostics.js";

const directories: string[] = [];
const open: StorageDatabase[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

async function dataDir(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(tmpdir(), "orkestrator-storage-gauges-"));
  directories.push(directory);
  return directory;
}

const layouts: Record<string, StoreLayout> = {
  records: { kind: "record" },
};

function database(directory: string, registry?: RecurringDiagnosticsRegistry) {
  const db = new StorageDatabase(directory, {
    layoutFor: (store) => layouts[store] ?? { kind: "document" },
    ...(registry ? { cacheGaugeRegistry: registry } : {}),
  });
  open.push(db);
  return db;
}

const rowCache = (registry: RecurringDiagnosticsRegistry) =>
  registry
    .snapshot(new RecurringWorkMetrics({ enabled: false }))
    .caches.find((entry) => entry.name === "storage-row-cache");

test("the row cache gauge counts cached stores, rows and serialized length, never content", async () => {
  const db = database(await dataDir());
  expect(db.cacheGauges()).toEqual({ connections: 1, stores: 0, rows: 0, bytes: 0 });
  db.writeStore("records", { alpha: "secret-value", beta: { nested: true } });
  db.writeStore("config", { theme: "dark" });
  db.readStore("records");
  db.readStore("config");
  const gauges = db.cacheGauges();
  expect(gauges).toMatchObject({ connections: 1, stores: 2, rows: 2 });
  const expectedBytes =
    JSON.stringify("secret-value").length +
    JSON.stringify({ nested: true }).length +
    (db.db.query("SELECT document FROM stores WHERE name = 'config'").get() as { document: string })
      .document.length;
  expect(gauges.bytes).toBe(expectedBytes);
  expect(JSON.stringify(gauges)).not.toContain("secret");

  // A one-row update replaces the cached store; the gauge follows it.
  db.updateStoreRow("records", "alpha", () => ({
    result: undefined,
    value: "a much longer replacement value",
  }));
  db.readStore("records");
  expect(db.cacheGauges().bytes).toBe(
    expectedBytes -
      JSON.stringify("secret-value").length +
      JSON.stringify("a much longer replacement value").length,
  );

  db.deleteStore("config");
  expect(db.cacheGauges()).toMatchObject({ stores: 1, rows: 2 });
});

test("a rolled-back transaction leaves the gauge on the committed cache", async () => {
  const db = database(await dataDir());
  db.writeStore("records", { a: "committed" });
  db.readStore("records");
  const before = db.cacheGauges();
  expect(() =>
    db.transaction(() => {
      db.writeStoreInTransaction("records", { a: "rolled back", b: "more", c: "rows" });
      throw new Error("abort");
    }),
  ).toThrow("abort");
  expect(db.cacheGauges()).toEqual(before);
});

test("a connection registers its gauge while open and unregisters on close", async () => {
  const registry = new RecurringDiagnosticsRegistry();
  const directory = await dataDir();
  const first = database(directory, registry);
  const second = database(directory, registry);
  first.writeStore("records", { a: 1 });
  first.readStore("records");
  expect(rowCache(registry)).toEqual({
    name: "storage-row-cache",
    sources: 2,
    gauges: { connections: 2, stores: 1, rows: 1, bytes: 1 },
  });
  first.close();
  expect(rowCache(registry)?.gauges).toEqual({ connections: 1, stores: 0, rows: 0, bytes: 0 });
  second.close();
  expect(rowCache(registry)).toBeUndefined();
});

test("backend database connections report to recurring diagnostics by default", async () => {
  const directory = await dataDir();
  const sources = () =>
    recurringWorkDiagnostics().caches.find((entry) => entry.name === "storage-row-cache")
      ?.sources ?? 0;
  const before = sources();
  const db = openBackendDatabase(directory);
  open.push(db);
  expect(sources()).toBe(before + 1);
  db.close();
  expect(sources()).toBe(before);
});
