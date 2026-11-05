import { AGENT_PLATFORMS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  USAGE_HISTORY_RETENTION_DAYS,
  addUsageTotals,
  emptyUsageTotals,
  normalizeUsageRangeDays,
  shiftUsageDay,
  usageDayKey,
  usageDayRange,
  type UsageDayPoint,
  type UsageEnvironmentSummary,
  type UsageHistoryQuery,
  type UsageHistoryReport,
  type UsageModelSummary,
  type UsagePlatformSummary,
  type UsageTotals,
} from "@orkestrator/protocol/usage-history";
import type { NativeAgentTurnUsage } from "@orkestrator/protocol/native-agent";
import { StoreCorruptError, type StorageDatabase } from "./storage-database.js";
import { USAGE_HISTORY_STORE } from "./usage-history-layout.js";
import {
  applyLabelToRecord,
  applyTurnToRecord,
  emptyUsageSessionRecord,
  parseUsageSessionRecord,
  pruneRecordDays,
  type UsageEnvironmentLabel,
  type UsageSessionRecord,
} from "./usage-history-record.js";
import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("usage-history");

/**
 * Recorded agent usage as rows of the backend database (`usage-history`), one
 * row per agent session, the row owner being the session's environment.
 *
 * Writes go through {@link StorageDatabase.updateStoreRow}: one row, one
 * transaction, so two sessions recording turns at the same moment never
 * overwrite each other and a write costs O(row). Reads use the uncached row
 * access, because a report walks every row once and caching the whole store
 * would retain months of history in memory for a pane nobody has open.
 *
 * A report reads every row rather than the owner index even when it filters by
 * environment: `recordingSince` and `recordedPlatforms` describe the whole
 * recording whatever the filters, so one unfiltered pass answers both those
 * and the filtered aggregation. The owner index is what
 * {@link UsageHistoryStore.deleteByEnvironment} deletes by.
 *
 * What is kept instead is the small finished report per query, never the
 * parsed rows: a repeat query (the pane re-opening, a poll, switching back to
 * a range) answers from it without reading a row. Entries are valid for one
 * store state: the database identity, the store's committed revision (which
 * every row write bumps, whichever process made it) and today's date, so a
 * new turn, a label, a deletion, a prune or a day rollover all invalidate
 * them. The cache is bounded by entry count and bytes.
 *
 * Retention is swept from the write path only. A read never triggers it: the
 * usage pane would otherwise pay a second full scan plus a write transaction
 * per expired row before it could answer.
 *
 * Usage rows outlive the session, the environment and the project they came
 * from: a report of the last ninety days must not change because an
 * environment was deleted yesterday. They hold no conversation content, so
 * there is nothing in them to scrub. So that a deleted environment's usage
 * still says where it came from, deletion stamps the environment and project
 * names onto its rows ({@link UsageHistoryStore.labelEnvironment}) and the
 * report carries the newest stamp.
 */

/** Rows retained before the least recently used are dropped. */
export const MAX_USAGE_HISTORY_ROWS = 20_000;
/** How often a read or write may trigger the retention sweep. */
export const USAGE_HISTORY_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
/** Rows per prune transaction, so a large first prune cannot hold the write lock. */
export const USAGE_HISTORY_PRUNE_BATCH_ROWS = 250;
/** Finished reports kept for the current store state, one per query. */
export const USAGE_REPORT_CACHE_MAX_ENTRIES = 16;
/** Serialized bytes the kept reports may hold together. */
export const USAGE_REPORT_CACHE_MAX_BYTES = 2 * 1024 * 1024;

export interface UsageHistoryStoreOptions {
  /** The backend database; called per operation so a reopened connection is used. */
  database: () => StorageDatabase;
  now?: () => Date;
  limits?: { maxRows?: number; retentionDays?: number };
}

export interface RecordUsageTurnsInput {
  /** The native-agent session storage key; unique per environment, agent and tab. */
  sessionKey: string;
  environmentId: string;
  platform: AgentPlatform;
  /**
   * The conversation the turns belong to, which scopes their ids. A tab
   * outlives the conversation in it, and two bridges number turns per session.
   */
  providerSessionId?: string;
  turns: readonly NativeAgentTurnUsage[];
}

