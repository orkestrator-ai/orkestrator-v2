/**
 * Elapsed-time semantics for attempt-counted workflow deadlines.
 *
 * Several workflow deadlines are persisted as poll counts: "five idle polls
 * without a structured result", "twelve final-usage probes". Under a fixed
 * one-second tick a count *is* a duration, but once passes can be woken by
 * events a count stops meaning time: a burst of wakeups would exhaust a
 * five-poll grace in milliseconds, and a slower fallback cadence would stretch
 * it into minutes.
 *
 * The gate keeps both meanings explicit without changing the persisted
 * records (older clients validate their exact shape):
 *
 * - **Attempt limit preserved.** A periodic or explicit pass always counts, so
 *   the fixed-cadence behavior — and every test that drives passes directly —
 *   is unchanged.
 * - **Bursts do not count.** A pass started by a scoped wakeup counts only when
 *   at least `spacingMs` passed since the last counted observation, so a
 *   wakeup storm cannot shorten the grace to a burst of immediate passes.
 * - **Time limit enforced.** {@link ElapsedPollGate.exhausted} also reports
 *   exhaustion once `limit × spacingMs` elapsed since the first counted
 *   observation (with at least two observations), so a slowed cadence cannot
 *   silently stretch the grace far beyond the duration it stood for.
 *
 * State is process-local and bounded. After a restart the first observation
 * starts a new window; the persisted count still carries the attempts.
 */

export type PollTrigger = "periodic" | "wake" | "explicit";

type ScopeState = { firstAt: number; lastCountedAt: number };

export class ElapsedPollGate {
  private readonly scopes = new Map<string, ScopeState>();
  private readonly now: () => number;
  private readonly maxScopes: number;

  constructor(
    private readonly spacingMs: number,
    options: { now?: () => number; maxScopes?: number } = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.maxScopes = Math.max(1, options.maxScopes ?? 1_024);
  }

  /** Whether this observation counts toward the scope's attempt limit. */
  count(scope: string, trigger: PollTrigger): boolean {
    const now = this.now();
    const state = this.scopes.get(scope);
    if (!state) {
      if (this.scopes.size >= this.maxScopes) {
        // Oldest first: Map iteration order is insertion order.
        const oldest = this.scopes.keys().next().value;
        if (oldest !== undefined) this.scopes.delete(oldest);
      }
      this.scopes.set(scope, { firstAt: now, lastCountedAt: now });
      return true;
    }
    if (trigger === "wake" && now - state.lastCountedAt < this.spacingMs) return false;
    state.lastCountedAt = now;
    return true;
  }

  /** Milliseconds since the scope's first counted observation in this process. */
  elapsedMs(scope: string): number {
    const state = this.scopes.get(scope);
    return state ? Math.max(0, this.now() - state.firstAt) : 0;
  }

  /** The attempt limit is reached, or the duration it stands for has elapsed. */
  exhausted(scope: string, count: number, limit: number): boolean {
    if (count >= limit) return true;
    return count >= 2 && this.elapsedMs(scope) >= limit * this.spacingMs;
  }

  clear(scope: string): void {
    this.scopes.delete(scope);
  }

  /** Drops every scope with the given prefix (a settled workflow). */
  clearPrefix(prefix: string): void {
    for (const scope of Array.from(this.scopes.keys())) {
      if (scope.startsWith(prefix)) this.scopes.delete(scope);
    }
  }

  get size(): number {
    return this.scopes.size;
  }
}
