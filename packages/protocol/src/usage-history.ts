import { AGENT_PLATFORMS, isAgentPlatform, type AgentPlatform } from "./agent-platforms.js";

/**
 * Token and spend history across every agent platform.
 *
 * The backend records one row per agent session, bucketed by local calendar
 * day and model, from the per-turn usage providers already report. Nothing
 * here carries prompts, file contents, paths, titles or session identifiers:
 * a record is counts, a model name and a platform, which is what the usage
 * panes render.
 *
 * Only a turn the provider priced contributes to `costUsd`. Codex and Grok
 * report tokens without a price, so their tokens are also counted in
 * {@link UsageTotals.unpricedTokens} and the panes label them rather than
 * inventing a rate from a price table this app does not keep.
 *
 * A turn is bucketed by the day its bridge finalized it (`NativeAgentTurnUsage.at`),
 * never by the day it was read. Providers republish their recent turns on
 * every usage read and several bridges restore them across a restart, so the
 * two differ by months whenever a conversation with history is observed for
 * the first time. A turn its bridge could not date falls back to the day it
 * was first seen, which is all that is known about it.
 */

/** Counts for one bucket. Every field is a sum; nothing is an average. */
export interface UsageTotals {
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Reasoning tokens, where the provider reports them apart from output. */
  reasoningTokens: number;
  /** Everything the provider processed: input + output + cache read + write. */
  totalTokens: number;
  /** Spend the provider itself priced. */
  costUsd: number;
  /** Processed tokens whose turn carried no price. */
  unpricedTokens: number;
  /** Model responses counted into this bucket. */
  turns: number;
}

/** The model name used when a provider priced a turn without naming a model. */
export const UNKNOWN_USAGE_MODEL_ID = "unknown";

/** Ranges the usage panes offer, in days ending today (today included). */
export const USAGE_HISTORY_RANGE_DAYS: readonly number[] = Object.freeze([1, 7, 30, 90]);

/** Days of history the backend keeps before pruning a bucket. */
export const USAGE_HISTORY_RETENTION_DAYS = 400;

export interface UsageHistoryQuery {
  /** Days ending today, bounded to {@link USAGE_HISTORY_RETENTION_DAYS}. */
  days?: number;
  platform?: AgentPlatform;
  environmentId?: string;
}

export interface UsagePlatformSummary {
  platform: AgentPlatform;
  totals: UsageTotals;
  sessions: number;
}

export interface UsageModelSummary {
  modelId: string;
  /** The platform that ran the model; one row per (platform, model). */
  platform: AgentPlatform;
  totals: UsageTotals;
  sessions: number;
}

export interface UsageEnvironmentSummary {
  environmentId: string;
  /** Absent once the environment has been deleted; its usage is still counted. */
  name?: string;
  projectName?: string;
  totals: UsageTotals;
  sessions: number;
}

/** One calendar day of the range. Every day in range is present, zeros included. */
export interface UsageDayPoint {
  /** `YYYY-MM-DD` in the backend host's local time. */
  day: string;
  totals: UsageTotals;
  /** Only platforms with usage that day, in {@link AGENT_PLATFORMS} order. */
  platforms: Array<{ platform: AgentPlatform; totals: UsageTotals }>;
}

export interface UsageHistoryReport {
  generatedAt: string;
  /** Inclusive day bounds of the range the rest of the report covers. */
  fromDay: string;
  toDay: string;
  days: UsageDayPoint[];
  totals: UsageTotals;
  /** Sessions with at least one turn inside the range. */
  sessions: number;
  platforms: UsagePlatformSummary[];
  models: UsageModelSummary[];
  environments: UsageEnvironmentSummary[];
  /**
   * Earliest day with any recorded usage, whatever the range or filters, so a
   * pane can say that history starts later than the range it is showing.
   */
  recordingSince?: string;
  /** Platforms that have ever recorded usage; the filter is built from this. */
  recordedPlatforms: AgentPlatform[];
}

export function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    unpricedTokens: 0,
    turns: 0,
  };
}

/** Adds `addition` into `target` in place and returns it. */
export function addUsageTotals(target: UsageTotals, addition: UsageTotals): UsageTotals {
  target.inputTokens += addition.inputTokens;
  target.outputTokens += addition.outputTokens;
  target.cacheReadTokens += addition.cacheReadTokens;
  target.cacheWriteTokens += addition.cacheWriteTokens;
  target.reasoningTokens += addition.reasoningTokens;
  target.totalTokens += addition.totalTokens;
  target.costUsd += addition.costUsd;
  target.unpricedTokens += addition.unpricedTokens;
  target.turns += addition.turns;
  return target;
}

export function isUsageTotalsEmpty(totals: UsageTotals): boolean {
  return totals.totalTokens === 0 && totals.costUsd === 0 && totals.turns === 0;
}

/** A finite, non-negative count; anything else counts as zero. */
export function usageCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** `YYYY-MM-DD` of a date in the local time zone (never UTC: ranges are days a user recognizes). */
export function usageDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isUsageDayKey(value: unknown): value is string {
  return typeof value === "string" && DAY_PATTERN.test(value);
}

/** The day `offset` days before `day`, as a key. Negative offsets move forward. */
export function shiftUsageDay(day: string, offset: number): string {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  const shifted = new Date(year ?? 1970, (month ?? 1) - 1, (date ?? 1) - offset);
  return usageDayKey(shifted);
}

/** Every day from `fromDay` to `toDay` inclusive, oldest first. */
export function usageDayRange(fromDay: string, toDay: string): string[] {
  const days: string[] = [];
  let cursor = fromDay;
  // Bounded by the retention window so a corrupt pair cannot spin.
  for (let index = 0; index <= USAGE_HISTORY_RETENTION_DAYS && cursor <= toDay; index += 1) {
    days.push(cursor);
    cursor = shiftUsageDay(cursor, -1);
  }
  return days;
}

/** Clamps a requested range onto the retention window. */
export function normalizeUsageRangeDays(days: unknown): number {
  const requested = typeof days === "number" && Number.isFinite(days) ? Math.trunc(days) : 30;
  return Math.min(Math.max(requested, 1), USAGE_HISTORY_RETENTION_DAYS);
}

export function normalizeUsageHistoryQuery(value: unknown): UsageHistoryQuery {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const platform = isAgentPlatform(record.platform) ? record.platform : undefined;
  const environmentId =
    typeof record.environmentId === "string" && record.environmentId.trim().length > 0
      ? record.environmentId
      : undefined;
  return {
    days: normalizeUsageRangeDays(record.days),
    ...(platform ? { platform } : {}),
    ...(environmentId ? { environmentId } : {}),
  };
}

/** Orders platform summaries the way the rest of the app lists platforms. */
export function sortUsagePlatformSummaries(
  summaries: readonly UsagePlatformSummary[],
): UsagePlatformSummary[] {
  return [...summaries].sort(
    (left, right) =>
      AGENT_PLATFORMS.indexOf(left.platform) - AGENT_PLATFORMS.indexOf(right.platform),
  );
}
