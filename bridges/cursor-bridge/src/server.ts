/**
 * Process lifecycle: the HTTP server, idle detaching, and a clean shutdown.
 */
import { createServer, type Server } from "node:http";
import { hostname, port } from "./config.js";
import { detachAgent } from "./agent-session.js";
import { json, route } from "./http.js";
import { drainPersistence, loadPersistedState } from "./persistence.js";
import { sessionIsWorking, sessions } from "./state.js";

/** How long a session may sit untouched before its SDK agent is released. */
const IDLE_DETACH_MS = 10 * 60 * 1000;
const IDLE_SWEEP_MS = 60 * 1000;
/** How often to check that the backend that spawned us is still alive. */
const PARENT_WATCH_MS = 5_000;

let shuttingDown = false;

export const server: Server = createServer((request, response) => {
  const controller = new AbortController();
  // A renderer that navigates away aborts its request. That must reach a read
  // in progress, but it deliberately does not cancel a turn: closing a tab is
  // not the user asking the agent to stop.
  request.once("aborted", () => controller.abort());

  if (shuttingDown) {
    json(response, 503, { error: "Bridge is shutting down" });
    return;
  }

  void route(request, response, controller.signal).catch(() => {
    if (response.headersSent) {
      response.end();
      return;
    }
    // Never surface an unexpected error's text: it can carry a prompt, a file
    // path or a credential from whatever threw it.
    json(response, 500, { error: "Internal bridge error" });
  });
});

/**
 * Release the SDK agent behind a session nobody has touched recently.
 *
 * The session, its transcript and its agent id all survive, so the next
 * request re-attaches to the same conversation transparently. A session with a
 * turn or a background child still running is never detached.
 */
function sweepIdleSessions(): void {
  const now = Date.now();
  for (const state of Array.from(sessions.values())) {
    if (!state.agent || sessionIsWorking(state) || state.dispatching) continue;
    if (now - state.lastAccessed < IDLE_DETACH_MS) continue;
    void detachAgent(state).catch(() => undefined);
  }
}

export async function start(): Promise<void> {
  await loadPersistedState();
  await new Promise<void>((resolve) => server.listen(port, hostname, resolve));

  const idleSweep = setInterval(sweepIdleSessions, IDLE_SWEEP_MS);
  idleSweep.unref();

  // Bridges are spawned detached so they outlive a backend that dies without
  // running its shutdown path. Watching the advertised PID is what stops this
  // process — and every agent it owns — from being orphaned.
  const parentPid = Number.parseInt(process.env.ORKESTRATOR_PARENT_PID?.trim() || "", 10);
  if (Number.isInteger(parentPid) && parentPid > 1) {
    const watch = setInterval(() => {
      try {
        process.kill(parentPid, 0);
      } catch {
        void shutdown().then(() => process.exit(0));
      }
    }, PARENT_WATCH_MS);
    watch.unref();
  }

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void shutdown().then(() => process.exit(0));
    });
  }
}

export async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  // Persist before releasing agents: a transcript written after the agents are
  // gone is the same transcript, but one lost to a hung dispose is not.
  await drainPersistence();
  await Promise.allSettled(Array.from(sessions.values()).map((state) => detachAgent(state)));
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