export class UsageHistoryStore {
  private readonly now: () => Date;
  private readonly maxRows: number;
  private readonly retentionDays: number;
  private lastPruneAt = 0;
  /** Finished reports by query, valid while the store is in `reportCacheState`. */
  private readonly reportCache = new Map<string, { report: UsageHistoryReport; bytes: number }>();
  private reportCacheBytes = 0;
  private reportCacheState: string | null = null;
  private reportCacheDatabase: StorageDatabase | null = null;

  constructor(private readonly options: UsageHistoryStoreOptions) {
    this.now = options.now ?? (() => new Date());
    this.maxRows = Math.max(1, options.limits?.maxRows ?? MAX_USAGE_HISTORY_ROWS);
    this.retentionDays = Math.max(1, options.limits?.retentionDays ?? USAGE_HISTORY_RETENTION_DAYS);
  }

  /**
   * Records every turn not already in the row. Returns how many were applied,
   * so a caller can tell a repeated read from new usage.
   */
  recordTurns(input: RecordUsageTurnsInput): number {
    if (!input.sessionKey || !input.environmentId || input.turns.length === 0) return 0;
    const at = this.now();
    const day = usageDayKey(at);
    const timestamp = at.toISOString();
    const applied = this.options
      .database()
      .updateStoreRow<number>(USAGE_HISTORY_STORE, input.sessionKey, (current) => {
        const record =
          parseUsageSessionRecord(current) ??
          emptyUsageSessionRecord(input.environmentId, input.platform, timestamp);
        let count = 0;
        for (const turn of input.turns) {
          if (applyTurnToRecord(record, turn, day, timestamp, input.providerSessionId)) count += 1;
        }
        if (count === 0) return { result: 0 };
        return { result: count, value: record };
      });
    if (applied > 0) this.pruneIfDue();
    return applied;
  }

  /** The range report the usage panes render. */
  report(query: UsageHistoryQuery = {}): UsageHistoryReport {
    const now = this.now();
    const toDay = usageDayKey(now);
    const days = normalizeUsageRangeDays(query.days);
    const database = this.options.database();
    const state = `${database.instanceId}\u0000${database.storeRevision(USAGE_HISTORY_STORE) ?? "none"}\u0000${toDay}`;
    if (state !== this.reportCacheState || database !== this.reportCacheDatabase) {
      this.clearReportCache();
      this.reportCacheState = state;
      this.reportCacheDatabase = database;
    }
    const cacheKey = JSON.stringify([days, query.platform ?? null, query.environmentId ?? null]);
    const cached = this.reportCache.get(cacheKey);
    if (cached) {
      // Most recently used last, so eviction drops the oldest query.
      this.reportCache.delete(cacheKey);
      this.reportCache.set(cacheKey, cached);
      return { ...structuredClone(cached.report), generatedAt: now.toISOString() };
    }
    const report = this.buildReport(query, now, toDay, days);
    this.rememberReport(cacheKey, report);
    return report;
  }

  /** Drops every kept report (also how tests and a reopened database start clean). */
  clearReportCache(): void {
    this.reportCache.clear();
    this.reportCacheBytes = 0;
  }

  private rememberReport(cacheKey: string, report: UsageHistoryReport): void {
    const bytes = Buffer.byteLength(JSON.stringify(report));
    // One report may use at most a quarter of the budget, so a few large
    // environment lists cannot crowd out every other query.
    if (bytes > USAGE_REPORT_CACHE_MAX_BYTES / 4) return;
    this.reportCache.set(cacheKey, { report: structuredClone(report), bytes });
    this.reportCacheBytes += bytes;
    while (
      this.reportCache.size > USAGE_REPORT_CACHE_MAX_ENTRIES ||
      this.reportCacheBytes > USAGE_REPORT_CACHE_MAX_BYTES
    ) {
      const oldest = this.reportCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.reportCacheBytes -= this.reportCache.get(oldest)?.bytes ?? 0;
      this.reportCache.delete(oldest);
    }
  }

