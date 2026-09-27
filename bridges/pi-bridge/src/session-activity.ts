import { publicActivity } from "./public.js";
import { sessions, type JsonObject } from "./state.js";

/**
 * The one activity read both `GET /session/:id/activity` and
 * `POST /sessions/activity` answer with, so the two cannot drift.
 *
 * A pure read of the in-memory session table: it never refreshes
 * `lastAccessed` (which is what idle detaching reads), hydrates the composer,
 * attaches an agent, bounds a transcript or persists anything. An id this
 * process does not hold is answered in band as `missing`; neither route ever
 * 404s for an unknown session, because a 404 from them means "this bridge
 * predates the route" and must not be confused with a deleted session.
 */
export function sessionActivityObservation(sessionId: string): JsonObject {
  const state = sessions.get(sessionId);
  return state ? publicActivity(state) : { activity: "missing" };
}
