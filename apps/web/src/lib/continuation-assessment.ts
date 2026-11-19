import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { NativeAgentTurnUsage } from "@orkestrator/protocol/native-agent";

/**
 * What the next continuation of a conversation is likely to cost, judged only
 * from evidence the provider already reported.
 *
 * The assessment is a pure function of that evidence and the caller's clock.
 * Re-evaluating it never refreshes anything: the cache's reference point is
 * the provider-dated time of the last response, so a panel that re-renders
 * every few seconds cannot keep a cache "warm" by looking at it. Session-wide
 * cache-read totals are history and are deliberately not used as evidence.
 */

export type ContinuationCacheState = "likely-warm" | "likely-expired" | "unknown";

export type ContinuationCacheReason =
  /** The last response's cache use is within the provider's shortest lifetime. */
  | "within-minimum-lifetime"
  /** Past the shortest lifetime but inside the longest one the provider offers. */
  | "past-minimum-lifetime"
  /** Past the longest lifetime the provider offers. */
  | "past-maximum-lifetime"
  /** The platform does not publish a cache lifetime Orkestrator can rely on. */
  | "lifetime-unknown"
  /** No response has been reported yet, or none carried usage. */
  | "no-response"
  /** The last response carried no timestamp. */
  | "undated-response"
  /** The last response's timestamp is unreadable or ahead of this clock. */
  | "clock-mismatch"
  /** The last response did not say whether it used the cache. */
  | "no-cache-report"
  /** The last response reported neither cache reads nor cache writes. */
  | "no-cache-activity"
  /** A response is running now. */
  | "response-running";

export interface CacheLifetime {
  /** Inactivity after which the provider's cache may already have gone. */
  minimumMs: number;
  /** Inactivity after which no cache the provider offers is still held. */
  maximumMs?: number;
}

/**
 * Published prompt-cache lifetimes, measured from the last request that used
 * the cache. Only platforms that talk to one vendor are listed: OpenCode, Pi,
 * Cursor and Grok front model providers whose cache behaviour Orkestrator is
 * not told, so they stay "unknown".
 *
 * - Claude: a cache entry lives five minutes by default and one hour when the
 *   request asked for the longer lifetime. Which one a session used is not
 *   reported, so the band between the two stays unknown.
 * - Codex (OpenAI): cached prefixes generally survive five to ten minutes of
 *   inactivity, and extended retention keeps them for up to a day.
 */
export const PROVIDER_CACHE_LIFETIMES: Readonly<Partial<Record<AgentPlatform, CacheLifetime>>> =
  Object.freeze({
    claude: { minimumMs: 5 * 60_000, maximumMs: 60 * 60_000 },
    codex: { minimumMs: 5 * 60_000, maximumMs: 24 * 60 * 60_000 },
  });

/** At or above this many tokens of context, a cold continuation is expensive. */
export const LARGE_CONTEXT_TOKENS = 100_000;

/** Clock skew tolerated before a response dated "in the future" is distrusted. */
export const CONTINUATION_CLOCK_SKEW_MS = 60_000;

export interface ContinuationEvidence {
  provider: AgentPlatform | undefined;
  /** Provider-reported turns, newest last. */
  turns: readonly NativeAgentTurnUsage[] | undefined;
  /** Tokens currently in context, when the provider measured them. */
  contextTokens: number | undefined;
  /** Whether a response is in progress now. */
  running?: boolean;
  nowMs: number;
}

export interface ContinuationAssessment {
  cache: ContinuationCacheState;
  reason: ContinuationCacheReason;
  /** Time since the provider-dated last response, when it can be trusted. */
  idleMs?: number;
  /** The lifetime the verdict was judged against, when one applies. */
  lifetime?: CacheLifetime;
  contextTokens?: number;
  largeContext: boolean;
}

function lastResponseTime(
  turn: NativeAgentTurnUsage,
  nowMs: number,
): { idleMs: number } | { reason: "undated-response" | "clock-mismatch" } {
  if (turn.at === undefined) return { reason: "undated-response" };
  const at = Date.parse(turn.at);
  if (!Number.isFinite(at) || !Number.isFinite(nowMs) || at > nowMs + CONTINUATION_CLOCK_SKEW_MS) {
    return { reason: "clock-mismatch" };
  }
  return { idleMs: Math.max(0, nowMs - at) };
}

function cacheActivity(turn: NativeAgentTurnUsage): "active" | "none" | "unreported" {
  const read = turn.cacheReadTokens;
  const write = turn.cacheWriteTokens;
  if (read === undefined && write === undefined) return "unreported";
  return (read ?? 0) > 0 || (write ?? 0) > 0 ? "active" : "none";
}

export function assessContinuation(evidence: ContinuationEvidence): ContinuationAssessment {
  const contextTokens =
    evidence.contextTokens !== undefined &&
    Number.isFinite(evidence.contextTokens) &&
    evidence.contextTokens > 0
      ? evidence.contextTokens
      : undefined;
  const base = {
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    largeContext: contextTokens !== undefined && contextTokens >= LARGE_CONTEXT_TOKENS,
  };
  if (evidence.running) {
    return { ...base, cache: "unknown", reason: "response-running" };
  }

  const turn = evidence.turns?.at(-1);
  if (!turn) return { ...base, cache: "unknown", reason: "no-response" };
  const time = lastResponseTime(turn, evidence.nowMs);
  if ("reason" in time) return { ...base, cache: "unknown", reason: time.reason };
  const { idleMs } = time;
  const timed = { ...base, idleMs };

  const lifetime = evidence.provider ? PROVIDER_CACHE_LIFETIMES[evidence.provider] : undefined;
  if (!lifetime) return { ...timed, cache: "unknown", reason: "lifetime-unknown" };
  const judged = { ...timed, lifetime };

  // Past the longest lifetime nothing survives, whatever the last response did.
  if (lifetime.maximumMs !== undefined && idleMs >= lifetime.maximumMs) {
    return { ...judged, cache: "likely-expired", reason: "past-maximum-lifetime" };
  }
  const activity = cacheActivity(turn);
  if (activity === "unreported") return { ...judged, cache: "unknown", reason: "no-cache-report" };
  if (activity === "none") return { ...judged, cache: "unknown", reason: "no-cache-activity" };
  if (idleMs < lifetime.minimumMs) {
    return { ...judged, cache: "likely-warm", reason: "within-minimum-lifetime" };
  }
  return { ...judged, cache: "unknown", reason: "past-minimum-lifetime" };
}

/** "45s", "12m", "3h 5m", "2d 4h": coarse enough to read at a glance. */
export function formatIdleDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** "5 minutes", "1 hour", "24 hours". */
export function formatLifetime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}
