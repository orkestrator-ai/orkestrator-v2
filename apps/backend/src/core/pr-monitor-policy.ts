import {
  PR_MONITOR_INTERVALS_MS,
  getEffectivePrMonitorInterval,
  type PrMonitorMode,
} from "@orkestrator/protocol/pr-monitor";
import type { RecurringPriorityClass } from "@orkestrator/protocol/recurring-work";

/**
 * Lifecycle observation policy for the backend PR monitor.
 *
 * The public {@link PrMonitorMode} is the *user intent* a client asked for
 * (normal, create-pending, merge-pending). How often and how an entry is
 * observed also depends on where its pull request is in its lifecycle, which
 * clients never choose. Keeping the two separate means a merged PR can be
 * observed rarely without inventing a new mode on the wire, and a pending
 * intent always wins over the quiet lifecycle cadence.
 *
 * | Policy               | When                                                        | Next action           | Cadence                        |
 * | -------------------- | ----------------------------------------------------------- | --------------------- | ------------------------------ |
 * | `paused`             | the environment cannot run `gh` (stopped container)         | none                  | none                           |
 * | `merge-pending`      | a client asked for merge confirmation                       | detection             | 1 s                            |
 * | `create-pending`     | a client asked for creation confirmation                    | detection             | 5 s                            |
 * | `provisional`        | one-shot discovery after an agent completion edge           | detection             | immediate, then retired        |
 * | `open`               | an open PR (or one whose persistence is still pending)      | detection             | 20 s                           |
 * | `terminal-repair`    | merged/closed, local obligations not yet confirmed settled  | local repair (no gh)  | 20 s, own backoff              |
 * | `terminal-discovery` | merged/closed and every obligation settled                  | branch discovery      | 5 min (+ bounded jitter)       |
 *
 * Every policy is recomputed from runtime state after each action; nothing
 * here is persisted. An immediate explicit refresh, a new pending intent and an
 * agent-completion edge reset the due time of any policy.
 */
export type PrObservationPolicy =
  | "paused"
  | "merge-pending"
  | "create-pending"
  | "provisional"
  | "open"
  | "terminal-repair"
  | "terminal-discovery";

/** Why a check was requested; decides admission priority and cooldown bypass. */
export type PrMonitorWakeReason =
  /** A client pressed refresh, create or merge: a user is waiting. */
  | "interactive"
  /** An agent turn ended; the agent may have pushed or opened a PR. */
  | "completion";

export interface PrMonitorPolicyConfig {
  /** Branch discovery period for a settled terminal entry. Trial value. */
  terminalDiscoveryIntervalMs: number;
  /** Bounded jitter added to every terminal discovery so periods never re-align. */
  terminalDiscoveryJitterMs: number;
  /** Ordinary entries restored by reconciliation spread over this window. */
  startupJitterMs: number;
  /** Error backoff jitter: a fraction of the backed-off delay, capped. */
  errorJitterRatio: number;
  errorJitterMaxMs: number;
  /** Cooldown after a rate-limit failure when `gh` gives no retry timing. */
  rateLimitCooldownMs: number;
  /** Upper bound applied to any retry timing reported by the boundary. */
  maxRetryAfterMs: number;
  /** Per-entry bound on remembered task-reconciliation progress keys. */
  maxReconciliationKeys: number;
  /** Bound on remembered shared cooldown scopes. */
  maxCooldownScopes: number;
}

export const DEFAULT_PR_MONITOR_POLICY: Readonly<PrMonitorPolicyConfig> = {
  terminalDiscoveryIntervalMs: 5 * 60_000,
  terminalDiscoveryJitterMs: 30_000,
  startupJitterMs: PR_MONITOR_INTERVALS_MS.normal,
  errorJitterRatio: 0.1,
  errorJitterMaxMs: 30_000,
  rateLimitCooldownMs: 2 * 60_000,
  maxRetryAfterMs: 60 * 60_000,
  maxReconciliationKeys: 8,
  maxCooldownScopes: 64,
};

