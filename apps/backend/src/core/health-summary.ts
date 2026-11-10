import { eventLoopDiagnostics } from "@orkestrator/protocol/event-loop-stall-monitor";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { RecurringWorkSnapshot } from "@orkestrator/protocol/recurring-work";
import { bridgeRestarts, type BridgeRestartSnapshot } from "./bridge-restarts.js";
import { HEALTH_SUMMARY_STORE } from "./health-summary-layout.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";
import type { DatabaseSummaryCache } from "./database-summary.js";
import type { StorageDatabase } from "./storage-database.js";

const log = createLogger("backend");

/**
 * A rolling, content-free record of how this backend has been doing, kept in
 * the database so it survives the restart it may explain: every in-memory
 * metric resets then, and "is it leaking?", "why did it restart?" and "which job
 * burns CPU?" otherwise have no answer afterwards.
 *
 * One row per sample every {@link HEALTH_SAMPLE_INTERVAL_MS}, plus a `started`
 * marker at start and a `clean-exit` marker as the last shutdown step. Rows hold
 * numbers, recurring-work job kinds and bridge provider names (fixed
 * vocabularies) only. The backend's
 * identity is its pid and start time, so a row needs no string to say whose it
 * is. Backends sharing a directory each write their own rows, under one bound:
 * a second backend's health can be the thing someone is investigating.
 *
 * A marker-less run reads as crashed, which is right for a kill or a power
 * loss, and also what a shutdown failing late looks like.
 *
 * The sample is one plain timer and not a recurring job, so it does not appear
 * in the figures it reports.
 *
 * Under Bun 1.4.4 only `rss` tracks what a leak needs: it follows JavaScript
 * objects, `Buffer`s and SQLite's own memory. `heapUsed` can exceed `heapTotal`,
 * `external` follows `Buffer`s only after a GC, and `arrayBuffers` stayed 0 with
 * 200 MiB held in a `Buffer`, so it is not kept. Read the heap figures as trends.
 */
export const HEALTH_SAMPLE_INTERVAL_MS = 5 * 60 * 1000;
/** Seven days at one backend. Two backends halve the history. */
export const HEALTH_SUMMARY_MAX_ROWS = 2_016;
/** Job kinds a sample lists: those with the most run time, enough to name a culprit. */
export const HEALTH_SAMPLE_MAX_JOB_KINDS = 8;
/** A row this recent from a live pid means that backend is still running, not gone. */
const LIVE_BACKEND_WINDOW_MS = 2 * HEALTH_SAMPLE_INTERVAL_MS;

export interface HealthSampleJob {
  started: number;
  failed: number;
  active: number;
  totalMs: number;
}

export interface HealthSample {
  uptimeMs: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  /** Cumulative in this process. */
  stalls: number | null;
  worstStallMs: number | null;
  mainDatabaseBytes: number | null;
  mainWalBytes: number | null;
  mainFreeBytes: number | null;
  ledgerBytes: number | null;
  ledgerWalBytes: number | null;
  backupBytes: number | null;
  jobs: Record<string, HealthSampleJob>;
  /**
   * Bridge starts, unrequested exits and container launches per provider,
   * cumulative in this process; providers with no count are left out. Absent
   * from a row an older backend wrote.
   */
  bridges?: BridgeRestartSnapshot;
}

export type HealthRow =
  | { kind: "started"; at: number; pid: number; startedAt: number }
  | { kind: "clean-exit"; at: number; pid: number; startedAt: number }
  | ({ kind: "sample"; at: number; pid: number; startedAt: number } & HealthSample);

export type PreviousRun =
  { outcome: "none" } | { outcome: "clean" | "crashed"; ranForMs: number; lastSeenAgoMs: number };

/** The instance's rows oldest first by time; zero-padded so the key order is that order. */
function rowKey(row: HealthRow, sequence: number): string {
  return [
    String(row.at).padStart(15, "0"),
    String(row.pid).padStart(10, "0"),
    String(sequence).padStart(6, "0"),
  ].join("-");
}

