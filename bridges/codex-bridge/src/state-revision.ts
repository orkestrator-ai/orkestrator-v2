import { BridgeStateRevisions } from "@orkestrator/protocol/node/bridge-state-revision";
import type { AppServerRuntime } from "./app-server-runtime.js";

/**
 * Per-session state revisions (to-do 8102 task 2, design D7; the contract is
 * `@orkestrator/protocol/bridge-state-revision`).
 *
 * One revision covers everything the backend's state read gets for a Codex
 * session: the `/status` body, `/config` (without `durable`, which that read
 * never takes), `/approvals` and `/interactions`. `/status`'s
 * `messageRevision` and `contentEpoch` are the transcript's own revision and
 * are left out, so a streamed delta alone does not move the state; the
 * transcript revision travels separately on observe frames.
 *
 * Two inputs move it: `emit` bumps it for every session event that is not
 * transcript-only, and `GET /session/:id/status` settles it against a digest
 * of what the state read returns, so a mutation that emitted nothing still
 * moves it at the next read.
 */
export const sessionStateRevisions = new BridgeStateRevisions();

/** Events that change only the transcript; every other session event moves the state. */
const TRANSCRIPT_ONLY_EVENTS: ReadonlySet<string> = new Set(["message.updated", "message.patched"]);

export function eventMovesSessionState(type: string): boolean {
  return !TRANSCRIPT_ONLY_EVENTS.has(type);
}

/**
 * The emit-side input: move the state revision of the session an event names
 * unless the event is transcript-only. Called before the fan-out, so the
 * observe frame carries the moved revision. Synchronous.
 */
export function noteEmittedEvent(
  event: { type: string; sessionId?: string },
  revisions: BridgeStateRevisions = sessionStateRevisions,
): void {
  if (event.sessionId && eventMovesSessionState(event.type)) revisions.bump(event.sessionId);
}

/** `/status` fields that belong to the transcript revision, not the state. */
const TRANSCRIPT_STATUS_FIELDS = ["messageRevision", "contentEpoch"] as const;

export type CodexStateRevisionSource = Pick<
  AppServerRuntime,
  "configSnapshot" | "listApprovals" | "listInteractions"
>;

/**
 * Everything the backend's state read gets for a session, for the digest:
 * the `/status` body given (already read by the route) minus its transcript
 * fields, and the side routes, read without a touch.
 */
export function codexStateRevisionContent(
  runtime: CodexStateRevisionSource,
  sessionId: string,
  status: Record<string, unknown>,
): Record<string, unknown> {
  const state: Record<string, unknown> = { ...status };
  for (const field of TRANSCRIPT_STATUS_FIELDS) delete state[field];
  return {
    state,
    config: runtime.configSnapshot(sessionId),
    approvals: runtime.listApprovals(sessionId),
    interactions: runtime.listInteractions(sessionId),
  };
}