export function resolvePrMonitorPolicy(
  overrides: Partial<PrMonitorPolicyConfig> | undefined,
): PrMonitorPolicyConfig {
  const merged = { ...DEFAULT_PR_MONITOR_POLICY, ...overrides };
  const nonNegative = (value: number, fallback: number) =>
    Number.isFinite(value) && value >= 0 ? value : fallback;
  const positiveInteger = (value: number, fallback: number) =>
    Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  const defaults = DEFAULT_PR_MONITOR_POLICY;
  return {
    terminalDiscoveryIntervalMs: Math.max(
      PR_MONITOR_INTERVALS_MS.normal,
      nonNegative(merged.terminalDiscoveryIntervalMs, defaults.terminalDiscoveryIntervalMs),
    ),
    terminalDiscoveryJitterMs: nonNegative(
      merged.terminalDiscoveryJitterMs,
      defaults.terminalDiscoveryJitterMs,
    ),
    startupJitterMs: nonNegative(merged.startupJitterMs, defaults.startupJitterMs),
    errorJitterRatio: Math.min(1, nonNegative(merged.errorJitterRatio, defaults.errorJitterRatio)),
    errorJitterMaxMs: nonNegative(merged.errorJitterMaxMs, defaults.errorJitterMaxMs),
    rateLimitCooldownMs: nonNegative(merged.rateLimitCooldownMs, defaults.rateLimitCooldownMs),
    maxRetryAfterMs: nonNegative(merged.maxRetryAfterMs, defaults.maxRetryAfterMs),
    maxReconciliationKeys: positiveInteger(
      merged.maxReconciliationKeys,
      defaults.maxReconciliationKeys,
    ),
    maxCooldownScopes: positiveInteger(merged.maxCooldownScopes, defaults.maxCooldownScopes),
  };
}

/** Admission priority for a detection, user intent ahead of quiet discovery. */
export function detectionPriority(
  policy: PrObservationPolicy,
  wake: PrMonitorWakeReason | null,
  persistencePending: boolean,
): Exclude<RecurringPriorityClass, "critical"> {
  if (wake === "interactive" || policy === "merge-pending" || policy === "create-pending") {
    return "interactive";
  }
  // A confirmed observation that storage has not accepted yet is a durable
  // obligation, not discovery.
  if (persistencePending) return "recovery";
  if (wake === "completion" || policy === "provisional") return "progress";
  if (policy === "terminal-discovery" || policy === "terminal-repair") return "maintenance";
  return "discovery";
}

export interface DelayInput {
  policy: PrObservationPolicy;
  mode: PrMonitorMode;
  consecutiveErrors: number;
  repairFailures: number;
  /** First schedule after reconciliation restored or resumed the entry. */
  restored: boolean;
  /** A uniform sample in [0, 1). */
  random: number;
}

/**
 * Background due delay for a policy. Explicit wakes schedule `0` directly and
 * never pass through here, so user feedback never inherits background jitter.
 */
export function backgroundDelay(input: DelayInput, config: PrMonitorPolicyConfig): number {
  const sample = Math.min(Math.max(input.random, 0), 0.999_999);
  switch (input.policy) {
    case "terminal-discovery": {
      const backedOff = getEffectivePrMonitorInterval("normal", input.consecutiveErrors);
      if (input.restored) {
        // A backend restart restores every terminal entry at once. Spread their
        // first discovery over one whole period instead of aligning them all a
        // period later; the per-entry cadence then keeps its own phase.
        return Math.max(
          PR_MONITOR_INTERVALS_MS.normal,
          Math.floor(sample * config.terminalDiscoveryIntervalMs),
        );
      }
      return (
        Math.max(config.terminalDiscoveryIntervalMs, backedOff) +
        Math.floor(sample * config.terminalDiscoveryJitterMs)
      );
    }
    case "terminal-repair": {
      const failures = Math.max(input.consecutiveErrors, input.repairFailures);
      const base = getEffectivePrMonitorInterval("normal", failures);
      return base + errorJitter(base, failures, sample, config) + restoreJitter(input, config);
    }
    default: {
      const mode =
        input.policy === "open" || input.policy === "provisional" ? "normal" : input.mode;
      const base = getEffectivePrMonitorInterval(mode, input.consecutiveErrors);
      return (
        base +
        errorJitter(base, input.consecutiveErrors, sample, config) +
        (mode === "normal" ? restoreJitter(input, config) : 0)
      );
    }
  }
}

