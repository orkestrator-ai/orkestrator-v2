import type { Hono } from "hono";
import {
  answerSessionActivityBatch,
  SESSION_ACTIVITY_BATCH_PATH,
} from "@orkestrator/protocol/session-activity-batch";

export interface SessionActivityRuntime {
  getActivitySnapshot(sessionId: string): unknown;
}

/**
 * `POST /sessions/activity` — `GET /session/:id/activity` for a bounded set of
 * sessions in one request.
 *
 * Each id is answered by `getActivitySnapshot`, the same synchronous no-touch
 * read the single route serves, so the two answers cannot drift: it never
 * calls `touchSession`, `registry.touch` or `ensureAttached`, and a detached
 * thread is reported detached rather than re-attached. An unknown session is
 * answered in band as `missing`; the route itself only 404s on a bridge that
 * predates it, which is how the backend detects support.
 *
 * Registered after the authentication middleware like every data route.
 */
export function registerSessionActivityBatchRoute(
  app: Hono,
  runtime: SessionActivityRuntime,
): void {
  app.post(SESSION_ACTIVITY_BATCH_PATH, async (c) => {
    const answer = await answerSessionActivityBatch(
      c.req.raw.body,
      // Resolved per call so a replaced runtime method is honoured.
      (sessionId) => runtime.getActivitySnapshot(sessionId),
      { contentLength: c.req.header("content-length") },
    );
    return c.json(answer.body, answer.status as 200);
  });
}
