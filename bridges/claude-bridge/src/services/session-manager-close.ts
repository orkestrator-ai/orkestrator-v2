// Non-destructive ownership close for one bridge session.
//
// A closed tab releases what this bridge holds for it and nothing more. The
// Claude rollout (`{sdkSessionId}.jsonl`) and the bridge-owned preferences file
// (durable dispatch journal, steer journal and client-key alias) are both kept,
// so the conversation stays listed by `GET /session/list` and a deliberate
// resume reaches it again. Permanent deletion is `deleteSessionDurably`, which
// only an explicit DELETE may invoke.

import type { ClaudeQueryControl, SessionState } from "../types/index.js";
import {
  claimedPromptDispatches,
  sessionOperationError,
  sessions,
} from "./session-manager-core.js";
import {
  cleanupPendingInteractions,
  forgetPromptDispatchesForSession,
  waitForPendingPromptDispatchClaim,
} from "./session-manager-lifecycle.js";
import { takeQueryControls } from "./session-manager-background-tasks.js";

export type RetainingCloseOutcome = "closed" | "missing";

/**
 * How long one close attempt may spend proving that the session's work has
 * stopped. Kept well inside the backend's 30 s bridge request timeout so the
 * caller gets an in-band 503 rather than a transport timeout it cannot read.
 */
export const CLOSE_CONFIRMATION_BUDGET_MS = 10_000;

/** Stop could not be proven; the session stays registered for a retry. */
export class SessionCloseNotConfirmedError extends Error {
  override readonly name = "SessionCloseNotConfirmedError";
}

const closesInFlight = new Map<string, Promise<RetainingCloseOutcome>>();

/**
 * Sessions whose `deleting` claim belongs to a close that could not confirm
 * stop, with the query controls whose `close()` failed or did not settle. Such
 * a session stays fenced (no prompt, dispatch claim or deletion is admitted)
 * but a later close may take the claim over and try again.
 */
const stalledCloses = new WeakMap<SessionState, Set<ClaudeQueryControl>>();

export type RetainingCloseOptions = {
  /** Overrides {@link CLOSE_CONFIRMATION_BUDGET_MS}; tests use a short one. */
  budgetMs?: number;
};

/**
 * Stop this session's owned work and retire it from the live registry while
 * retaining its conversation history.
 *
 * - An id with no live registry entry answers `missing`. It is deliberately not
 *   materialized from disk first: a rollout that is not in memory has no query,
 *   no parked interaction and no dispatch claim, so there is nothing to close,
 *   and adopting it only to drop it again would cost a history read.
 * - The claim is taken before the first await, exactly as permanent deletion
 *   does, so a prompt cannot slip in on the next microtask.
 * - Concurrent closes share one operation. A permanent deletion already in
 *   progress is a conflict the caller retries; its outcome is not ours to
 *   report.
 * - Stop must be proven within the budget: every owned query's `close()` must
 *   return (or resolve) without throwing, and a dispatch claim racing the close
 *   must settle. Otherwise this rejects with
 *   {@link SessionCloseNotConfirmedError} and the session stays registered and
 *   fenced — `deleting` is kept, so nothing new runs on a CLI that may still be
 *   alive — until a retried close confirms it.
 * - The dropped state keeps `deleting` set, which is the fence every late turn
 *   callback already checks before it publishes, so no late work revives it.
 */
export function closeSessionRetainingHistory(
  sessionId: string,
  options: RetainingCloseOptions = {},
): Promise<RetainingCloseOutcome> {
  const inFlight = closesInFlight.get(sessionId);
  if (inFlight) return inFlight;
  const session = sessions.get(sessionId);
  if (!session) return Promise.resolve("missing");
  const unconfirmed = stalledCloses.get(session);
  if (session.deleting && !unconfirmed) {
    return Promise.reject(
      sessionOperationError("conflict", "Session deletion is already in progress"),
    );
  }

  stalledCloses.delete(session);
  session.deleting = true;
  session.status = "running";
  claimedPromptDispatches.delete(sessionId);
  session.abortController?.abort();
  session.abortController = undefined;
  // Parked questions and plan approvals are rejected ("Session terminated")
  // and withdrawn — a closing tab denies, it never approves. Repeated on a
  // retry in case a still-running CLI parked another one meanwhile.
  cleanupPendingInteractions(sessionId);
  const controls = takeQueryControls(session);
  for (const control of unconfirmed ?? []) controls.add(control);

  const deadline = Date.now() + (options.budgetMs ?? CLOSE_CONFIRMATION_BUDGET_MS);
  const operation = (async (): Promise<RetainingCloseOutcome> => {
    // `Query.close()` ends the CLI subprocess, which is the proof that the
    // turn can no longer write.
    const failed = await closeQueryControls(controls, deadline);
    if (failed.size > 0) {
      stalledCloses.set(session, failed);
      throw new SessionCloseNotConfirmedError("A Claude query did not confirm close");
    }
    // A claim racing the close rolls its own journal entry back once it sees
    // `deleting`; wait so that rollback is ordered before we let go.
    if (!(await settlesBy(waitForPendingPromptDispatchClaim(sessionId), deadline))) {
      stalledCloses.set(session, new Set());
      throw new SessionCloseNotConfirmedError("A racing prompt dispatch did not settle");
    }
    forgetPromptDispatchesForSession(sessionId);
    if (sessions.get(sessionId) === session) sessions.delete(sessionId);
    return "closed";
  })();
  closesInFlight.set(sessionId, operation);
  const release = () => {
    if (closesInFlight.get(sessionId) === operation) closesInFlight.delete(sessionId);
  };
  operation.then(release, release);
  return operation;
}

/** Close each control; answer the ones whose close threw or missed the deadline. */
async function closeQueryControls(
  controls: Iterable<ClaudeQueryControl>,
  deadline: number,
): Promise<Set<ClaudeQueryControl>> {
  const failed = new Set<ClaudeQueryControl>();
  await Promise.all(
    Array.from(controls, async (control) => {
      if (typeof control.close !== "function") return;
      try {
        // The pinned SDK's `Query.close()` is synchronous and throws on
        // failure; the bridge's control type also admits an async close.
        if (await settlesBy(Promise.resolve(control.close()), deadline)) return;
      } catch (error) {
        console.error(
          "[session-manager] Claude query close failed during tab close:",
          error instanceof Error ? error.name : typeof error,
        );
      }
      failed.add(control);
    }),
  );
  return failed;
}

/** True when `work` settles by `deadline`; rejections propagate. */
async function settlesBy(work: Promise<unknown>, deadline: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, deadline - Date.now()));
  });
  try {
    return await Promise.race([work.then(() => true as const), expired]);
  } finally {
    clearTimeout(timer);
  }
}
