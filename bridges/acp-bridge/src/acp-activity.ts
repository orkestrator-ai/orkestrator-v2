import { randomUUID } from "node:crypto";
import { provider, sessions, type JsonObject } from "./acp-context.js";

const activityGeneration = randomUUID();

/**
 * The one activity read both `GET /session/:id/activity` and
 * `POST /sessions/activity` answer with, so the two cannot drift.
 *
 * A pure read of the in-memory session table: it never spawns, attaches or
 * loads an agent, bounds or reads a transcript, or persists anything. An id
 * this process does not hold is answered in band as `missing`; neither route
 * ever 404s for an unknown session, because a 404 from them means "this bridge
 * predates the route".
 *
 * Active work that holds a permission, question or plan approval is `waiting`,
 * as the Codex bridge answers for parked input: the agent cannot continue
 * until someone answers, and only `waiting` makes the backend surface it.
 */
export function sessionActivityObservation(sessionId: string): JsonObject {
  const state = sessions.get(sessionId);
  if (!state) return { activity: "missing" };
  const revision =
    provider === "grok" ? { contentRevision: `${activityGeneration}:${state.revision}` } : {};
  if (state.status !== "running" && state.activeSubagentToolIds.size === 0) {
    // How the latest turn ended, for the backend's turn-end bell. A turn the
    // bridge cut short leaves the session idle; the backend reads that one
    // from the dispatch journal.
    return {
      ...revision,
      activity: "idle",
      ...(state.status === "error" ? { turnFailed: true } : {}),
    };
  }
  return {
    ...revision,
    activity: state.approvals.size > 0 || state.interactions.size > 0 ? "waiting" : "working",
  };
}