  private buildReport(
    query: UsageHistoryQuery,
    now: Date,
    toDay: string,
    days: number,
  ): UsageHistoryReport {
    const fromDay = shiftUsageDay(toDay, days - 1);
    const dayTotals = new Map<string, UsageTotals>();
    const dayPlatformTotals = new Map<string, Map<AgentPlatform, UsageTotals>>();
    const platformTotals = new Map<AgentPlatform, UsageTotals>();
    const platformSessions = new Map<AgentPlatform, number>();
    const modelTotals = new Map<string, UsageModelSummary>();
    const modelSessions = new Map<string, Set<string>>();
    const environmentTotals = new Map<string, UsageTotals>();
    const environmentSessions = new Map<string, number>();
    const environmentLabels = new Map<string, { label: UsageEnvironmentLabel; at: string }>();
    const totals = emptyUsageTotals();
    const recordedPlatforms = new Set<AgentPlatform>();
    let sessions = 0;
    let recordingSince: string | undefined;

    for (const { key, record } of this.readRecords()) {
      // Both of these describe the whole recording, so they are collected
      // before either filter: a pane has to be able to say that history starts
      // later than the range it shows, and to offer a platform whose usage is
      // outside the environment currently selected.
      for (const day of Object.keys(record.days)) {
        if (!recordingSince || day < recordingSince) recordingSince = day;
      }
      recordedPlatforms.add(record.platform);
      // An environment is named by its newest stamped row, whichever platform
      // or range that row falls in: the name belongs to the environment.
      if (record.environmentName || record.projectName) {
        const previous = environmentLabels.get(record.environmentId);
        if (!previous || record.lastSeenAt > previous.at) {
          environmentLabels.set(record.environmentId, {
            label: {
              ...(record.environmentName ? { environmentName: record.environmentName } : {}),
              ...(record.projectName ? { projectName: record.projectName } : {}),
            },
            at: record.lastSeenAt,
          });
        }
      }
      if (query.platform && record.platform !== query.platform) continue;
      if (query.environmentId && record.environmentId !== query.environmentId) continue;
      let sessionCounted = false;
      for (const [day, bucket] of Object.entries(record.days)) {
        if (day < fromDay || day > toDay) continue;
        for (const [modelId, modelUsage] of Object.entries(bucket.models)) {
          if (!sessionCounted) {
            sessionCounted = true;
            sessions += 1;
            platformSessions.set(record.platform, (platformSessions.get(record.platform) ?? 0) + 1);
            environmentSessions.set(
              record.environmentId,
              (environmentSessions.get(record.environmentId) ?? 0) + 1,
            );
          }
          addUsageTotals(totals, modelUsage);
          addUsageTotals(mapTotals(dayTotals, day), modelUsage);
          addUsageTotals(
            mapTotals(mapPlatforms(dayPlatformTotals, day), record.platform),
            modelUsage,
          );
          addUsageTotals(mapTotals(platformTotals, record.platform), modelUsage);
          addUsageTotals(mapTotals(environmentTotals, record.environmentId), modelUsage);
          const modelKey = `${record.platform}\u0000${modelId}`;
          const model = modelTotals.get(modelKey) ?? {
            modelId,
            platform: record.platform,
            totals: emptyUsageTotals(),
            sessions: 0,
          };
          addUsageTotals(model.totals, modelUsage);
          modelTotals.set(modelKey, model);
          const seen = modelSessions.get(modelKey) ?? new Set<string>();
          seen.add(key);
          modelSessions.set(modelKey, seen);
        }
      }
    }

    const series: UsageDayPoint[] = usageDayRange(fromDay, toDay).map((day) => ({
      day,
      totals: dayTotals.get(day) ?? emptyUsageTotals(),
      platforms: AGENT_PLATFORMS.flatMap((platform) => {
        const value = dayPlatformTotals.get(day)?.get(platform);
        return value ? [{ platform, totals: value }] : [];
      }),
    }));

    const platforms: UsagePlatformSummary[] = AGENT_PLATFORMS.flatMap((platform) => {
      const value = platformTotals.get(platform);
      return value
        ? [{ platform, totals: value, sessions: platformSessions.get(platform) ?? 0 }]
        : [];
    });

    const models = [...modelTotals.entries()]
      .map(([modelKey, summary]) => ({
        ...summary,
        sessions: modelSessions.get(modelKey)?.size ?? 0,
      }))
      .sort((left, right) => right.totals.totalTokens - left.totals.totalTokens);

    const environments: UsageEnvironmentSummary[] = [...environmentTotals.entries()]
      .map(([environmentId, value]) => {
        const label = environmentLabels.get(environmentId)?.label;
        return {
          environmentId,
          ...(label?.environmentName ? { name: label.environmentName } : {}),
          ...(label?.projectName ? { projectName: label.projectName } : {}),
          totals: value,
          sessions: environmentSessions.get(environmentId) ?? 0,
        };
      })
      .sort((left, right) => right.totals.totalTokens - left.totals.totalTokens);

    return {
      generatedAt: now.toISOString(),
      fromDay,
      toDay,
      days: series,
      totals,
      sessions,
      platforms,
      models,
      environments,
      ...(recordingSince ? { recordingSince } : {}),
      recordedPlatforms: AGENT_PLATFORMS.filter((platform) => recordedPlatforms.has(platform)),
    };
  }

