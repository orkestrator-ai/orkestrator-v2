import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openChangeLedgerDatabase } from "../src/core/change-tracking/ledger-schema.js";
import {
  runDatabaseUpkeep,
  snapshotBeforeMigration,
  takeHourlySnapshotIfDue,
  takeLedgerSnapshotIfDue,
} from "../src/core/storage-backups.js";
import { StorageDatabase } from "../src/core/storage-database.js";
import { storeLayout } from "../src/core/storage-stores.js";

/**
 * How long the periodic storage maintenance holds the backend's event loop
 * (to-do 1202 task 7, report finding ST-13):
 *
 *   mise exec -- bun apps/backend/scripts/storage-maintenance-stall.ts \
 *     [--main-mb 256] [--ledger-mb 256] [--runs 3] [--scrub-only] [--json]
 *
 * Builds a throwaway data directory under the system temporary directory (a
 * main database and a change-tracking ledger of the given sizes, filled with
 * incompressible rows), then runs each step of the snapshot check the way the
 * backend does and records the longest event-loop stall during it. A stall is
 * the lateness of a 2 ms timer chain, the same mechanism as the backend's own
 * stall monitor (`event-loop-stall-monitor.ts`) at a finer interval.
 *
 * - `in-process copy`: `VACUUM INTO` and `quick_check` on this thread, which is
 *   what the hourly copy did before it moved to a child process (8a6bc2f84)
 *   and what the pre-migration snapshot still does.
 * - `hourly check`, `ledger check`: `takeHourlySnapshotIfDue` and
 *   `takeLedgerSnapshotIfDue`, each forced due, copying in a child process.
 * - `hourly check, not due`: the cheap check that runs every five minutes.
 * - `upkeep`: `runDatabaseUpkeep` after 1 / (2 × runs) of the main rows were
 *   deleted, so it has free pages to return; `optimize` alone is timed too.
 * - `scrub`: `scrubDeletedContent` after another such share was deleted. Not part
 *   of the snapshot check: a deletion runs it. Since 2026-11-11 it is only the
 *   truncating checkpoint (storage.md, "Durability and deletion").
 * - `release 16 MiB`: `releaseFreePages()` straight after the scrub, which is
 *   what the scrub also did before 2026-11-11 and the upkeep's child now does
 *   instead.
 *
 * `--scrub-only` skips every step but the last two (and the ledger), for a
 * quick check of the deletion path.
 *
 * The directory is removed afterwards. Nothing outside it is read or written.
 */

