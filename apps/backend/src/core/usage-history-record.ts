import { isAgentPlatform, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import {
  UNKNOWN_USAGE_MODEL_ID,
  addUsageTotals,
  emptyUsageTotals,
  isUsageDayKey,
  usageCount,
  type UsageTotals,
} from "@orkestrator/protocol/usage-history";
import type { NativeAgentTurnUsage } from "@orkestrator/protocol/native-agent";

/**
 * The persisted shape of one session's usage, and the turn-to-bucket
 * arithmetic that fills it.
 *
 * A row is content-free: platform, environment, model names and counts. It is
 * bucketed by local calendar day because that is what the panes offer, and by
 * model inside each day so a range query can report per-model totals without
 * keeping a second index.
 *
 * `turnIds` is the durable half of the de-duplication: providers keep
 * re-reporting their last twenty turns on every read, and a backend restart
 * empties the recorder's in-memory set.
 */

export const USAGE_SESSION_RECORD_VERSION = 1;

/** Turn ids retained per row; comfortably past the twenty providers republish. */
export const MAX_RECORDED_TURN_IDS = 64;
/** Day buckets retained per row before the oldest are dropped. */
export const MAX_RECORDED_DAYS = 120;
/** Models retained per day bucket; a session rarely uses more than a handful. */
export const MAX_RECORDED_MODELS_PER_DAY = 24;

export interface UsageDayBucket {
  /** Totals per model id; `unknown` when the provider named no model. */
  models: Record<string, UsageTotals>;
}

export interface UsageSessionRecord {
  version: number;
  environmentId: string;
  platform: AgentPlatform;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Keyed `YYYY-MM-DD`. */
  days: Record<string, UsageDayBucket>;
  /** Oldest first; bounded by {@link MAX_RECORDED_TURN_IDS}. */
  turnIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTotals(value: unknown): UsageTotals | null {
  if (!isRecord(value)) return null;
  const totals = emptyUsageTotals();
  totals.inputTokens = usageCount(value.inputTokens);
  totals.outputTokens = usageCount(value.outputTokens);
  totals.cacheReadTokens = usageCount(value.cacheReadTokens);
  totals.cacheWriteTokens = usageCount(value.cacheWriteTokens);
  totals.reasoningTokens = usageCount(value.reasoningTokens);
  totals.totalTokens = usageCount(value.totalTokens);
  totals.costUsd = usageCount(value.costUsd);
  totals.unpricedTokens = usageCount(value.unpricedTokens);
  totals.turns = usageCount(value.turns);
  return totals;
}

/** Validates a stored row. An unreadable row is a miss, never a throw. */
export function parseUsageSessionRecord(value: unknown): UsageSessionRecord | null {
  if (!isRecord(value)) return null;
  if (!isAgentPlatform(value.platform)) return null;
  if (typeof value.environmentId !== "string" || !value.environmentId) return null;
  if (!isRecord(value.days)) return null;
  const days: Record<string, UsageDayBucket> = {};
  for (const [day, bucket] of Object.entries(value.days)) {
    if (!isUsageDayKey(day) || !isRecord(bucket) || !isRecord(bucket.models)) continue;
    const models: Record<string, UsageTotals> = {};
    for (const [modelId, totals] of Object.entries(bucket.models)) {
      const parsed = readTotals(totals);
      if (parsed) models[modelId] = parsed;
    }
    if (Object.keys(models).length > 0) days[day] = { models };
  }
  const firstSeenAt = typeof value.firstSeenAt === "string" ? value.firstSeenAt : "";
  const lastSeenAt = typeof value.lastSeenAt === "string" ? value.lastSeenAt : firstSeenAt;
  return {
    version: USAGE_SESSION_RECORD_VERSION,
    environmentId: value.environmentId,
    platform: value.platform,
    firstSeenAt,
    lastSeenAt,
    days,
    turnIds: Array.isArray(value.turnIds)
      ? value.turnIds.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [],
  };
}

export function emptyUsageSessionRecord(
  environmentId: string,
  platform: AgentPlatform,
  at: string,
): UsageSessionRecord {
  return {
    version: USAGE_SESSION_RECORD_VERSION,
    environmentId,
    platform,
    firstSeenAt: at,
    lastSeenAt: at,
    days: {},
    turnIds: [],
  };
}

/**
 * A turn's contribution to a bucket.
 *
 * `totalTokens` is what the provider processed, so it is rebuilt from the
 * parts rather than trusted: several providers report it as the context
 * occupancy after the turn, which would count the same cached prefix again on
 * every turn of a conversation.
 */
export function usageTotalsFromTurn(turn: NativeAgentTurnUsage): UsageTotals {
  const totals = emptyUsageTotals();
  totals.inputTokens = usageCount(turn.inputTokens);
  totals.outputTokens = usageCount(turn.outputTokens);
  totals.cacheReadTokens = usageCount(turn.cacheReadTokens);
  totals.cacheWriteTokens = usageCount(turn.cacheWriteTokens);
  totals.reasoningTokens = usageCount(turn.reasoningTokens);
  totals.totalTokens =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  totals.costUsd = usageCount(turn.costUsd);
  totals.unpricedTokens = totals.costUsd > 0 ? 0 : totals.totalTokens;
  totals.turns = 1;
  return totals;
}

/** Whether a turn carries anything worth recording. */
export function usageTurnIsEmpty(totals: UsageTotals): boolean {
  return totals.totalTokens === 0 && totals.costUsd === 0;
}

function trimDays(record: UsageSessionRecord): void {
  const days = Object.keys(record.days).sort();
  for (const day of days.slice(0, Math.max(0, days.length - MAX_RECORDED_DAYS))) {
    delete record.days[day];
  }
}

function trimModels(bucket: UsageDayBucket): void {
  const models = Object.entries(bucket.models);
  if (models.length <= MAX_RECORDED_MODELS_PER_DAY) return;
  // Keep the heaviest models; the rest fold into one bucket so the day's
  // totals stay exact even when its model list is cut.
  models.sort((left, right) => right[1].totalTokens - left[1].totalTokens);
  const overflow = emptyUsageTotals();
  for (const [modelId, totals] of models.slice(MAX_RECORDED_MODELS_PER_DAY - 1)) {
    addUsageTotals(overflow, totals);
    delete bucket.models[modelId];
  }
  const existing = bucket.models[UNKNOWN_USAGE_MODEL_ID];
  bucket.models[UNKNOWN_USAGE_MODEL_ID] = existing ? addUsageTotals(existing, overflow) : overflow;
}

/**
 * Applies one turn to a record. Returns false when the turn was already
 * recorded (its id is in `turnIds`) or carries nothing.
 */
export function applyTurnToRecord(
  record: UsageSessionRecord,
  turn: NativeAgentTurnUsage,
  day: string,
  at: string,
): boolean {
  if (!turn.turnId || record.turnIds.includes(turn.turnId)) return false;
  const totals = usageTotalsFromTurn(turn);
  // The id is retained either way: a turn that reported nothing must not be
  // re-examined on every later read.
  record.turnIds.push(turn.turnId);
  if (record.turnIds.length > MAX_RECORDED_TURN_IDS) {
    record.turnIds.splice(0, record.turnIds.length - MAX_RECORDED_TURN_IDS);
  }
  record.lastSeenAt = at;
  if (!record.firstSeenAt) record.firstSeenAt = at;
  if (usageTurnIsEmpty(totals)) return true;
  const modelId = turn.modelId?.trim() || UNKNOWN_USAGE_MODEL_ID;
  const bucket = (record.days[day] ??= { models: {} });
  const existing = bucket.models[modelId];
  bucket.models[modelId] = existing ? addUsageTotals(existing, totals) : totals;
  trimModels(bucket);
  trimDays(record);
  return true;
}

/** Drops day buckets older than `oldestDay`. Returns true when anything went. */
export function pruneRecordDays(record: UsageSessionRecord, oldestDay: string): boolean {
  let pruned = false;
  for (const day of Object.keys(record.days)) {
    if (day >= oldestDay) continue;
    delete record.days[day];
    pruned = true;
  }
  return pruned;
}
