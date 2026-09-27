import { closeSession, markSessionClosed } from "./agent-session.js";
import { persistBarrier } from "./persistence.js";
import { requestTurnCancellation } from "./prompt.js";
import {
  clientSessionKeys,
  promptClaimReleased,
  sessions,
  setPendingRemoval,
  type SessionState,
} from "./state.js";
import { withTimeout } from "./timeout.js";

export type RetainingCloseOutcome = "closed" | "pending";

const closesInFlight = new WeakMap<SessionState, Promise<RetainingCloseOutcome>>();

/**
 * Ordinary tab close for one Pi bridge session (`POST /session/:id/close`).
 *
 * Shares DELETE's release path — deny parked approvals, cancel the turn,
 * permanently close the SDK session, drop the registry entry — and, like it,
 * never removes Pi's own JSONL session file, which is where the conversation
 * lives. What close adds is an honest answer:
 *
 * - The session is marked closed before the first await, so no prompt is
 *   admitted from then on (409) and one still preparing settles as cancelled.
 * - A cancel that fails, a prompt claim that is not released (a cold attach or
 *   Pi's preflight still pending), or a release (attach wait, runtime dispose)
 *   that does not finish within the budget is `pending`, not a success.
 * - The session stays registered — closed, refusing admission — until its
 *   removal is published with `persistBarrier`. A retry during or after a
 *   failed close therefore always reaches it and is never told `missing` for a
 *   close that did not happen; only a published removal unregisters it.
 *
 * Concurrent closes of the same session share one operation. A later retry
 * starts a new one, and every step is idempotent.
 */
export function closeSessionRetaining(
  state: SessionState,
  budgetMs: number,
): Promise<RetainingCloseOutcome> {
  const existing = closesInFlight.get(state);
  if (existing) return existing;
  const operation = runClose(state, budgetMs).finally(() => closesInFlight.delete(state));
  closesInFlight.set(state, operation);
  return operation;
}

async function runClose(state: SessionState, budgetMs: number): Promise<RetainingCloseOutcome> {
  const deadline = Date.now() + budgetMs;
  const remaining = () => Math.max(1, deadline - Date.now());
  markSessionClosed(state);
  const { cancel } = requestTurnCancellation(
    state,
    "The session was closed before this request was answered.",
  );
  try {
    if (cancel) {
      await withTimeout(cancel, remaining(), "Pi cancellation timed out while closing the session");
    }
    // A prompt still preparing settles at its next boundary; one in Pi's
    // preflight settles when Pi accepts (and is aborted) or refuses. Until
    // then something can still reach Pi, so the close is not proven.
    await withTimeout(
      promptClaimReleased(state),
      remaining(),
      "A Pi prompt was still starting while closing the session",
    );
    await withTimeout(closeSession(state), remaining(), "Pi session release timed out");
  } catch {
    // Still registered and still closed: the backend's durable intent retries.
    return "pending";
  }
  setPendingRemoval(state, true);
  try {
    await persistBarrier();
  } catch {
    setPendingRemoval(state, false);
    return "pending";
  }
  const clientKey = state.clientSessionKey;
  if (sessions.get(state.id) === state) sessions.delete(state.id);
  if (clientKey !== undefined && clientSessionKeys.get(clientKey) === state.id) {
    clientSessionKeys.delete(clientKey);
  }
  return "closed";
}
