import type { Hono } from "hono";

export interface SessionCloseRuntime {
  closeSessionRetaining(sessionId: string): Promise<"closed" | "missing" | "pending">;
}

/**
 * `POST /session/:id/close` — ordinary tab close, shared contract across bridges.
 *
 * Stops this session's owned work (last reference only), denies its parked
 * approvals, releases the thread and publishes the bridge-record tombstone. The
 * Codex rollout is never deleted: `thread/delete` is not called anywhere.
 *
 * - 200 `{ closed: true, retained: true }` once released.
 * - 200 `{ closed: true, missing: true }` for an unknown id. Never 404, which the
 *   backend reserves for "this bridge predates the route".
 * - 503 `{ closed: false, pending: true, error }` when a running turn (or a
 *   `turn/start` still in flight) could not be proven stopped within the
 *   budget, or the removal tombstone could not be written. The session stays
 *   registered and the backend keeps its intent and retries. The error text is
 *   fixed and content-free.
 *
 * From the moment close starts, prompts, steers, compactions and reviews on the
 * session are refused with 409 `Session is closing`; a pending close keeps that
 * fence up until a retry confirms.
 */
export function registerSessionCloseRoute(app: Hono, runtime: SessionCloseRuntime): void {
  app.post("/session/:id/close", async (c) => {
    let outcome: "closed" | "missing" | "pending";
    try {
      outcome = await runtime.closeSessionRetaining(c.req.param("id"));
    } catch {
      outcome = "pending";
    }
    if (outcome === "missing") return c.json({ closed: true, missing: true });
    if (outcome === "closed") return c.json({ closed: true, retained: true });
    return c.json({ closed: false, pending: true, error: "Session close did not complete" }, 503);
  });
}
