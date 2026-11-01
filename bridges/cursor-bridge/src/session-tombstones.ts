/**
 * Closes a previous bridge process recorded but did not finish.
 *
 * A restored tombstone owns no live session, only the conversation id whose
 * surviving run must be cancelled before the removal is published. Adoption of
 * that conversation in `agent-session.ts` waits on the same per-id operation.
 */
import { CANCEL_ACK_TIMEOUT_MS, CLOSE_ACK_TIMEOUT_MS } from "./config.js";
import { cancelSurvivingRuns, SessionConflictError } from "./cursor-runs.js";
import { persistBarrier } from "./persistence.js";
import { closingTombstones } from "./state.js";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("bridge.cursor");

export type CloseOutcome = "closed" | "pending";

/**
 * Finish a close that a previous bridge process recorded but did not publish.
 *
 * The session itself was never restored — a tombstone is not a session — so
 * the only thing left that may still be executing is a run the SDK kept alive
 * across the restart. That run is looked up and cancelled; a lookup that
 * cannot answer or a run that does not stop keeps the tombstone for a retry.
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
  if (!closingTombstones.has(id) && !tombstoneCloses.has(id)) return "closed";
  const outcome = await withBudget(finishTombstone(id), ackTimeoutMs);
  return outcome === "timeout" ? "pending" : outcome;
}

const tombstoneCloses = new Map<string, Promise<CloseOutcome>>();
const publishingTombstones = new Map<
  string,
  NonNullable<ReturnType<typeof closingTombstones.get>>
>();

/** Includes a removal that has left the snapshot but is still publishing. */
export function hasRestoredTombstone(id: string): boolean {
  return closingTombstones.has(id) || tombstoneCloses.has(id);
}

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
    if (survivors === "running" || survivors === "unknown") return "pending";
  }
  if (closingTombstones.get(id) !== tombstone) return "closed";
  closingTombstones.delete(id);
  publishingTombstones.set(id, tombstone);
  try {
    await persistBarrier(() => {
      // Roll back inside the write queue, before a later snapshot can omit an
      // unpublished tombstone after a transient write failure.
      if (!closingTombstones.has(id)) closingTombstones.set(id, tombstone);
      publishingTombstones.delete(id);
    });
  } catch (error) {
    if (!closingTombstones.has(id)) closingTombstones.set(id, tombstone);
    throw error;
  } finally {
    publishingTombstones.delete(id);
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
  const pending = [...closingTombstones.values(), ...publishingTombstones.values()].filter(
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
  for (const tombstone of [...closingTombstones.values(), ...publishingTombstones.values()]) {
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
    log.warn("startup.closes-incomplete", { closes: result.pending + result.failed });
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
