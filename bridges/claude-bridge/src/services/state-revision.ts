import { BridgeStateRevisions } from "@orkestrator/protocol/node/bridge-state-revision";
import type { SSEEventType } from "../types/index.js";

/**
 * Per-session state revisions (to-do 8102 task 2, design D7; the contract is
 * `@orkestrator/protocol/bridge-state-revision`).
 *
 * One revision covers everything the backend's state read gets for a Claude
 * session: the `GET /session/:id` body (without `lastActivity`, which that
 * read itself moves) and the three side routes read beside it,
 * `/questions`, `/plan-approvals` and `/interactions`. The transcript has its
 * own revision (`readTranscriptVersion`), carried separately on observe
 * frames.
 *
 * Two inputs move it: the event fan-out bumps it for every session event that
 * is not transcript-only (`eventEmitter.emit`), and `GET /session/:id` settles
 * it against a digest of what it returns, so a mutation that emitted nothing
 * still moves it at the next read. Explicit `bumpSessionState` calls cover
 * state changes that emit no event but must still reach a push observer.
 */
export const sessionStateRevisions = new BridgeStateRevisions();

/**
 * Events that change only the transcript. Every other session event moves the
 * state revision before its frame is fanned out.
 */
const TRANSCRIPT_ONLY_EVENTS: ReadonlySet<SSEEventType> = new Set([
  "message.updated",
  "message.patched",
]);

export function eventMovesSessionState(type: SSEEventType): boolean {
  return !TRANSCRIPT_ONLY_EVENTS.has(type);
}

/** Move a session's state revision. Synchronous; safe in SDK listeners. */
export function bumpSessionState(sessionId: string): void {
  sessionStateRevisions.bump(sessionId);
}
