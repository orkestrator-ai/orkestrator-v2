/**
 * Permanently closing a session: the one operation after which nothing this
 * session owned may start, or keep running unobserved.
 *
 * Idle detach (`detachAgent`) is a different thing and stays one. It releases
 * the SDK agent of a session that will be used again, keeping its identity so
 * the next request re-attaches to the same conversation. Permanent close is
 * what a closed tab asks for, and it has three boundaries that must be handled
 * together or not at all:
 *
 * 1. Admission. `state.closed` is set synchronously, before the close awaits
 *    anything, so a prompt, attach, config change, steer or same-key create
 *    that arrives — or resumes from an await — after it cannot start work.
 * 2. Late results. An attach or `agent.send` already in flight cannot be
 *    recalled, so its result is owned: a late agent is disposed instead of
 *    installed, and a late run is cancelled the moment its handle exists and
 *    followed to its end.
 * 3. Publication. The removal is published before the close is acknowledged.
 *    Until then the record stays registered (answered as closing, never as a
 *    live session), so a retried close cannot read "not found" while the state
 *    file still describes a session a restart would reopen.
 *
 * Deleting is local. The SDK agent is disposed, never deleted: the user's
 * Cursor conversation is theirs, and closing a tab does not destroy it.
 */
import { CLOSE_ACK_TIMEOUT_MS } from "./config.js";
import { detachAgent } from "./agent-session.js";
import { persistBarrier, schedulePersist } from "./persistence.js";
import type { CloseOutcome } from "./session-tombstones.js";
import { clientSessionKeys, ownedWork, sessions, type SessionState } from "./state.js";

export { assertSessionOpen, SessionClosedError } from "./state.js";
export type { CloseOutcome } from "./session-tombstones.js";

/**
 * Close a session, sharing one operation between every concurrent request.
 *
 * Answers `pending` when the close has not finished within `ackTimeoutMs`: the
 * operation carries on, owned by the session record, and a later request
 * joins it. That keeps a slow cancellation from being reported either as a
 * failure (it is not one) or as a success (the run may still be writing).
 * Rejects when publishing the removal failed; a retry starts that part again.
 */
export async function closeSessionPermanently(
  state: SessionState,
  ackTimeoutMs: number = CLOSE_ACK_TIMEOUT_MS,
): Promise<CloseOutcome> {
  state.closed = true;
  if (!state.closing) {
    state.revision += 1;
    const operation = runClose(state);
    state.closing = operation;
    // A failed publication must be retryable by the next request, and the
    // operation must never become an unobserved rejection when no request is
    // waiting on it any more.
    operation.catch(() => {
      if (state.closing === operation) state.closing = undefined;
    });
  }
  const operation = state.closing;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ackTimeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation.then(() => "closed" as const), timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runClose(state: SessionState): Promise<void> {
  if (!state.closeFenced) {
    // Best effort: record the tombstone now, so a crash mid-close restarts
    // into "closing" rather than a live session. The removal below is the
    // publication the acknowledgement actually depends on.
    schedulePersist();
    await stopOwnedWork(state);
    await detachAgent(state);
    state.closeFenced = true;
    state.revision += 1;
  }
  await persistBarrier();
  if (sessions.get(state.id) === state) sessions.delete(state.id);
  if (state.clientSessionKey && clientSessionKeys.get(state.clientSessionKey) === state.id) {
    clientSessionKeys.delete(state.clientSessionKey);
  }
}

/**
 * Ask whatever is running to stop, then wait until nothing owned is left.
 *
 * Owned work arrives in stages — an attach resolves into a prompt claim, a
 * claim into a run — so this re-reads the handles until a pass finds nothing
 * new. A run whose cancellation is never acknowledged keeps the close
 * pending rather than letting it report a stop that did not happen.
 */
async function stopOwnedWork(state: SessionState): Promise<void> {
  for (let pass = 0; pass < 16; pass += 1) {
    requestStop(state);
    const owned = ownedWork(state).map((work) => work.catch(() => undefined));
    if (owned.length === 0) break;
    await Promise.all(owned);
  }
  // Nothing is left that could settle these, and the turn that owned them
  // was stopped by this close rather than completing.
  state.cancelTurn = undefined;
  state.activeRun = undefined;
  state.activeRunRecovered = undefined;
  state.activeRunCreatedAt = undefined;
  state.pendingCancelPromptSequence = undefined;
  if (state.status === "running") state.status = "idle";
  state.dispatching = false;
}

/**
 * Cancel the run in flight, or park the cancel for one that has no handle
 * yet. `dispatchPrompt` also checks `closed` when its handle arrives; the park
 * covers a claim that reached `send` before this close began.
 */
function requestStop(state: SessionState): void {
  const cancel = state.cancelTurn;
  if (cancel) {
    void Promise.resolve()
      .then(cancel)
      .catch(() => undefined);
    return;
  }
  if (state.status === "running" || state.dispatching) {
    state.pendingCancelPromptSequence =
      state.status === "running" ? state.promptSequence : state.promptSequence + 1;
  }
}
