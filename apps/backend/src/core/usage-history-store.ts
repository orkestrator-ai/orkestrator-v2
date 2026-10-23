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
import type { StorageDatabase } from "./storage-database.js";
import { USAGE_HISTORY_STORE } from "./usage-history-layout.js";
import {
  applyTurnToRecord,
  emptyUsageSessionRecord,
  parseUsageSessionRecord,
  pruneRecordDays,
  type UsageSessionRecord,
} from "./usage-history-record.js";

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
 * Retention is swept from the write path only. A read never triggers it: the
 * usage pane would otherwise pay a second full scan plus a write transaction
 * per expired row before it could answer.
 *
 * Usage rows outlive the session, the environment and the project they came
 * from: a report of the last ninety days must not change because an
 * environment was deleted yesterday. They hold no conversation content, so
 * there is nothing in them to scrub.
 */

/** Rows retained before the least recently used are dropped. */
export const MAX_USAGE_HISTORY_ROWS = 20_000;
/** How often a read or write may trigger the retention sweep. */
export const USAGE_HISTORY_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

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
    const fromDay = shiftUsageDay(toDay, days - 1);
    const dayTotals = new Map<string, UsageTotals>();
    const dayPlatformTotals = new Map<string, Map<AgentPlatform, UsageTotals>>();
    const platformTotals = new Map<AgentPlatform, UsageTotals>();
    const platformSessions = new Map<AgentPlatform, number>();
    const modelTotals = new Map<string, UsageModelSummary>();
    const modelSessions = new Map<string, Set<string>>();
    const environmentTotals = new Map<string, UsageTotals>();
    const environmentSessions = new Map<string, number>();
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
      .map(([environmentId, value]) => ({
        environmentId,
        totals: value,
        sessions: environmentSessions.get(environmentId) ?? 0,
      }))
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

  /** Day buckets past retention, then the least recently used rows. */
  prune(): { prunedRows: number; prunedDays: number } {
    this.lastPruneAt = Date.now();
    const oldestDay = shiftUsageDay(usageDayKey(this.now()), this.retentionDays - 1);
    const records = this.readRecords();
    let prunedRows = 0;
    let prunedDays = 0;
    const survivors: Array<{ key: string; lastSeenAt: string }> = [];
    for (const { key, record } of records) {
      const changed = pruneRecordDays(record, oldestDay);
      if (Object.keys(record.days).length === 0) {
        this.deleteRow(key);
        prunedRows += 1;
        continue;
      }
      if (changed) {
        prunedDays += 1;
        this.writeRow(key, record);
      }
      survivors.push({ key, lastSeenAt: record.lastSeenAt });
    }
    if (survivors.length > this.maxRows) {
      survivors.sort((left, right) => left.lastSeenAt.localeCompare(right.lastSeenAt));
      for (const { key } of survivors.slice(0, survivors.length - this.maxRows)) {
        this.deleteRow(key);
        prunedRows += 1;
      }
    }
    return { prunedRows, prunedDays };
  }

  private pruneIfDue(): void {
    const elapsed = Date.now() - this.lastPruneAt;
    if (this.lastPruneAt !== 0 && elapsed < USAGE_HISTORY_PRUNE_INTERVAL_MS) return;
    try {
      this.prune();
    } catch (error) {
      console.warn("[usage-history] Could not prune recorded usage:", error);
    }
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

  private writeRow(key: string, record: UsageSessionRecord): void {
    this.options
      .database()
      .updateStoreRow(USAGE_HISTORY_STORE, key, () => ({ result: true, value: record }));
  }

  private deleteRow(key: string): void {
    this.options
      .database()
      .updateStoreRow(USAGE_HISTORY_STORE, key, () => ({ result: true, delete: true as const }));
  }
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
