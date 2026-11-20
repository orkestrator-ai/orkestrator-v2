/**
 * The change signal (to-do 8102 task 2, design D7): per-session state
 * revisions and the backend observer's `GET /event/subscribe?observe=1`
 * stream.
 *
 * - **`stateRevisions`** moves on every change of anything the backend's state
 *   read gets for a Pi session: the `/status` body, `/queue`, `/approvals`,
 *   `/interactions` and the composer's own revision (`state-read.ts`).
 * - **`composerRevisions`** is the composer's own, so a state change that
 *   leaves the model list alone does not resend it.
 * - **The transcript revision** is derived from what the transcript route's
 *   token keys on (`piTranscriptRevision`).
 *
 * Every mutation goes through `revisionChanged` (it moves the session's
 * `revision` counter, which the transcript token and every state body carry)
 * or `stateChanged` (state only). Both are synchronous and O(1), so they are
 * safe on Pi's SDK listener. Frames are coalesced per session to one per
 * synchronous burst; the revisions themselves move at once.
 */
import { BridgeObservationHub } from "@orkestrator/protocol/node/bridge-observation-stream";
import { BridgeStateRevisions } from "@orkestrator/protocol/node/bridge-state-revision";
import type { SessionState } from "./state.js";

/** What a mutation needs of a session: its id and transcript counters. */
type ObservedSession = Pick<
  SessionState,
  "id" | "revision" | "transcriptEpoch" | "droppedMessages"
>;

export const stateRevisions = new BridgeStateRevisions();
export const composerRevisions = new BridgeStateRevisions({
  generation: stateRevisions.generation,
});
export const observationHub = new BridgeObservationHub();

/** The frame type every Pi observe frame carries. */
export const SESSION_CHANGED_FRAME = "session.changed";

const pendingFrames = new Map<string, ObservedSession>();
let flushScheduled = false;
/** Sessions whose removal was published: their frames carry no revision. */
const removed = new WeakSet<ObservedSession>();

/**
 * Opaque, printable, bounded: moves whenever `GET /session/:id/transcript`
 * would answer differently. Its token keys on the process generation, the
 * content epoch (`transcriptEpoch:droppedMessages`) and `revision`, and every
 * row change, title change and trim moves `revision`.
 */
export function piTranscriptRevision(state: ObservedSession): string {
  return `${stateRevisions.generation}.${state.transcriptEpoch ?? 0}.${state.droppedMessages ?? 0}.${state.revision}`;
}

/**
 * A change to what the state read returns: move the state revision and
 * announce it. Never throws, never awaits.
 */
export function stateChanged(state: ObservedSession): void {
  // A removed session keeps no revision; a late change only re-announces it.
  if (!removed.has(state)) stateRevisions.bump(state.id);
  scheduleFrame(state);
}

/**
 * A change that moves the session's `revision`: every transcript row change,
 * and the state changes that have always moved it (queue, approvals, title,
 * composer, compaction). `/status` carries `revision`, so this always moves
 * the state revision too. Use it instead of `state.revision += 1`.
 */
export function revisionChanged(state: ObservedSession): void {
  state.revision += 1;
  stateChanged(state);
}

/**
 * The session is gone (its close was published). Forget its revisions and
 * announce it once more, without revisions, so the backend reads it as missing.
 */
export function sessionRemoved(state: ObservedSession): void {
  removed.add(state);
  stateRevisions.forget(state.id);
  composerRevisions.forget(state.id);
  scheduleFrame(state);
}

function scheduleFrame(state: ObservedSession): void {
  pendingFrames.set(state.id, state);
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(flushFrames);
}

/** Publish the coalesced frames with the revisions as they stand now. */
function flushFrames(): void {
  flushScheduled = false;
  const batch = Array.from(pendingFrames.entries());
  pendingFrames.clear();
  for (const [sessionId, state] of batch) {
    if (removed.has(state)) {
      observationHub.publish(SESSION_CHANGED_FRAME, sessionId);
      continue;
    }
    observationHub.publish(SESSION_CHANGED_FRAME, sessionId, {
      stateRevision: stateRevisions.peek(sessionId),
      transcriptRevision: piTranscriptRevision(state),
    });
  }
}
