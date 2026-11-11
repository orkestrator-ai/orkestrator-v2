import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startEventLoopStallMonitor } from "@orkestrator/protocol/event-loop-stall-monitor";
import { releaseFreePagesInChildProcess } from "../src/core/storage-backups.js";
import { StorageDatabase } from "../src/core/storage-database.js";

/**
 * Whether the background free-page release holds the backend's own writers,
 * and with them the event loop, behind the SQLite write lock (to-do 7210 task 4, retired; its
 * findings are in docs/architecture/storage.md, "Migrations"):
 *
 *   mise exec -- bun apps/backend/scripts/storage-release-writer-stall.ts \
 *     [--free-mb 1024] [--live-mb 256] [--disk-load 0,4] \
 *     [--variants "default;slow=999999;checks=20"] \
 *     [--writer-interval-ms 10] [--control-s 10] [--json]
 *
 * Builds one throwaway database under `output/benchmarks/` in this checkout:
 * `--live-mb` of live rows interleaved with `--free-mb` of rows that are then
 * deleted, so the free pages are scattered and `incremental_vacuum` has to move
 * live pages from the end of the file, as after the ledger moved out. Each run
 * clones that file, opens it with {@link StorageDatabase} (the backend's
 * `busy_timeout`, durability and `secure_delete`), and runs the real
 * {@link releaseFreePagesInChildProcess} with the full 1 GiB budget while this
 * thread commits one small store write every `--writer-interval-ms`.
 *
 * Recorded: the latency of each write (time inside the synchronous call, so
 * time the event loop is held), the longest lateness of a 2 ms timer chain, the
 * backend's own stall monitor (`event-loop-stall-monitor.ts`) at a 50 ms
 * interval, and, from a prelude that wraps the child's `exec`, how long each
 * `incremental_vacuum` held the write lock and the gap before the next one.
 * `--disk-load N` runs N processes beside it, each writing and fsyncing 4 MiB
 * blocks into the same directory. Each disk load also gets a control run of
 * `--control-s` seconds with the writer and no release.
 *
 * `--variants` is a `;`-separated list of runs, each a `,`-separated list of
 * overrides of the release as committed (`default` for none):
 *
 * - `pause=<ms>`, `step=<pages>`, `slow=<ms>`: passed to the release.
 *   `slow=999999` is the release before it gave way to a slow step.
 * - `checks=<n>`: n releases back to back, as n upkeep checks without the five
 *   minutes between them. A release that gives way stops at its first slow
 *   step, so one run shows one.
 * - Experiments, not options of the release: `sync=<mode>` rewrites the child's
 *   `PRAGMA synchronous`; `prefetch=<pages>` reads that many pages at the end
 *   of the file before each step, outside the lock; `warm` reads the whole
 *   file once before the release starts.
 *
 * Every file it creates is under its own directory, removed afterwards.
 */

const MIB = 1024 * 1024;
const PAGE_BYTES = 4096;
/** One row per page: under the 4 KiB page's local payload limit. */
const ROW_BYTES = 3500;
const PROBE_INTERVAL_MS = 2;

