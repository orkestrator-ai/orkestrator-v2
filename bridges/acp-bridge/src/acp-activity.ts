import { sessions, type JsonObject } from "./acp-context.js";

/**
 * The one activity read both `GET /session/:id/activity` and
 * `POST /sessions/activity` answer with, so the two cannot drift.
 *
 * A pure read of the in-memory session table: it never spawns, attaches or
 * loads an agent, bounds or reads a transcript, or persists anything. An id
 * this process does not hold is answered in band as `missing`; neither route
 * ever 404s for an unknown session, because a 404 from them means "this bridge
 * predates the route".
 */
export function sessionActivityObservation(sessionId: string): JsonObject {
  const state = sessions.get(sessionId);
  if (!state) return { activity: "missing" };
  return {
    activity:
      state.status === "running" || state.activeSubagentToolIds.size > 0 ? "working" : "idle",
  };
}
