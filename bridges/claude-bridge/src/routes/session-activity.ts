import { Hono } from "hono";
import {
  answerSessionActivityBatch,
  SESSION_ACTIVITY_BATCH_PATH,
} from "@orkestrator/protocol/session-activity-batch";
import {
  getSessionActivity,
  peekSession,
  type SessionActivity,
} from "../services/session-manager.js";

/**
 * The one activity read both `GET /session/:id/activity` and
 * `POST /sessions/activity` answer with, so the two cannot drift.
 *
 * `getSessionActivity` reads only what is already resident and materializes
 * nothing; `peekSession` does not touch the idle clock. Neither route may route
 * through `resolveSession` / `ensurePersistedSession` / `getSession`: the
 * backend polls every persisted session every couple of seconds, and a touch or
 * hydration here would pin every transcript in memory forever.
 *
 * `missing` is only the in-band proof that a session is gone. A failed
 * existence probe answers `idle` (see `persistedSessionExistsOnDisk`), because
 * an error is not evidence of deletion.
 */
export async function readSessionActivityObservation(
  sessionId: string,
): Promise<{ activity: SessionActivity; readyForInput?: true }> {
  const activity = await getSessionActivity(sessionId);
  const resident = peekSession(sessionId);
  return {
    activity,
    // Readiness and activity deliberately diverge while background work is
    // alive: the composer may accept a new prompt (and the bell may announce
    // that fact) while the environment icon must remain blue and pulsing.
    ...(resident?.status === "idle" ? { readyForInput: true as const } : {}),
  };
}

/**
 * `POST /sessions/activity` — the bounded batch form of the single route.
 *
 * Mounted at the application root rather than under `/session`, so no
 * `/session/:id` route can ever read `activity` as a session id. Mounted after
 * the authentication middleware like every data route.
 */
export const sessionActivityBatch = new Hono();

sessionActivityBatch.post(SESSION_ACTIVITY_BATCH_PATH, async (c) => {
  const answer = await answerSessionActivityBatch(c.req.raw.body, readSessionActivityObservation, {
    contentLength: c.req.header("content-length"),
  });
  return c.json(answer.body, answer.status as 200);
});