  /**
   * Stamps the environment's names onto every row it owns, so its usage keeps
   * them after the environment is deleted. Returns how many rows changed.
   * Rows only: an environment that never recorded usage leaves nothing behind.
   */
  labelEnvironment(environmentId: string, label: UsageEnvironmentLabel): number {
    if (!environmentId) return 0;
    const database = this.options.database();
    if (!database.hasStore(USAGE_HISTORY_STORE)) return 0;
    const keys = database
      .rows(USAGE_HISTORY_STORE)
      .list({ owner: environmentId, values: false })
      .map((entry) => entry.key);
    let changed = 0;
    for (const key of keys) {
      const updated = database.updateStoreRow<boolean>(USAGE_HISTORY_STORE, key, (current) => {
        const record = parseUsageSessionRecord(current);
        if (!record || !applyLabelToRecord(record, label)) return { result: false };
        return { result: true, value: record };
      });
      if (updated) changed += 1;
    }
    return changed;
  }

  /** Removes every row of one environment. Only an explicit purge calls this. */
  deleteByEnvironment(environmentId: string): number {
    if (!environmentId) return 0;
    const database = this.options.database();
    return database.transaction(() =>
      database.rows(USAGE_HISTORY_STORE).deleteWhere({
        owner: environmentId,
      }),
    );
  }

