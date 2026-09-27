/**
 * Transcript content revisions for Claude's conditional transcript route.
 *
 * `GET /session/:id/transcript` answers `unchanged` when a caller's token still
 * describes the transcript. Without a revision the shared helper hashes the
 * whole serialized history on every poll, so the route passes this pair
 * instead:
 *
 * - `transcriptRevision` advances on every change to anything serialized from
 *   `session.messages`: appends, in-place edits (streamed text, tool results,
 *   model attribution, SSE revision stamps), notices and overlay rows.
 * - `transcriptEpoch` is replaced when the array is replaced wholesale:
 *   hydration, eviction, a conversation reset, a preview/hydrated flip.
 *   Positions from different epochs are unrelated, which is what the backend
 *   keys its history continuity on.
 *
 * Both are drawn from one process-global counter rather than per-session
 * counters. A session deleted and recreated under the same id, or a fresh
 * object built by materialization, therefore can never reproduce a
 * (epoch, revision) pair an older token was issued for. The counter is a
 * safe integer that advances by one per mutation, so it cannot overflow
 * within a process lifetime; a new process has a new transcript generation,
 * which the route puts in the token separately.
 *
 * Every mutation site calls one of the two markers synchronously, right
 * after the change is installed. Callers must not await between a mutation
 * and its marker: a read in that gap would pair new content with an old
 * token, which the reader would then cache as current.
 */
import type { NormalizedMessage, SessionState } from "../types/index.js";

let lastStamp = 0;

function nextStamp(): number {
  lastStamp += 1;
  return lastStamp;
}

/**
 * The array and length the markers last saw, per session object.
 *
 * Held off `SessionState` so a stray serialization of the session cannot
 * duplicate its transcript through this reference.
 */
const observed = new WeakMap<SessionState, { messages: NormalizedMessage[]; length: number }>();

function observe(session: SessionState): void {
  observed.set(session, { messages: session.messages, length: session.messages.length });
}

/** Record an append or in-place change to `session.messages` or a message in it. */
export function markTranscriptChanged(session: SessionState): void {
  session.transcriptEpoch ??= nextStamp();
  session.transcriptRevision = nextStamp();
  observe(session);
}

/**
 * Record a wholesale replacement of the transcript (or of its loaded state).
 *
 * Also advances the revision, so the pair is new even for a reader that keyed
 * only on one of them.
 */
export function resetTranscriptEpoch(session: SessionState): void {
  session.transcriptEpoch = nextStamp();
  session.transcriptRevision = nextStamp();
  observe(session);
}

let repairs = 0;

/**
 * How many reads found an array replacement or a length change that no marker
 * recorded. Each one is a missed mutation site; tests assert it stays zero.
 */
export function transcriptVersionRepairsForTesting(): number {
  return repairs;
}

/**
 * The (epoch, revision) pair describing `session.messages` right now.
 *
 * O(1). As a guard behind the explicit markers it also notices a replaced
 * array or a changed length that skipped its marker and invalidates for it;
 * an in-place edit is invisible here, which is why every such site marks.
 */
export function readTranscriptVersion(session: SessionState): {
  epoch: number;
  revision: number;
} {
  const seen = observed.get(session);
  if (
    session.transcriptEpoch === undefined ||
    session.transcriptRevision === undefined ||
    !seen ||
    seen.messages !== session.messages
  ) {
    // A session nothing has marked yet starts its own epoch here. Counted as a
    // repair only when a marker had run and the array still moved under it.
    if (seen) repairs += 1;
    resetTranscriptEpoch(session);
  } else if (seen.length !== session.messages.length) {
    repairs += 1;
    markTranscriptChanged(session);
  }
  return { epoch: session.transcriptEpoch!, revision: session.transcriptRevision! };
}
