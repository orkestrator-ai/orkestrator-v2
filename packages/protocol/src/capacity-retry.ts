/**
 * The backoff every provider uses to continue a turn a model refused for
 * capacity (todo 1010). Each provider decides for itself which refusals count;
 * how long to wait, and what must never count, is shared.
 *
 * Pure: no timers, no I/O.
 */

export interface CapacityRetryPolicy {
  /** Attempts in total, the original one included. 1 turns retrying off. */
  maxAttempts: number;
  /** Nominal wait before the first retry. */
  baseDelayMs: number;
  /** Growth of the nominal wait per retry. */
  multiplier: number;
  /** Ceiling on any one wait, applied before jitter. */
  maxDelayMs: number;
}

/**
 * Five attempts, waits of about 2, 6, 18 and 54 s: about 80 s in all, never
 * more than 60 s at once. A capacity incident usually needs longer than a
 * doubling series from 2 s gives it (about 30 s for four retries), and a
 * workflow abandons a step only after 45 minutes without activity, so the
 * longer window costs nothing a user waits on in practice.
 */
export const DEFAULT_CAPACITY_RETRY_POLICY: CapacityRetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 2_000,
  multiplier: 3,
  maxDelayMs: 60_000,
};

/**
 * The wait before attempt `nextAttempt` (2 for the first retry).
 *
 * "Equal jitter": half the nominal wait is fixed, the other half random, so
 * retries from many sessions refused at the same moment spread out, and none
 * retries sooner than half its nominal wait.
 */
export function capacityRetryDelayMs(
  policy: CapacityRetryPolicy,
  nextAttempt: number,
  random: () => number = Math.random,
): number {
  const retryIndex = Math.max(0, nextAttempt - 2);
  const nominal = Math.min(policy.maxDelayMs, policy.baseDelayMs * policy.multiplier ** retryIndex);
  const unit = Math.min(1, Math.max(0, random()));
  return Math.round(nominal / 2 + (nominal / 2) * unit);
}

/** Whole seconds for the transcript; a sub-second wait still reads "1 s". */
export function formatRetryDelay(delayMs: number): string {
  return `${Math.max(1, Math.round(delayMs / 1_000))} s`;
}

/**
 * Wording that rules out a retry whatever status or code came with it, for a
 * provider whose refusals are only classified by text: a usage limit, a rate
 * limit, quota or billing, or a login. Waiting a minute cures none of them,
 * and some gateways report them under an overload status.
 */
const NOT_A_CAPACITY_REFUSAL =
  /usage[ _-]?(?:limit|not[ _-]?included)|rate[ _-]?limit|too[ _-]?many[ _-]?requests|quota|billing|credits?\b|spend(?:ing)?[ _-]?(?:cap|limit)|subscription|insufficient|unauthori[sz]ed|unauthenticated|forbidden|authenticat|log[ -]?in\b|sign[ -]?in\b|api[ _-]?key/i;

/** See {@link NOT_A_CAPACITY_REFUSAL}. */
export function namesLimitOrLogin(text: string): boolean {
  return NOT_A_CAPACITY_REFUSAL.test(text);
}
