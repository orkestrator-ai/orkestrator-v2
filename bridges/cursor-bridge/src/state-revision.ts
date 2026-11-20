/**
 * The bridge's change signal (to-do 8102 task 2, design D7).
 *
 * Two revisions per session, moved by the helpers below and announced on
 * `GET /event/subscribe?observe=1`:
 *
 * - **State** (`stateRevisions`): everything the backend's state read gets —
 *   the `/status` body (composer included) and the `/approvals` and
 *   `/interactions` bodies — minus their `revision` field, which is the
 *   transcript token (see `stateReadContent`). `/status` answers
 *   `{ unchanged: true, stateRevision }` to a still-current
 *   `?knownStateRevision=`.
 * - **Transcript** (`transcriptRevision`): built from `state.revision`, the
 *   token every transcript route already answers with, and moves whenever it
 *   does.
 *
 * Every mutation goes through `transcriptChanged`, `stateChanged` or
 * `sessionChanged`; never bump `state.revision` alone. All three are
 * synchronous, O(1) and never throw, so they are safe inside an SDK listener.
 * `state-revision.test.ts` drives each mutation path and fails one whose state
 * read changed without the revision moving.
 */
import { randomBytes } from "node:crypto";
import { BridgeObservationHub } from "@orkestrator/protocol/node/bridge-observation-stream";
import { BridgeStateRevisions } from "@orkestrator/protocol/node/bridge-state-revision";
import { sessions, type SessionState } from "./state.js";

/** Prefixes every transcript revision, so a restarted process never repeats one. */
const TRANSCRIPT_REVISION_GENERATION = randomBytes(12).toString("base64url");

/** Per-session state revisions of this process. */
export const stateRevisions = new BridgeStateRevisions();

/** `GET /event/subscribe?observe=1`. */
export const observationHub = new BridgeObservationHub();

/** The one frame type this bridge publishes. */
export const SESSION_CHANGED_EVENT = "session.changed";

/**
 * Only the transcript changed: rows, the window, an advisory row. Moves the
 * transcript token readers compare.
 */
export function transcriptChanged(state: SessionState): void {
  state.revision += 1;
  schedulePublish(state);
}

/** Only what the state read returns changed (status, composer, usage, runtime, …). */
export function stateChanged(state: SessionState): void {
  stateRevisions.bump(state.id);
  schedulePublish(state);
}

/**
 * Both moved. Also the safe choice for a site that is unsure: an extra state
 * move costs the backend one read, a missing one costs push latency.
 */
export function sessionChanged(state: SessionState): void {
  state.revision += 1;
  stateRevisions.bump(state.id);
  schedulePublish(state);
}

/** Something every session's state read includes changed (sign-in, account windows). */
export function everySessionStateChanged(): void {
  for (const state of sessions.values()) stateChanged(state);
}

/** The session left the table (close published): announce it and forget its revision. */
export function sessionRemoved(state: SessionState): void {
  pending.delete(state.id);
  stateRevisions.bump(state.id);
  publishNow(state);
  stateRevisions.forget(state.id);
}

/**
 * The transcript revision an observe frame carries: opaque, printable, at
 * most 96 characters. `state.revision` moves on every transcript change; the
 * epoch and the dropped-row count keep it moving across a rewind or a reload
 * that would otherwise reuse a number.
 */
export function transcriptRevision(state: SessionState): string {
  return `${TRANSCRIPT_REVISION_GENERATION}.${state.transcriptEpoch ?? 0}.${state.droppedMessages}.${state.revision}`;
}

/**
 * Which fields of a state-read body are content, not the transcript token.
 * `revision` on `/status`, `/approvals` and `/interactions` is `state.revision`,
 * the transcript's token, so it is left out of the state digest: the
 * transcript has its own revision and moves without the state.
 */
export function stateReadContent(parts: {
  status: Record<string, unknown>;
  approvals: Record<string, unknown>;
  interactions: Record<string, unknown>;
}): unknown {
  return {
    status: withoutRevision(parts.status),
    approvals: withoutRevision(parts.approvals),
    interactions: withoutRevision(parts.interactions),
  };
}

function withoutRevision(body: Record<string, unknown>): Record<string, unknown> {
  const { revision: _transcriptToken, stateRevision: _state, ...rest } = body;
  return rest;
}

/**
 * Frames are coalesced per session within one synchronous burst (one SDK
 * update can move a row several times); each carries the revisions current
 * when it is written, never older ones.
 */
const pending = new Map<string, SessionState>();
let flushQueued = false;

function schedulePublish(state: SessionState): void {
  pending.set(state.id, state);
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(flushPublishes);
}

function flushPublishes(): void {
  flushQueued = false;
  const batch = Array.from(pending.values());
  pending.clear();
  for (const state of batch) {
    // A session removed since it was queued was announced by `sessionRemoved`.
    if (sessions.get(state.id) !== state) continue;
    publishNow(state);
  }
}

function publishNow(state: SessionState): void {
  try {
    observationHub.publish(SESSION_CHANGED_EVENT, state.id, {
      stateRevision: stateRevisions.peek(state.id),
      transcriptRevision: transcriptRevision(state),
    });
  } catch {
    // A wakeup hint; the backend's recovery read covers a lost one.
  }
}
