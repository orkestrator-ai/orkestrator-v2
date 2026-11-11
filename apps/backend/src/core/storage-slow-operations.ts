import type { Database } from "bun:sqlite";
import type {
  SlowStorageOperation,
  SlowStorageOperationSeries,
  SlowStorageOperationsSnapshot,
} from "@orkestrator/protocol/backend-diagnostics";
import type { EventLoopStallContext } from "@orkestrator/protocol/event-loop-stall-monitor";
import { createLogger } from "@orkestrator/protocol/logger";
import {
  readSeriesForStore,
  readSeriesForTable,
  storageActivityMetrics,
  type StorageActivityMetrics,
} from "./storage-activity-metrics.js";
import { leaseFamily } from "./storage-lease-metrics.js";

/**
 * A bounded, content-free record of the synchronous SQLite calls and
 * transactions that held the event loop. `bun:sqlite` runs on the event-loop
 * thread and its busy handler sleeps there, so a call waiting for another
 * connection's write lock (up to the busy timeout, 10 s by default) is an
 * event-loop stall that otherwise leaves no trace of its cause.
 *
 * {@link instrumentSqliteConnection} times every statement call and every
 * outermost transaction on one connection. Below the threshold a call costs
 * two `performance.now()` reads, a comparison and its commit/read count
 * (`storage-activity-metrics.ts`). Counting needs the statement's kind: a
 * prepared statement (`query`, `prepare`) is classified once, on its first
 * call, but `db.run` and `db.exec` carry their SQL per call, so each of those
 * calls lowercases and matches the first 512 characters of its SQL
 * ({@link classifyStatement}). The slow-operation record parses the SQL again
 * only when a call is slow. Never kept or logged: SQL text, parameters, rows.
 */
const log = createLogger("storage");

/** A call this long blocked everything else the backend serves. */
export const SLOW_STORAGE_OPERATION_MS = 250;
/** Minimum spacing of `operation.slow` lines per series; the rest are folded in. */
export const SLOW_STORAGE_LOG_INTERVAL_MS = 10_000;
/** A call at least this long is always logged. */
export const SLOW_STORAGE_ALWAYS_LOG_MS = 5_000;
export const RECENT_SLOW_STORAGE_OPERATIONS = 32;
export const MAX_SLOW_STORAGE_SERIES = 64;

export type StorageDatabaseName = "main" | "ledger" | "other";
export type TransactionMode = "deferred" | "immediate" | "exclusive";

/** Statement kinds, from the leading keyword. */
export const STORAGE_OPERATION_KINDS = [
  "select",
  "insert",
  "update",
  "delete",
  "pragma",
  "schema",
  "vacuum",
  "transaction",
  "other",
] as const;
export type StorageOperationKind = (typeof STORAGE_OPERATION_KINDS)[number];

const KEYWORD_KINDS: Readonly<Record<string, StorageOperationKind>> = {
  select: "select",
  with: "select",
  insert: "insert",
  replace: "insert",
  update: "update",
  delete: "delete",
  pragma: "pragma",
  create: "schema",
  drop: "schema",
  alter: "schema",
  vacuum: "vacuum",
};

