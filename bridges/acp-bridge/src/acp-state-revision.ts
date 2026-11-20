import { BridgeObservationHub } from "@orkestrator/protocol/node/bridge-observation-stream";
import { BridgeStateRevisions } from "@orkestrator/protocol/node/bridge-state-revision";
import type { JsonObject, SessionState } from "./acp-context.js";

/**
 * The change signal (to-do 8102 task 2, design D7): one state revision per
 * session and the backend observer's `GET /event/subscribe?observe=1` stream.
 *
 * - The **state revision** covers everything the backend's state read gets for
 *   an ACP session: the `/status` body (composer included) and the
 *   `/approvals` and `/interactions` bodies (`acpStateReadContent`). The combined
 *   `revision` those bodies carry is left out of it: it moves with every
 *   transcript chunk, and the transcript has its own revision.
 * - The **transcript revision** is `<process generation>:<state.revision>`.
 *   Every transcript change moves `state.revision`, so it moves whenever the
 *   transcript routes' answer would change (and on state changes too, which
 *   only costs a transcript read).
 *
 * Every mutation goes through one of the `mark*` helpers below, which move the
 * revision(s) and publish a frame. All of them are synchronous and never throw,
 * so they are safe inside an ACP listener. The revision harness test
 * (`acp-state-revision.test.ts`) fails a mutation path whose state read
 * changes without the state revision moving.
 */
export const stateRevisions = new BridgeStateRevisions();
export const observationHub = new BridgeObservationHub({ generation: stateRevisions.generation });

/** What every observe frame names as its event type. */
export const SESSION_CHANGED_EVENT = "session.changed";

/** Opaque and bounded (well under 96 characters, no quote or backslash). */
export function acpTranscriptRevision(state: SessionState): string {
  return `${stateRevisions.generation}:${state.revision}`;
}

function publish(state: SessionState): void {
  observationHub.publish(SESSION_CHANGED_EVENT, state.id, {
    stateRevision: stateRevisions.peek(state.id),
    transcriptRevision: acpTranscriptRevision(state),
  });
}

/**
 * Something the state read returns changed, and so may the transcript: moves
 * the combined `revision` (and with it the transcript revision) and the state
 * revision, then publishes. The default for any mutation that is not plainly
 * transcript-only.
 */
export function markSessionChanged(state: SessionState): void {
  state.revision += 1;
  stateRevisions.bump(state.id);
  publish(state);
}

/**
 * Only the transcript changed (a chunk, a row, a tool card, a trim): moves
 * the combined `revision` and publishes, leaving the state revision alone.
 */
export function markTranscriptChanged(state: SessionState): void {
  state.revision += 1;
  publish(state);
}

/**
 * Only the state read changed, at a site that never moved the combined
 * `revision` (parked requests cleared, policy, read-only, a runtime notice).
 */
export function markStateChanged(state: SessionState): void {
  stateRevisions.bump(state.id);
  publish(state);
}

/**
 * The session left the registry: one last frame (both reads now answer
 * "missing"), then its state revision is dropped.
 */
export function forgetSessionRevision(state: SessionState): void {
  markSessionChanged(state);
  stateRevisions.forget(state.id);
}

/**
 * The state read's digest content: the `/status` body and the `/approvals`
 * and `/interactions` bodies, each without the combined `revision`.
 */
export function acpStateReadContent(
  status: JsonObject,
  approvals: unknown[],
  interactions: unknown[],
): unknown {
  const { revision: _revision, ...statusContent } = status;
  return { status: statusContent, approvals, interactions };
}