function isHealthRow(value: unknown): value is HealthRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Partial<HealthRow>;
  return (
    (row.kind === "started" || row.kind === "clean-exit" || row.kind === "sample") &&
    Number.isFinite(row.at) &&
    Number.isFinite(row.pid) &&
    Number.isFinite(row.startedAt)
  );
}

/** Every row, oldest first. Unreadable rows are skipped: this is a diagnostic. */
export function readHealthRows(database: StorageDatabase): HealthRow[] {
  if (!database.hasStore(HEALTH_SUMMARY_STORE)) return [];
  const rows: HealthRow[] = [];
  for (const entry of database.rows(HEALTH_SUMMARY_STORE).list()) {
    try {
      const value = JSON.parse(entry.value ?? "null") as unknown;
      if (isHealthRow(value)) rows.push(value);
    } catch {
      // Skipped.
    }
  }
  return rows.sort((left, right) => left.at - right.at);
}

/**
 * How the most recent earlier run ended. A run with no `clean-exit` crashed,
 * unless it looks alive: another backend sharing the directory, whose pid
 * answers and whose last row is recent. That one is skipped rather than reported
 * as a crash, and the pid and the row's age together cover a reused pid.
 */
export function previousRunOf(
  rows: readonly HealthRow[],
  self: { pid: number; startedAt: number },
  now: number,
  isAlive: (pid: number) => boolean,
): PreviousRun {
  const runs = new Map<
    string,
    { pid: number; startedAt: number; lastAt: number; clean: boolean }
  >();
  for (const row of rows) {
    if (row.pid === self.pid && row.startedAt === self.startedAt) continue;
    const key = `${row.pid}:${row.startedAt}`;
    const run = runs.get(key) ?? {
      pid: row.pid,
      startedAt: row.startedAt,
      lastAt: row.at,
      clean: false,
    };
    run.lastAt = Math.max(run.lastAt, row.at);
    run.clean ||= row.kind === "clean-exit";
    runs.set(key, run);
  }
  const newestFirst = [...runs.values()].sort((left, right) => right.startedAt - left.startedAt);
  for (const run of newestFirst) {
    if (!run.clean && now - run.lastAt < LIVE_BACKEND_WINDOW_MS && isAlive(run.pid)) continue;
    return {
      outcome: run.clean ? "clean" : "crashed",
      ranForMs: Math.max(0, run.lastAt - run.startedAt),
      lastSeenAgoMs: Math.max(0, now - run.lastAt),
    };
  }
  return { outcome: "none" };
}