function argument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} needs a positive number`);
  return value;
}

function list(name: string, fallback: number[]): number[] {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const values = String(process.argv[index + 1])
    .split(",")
    .map(Number);
  if (values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error(`${name} needs a comma-separated list of numbers`);
  }
  return values;
}

interface Variant {
  label: string;
  pauseMs?: number;
  stepPages?: number;
  slowStepMs?: number;
  synchronous?: string;
  prefetchPages?: number;
  warm?: boolean;
  checks?: number;
}

function variants(): Variant[] {
  const index = process.argv.indexOf("--variants");
  const spec = index === -1 ? "default" : String(process.argv[index + 1]);
  return spec.split(";").map((label) => {
    const variant: Variant = { label };
    for (const part of label.split(",")) {
      if (part === "default") continue;
      if (part === "warm") {
        variant.warm = true;
        continue;
      }
      const [key, value] = part.split("=");
      if (key === "pause") variant.pauseMs = Number(value);
      else if (key === "step") variant.stepPages = Number(value);
      else if (key === "slow") variant.slowStepMs = Number(value);
      else if (key === "prefetch") variant.prefetchPages = Number(value);
      else if (key === "checks") variant.checks = Number(value);
      else if (key === "sync" && /^(OFF|NORMAL|FULL|EXTRA)$/.test(value ?? "")) {
        variant.synchronous = value;
      } else throw new Error(`Unknown variant part: ${part}`);
    }
    return variant;
  });
}

export function buildFixture(directory: string, freeMb: number, liveMb: number): string {
  const db = new StorageDatabase(directory);
  try {
    db.db.exec("CREATE TABLE waste (id INTEGER PRIMARY KEY, body BLOB)");
    db.db.exec("CREATE TABLE live (id INTEGER PRIMARY KEY, body BLOB)");
    const waste = db.db.query(`INSERT INTO waste (body) VALUES (randomblob(${ROW_BYTES}))`);
    const live = db.db.query(`INSERT INTO live (body) VALUES (randomblob(${ROW_BYTES}))`);
    const wasteRows = Math.ceil((freeMb * MIB) / PAGE_BYTES);
    const liveRows = Math.ceil((liveMb * MIB) / PAGE_BYTES);
    let written = 0;
    let livesWritten = 0;
    while (written < wasteRows) {
      db.db.transaction(() => {
        for (let batch = 0; batch < 8192 && written < wasteRows; batch += 1, written += 1) {
          waste.run();
          // Spread every live row across the waste rows, including ratios above 1.
          const liveTarget = Math.floor(((written + 1) * liveRows) / wasteRows);
          while (livesWritten < liveTarget) {
            live.run();
            livesWritten += 1;
          }
        }
      })();
    }
    db.db.exec("DELETE FROM waste");
    db.db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } finally {
    db.close();
  }
  return path.join(directory, "orkestrator.sqlite");
}

/** N processes writing and fsyncing 4 MiB blocks, cycling over 256 MiB each. */
function startDiskLoad(directory: string, workers: number): ChildProcess[] {
  const script = `
    const fs = require("node:fs");
    const file = process.argv[1];
    const block = require("node:crypto").randomBytes(4 * 1024 * 1024);
    const fd = fs.openSync(file, "w");
    let offset = 0;
    for (;;) {
      fs.writeSync(fd, block, 0, block.length, offset);
      fs.fsyncSync(fd);
      offset = (offset + block.length) % (256 * 1024 * 1024);
    }
  `;
  return Array.from({ length: workers }, (_, index) =>
    spawn(process.execPath, ["-e", script, path.join(directory, `disk-load-${index}.bin`)], {
      stdio: "ignore",
    }),
  );
}

async function stopDiskLoad(children: ChildProcess[]): Promise<void> {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once("exit", () => resolve());
          child.kill("SIGKILL");
        }),
    ),
  );
}

/**
 * Spawns the real supervisor and helper with a prelude that times each
 * `incremental_vacuum` (the write-lock hold) and the gap after it, written to
 * `traceFile` when the helper exits.
 */
function tracedSpawn(traceFile: string, variant: Variant) {
  return (command: string, args: string[], options: SpawnOptions) => {
    const prelude = `
      const traceFs = require("node:fs");
      const traceSqlite = require("bun:sqlite");
      const holds = [];
      const gaps = [];
      const checkpoints = [];
      const query = traceSqlite.Database.prototype.query;
      traceSqlite.Database.prototype.query = function (sql, ...rest) {
        const statement = query.call(this, sql, ...rest);
        if (!String(sql).includes("wal_checkpoint")) return statement;
        const get = statement.get.bind(statement);
        statement.get = (...args) => {
          const start = performance.now();
          try {
            return get(...args);
          } finally {
            checkpoints.push(performance.now() - start);
          }
        };
        return statement;
      };
      let lastEnd = null;
      const exec = traceSqlite.Database.prototype.exec;
      const synchronous = ${JSON.stringify(variant.synchronous ?? null)};
      const prefetchPages = ${JSON.stringify(variant.prefetchPages ?? 0)};
      const prefetch = (db) => {
        const pageSize = db.query("PRAGMA page_size").get().page_size;
        const pageCount = db.query("PRAGMA page_count").get().page_count;
        const start = Math.max(0, pageCount - prefetchPages) * pageSize;
        const fd = traceFs.openSync(db.filename, "r");
        try {
          const buffer = Buffer.allocUnsafe(1024 * 1024);
          for (let offset = start; offset < pageCount * pageSize; offset += buffer.length) {
            if (traceFs.readSync(fd, buffer, 0, buffer.length, offset) <= 0) break;
          }
        } finally {
          traceFs.closeSync(fd);
        }
      };
      traceSqlite.Database.prototype.exec = function (sql, ...rest) {
        if (synchronous && /^PRAGMA synchronous = /.test(String(sql))) {
          return exec.call(this, "PRAGMA synchronous = " + synchronous, ...rest);
        }
        if (!String(sql).includes("incremental_vacuum")) return exec.call(this, sql, ...rest);
        if (prefetchPages > 0) prefetch(this);
        const start = performance.now();
        if (lastEnd !== null) gaps.push(start - lastEnd);
        try {
          return exec.call(this, sql, ...rest);
        } finally {
          lastEnd = performance.now();
          holds.push(lastEnd - start);
        }
      };
      process.on("exit", () => {
        // Several checks share one trace.
        const file = ${JSON.stringify(traceFile)};
        const before = traceFs.existsSync(file) ? JSON.parse(traceFs.readFileSync(file, "utf8")) : { holds: [], gaps: [], checkpoints: [] };
        traceFs.writeFileSync(file, JSON.stringify({ holds: before.holds.concat(holds), gaps: before.gaps.concat(gaps), checkpoints: before.checkpoints.concat(checkpoints) }));
      });
    `;
    const traced = args.slice();
    // -e, supervisor, --, timeoutMs, helper, ...helperArgs
    traced[4] = prelude + args[4];
    return spawn(command, traced, options);
  };
}

function readTrace(traceFile: string): { holds: number[]; gaps: number[]; checkpoints: number[] } {
  try {
    return JSON.parse(fs.readFileSync(traceFile, "utf8"));
  } catch {
    return { holds: [], gaps: [], checkpoints: [] };
  }
}

interface Result {
  case: string;
  diskLoad: number;
  variant: string;
  wallMs: number;
  released: number;
  writes: number;
  busyErrors: number;
  writeP50Ms: number;
  writeP99Ms: number;
  writeMaxMs: number;
  writesOver100Ms: number;
  writesOver1000Ms: number;
  probeMaxStallMs: number;
  monitorMaxLagMs: number;
  monitorStalls: number;
  stepHoldP50Ms: number;
  stepHoldMaxMs: number;
  stepGapMinMs: number;
  stepGapP50Ms: number;
  checkpointMaxMs: number;
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/** Runs `work` while this thread writes on `db` and both stall probes run. */
async function underWriters(
  db: StorageDatabase,
  writerIntervalMs: number,
  work: () => Promise<number>,
): Promise<
  Omit<
    Result,
    | "case"
    | "diskLoad"
    | "variant"
    | "stepHoldP50Ms"
    | "stepHoldMaxMs"
    | "stepGapMinMs"
    | "stepGapP50Ms"
    | "checkpointMaxMs"
  >
> {
  const latencies: number[] = [];
  let busyErrors = 0;
  let stopped = false;
  let sequence = 0;
  let writer: ReturnType<typeof setTimeout> | undefined;
  const write = () => {
    const started = performance.now();
    try {
      db.writeStore("bench-marker", { sequence: (sequence += 1), at: Date.now() });
    } catch (error) {
      if ((error as { code?: string }).code !== "SQLITE_BUSY") throw error;
      busyErrors += 1;
    }
    latencies.push(performance.now() - started);
    if (!stopped) writer = setTimeout(write, writerIntervalMs);
  };

  let probeMaxStallMs = 0;
  let expected = performance.now() + PROBE_INTERVAL_MS;
  let probe: ReturnType<typeof setTimeout> | undefined;
  const tick = () => {
    const now = performance.now();
    probeMaxStallMs = Math.max(probeMaxStallMs, now - expected);
    expected = now + PROBE_INTERVAL_MS;
    if (!stopped) probe = setTimeout(tick, PROBE_INTERVAL_MS);
  };
  const monitor = startEventLoopStallMonitor({
    intervalMs: 50,
    thresholdMs: 100,
    report: () => undefined,
  });

  probe = setTimeout(tick, PROBE_INTERVAL_MS);
  writer = setTimeout(write, writerIntervalMs);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const started = performance.now();
  let released = 0;
  try {
    released = await work();
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 100));
    stopped = true;
    clearTimeout(writer);
    clearTimeout(probe);
    monitor.stop();
  }
  const wallMs = performance.now() - started;
  const snapshot = monitor.snapshot();
  const sorted = latencies.toSorted((a, b) => a - b);
  return {
    wallMs,
    released,
    writes: latencies.length,
    busyErrors,
    writeP50Ms: quantile(sorted, 0.5),
    writeP99Ms: quantile(sorted, 0.99),
    writeMaxMs: sorted.at(-1) ?? 0,
    writesOver100Ms: sorted.filter((ms) => ms >= 100).length,
    writesOver1000Ms: sorted.filter((ms) => ms >= 1000).length,
    probeMaxStallMs,
    monitorMaxLagMs: snapshot.maxLagMs,
    monitorStalls: snapshot.stalls,
  };
}

function clone(source: string, directory: string): void {
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, "orkestrator.sqlite");
  try {
    fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE_FORCE);
  } catch {
    fs.copyFileSync(source, target);
  }
}

async function main(): Promise<void> {
  const freeMb = argument("--free-mb", 1024);
  const liveMb = argument("--live-mb", 256);
  const writerIntervalMs = argument("--writer-interval-ms", 10);
  const controlMs = argument("--control-s", 10) * 1000;
  const releaseVariants = variants();
  const diskLoads = list("--disk-load", [0, 4]);
  const root = path.resolve(import.meta.dir, "../../../output/benchmarks");
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, "storage-release-writer-stall-"));
  const results: Result[] = [];
  try {
    const fixtureStarted = performance.now();
    const fixture = buildFixture(path.join(directory, "fixture"), freeMb, liveMb);
    const fixtureMs = performance.now() - fixtureStarted;
    if (!process.argv.includes("--json")) {
      console.log(
        `fixture ${(fs.statSync(fixture).size / MIB).toFixed(0)} MiB in ${(fixtureMs / 1000).toFixed(1)} s`,
      );
    }
    let run = 0;
    for (const diskLoad of diskLoads) {
      const load = startDiskLoad(directory, diskLoad);
      try {
        // Let the load reach a steady state.
        if (diskLoad > 0) await new Promise((resolve) => setTimeout(resolve, 2_000));
        const cases: Array<Variant | null> = [null, ...releaseVariants];
        for (const variant of cases) {
          run += 1;
          const runDirectory = path.join(directory, `run-${run}`);
          clone(fixture, runDirectory);
          const db = new StorageDatabase(runDirectory);
          const traceFile = path.join(runDirectory, "trace.json");
          try {
            // Outside the measurement: a synchronous read of the whole file.
            if (variant?.warm) {
              const fd = fs.openSync(db.path, "r");
              try {
                const buffer = Buffer.allocUnsafe(MIB);
                while (fs.readSync(fd, buffer, 0, buffer.length, null) > 0);
              } finally {
                fs.closeSync(fd);
              }
            }
            const measured = await underWriters(db, writerIntervalMs, async () => {
              if (variant === null) {
                await new Promise((resolve) => setTimeout(resolve, controlMs));
                return 0;
              }
              let released = 0;
              for (let check = 0; check < (variant.checks ?? 1); check += 1) {
                const result = await releaseFreePagesInChildProcess(db.path, {
                  pauseMs: variant.pauseMs,
                  stepPages: variant.stepPages,
                  slowStepMs: variant.slowStepMs,
                  spawn: tracedSpawn(traceFile, variant),
                });
                released += result.released;
                if (result.left === 0) break;
              }
              return released;
            });
            const trace = readTrace(traceFile);
            const holds = trace.holds.toSorted((a, b) => a - b);
            const gaps = trace.gaps.toSorted((a, b) => a - b);
            const checkpoints = trace.checkpoints.toSorted((a, b) => a - b);
            const result: Result = {
              case: variant === null ? "writers only" : `release ${variant.label}`,
              diskLoad,
              variant: variant?.label ?? "none",
              ...measured,
              stepHoldP50Ms: quantile(holds, 0.5),
              stepHoldMaxMs: holds.at(-1) ?? 0,
              stepGapMinMs: gaps[0] ?? 0,
              stepGapP50Ms: quantile(gaps, 0.5),
              checkpointMaxMs: checkpoints.at(-1) ?? 0,
            };
            results.push(result);
            if (!process.argv.includes("--json")) printRow(result);
          } finally {
            db.close();
            fs.rmSync(runDirectory, { recursive: true, force: true });
          }
        }
      } finally {
        await stopDiskLoad(load);
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  if (process.argv.includes("--json")) {
    process.stdout.write(
      `${JSON.stringify({ freeMb, liveMb, writerIntervalMs, bun: Bun.version, results }, null, 2)}\n`,
    );
  }
}

let headerPrinted = false;
function printRow(result: Result): void {
  if (!headerPrinted) {
    headerPrinted = true;
    console.log(
      "case                           load  wall s  released  writes  busy  p50 ms  p99 ms  max ms  >=100  >=1000  probe ms  monitor ms  hold p50  hold max  gap min  gap p50  ckpt max",
    );
  }
  const n = (value: number, width: number, digits = 1) => value.toFixed(digits).padStart(width);
  console.log(
    `${result.case.padEnd(30)} ${String(result.diskLoad).padStart(4)}  ${n(result.wallMs / 1000, 6)}  ${String(result.released).padStart(8)}  ${String(result.writes).padStart(6)}  ${String(result.busyErrors).padStart(4)}  ${n(result.writeP50Ms, 6)}  ${n(result.writeP99Ms, 6)}  ${n(result.writeMaxMs, 6)}  ${String(result.writesOver100Ms).padStart(5)}  ${String(result.writesOver1000Ms).padStart(6)}  ${n(result.probeMaxStallMs, 8)}  ${n(result.monitorMaxLagMs, 10, 0)}  ${n(result.stepHoldP50Ms, 8)}  ${n(result.stepHoldMaxMs, 8)}  ${n(result.stepGapMinMs, 7)}  ${n(result.stepGapP50Ms, 7)}  ${n(result.checkpointMaxMs, 8)}`,
  );
}

if (import.meta.main) await main();
