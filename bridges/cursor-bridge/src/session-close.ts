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
import { CANCEL_ACK_TIMEOUT_MS, CLOSE_ACK_TIMEOUT_MS } from "./config.js";
import { cancelSurvivingRuns, detachAgent, SessionConflictError } from "./agent-session.js";
import { persistBarrier, schedulePersist } from "./persistence.js";
import {
  clientSessionKeys,
  closingTombstones,
  ownedWork,
  sessions,
  type SessionState,
} from "./state.js";

export { assertSessionOpen, SessionClosedError } from "./state.js";

export type CloseOutcome = "closed" | "pending";

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

/**
 * Finish a close that a previous bridge process recorded but did not publish.
 *
 * The session itself was never restored — a tombstone is not a session — so
 * the only thing left that may still be executing is a run the SDK kept alive
 * across the restart. That run is looked up and cancelled; a lookup that
 * cannot answer is not evidence of one, but a run found and not stopped is,
 * and keeps the tombstone.
 *
 * One operation per id, shared by every caller — a close request, the startup
 * sweep, a resume of the same conversation — so a second request can never
 * acknowledge `closed` before the first one's removal is published: it joins
 * it, and a failed publication fails both. A request that outlives
 * `ackTimeoutMs` answers `pending` while the operation carries on.
 */
export async function closeRestoredTombstone(
  id: string,
  ackTimeoutMs: number = CLOSE_ACK_TIMEOUT_MS,
): Promise<CloseOutcome> {
  if (!closingTombstones.has(id)) return "closed";
  const outcome = await withBudget(finishTombstone(id), ackTimeoutMs);
  return outcome === "timeout" ? "pending" : outcome;
}

const tombstoneCloses = new Map<string, Promise<CloseOutcome>>();

/** The shared finishing operation for one tombstone. Rejects only on publication. */
function finishTombstone(id: string): Promise<CloseOutcome> {
  const inFlight = tombstoneCloses.get(id);
  if (inFlight) return inFlight;
  const operation = runTombstoneClose(id);
  tombstoneCloses.set(id, operation);
  // Released however it ends, so a failed or pending finish is retried by the
  // next caller rather than answered from a stale result. Observed here so an
  // operation nobody waits on any more cannot become an unhandled rejection.
  void operation
    .catch(() => undefined)
    .finally(() => {
      if (tombstoneCloses.get(id) === operation) tombstoneCloses.delete(id);
    });
  return operation;
}

async function runTombstoneClose(id: string): Promise<CloseOutcome> {
  const tombstone = closingTombstones.get(id);
  if (!tombstone) return "closed";
  if (tombstone.agentId) {
    // Bounded on its own: the run listing has a catalogue timeout and each
    // cancellation an acknowledgement timeout.
    const survivors = await cancelSurvivingRuns(tombstone.agentId, CANCEL_ACK_TIMEOUT_MS);
    if (survivors === "running") return "pending";
  }
  if (closingTombstones.get(id) !== tombstone) return "closed";
  closingTombstones.delete(id);
  try {
    await persistBarrier();
  } catch (error) {
    if (!closingTombstones.has(id)) closingTombstones.set(id, tombstone);
    throw error;
  }
  return "closed";
}

/**
 * Finish every close that is still pending for `agentId` before that
 * conversation is adopted again.
 *
 * A tombstone's close cancels every run of its agent it finds. Finishing it
 * first is what guarantees it can never cancel a run the new owner starts.
 * Throws when one could not finish — a run that ignored cancellation, or a
 * failed publication — so the caller refuses the adoption rather than races
 * it.
 */
export async function finishTombstonesForAgent(agentId: string): Promise<void> {
  const pending = Array.from(closingTombstones.values()).filter(
    (tombstone) => tombstone.agentId === agentId,
  );
  for (const tombstone of pending) {
    if ((await finishTombstone(tombstone.id)) === "pending") {
      throw new SessionConflictError(
        "A previous close of this Cursor conversation is still stopping its run; retry shortly",
      );
    }
  }
}

/** Whether adopting `agentId` has to wait for {@link finishTombstonesForAgent}. */
export function hasTombstoneForAgent(agentId: string): boolean {
  for (const tombstone of closingTombstones.values()) {
    if (tombstone.agentId === agentId) return true;
  }
  return false;
}

/** How many restored closes the startup sweep finishes at once. */
const STARTUP_TOMBSTONE_CONCURRENCY = 4;

/**
 * Finish the closes a previous process recorded, without waiting for a close
 * request to ask. Started once the state file is loaded and never awaited by
 * startup: every step is bounded, and a close request or a resume that
 * arrives meanwhile joins the same per-id operation. What could not be
 * finished stays a tombstone for a later request, and is reported by count
 * only.
 */
export async function finishRestoredTombstones(): Promise<{
  closed: number;
  pending: number;
  failed: number;
}> {
  const queue = Array.from(closingTombstones.keys());
  const result = { closed: 0, pending: 0, failed: 0 };
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        result[(await finishTombstone(id)) === "closed" ? "closed" : "pending"] += 1;
      } catch {
        result.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: STARTUP_TOMBSTONE_CONCURRENCY }, worker));
  if (result.pending > 0 || result.failed > 0) {
    console.warn(
      `[cursor-bridge] ${result.pending + result.failed} restored close(s) could not finish at startup; a retried close finishes them`,
    );
  }
  return result;
}

async function withBudget<T>(work: Promise<T>, timeoutMs: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