const MIB = 1024 * 1024;
const ROW_BYTES = 4096;
const PROBE_INTERVAL_MS = 2;

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} needs a positive number`);
  return value;
}

/** Runs `work` while a timer chain records how late it fires. */
async function measure(work: () => unknown): Promise<{ wallMs: number; maxStallMs: number }> {
  let maxStallMs = 0;
  let stopped = false;
  let expected = performance.now() + PROBE_INTERVAL_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const now = performance.now();
    maxStallMs = Math.max(maxStallMs, now - expected);
    expected = now + PROBE_INTERVAL_MS;
    if (!stopped) timer = setTimeout(tick, PROBE_INTERVAL_MS);
  };
  timer = setTimeout(tick, PROBE_INTERVAL_MS);
  // Let the probe start before the work does.
  await new Promise((resolve) => setTimeout(resolve, 10));
  const started = performance.now();
  await work();
  const wallMs = performance.now() - started;
  // One more tick, so a stall that ends with the work is counted.
  await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS * 3));
  stopped = true;
  clearTimeout(timer);
  return { wallMs, maxStallMs };
}

function fillMain(db: StorageDatabase, bytes: number): void {
  db.writeStore("bench-records", { seed: "value" });
  const insert = db.db.query(
    "INSERT INTO store_rows (store, collection, key, position, owner, value) VALUES ('bench-records', '', ?, ?, ?, ?)",
  );
  const rows = Math.ceil(bytes / ROW_BYTES);
  db.db.transaction(() => {
    for (let index = 0; index < rows; index += 1) {
      const value = JSON.stringify(randomBytes(ROW_BYTES / 2).toString("hex"));
      insert.run(`row-${index}`, index, `owner-${index % 64}`, value);
    }
  })();
  // A query on the rows, so `PRAGMA optimize` has a table this connection used.
  db.db
    .query("SELECT count(*) FROM store_rows WHERE store = 'bench-records' AND owner = ?")
    .get("owner-1");
}

function fillLedger(directory: string, bytes: number): void {
  const ledger = openChangeLedgerDatabase(directory);
  try {
    ledger.db.exec("CREATE TABLE IF NOT EXISTS bench_filler (id INTEGER PRIMARY KEY, body BLOB)");
    const insert = ledger.db.query("INSERT INTO bench_filler (body) VALUES (?)");
    const rows = Math.ceil(bytes / ROW_BYTES);
    ledger.db.transaction(() => {
      for (let index = 0; index < rows; index += 1) insert.run(randomBytes(ROW_BYTES));
    })();
  } finally {
    ledger.close();
  }
}

type Row = { step: string; run: number; wallMs: number; maxStallMs: number };

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

async function main(): Promise<void> {
  const mainMb = argument("--main-mb", 256);
  const ledgerMb = argument("--ledger-mb", 256);
  const runs = argument("--runs", 3);
  const scrubOnly = process.argv.includes("--scrub-only");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "orkestrator-maintenance-stall-"));
  const rows: Row[] = [];
  try {
    const db = new StorageDatabase(directory, {
      layoutFor: (store) => (store === "bench-records" ? { kind: "record" } : storeLayout(store)),
    });
    try {
      fillMain(db, mainMb * MIB);
      if (!scrubOnly) fillLedger(directory, ledgerMb * MIB);
      let clock = Date.now();
      const tick = () => clock;
      const bump = (run: number) => db.writeStore("bench-marker", { run, at: clock });
      // Each run deletes two shares of 1 / (2 × runs) of the rows, never the same one twice.
      const deleteShare = (share: number) =>
        db.db
          .query("DELETE FROM store_rows WHERE store = 'bench-records' AND position % ? = ?")
          .run(2 * runs, share);
      for (let run = 1; run <= runs; run += 1) {
        if (scrubOnly) {
          deleteShare(2 * (run - 1) + 1);
          rows.push({ step: "scrub", run, ...(await measure(() => db.scrubDeletedContent())) });
          rows.push({
            step: "release 16 MiB",
            run,
            ...(await measure(() => db.releaseFreePages())),
          });
          continue;
        }
        clock += 2 * 24 * 60 * 60 * 1000;
        bump(run);
        rows.push({
          step: "in-process copy",
          run,
          ...(await measure(() => snapshotBeforeMigration(db, directory, 0, clock))),
        });
        clock += 2 * 60 * 60 * 1000;
        bump(run);
        rows.push({
          step: "hourly check",
          run,
          ...(await measure(() => takeHourlySnapshotIfDue(db, directory, tick))),
        });
        rows.push({
          step: "hourly check, not due",
          run,
          ...(await measure(() => takeHourlySnapshotIfDue(db, directory, tick))),
        });
        rows.push({
          step: "ledger check",
          run,
          ...(await measure(() => takeLedgerSnapshotIfDue(db, directory, tick))),
        });
        // Free a share of the rows so upkeep has pages to return.
        deleteShare(2 * (run - 1));
        rows.push({ step: "optimize", run, ...(await measure(() => db.optimize())) });
        rows.push({ step: "upkeep", run, ...(await measure(() => runDatabaseUpkeep(db))) });
        // A deletion's scrub is its truncating checkpoint; the release it used
        // to run in-process (up to 16 MiB) is timed on its own after it.
        deleteShare(2 * (run - 1) + 1);
        rows.push({ step: "scrub", run, ...(await measure(() => db.scrubDeletedContent())) });
        rows.push({ step: "release 16 MiB", run, ...(await measure(() => db.releaseFreePages())) });
      }
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ mainMb, ledgerMb, runs, rows }, null, 2)}\n`);
    return;
  }
  console.log(
    `main ${mainMb} MiB, ledger ${ledgerMb} MiB, ${runs} runs, bun ${Bun.version}, ${process.platform}`,
  );
  console.log("step                     wall p50 ms  wall max ms  stall p50 ms  stall max ms");
  for (const step of new Set(rows.map((row) => row.step))) {
    const of = rows.filter((row) => row.step === step);
    const wall = of.map((row) => row.wallMs);
    const stall = of.map((row) => row.maxStallMs);
    console.log(
      `${step.padEnd(24)} ${quantile(wall, 0.5).toFixed(1).padStart(11)}  ${Math.max(...wall)
        .toFixed(1)
        .padStart(11)}  ${quantile(stall, 0.5).toFixed(1).padStart(12)}  ${Math.max(...stall)
        .toFixed(1)
        .padStart(12)}`,
    );
  }
}

await main();