/** A name the code wrote: a table or a pragma. Anything else is not kept. */
const IDENTIFIER = /^[a-z]+(?:_[a-z]+)*$/;
const TABLE_AFTER: Partial<Record<StorageOperationKind, RegExp>> = {
  select: /\bfrom\s+["`[]?([a-z0-9_]+)/,
  insert: /\binto\s+["`[]?([a-z0-9_]+)/,
  update: /^\s*update\s+(?:or\s+[a-z]+\s+)?["`[]?([a-z0-9_]+)/,
  delete: /\bfrom\s+["`[]?([a-z0-9_]+)/,
  pragma: /^\s*pragma\s+(?:[a-z_]+\.)?([a-z0-9_]+)/,
  schema: /\b(?:table|index)\s+(?:if\s+(?:not\s+)?exists\s+)?["`[]?([a-z0-9_]+)/,
};

/** A statement's kind and table, from code-written SQL. Never returns SQL text. */
export function describeStatement(sql: string | null): {
  op: StorageOperationKind;
  table: string | null;
} {
  if (!sql) return { op: "other", table: null };
  // Leading keywords and identifiers are within the first few hundred
  // characters of every statement this backend writes.
  const head = sql.slice(0, 512).toLowerCase();
  const keyword = /^\s*([a-z]+)/.exec(head)?.[1] ?? "";
  const op = KEYWORD_KINDS[keyword] ?? "other";
  const table = TABLE_AFTER[op]?.exec(head)?.[1] ?? null;
  return { op, table: table && table.length <= 64 && IDENTIFIER.test(table) ? table : null };
}

/**
 * What a statement does to the file, for the commit and read counts
 * (`storage-activity-metrics.ts`): `read` a SELECT; `change` an INSERT,
 * UPDATE or DELETE, which writes only when it changes a row; `write` a schema
 * change or an incremental vacuum; `checkpoint` a `wal_checkpoint`; `none`
 * anything else (other pragmas, BEGIN and COMMIT, VACUUM INTO).
 */
export type StatementEffect = "read" | "change" | "write" | "checkpoint" | "none";

export interface ClassifiedStatement {
  effect: StatementEffect;
  table: string | null;
}

export function classifyStatement(sql: string | null): ClassifiedStatement {
  const { op, table } = describeStatement(sql);
  switch (op) {
    case "select":
      return { effect: "read", table };
    case "insert":
    case "update":
    case "delete":
      return { effect: "change", table };
    case "schema":
      return { effect: "write", table };
    case "pragma":
      if (table === "incremental_vacuum") return { effect: "write", table };
      if (table === "wal_checkpoint") return { effect: "checkpoint", table };
      return { effect: "none", table };
    default:
      return { effect: "none", table };
  }
}

/** Whether a call that completed wrote to the file. */
function wrote(effect: StatementEffect, result: unknown): boolean {
  if (effect === "write") return true;
  if (effect !== "change") return false;
  // `run` reports what it changed; a RETURNING read through `get` or `all`
  // does not, and counts as a change.
  const changes = (result as { changes?: unknown } | null)?.changes;
  return typeof changes === "number" ? changes > 0 : true;
}

export function storageDatabaseName(file: string): StorageDatabaseName {
  if (file === "orkestrator.sqlite") return "main";
  if (file === "change-tracking.sqlite") return "ledger";
  return "other";
}

/** What one connection measured; {@link SlowStorageOperations.record} keeps it. */
export interface SlowStorageSample {
  database: StorageDatabaseName;
  op: StorageOperationKind;
  /** The SQL the table is read from: the statement's, or a transaction's slowest. */
  sql: string | null;
  store: string | null;
  mode: TransactionMode | null;
  durationMs: number;
  beginMs: number | null;
  sqlMs: number | null;
  commitMs: number | null;
  busy: boolean;
  /** Monotonic end, in `performance.now()` milliseconds. */
  endedAtMs: number;
}

interface Series extends SlowStorageOperationSeries {
  lastLoggedAtMs: number;
  folded: number;
  foldedMaxMs: number;
}

interface RecentOperation extends SlowStorageOperation {
  endedAtMs: number;
}

const round = (ms: number | null) => (ms === null ? null : Math.round(ms));

export class SlowStorageOperations {
  private readonly series = new Map<string, Series>();
  private overflowed = 0;
  private readonly recent: RecentOperation[] = [];

  constructor(
    readonly thresholdMs = SLOW_STORAGE_OPERATION_MS,
    private readonly options: {
      logIntervalMs?: number;
      alwaysLogMs?: number;
      wallClock?: () => number;
    } = {},
  ) {}

  record(sample: SlowStorageSample): void {
    const { op, table } =
      sample.op === "transaction"
        ? { op: "transaction" as const, table: describeStatement(sample.sql).table }
        : describeStatement(sample.sql);
    const durationMs = Math.round(sample.durationMs);
    const store = sample.store === null ? null : leaseFamily(sample.store);
    const operation: RecentOperation = {
      at: new Date((this.options.wallClock ?? Date.now)()).toISOString(),
      database: sample.database,
      op,
      table,
      store,
      mode: sample.mode,
      durationMs,
      beginMs: round(sample.beginMs),
      sqlMs: round(sample.sqlMs),
      commitMs: round(sample.commitMs),
      busy: sample.busy,
      endedAtMs: sample.endedAtMs,
    };
    this.recent.push(operation);
    if (this.recent.length > RECENT_SLOW_STORAGE_OPERATIONS) this.recent.shift();

    let key = `${sample.database}:${op}:${table ?? "-"}`;
    if (!this.series.has(key) && this.series.size >= MAX_SLOW_STORAGE_SERIES) {
      this.overflowed += 1;
      key = "other";
    }
    let series = this.series.get(key);
    if (!series) {
      series = {
        count: 0,
        totalMs: 0,
        maxMs: 0,
        lastLoggedAtMs: -Infinity,
        folded: 0,
        foldedMaxMs: 0,
      };
      this.series.set(key, series);
    }
    series.count += 1;
    series.totalMs += durationMs;
    series.maxMs = Math.max(series.maxMs, durationMs);

    const alwaysLogMs = this.options.alwaysLogMs ?? SLOW_STORAGE_ALWAYS_LOG_MS;
    const logIntervalMs = this.options.logIntervalMs ?? SLOW_STORAGE_LOG_INTERVAL_MS;
    if (durationMs < alwaysLogMs && sample.endedAtMs - series.lastLoggedAtMs < logIntervalMs) {
      series.folded += 1;
      series.foldedMaxMs = Math.max(series.foldedMaxMs, durationMs);
      return;
    }
    const { folded, foldedMaxMs } = series;
    series.lastLoggedAtMs = sample.endedAtMs;
    series.folded = 0;
    series.foldedMaxMs = 0;
    // Absent rather than null, so a statement's line stays short.
    log.warn("operation.slow", {
      database: operation.database,
      op,
      table: table ?? undefined,
      store: store ?? undefined,
      mode: operation.mode ?? undefined,
      durationMs,
      beginMs: operation.beginMs ?? undefined,
      sqlMs: operation.sqlMs ?? undefined,
      commitMs: operation.commitMs ?? undefined,
      busy: operation.busy,
      folded: folded > 0 ? folded : undefined,
      foldedMaxMs: folded > 0 ? foldedMaxMs : undefined,
    });
  }

  /**
   * The longest slow operation overlapping `fromMs`–`toMs` (monotonic), as
   * stall-line fields, plus how much slow storage time fell in the window.
   */
  stallContext({
    fromMs,
    toMs,
  }: {
    fromMs: number;
    toMs: number;
  }): EventLoopStallContext | undefined {
    let longest: RecentOperation | null = null;
    let totalMs = 0;
    for (const operation of this.recent) {
      const startedAtMs = operation.endedAtMs - operation.durationMs;
      if (operation.endedAtMs < fromMs || startedAtMs > toMs) continue;
      totalMs += Math.min(operation.endedAtMs, toMs) - Math.max(startedAtMs, fromMs);
      if (!longest || operation.durationMs > longest.durationMs) longest = operation;
    }
    if (!longest) return undefined;
    return {
      storageMs: totalMs,
      storageDatabase: longest.database,
      storageOp: longest.op,
      storageTable: longest.table,
      storageStore: longest.store,
      storageLongestMs: longest.durationMs,
      storageBusy: longest.busy,
    };
  }

  snapshot(): SlowStorageOperationsSnapshot {
    const series: Record<string, SlowStorageOperationSeries> = {};
    for (const [key, { count, totalMs, maxMs }] of this.series) {
      series[key] = { count, totalMs, maxMs };
    }
    return {
      thresholdMs: this.thresholdMs,
      series,
      overflowed: this.overflowed,
      recent: this.recent.map(({ endedAtMs: _endedAtMs, ...operation }) => ({ ...operation })),
    };
  }
}

/** The process-wide record every {@link StorageDatabase} connection reports into. */
export const slowStorageOperations = new SlowStorageOperations();

function isBusy(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.startsWith("SQLITE_BUSY");
}

type AnyFunction = (this: unknown, ...args: unknown[]) => unknown;
const TIMED_STATEMENT_METHODS = ["get", "all", "run", "values"] as const;

/**
 * One connection's timing. Set {@link store} just before starting a
 * transaction to name the store it works on; the next transaction takes it,
 * nested or not.
 */
export interface SqliteConnectionTiming {
  store: string | null;
}

/** The open outermost transaction's measurements; `depth` 0 when none is open. */
interface TransactionState extends SqliteConnectionTiming {
  depth: number;
  sqlMs: number;
  slowestMs: number;
  slowestSql: string | null;
  /** A statement in it changed the file, so its COMMIT writes the WAL. */
  wrote: boolean;
}

/**
 * Times every statement (`query`, `prepare`, `run`, `exec`) and outermost
 * transaction on `db`, reporting those at or over the recorder's threshold.
 * Only the outermost transaction is timed (bun:sqlite turns a nested one into
 * a savepoint), and its time is split: `begin` and `commit` are the time
 * before and after its body, which is where the write lock and the WAL sync
 * are paid. Statement methods are own properties of each bun:sqlite
 * statement, so they are wrapped in place, once per statement.
 *
 * Every completed call and outermost transaction is also counted in
 * `activity` (`storage-activity-metrics.ts`): a transaction or a statement
 * outside one that changed the file is a commit, timed by its COMMIT (or the
 * whole statement); one that only read is a read, timed by its statements. A
 * prepared statement is classified once, when first called.
 */
export function instrumentSqliteConnection(
  db: Database,
  database: StorageDatabaseName,
  options: {
    recorder?: SlowStorageOperations;
    activity?: StorageActivityMetrics;
    now?: () => number;
  } = {},
): SqliteConnectionTiming {
  const recorder = options.recorder ?? slowStorageOperations;
  const activity = options.activity ?? storageActivityMetrics;
  const now = options.now ?? (() => performance.now());
  const state: TransactionState = {
    store: null,
    depth: 0,
    sqlMs: 0,
    slowestMs: -1,
    slowestSql: null,
    wrote: false,
  };
  activity.connectionOpened(database);
  const timedStatements = new WeakSet<object>();

  const slow = (sample: Omit<SlowStorageSample, "database">): void => {
    try {
      recorder.record({ ...sample, database });
    } catch {
      // Evidence must never fail the call it describes.
    }
  };

  /** Counts a completed call; never throws into it. */
  const count = (classified: ClassifiedStatement, result: unknown, ms: number): void => {
    try {
      const changed = wrote(classified.effect, result);
      if (state.depth > 0) {
        if (changed) state.wrote = true;
      } else if (changed) {
        activity.commit(database, ms);
      } else if (classified.effect === "read") {
        activity.read(database, readSeriesForTable(classified.table), ms);
      } else if (classified.effect === "checkpoint") {
        activity.checkpoint(database, ms);
      }
    } catch {
      // Evidence must never fail the call it describes.
    }
  };

  /** Wraps a call whose SQL is `sqlOf(args)`, classified by `classify(args)`. */
  const timed = (
    method: AnyFunction,
    sqlOf: (args: unknown[]) => string | null,
    classify: (args: unknown[]) => ClassifiedStatement,
  ): AnyFunction =>
    function (this: unknown, ...args: unknown[]) {
      const startedAt = now();
      let busy = false;
      let completed = false;
      let result: unknown;
      try {
        result = method.apply(this, args);
        completed = true;
        return result;
      } catch (error) {
        busy = isBusy(error);
        throw error;
      } finally {
        const endedAt = now();
        const ms = endedAt - startedAt;
        if (completed) count(classify(args), result, ms);
        if (state.depth > 0) {
          state.sqlMs += ms;
          if (ms > state.slowestMs) {
            state.slowestMs = ms;
            state.slowestSql = sqlOf(args);
          }
        } else if (ms >= recorder.thresholdMs) {
          const sql = sqlOf(args);
          slow({
            op: describeStatement(sql).op,
            sql,
            store: null,
            mode: null,
            durationMs: ms,
            beginMs: null,
            sqlMs: null,
            commitMs: null,
            busy,
            endedAtMs: endedAt,
          });
        }
      }
    };

  const statement = (created: unknown, sql: string): unknown => {
    const target = created as Record<string, AnyFunction>;
    if (timedStatements.has(target)) return created;
    timedStatements.add(target);
    let classified: ClassifiedStatement | null = null;
    const classify = () => (classified ??= classifyStatement(sql));
    for (const name of TIMED_STATEMENT_METHODS) {
      const method = target[name];
      if (typeof method === "function") target[name] = timed(method, () => sql, classify);
    }
    return created;
  };

  /** Counts an outermost transaction that returned; never throws into it. */
  const countTransaction = (
    store: string | null,
    endedAt: number,
    marks: { bodyStartedAt: number; bodyEndedAt: number },
  ): void => {
    try {
      if (state.wrote) {
        const bodyEndedAt = Number.isNaN(marks.bodyEndedAt) ? endedAt : marks.bodyEndedAt;
        activity.commit(database, endedAt - bodyEndedAt);
      } else if (state.slowestMs >= 0) {
        // Only a transaction that ran a statement read anything.
        const series =
          store === null
            ? readSeriesForTable(describeStatement(state.slowestSql).table)
            : readSeriesForStore(store);
        activity.read(database, series, state.sqlMs);
      }
    } catch {
      // Evidence must never fail the call it describes.
    }
  };

  const timedTransaction = (
    variant: AnyFunction,
    mode: TransactionMode,
    marks: { bodyStartedAt: number; bodyEndedAt: number },
  ): AnyFunction =>
    function (this: unknown, ...args: unknown[]) {
      const store = state.store;
      state.store = null;
      if (state.depth > 0) return variant.apply(this, args);
      state.depth = 1;
      state.sqlMs = 0;
      state.slowestMs = -1;
      state.slowestSql = null;
      state.wrote = false;
      marks.bodyStartedAt = Number.NaN;
      marks.bodyEndedAt = Number.NaN;
      const startedAt = now();
      let busy = false;
      let committed = false;
      try {
        const result = variant.apply(this, args);
        committed = true;
        return result;
      } catch (error) {
        busy = isBusy(error);
        throw error;
      } finally {
        state.depth = 0;
        const endedAt = now();
        const ms = endedAt - startedAt;
        if (committed) countTransaction(store, endedAt, marks);
        if (ms >= recorder.thresholdMs) {
          const ran = !Number.isNaN(marks.bodyStartedAt);
          const bodyEndedAt = Number.isNaN(marks.bodyEndedAt) ? endedAt : marks.bodyEndedAt;
          slow({
            op: "transaction",
            sql: state.slowestSql,
            store,
            mode,
            durationMs: ms,
            beginMs: (ran ? marks.bodyStartedAt : endedAt) - startedAt,
            sqlMs: state.sqlMs,
            commitMs: ran ? endedAt - bodyEndedAt : null,
            busy,
            endedAtMs: endedAt,
          });
        }
      }
    };

  const target = db as unknown as Record<string, AnyFunction>;
  const query = target.query!;
  const prepare = target.prepare!;
  target.query = (sql: unknown, ...rest: unknown[]) =>
    statement(query.call(db, sql, ...rest), String(sql));
  target.prepare = (sql: unknown, ...rest: unknown[]) =>
    statement(prepare.call(db, sql, ...rest), String(sql));
  const sqlArgument = (args: unknown[]) => (typeof args[0] === "string" ? args[0] : null);
  const classifyArgument = (args: unknown[]) => classifyStatement(sqlArgument(args));
  for (const name of ["run", "exec"] as const) {
    const method = target[name];
    if (typeof method === "function") {
      target[name] = timed(method.bind(db), sqlArgument, classifyArgument);
    }
  }
  const transaction = target.transaction!;
  target.transaction = (fn: unknown) => {
    const marks = { bodyStartedAt: Number.NaN, bodyEndedAt: Number.NaN };
    const body = function (this: unknown, ...args: unknown[]) {
      marks.bodyStartedAt = now();
      try {
        return (fn as AnyFunction).apply(this, args);
      } finally {
        marks.bodyEndedAt = now();
      }
    };
    const variants = transaction.call(db, body) as AnyFunction & Record<string, AnyFunction>;
    const wrapped = timedTransaction(variants, "deferred", marks) as AnyFunction &
      Record<string, unknown>;
    wrapped.deferred = timedTransaction(variants.deferred!, "deferred", marks);
    wrapped.immediate = timedTransaction(variants.immediate!, "immediate", marks);
    wrapped.exclusive = timedTransaction(variants.exclusive!, "exclusive", marks);
    wrapped.default = wrapped;
    wrapped.database = db;
    return wrapped;
  };
  return state;
}