function errorJitter(
  base: number,
  failures: number,
  sample: number,
  config: PrMonitorPolicyConfig,
): number {
  if (failures <= 0) return 0;
  return Math.floor(sample * Math.min(base * config.errorJitterRatio, config.errorJitterMaxMs));
}

function restoreJitter(input: DelayInput, config: PrMonitorPolicyConfig): number {
  return input.restored ? Math.floor(input.random * config.startupJitterMs) : 0;
}

export type PrDetectionFailure =
  | { kind: "rate-limited"; retryAfterMs: number | null }
  | { kind: "timeout" }
  | { kind: "failed" };

const RATE_LIMIT_PATTERN =
  /\b(?:api rate limit exceeded|secondary rate limit|rate limit(?:ed)?|abuse detection|http 429|too many requests)\b/i;

/**
 * Classifies a failure at the `gh` boundary without retaining its text.
 *
 * `gh pr view`/`gh pr list` do not surface GitHub's `Retry-After` or
 * `x-ratelimit-reset` headers, so a plain CLI failure has no reliable retry
 * timing and gets the configured cooldown. An error object that does carry a
 * numeric `retryAfterMs` (a structured boundary error) is honoured, bounded.
 */
export function classifyPrDetectionFailure(error: unknown): PrDetectionFailure {
  const record =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  // `CommandFailedError` (shell.ts) carries the child-process outcome.
  if (record.timedOut === true) return { kind: "timeout" };
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const retryAfter =
    typeof record.retryAfterMs === "number" && Number.isFinite(record.retryAfterMs)
      ? Math.max(0, record.retryAfterMs)
      : null;
  if (
    retryAfter !== null ||
    record.category === "rate-limited" ||
    RATE_LIMIT_PATTERN.test(message)
  ) {
    return { kind: "rate-limited", retryAfterMs: retryAfter };
  }
  return { kind: "failed" };
}

/**
 * Rate-limit cooldowns shared only inside a proven compatible host/auth scope.
 *
 * The scope is an opaque string chosen by the composition root. It must name a
 * credential boundary the backend can prove, never a hash of a token: when no
 * such boundary is observable the target has no scope and its cooldown stays
 * per entry. Bounded; expired scopes are pruned on every write.
 */
export class PrCooldownScopes {
  private readonly until = new Map<string, number>();

  constructor(private readonly maxScopes: number) {}

  set(scope: string, untilMs: number, nowMs: number): void {
    for (const [key, value] of Array.from(this.until)) {
      if (value <= nowMs) this.until.delete(key);
    }
    const existing = this.until.get(scope);
    if (existing !== undefined && existing >= untilMs) return;
    this.until.delete(scope);
    if (this.until.size >= this.maxScopes) {
      const oldest = this.until.keys().next().value;
      if (oldest !== undefined) this.until.delete(oldest);
    }
    this.until.set(scope, untilMs);
  }

  /** Remaining cooldown in milliseconds, 0 when the scope may run. */
  remaining(scope: string | null, nowMs: number): number {
    if (!scope) return 0;
    const value = this.until.get(scope);
    if (value === undefined) return 0;
    if (value <= nowMs) {
      this.until.delete(scope);
      return 0;
    }
    return value - nowMs;
  }

  get size(): number {
    return this.until.size;
  }

  clear(): void {
    this.until.clear();
  }
}