  /**
   * Day buckets past retention, then the least recently used rows, a batch of
   * rows per transaction with the event loop free between batches. A row is
   * read and decided inside its transaction, so a turn recorded during the sweep
   * is never overwritten, and a row it just refreshed is not dropped as least
   * recently used. A connection closed between batches ends the sweep; the next
   * one finishes it.
   */
  async prune(): Promise<{ prunedRows: number; prunedDays: number }> {
    this.lastPruneAt = Date.now();
    const oldestDay = shiftUsageDay(usageDayKey(this.now()), this.retentionDays - 1);
    const database = this.options.database();
    if (!database.hasStore(USAGE_HISTORY_STORE)) return { prunedRows: 0, prunedDays: 0 };
    const keys = database
      .rows(USAGE_HISTORY_STORE)
      .list({ values: false })
      .map((entry) => entry.key);
    let prunedRows = 0;
    let prunedDays = 0;
    const survivors: Array<{ key: string; lastSeenAt: string; snapshot: string }> = [];
    const sweep = await this.inBatches(database, keys, (key) => {
      const outcome = pruneExpiredDays(database, key, oldestDay);
      if (outcome.kind === "removed") prunedRows += 1;
      if (outcome.kind === "survivor") {
        if (outcome.changed) prunedDays += 1;
        survivors.push({ key, lastSeenAt: outcome.lastSeenAt, snapshot: outcome.snapshot });
      }
    });
    if (sweep && survivors.length > this.maxRows) {
      survivors.sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt));
      const oldest = survivors.slice(0, survivors.length - this.maxRows);
      await this.inBatches(database, oldest, ({ key, snapshot }) => {
        if (dropUnlessRefreshed(database, key, snapshot)) prunedRows += 1;
      });
    }
    return { prunedRows, prunedDays };
  }

  /** `false` when the connection closed before every item was visited. */
  private async inBatches<T>(
    database: StorageDatabase,
    items: readonly T[],
    visit: (item: T) => void,
  ): Promise<boolean> {
    for (let start = 0; start < items.length; start += USAGE_HISTORY_PRUNE_BATCH_ROWS) {
      if (start > 0) await new Promise((resolve) => setImmediate(resolve));
      if (database.isClosed()) return false;
      database.transaction(() => {
        for (const item of items.slice(start, start + USAGE_HISTORY_PRUNE_BATCH_ROWS)) visit(item);
      });
    }
    return true;
  }

  private pruneIfDue(): void {
    const elapsed = Date.now() - this.lastPruneAt;
    if (this.lastPruneAt !== 0 && elapsed < USAGE_HISTORY_PRUNE_INTERVAL_MS) return;
    void this.prune().catch((error: unknown) => {
      log.warn("prune.failed", { error: formatLogError(error) });
    });
  }

  private readRecords(): Array<{ key: string; record: UsageSessionRecord }> {
    const database = this.options.database();
    if (!database.hasStore(USAGE_HISTORY_STORE)) return [];
    const entries = database.rows(USAGE_HISTORY_STORE).list({ values: true });
    const records: Array<{ key: string; record: UsageSessionRecord }> = [];
    for (const entry of entries) {
      if (!entry.value) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.value) as unknown;
      } catch {
        continue;
      }
      const record = parseUsageSessionRecord(parsed);
      if (record) records.push({ key: entry.key, record });
    }
    return records;
  }
}

type PruneOutcome =
  | { kind: "removed" | "skipped" }
  | { kind: "survivor"; changed: boolean; lastSeenAt: string; snapshot: string };

/**
 * Drops one row's expired days, or the row when none is left. A row that cannot
 * be read is left alone, as a report leaves it out.
 */
function pruneExpiredDays(database: StorageDatabase, key: string, oldestDay: string): PruneOutcome {
  try {
    return database.updateStoreRow<PruneOutcome>(USAGE_HISTORY_STORE, key, (current) => {
      const record = parseUsageSessionRecord(current);
      if (!record) return { result: { kind: "skipped" } };
      const changed = pruneRecordDays(record, oldestDay);
      if (Object.keys(record.days).length === 0) {
        return { result: { kind: "removed" }, delete: true };
      }
      const result: PruneOutcome = {
        kind: "survivor",
        changed,
        lastSeenAt: record.lastSeenAt,
        snapshot: JSON.stringify(record),
      };
      return changed ? { result, value: record } : { result };
    });
  } catch (error) {
    if (error instanceof StoreCorruptError) return { kind: "skipped" };
    throw error;
  }
}

/** Removes a row chosen as least recently used, unless a turn has touched it since. */
function dropUnlessRefreshed(database: StorageDatabase, key: string, snapshot: string): boolean {
  return database.updateStoreRow<boolean>(USAGE_HISTORY_STORE, key, (current) =>
    JSON.stringify(parseUsageSessionRecord(current)) === snapshot
      ? { result: true, delete: true }
      : { result: false },
  );
}

function mapTotals<K>(map: Map<K, UsageTotals>, key: K): UsageTotals {
  const existing = map.get(key);
  if (existing) return existing;
  const created = emptyUsageTotals();
  map.set(key, created);
  return created;
}

function mapPlatforms(
  map: Map<string, Map<AgentPlatform, UsageTotals>>,
  key: string,
): Map<AgentPlatform, UsageTotals> {
  const existing = map.get(key);
  if (existing) return existing;
  const created = new Map<AgentPlatform, UsageTotals>();
  map.set(key, created);
  return created;
}
