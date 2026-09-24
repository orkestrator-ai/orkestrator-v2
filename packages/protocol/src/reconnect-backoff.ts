/**
 * Capped exponential backoff with jitter for read/stream reconnects.
 *
 * When a backend, a bridge or an OpenCode server restarts, every client and
 * provider watching it loses its stream at the same instant. A constant retry
 * delay keeps them in lock-step for the whole outage, and an outage that lasts
 * minutes turns into a steady synchronized request storm. Growing the delay on
 * *consecutive* failures and spreading it with jitter breaks that up, while
 * the first retry stays as fast as it was.
 *
 * Scope, deliberately narrow:
 *
 * - Policy only. No timers, no transport state, no I/O; randomness and time
 *   are injected so owners and tests stay deterministic. Each owner keeps its
 *   own single reconnect timer and decides when a connection counts as healthy.
 * - For read/stream recovery only. It must never drive a retry that could
 *   resubmit a prompt, approve an interaction or otherwise repeat a write whose
 *   outcome is ambiguous: those have their own journals and reconciliation.
 */

export interface ReconnectBackoffPolicy {
  /**
   * The delay before the first retry after a healthy connection. Jitter only
   * ever shortens it, so adopting the policy never slows the first reconnect.
   */
  initialDelayMs: number;
  /** No delay exceeds this, however many consecutive failures. */
  maxDelayMs: number;
  /** Growth per consecutive failure. Defaults to 2. */
  multiplier?: number;
  /**
   * Fraction of each delay that is randomized, in [0, 1]. The delay is drawn
   * from `[base × (1 − ratio), base]`. Defaults to 0.5 ("equal jitter"): half
   * the spread of full jitter, but never an immediate hammering retry.
   */
  jitterRatio?: number;
  /**
   * How long a connection must stay up to count as healthy. A connection that
   * closes sooner is treated as another consecutive failure, so a server that
   * accepts and immediately drops connections still backs off.
   */
  healthyAfterMs: number;
}

export interface ReconnectBackoffDependencies {
  /** Monotonic-enough clock for measuring connection health. */
  now?: () => number;
  /** Uniform in [0, 1). */
  random?: () => number;
}

/** Stops the exponent growing without bound; the cap applies long before. */
const MAX_TRACKED_FAILURES = 32;

function finiteAtLeast(value: number | undefined, minimum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

/**
 * The delay before the retry that follows `consecutiveFailures` failures
 * (0 for the first retry). Pure: the same inputs always give the same delay.
 */
export function reconnectDelayMs(
  policy: ReconnectBackoffPolicy,
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  const initial = finiteAtLeast(policy.initialDelayMs, 0, 0);
  const cap = Math.max(initial, finiteAtLeast(policy.maxDelayMs, 0, initial));
  const multiplier = finiteAtLeast(policy.multiplier, 1, 2);
  const ratio = Math.min(1, finiteAtLeast(policy.jitterRatio, 0, 0.5));
  const failures = Number.isNaN(consecutiveFailures)
    ? 0
    : Math.min(MAX_TRACKED_FAILURES, Math.max(0, Math.floor(consecutiveFailures)));
  const base = Math.min(cap, initial * multiplier ** failures);
  // Clamp the injected sample: a faulty source must not produce a negative or
  // over-cap delay.
  const sample = Math.min(1, Math.max(0, finiteAtLeast(random(), 0, 0)));
  return Math.round(base * (1 - ratio) + base * ratio * sample);
}

/**
 * The consecutive-failure count for one reconnect owner.
 *
 * Call `connected()` when the transport is actually delivering (an open
 * socket, a first frame), and `nextDelayMs()` each time it ends or fails to
 * connect. The count resets only when the connection that just ended had been
 * up for at least `healthyAfterMs`.
 */
export class ReconnectBackoff {
  #failures = 0;
  #connectedAt: number | undefined;
  readonly #policy: ReconnectBackoffPolicy;
  readonly #now: () => number;
  readonly #random: () => number;

  constructor(policy: ReconnectBackoffPolicy, dependencies: ReconnectBackoffDependencies = {}) {
    this.#policy = policy;
    this.#now = dependencies.now ?? Date.now;
    this.#random = dependencies.random ?? Math.random;
  }

  /** Consecutive failures since the last healthy connection. */
  get failures(): number {
    return this.#failures;
  }

  /** The transport is connected. Repeated calls keep the first timestamp. */
  connected(): void {
    this.#connectedAt ??= this.#now();
  }

  /** The transport ended or failed; returns how long to wait before retrying. */
  nextDelayMs(): number {
    const connectedAt = this.#connectedAt;
    this.#connectedAt = undefined;
    if (connectedAt !== undefined && this.#now() - connectedAt >= this.#policy.healthyAfterMs) {
      this.#failures = 0;
    }
    const delay = reconnectDelayMs(this.#policy, this.#failures, this.#random);
    this.#failures = Math.min(MAX_TRACKED_FAILURES, this.#failures + 1);
    return delay;
  }

  /** Forget all history, e.g. after an explicit user-initiated reconnect. */
  reset(): void {
    this.#failures = 0;
    this.#connectedAt = undefined;
  }
}
