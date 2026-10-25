import { AGENT_INTERACTION_HOLD_CEILING_MS } from "@orkestrator/protocol/agent-interactions";
import type { SessionState } from "./acp-context.js";

/**
 * The `session/prompt` timeout as a clock that stops while a user holds a
 * parked request.
 *
 * The timeout terminates the child that would answer a parked request, so it
 * used to end every pause at the turn's 30 minutes. Now holding any request
 * stops the turn's clock with the time it had left, and the last resume (or
 * the held request settling) starts it again from there. A request the user
 * resumes gets a fresh countdown, so the turn is given at least that much to
 * run. While stopped, the request's own timer is a backstop: the turn's
 * timeout moves to what it had left plus the hold ceiling, after the latest
 * moment any held request can expire.
 */
export interface PromptTurnClock {
  /** Time the turn had left when the clock last started. */
  remainingMs: number;
  /** When the clock last started; undefined while it is stopped. */
  runningSince: number | undefined;
  /** Moves the outstanding `session/prompt` timeout to an absolute time. */
  rearm(timeoutAt: number): void;
}

function anyParkedRequestHeld(state: SessionState): boolean {
  for (const entry of state.approvals.values()) {
    if (entry.deadline.heldAt !== undefined) return true;
  }
  for (const entry of state.interactions.values()) {
    if (entry.deadline.heldAt !== undefined) return true;
  }
  return false;
}

function latestParkedDeadline(state: SessionState): number {
  let latest = 0;
  for (const entry of state.approvals.values()) {
    latest = Math.max(latest, entry.deadline.expiresAt);
  }
  for (const entry of state.interactions.values()) {
    latest = Math.max(latest, entry.deadline.expiresAt);
  }
  return latest;
}

/** Start the clock for a `session/prompt` that was just sent with `budgetMs`. */
export function startPromptTurnClock(
  state: SessionState,
  budgetMs: number,
  rearm: (timeoutAt: number) => void,
): PromptTurnClock {
  const clock: PromptTurnClock = { remainingMs: budgetMs, runningSince: Date.now(), rearm };
  state.promptTurnClock = clock;
  state.promptDeadlineAt = clock.runningSince! + budgetMs;
  // A request already held from an earlier attempt keeps the clock stopped.
  syncPromptTurnClock(state);
  return clock;
}

/** The `session/prompt` behind `clock` settled; a newer attempt's clock is left alone. */
export function stopPromptTurnClock(state: SessionState, clock: PromptTurnClock): void {
  if (state.promptTurnClock !== clock) return;
  state.promptTurnClock = undefined;
  state.promptDeadlineAt = undefined;
}

/**
 * Stop or start the turn's clock to match whether any parked request is held.
 * Call after a hold changes and after a parked request is removed.
 */
export function syncPromptTurnClock(state: SessionState): void {
  const clock = state.promptTurnClock;
  if (!clock) return;
  const now = Date.now();
  const held = anyParkedRequestHeld(state);
  if (held && clock.runningSince !== undefined) {
    clock.remainingMs = Math.max(0, clock.remainingMs - (now - clock.runningSince));
    clock.runningSince = undefined;
    state.promptDeadlineAt = undefined;
    clock.rearm(now + clock.remainingMs + AGENT_INTERACTION_HOLD_CEILING_MS);
  } else if (!held && clock.runningSince === undefined) {
    // A resumed request restarts a full countdown; never let the turn end first.
    clock.remainingMs = Math.max(clock.remainingMs, latestParkedDeadline(state) - now);
    clock.runningSince = now;
    state.promptDeadlineAt = now + clock.remainingMs;
    clock.rearm(state.promptDeadlineAt);
  }
}
