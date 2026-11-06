import { Database } from "bun:sqlite";
import {
  instrumentSqliteConnection,
  SlowStorageOperations,
} from "../src/core/storage-slow-operations.js";

/**
 * What the slow-operation record (`storage-slow-operations.ts`) costs a SQLite
 * call that is not slow:
 *
 *   mise exec -- bun apps/backend/scripts/storage-timing-overhead.ts [--calls 200000] [--runs 7]
 *
 * Times the same work on two in-memory connections, one instrumented and one
 * not, and prints the median per call of each and their difference: a cached
 * point `SELECT` through `query().get()`, an `INSERT` through `run()`, and a
 * one-statement transaction. In memory, so the difference is not hidden by
 * disk time. Touches no file.
 */

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} needs a positive number`);
  return value;
}

const calls = argument("--calls", 200_000);
const runs = argument("--runs", 7);

function connection(instrumented: boolean): Database {
  const db = new Database(":memory:");
  if (instrumented) {
    instrumentSqliteConnection(db, "main", { recorder: new SlowStorageOperations() });
  }
  db.exec("CREATE TABLE stores (name TEXT PRIMARY KEY, revision INTEGER)");
  db.exec("CREATE TABLE store_rows (key INTEGER PRIMARY KEY, value TEXT)");
  for (let index = 0; index < 1_000; index += 1) {
    db.query("INSERT INTO stores (name, revision) VALUES (?, ?)").run(`store-${index}`, index);
  }
  return db;
}

const workloads: Record<string, (db: Database, count: number) => void> = {
  "select get": (db, count) => {
    for (let index = 0; index < count; index += 1) {
      db.query("SELECT revision FROM stores WHERE name = ?").get(`store-${index % 1_000}`);
    }
  },
  "insert run": (db, count) => {
    db.exec("DELETE FROM store_rows");
    for (let index = 0; index < count; index += 1) {
      db.query("INSERT INTO store_rows (key, value) VALUES (?, ?)").run(index, "x");
    }
  },
  transaction: (db, count) => {
    const work = (index: number) =>
      db.query("SELECT revision FROM stores WHERE name = ?").get(`store-${index % 1_000}`);
    for (let index = 0; index < count / 10; index += 1) {
      db.transaction(() => work(index)).immediate();
    }
  },
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

const rows: Array<Record<string, string>> = [];
for (const [name, run] of Object.entries(workloads)) {
  const perCall = { plain: [] as number[], instrumented: [] as number[] };
  const count = name === "transaction" ? calls / 10 : calls;
  for (let index = 0; index < runs; index += 1) {
    // Alternate, so drift in the host's speed hits both alike.
    for (const instrumented of index % 2 === 0 ? [false, true] : [true, false]) {
      const db = connection(instrumented);
      run(db, Math.min(10_000, calls)); // warm up
      const started = Bun.nanoseconds();
      run(db, calls);
      const elapsed = Bun.nanoseconds() - started;
      db.close();
      perCall[instrumented ? "instrumented" : "plain"].push(elapsed / count);
    }
  }
  const plain = median(perCall.plain);
  const instrumented = median(perCall.instrumented);
  rows.push({
    workload: name,
    "plain ns/call": plain.toFixed(0),
    "instrumented ns/call": instrumented.toFixed(0),
    "overhead ns/call": (instrumented - plain).toFixed(0),
  });
}
console.table(rows);
