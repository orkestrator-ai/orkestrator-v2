import type { Hono } from "hono";
import { closeSessionRetainingHistory } from "../services/session-manager-close.js";

/**
 * `POST /session/:id/close` — ordinary tab close.
 *
 * Stops the session's owned work, denies anything parked and retires the
 * bridge's live mapping, but never deletes the Claude conversation. That is the
 * whole difference from `DELETE /session/:id`, which removes the SDK rollout and
 * stays available only to callers that deliberately ask for permanent deletion.
 *
 * Contract shared by every bridge:
 * - 200 `{ closed: true, retained: true }` once the work is stopped.
 * - 200 `{ closed: true, missing: true }` for an id with no live mapping. Never
 *   404: the backend reads 404/405 here as "this bridge predates the route" and
 *   must not confuse that with "already closed".
 * - 503 `{ closed: false, pending: true, error }` when close cannot be confirmed
 *   (a query's `close()` threw or missed the budget, a racing dispatch claim did
 *   not settle, or a permanent deletion owns the session). The session stays
 *   registered and fenced, so the backend keeps its durable teardown intent and
 *   retries. The message is fixed text; a vendor error could carry paths or
 *   prompt content.
 */
export function registerSessionCloseRoute(app: Hono): void {
  app.post("/:id/close", async (c) => {
    try {
      const outcome = await closeSessionRetainingHistory(c.req.param("id"));
      return c.json(
        outcome === "missing" ? { closed: true, missing: true } : { closed: true, retained: true },
      );
    } catch (error) {
      const conflict = (error as { code?: unknown } | null)?.code === "conflict";
      return c.json(
        {
          closed: false,
          pending: true,
          error: conflict
            ? "Session is already being closed or deleted"
            : "Session close did not complete",
        },
        503,
      );
    }
  });
}