/** Kinds with the most run time, so a row stays small whatever the vocabulary grows to. */
export function topJobKinds(snapshot: RecurringWorkSnapshot): Record<string, HealthSampleJob> {
  const jobs = Object.entries(snapshot.kinds)
    .map(
      ([kind, job]) =>
        [
          kind,
          {
            started: job.started,
            failed: job.failed,
            active: job.active,
            totalMs: job.duration.totalMs,
          },
        ] as const,
    )
    .filter(([, job]) => job.started > 0 || job.active > 0)
    .sort((left, right) => right[1].totalMs - left[1].totalMs)
    .slice(0, HEALTH_SAMPLE_MAX_JOB_KINDS);
  return Object.fromEntries(jobs);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface HealthSummaryOptions {
  database: () => StorageDatabase;
  /** The same cached summary `/metrics` reads. Absent in a test that only checks markers. */
  databaseSummary?: Pick<DatabaseSummaryCache, "read">;
  now?: () => number;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  intervalMs?: number;
  maxRows?: number;
  memory?: () => Pick<NodeJS.MemoryUsage, "rss" | "heapUsed" | "heapTotal" | "external">;
  cpu?: () => { user: number; system: number };
  recurringWork?: () => RecurringWorkSnapshot;
  bridgeRestarts?: () => BridgeRestartSnapshot;
}

export class HealthSummary {
  private readonly now: () => number;
  private readonly pid: number;
  private readonly startedAt: number;
  private readonly maxRows: number;
  private sequence = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(private readonly options: HealthSummaryOptions) {
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.startedAt = this.now();
    this.maxRows = options.maxRows ?? HEALTH_SUMMARY_MAX_ROWS;
  }

  /** Reads the previous run's ending, says it in one log line, and starts the samples. */
  start(): PreviousRun | null {
    if (this.started) return null;
    this.started = true;
    let previous: PreviousRun | null = null;
    try {
      const now = this.now();
      previous = previousRunOf(
        readHealthRows(this.options.database()),
        { pid: this.pid, startedAt: this.startedAt },
        now,
        this.options.isAlive ?? processIsAlive,
      );
      if (previous.outcome === "crashed") log.warn("previous-run", previous);
      else if (previous.outcome === "clean") log.info("previous-run", previous);
    } catch (error) {
      log.warn("health.write-failed", { error: formatLogError(error, { message: false }) });
    }
    this.write({ kind: "started", ...this.identity() });
    this.timer = setInterval(
      () => this.sample(),
      this.options.intervalMs ?? HEALTH_SAMPLE_INTERVAL_MS,
    );
    this.timer.unref?.();
    return previous;
  }

  /** Stops the samples. A shutdown that failed stops them without claiming a clean exit. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The last shutdown step, before the database closes. */
  recordCleanExit(): void {
    this.stop();
    if (!this.started) return;
    this.write({ kind: "clean-exit", ...this.identity() });
  }

  /** Takes and stores one sample now; the timer's body. */
  sample(): void {
    this.write({ kind: "sample", ...this.identity(), ...this.collect() });
  }

  private identity() {
    return { at: this.now(), pid: this.pid, startedAt: this.startedAt };
  }

  private collect(): HealthSample {
    const memory = (this.options.memory ?? process.memoryUsage)();
    const cpu = (this.options.cpu ?? process.cpuUsage)();
    const loop = eventLoopDiagnostics();
    let summary: ReturnType<DatabaseSummaryCache["read"]> | null = null;
    try {
      summary = this.options.databaseSummary?.read() ?? null;
    } catch {
      // The process figures are worth keeping without the database's.
    }
    return {
      uptimeMs: this.now() - this.startedAt,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      cpuUserMs: Math.round(cpu.user / 1000),
      cpuSystemMs: Math.round(cpu.system / 1000),
      stalls: loop?.stalls ?? null,
      worstStallMs: loop?.maxLagMs ?? null,
      mainDatabaseBytes: summary?.main?.fileBytes ?? null,
      mainWalBytes: summary?.main?.walBytes ?? null,
      mainFreeBytes: summary?.main?.freelistBytes ?? null,
      ledgerBytes: summary?.ledger?.fileBytes ?? null,
      ledgerWalBytes: summary?.ledger?.walBytes ?? null,
      backupBytes: summary?.backups.bytes ?? null,
      jobs: topJobKinds((this.options.recurringWork ?? (() => recurringWorkMetrics.snapshot()))()),
      bridges: (this.options.bridgeRestarts ?? (() => bridgeRestarts.snapshot()))(),
    };
  }

  /** One row and its pruning commit together, so the bound holds at every commit. */
  private write(row: HealthRow): void {
    try {
      const database = this.options.database();
      if (database.isClosed()) return;
      database.transaction(() => {
        const rows = database.rows(HEALTH_SUMMARY_STORE);
        rows.put(rowKey(row, (this.sequence += 1)), JSON.stringify(row));
        const keys = rows
          .list({ values: false })
          .map((entry) => entry.key)
          .sort();
        for (const key of keys.slice(0, Math.max(0, keys.length - this.maxRows))) {
          rows.delete(key);
        }
      });
    } catch (error) {
      log.warn("health.write-failed", { error: formatLogError(error, { message: false }) });
    }
  }
}
