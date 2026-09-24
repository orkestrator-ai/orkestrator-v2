/**
 * Process lifecycle: the HTTP server, idle detaching, and a clean shutdown.
 */
import { createServer, type Server } from "node:http";
import {
  BridgeLifecycle,
  type LifecycleSignalTarget,
} from "@orkestrator/protocol/bridge-lifecycle";
import {
  type IntervalTimers,
  PARENT_PID_ENV,
  parseParentPid,
} from "@orkestrator/protocol/parent-watchdog";
import { hostname, port } from "./config.js";
import { detachSession } from "./agent-session.js";
import { json, route } from "./http.js";
import { settleIdleDetaches, sweepIdleSessions } from "./idle-detach.js";
import { denyAllApprovals } from "./interactions.js";
import { drainPersistence, loadPersistedState } from "./persistence.js";
import { sessions } from "./state.js";

const IDLE_SWEEP_MS = 60 * 1000;
/** How often to check that the backend that spawned us is still alive. */
const PARENT_WATCH_MS = 5_000;

/** Seams for the lifecycle's clock, parent probe and exit; production passes none. */
export interface ServerLifecycleOptions {
  timers?: IntervalTimers;
  parentPid?: number | null;
  isParentAlive?: (pid: number) => boolean;
  exit?: (code: number) => void;
  signals?: LifecycleSignalTarget | null;
}

let lifecycle: BridgeLifecycle | undefined;

export const server: Server = createServer((request, response) => {
  const controller = new AbortController();
  // A renderer that navigates away aborts its request. That must reach a read
  // in progress, but it deliberately does not cancel a turn: closing a tab is
  // not the user asking the agent to stop.
  request.once("aborted", () => controller.abort());

  if (lifecycle?.closing) {
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

async function releaseEverything(): Promise<void> {
  // Deny first. A parked approval is a turn awaiting a promise, and a process
  // that exits without settling it leaves the tool call unanswered — approving
  // it on the way out would run a command nobody read.
  for (const state of Array.from(sessions.values())) {
    denyAllApprovals(state, "The bridge shut down before this tool call was approved.");
  }
  // Persist before releasing sessions: a transcript written after they are gone
  // is the same transcript, but one lost to a hung dispose is not.
  await drainPersistence();
  await Promise.allSettled([
    ...Array.from(sessions.values()).map((state) => detachSession(state)),
    // An idle detach that started before shutdown is still disposing; the
    // shutdown is not finished until it is.
    settleIdleDetaches(),
  ]);
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function lifecycleFor(listenPort: number, options: ServerLifecycleOptions): BridgeLifecycle {
  return new BridgeLifecycle({
    label: "[pi-bridge]",
    open: async () => {
      await loadPersistedState();
      await new Promise<void>((resolve) => server.listen(listenPort, hostname, resolve));
    },
    close: releaseEverything,
    idleSweep: { intervalMs: IDLE_SWEEP_MS, run: () => void sweepIdleSessions() },
    parentPid:
      options.parentPid !== undefined
        ? options.parentPid
        : parseParentPid(process.env[PARENT_PID_ENV]),
    parentWatchMs: PARENT_WATCH_MS,
    exit: options.exit ?? ((code) => process.exit(code)),
    ...(options.timers ? { timers: options.timers } : {}),
    ...(options.isParentAlive ? { isParentAlive: options.isParentAlive } : {}),
    ...(options.signals !== undefined ? { signals: options.signals } : {}),
  });
}

/**
 * Bind the server and arm its background sweeps. Starts once: a second call,
 * including one after shutdown, rejects without arming anything.
 *
 * `listenPort` exists for tests. `config.ts` reads `PORT` once at import, so a
 * suite that sets it cannot count on being the first file in a shared process
 * to load that module — it would bind whatever port the ambient environment
 * happened to carry, and fail when that port is in use. Production passes
 * nothing and keeps the configured port.
 */
export async function start(
  listenPort: number = port,
  options: ServerLifecycleOptions = {},
): Promise<void> {
  if (lifecycle) throw new Error("The Pi bridge server was already started");
  lifecycle = lifecycleFor(listenPort, options);
  await lifecycle.start();
}

/**
 * Clear the lifecycle timers, then release every session and close the
 * server. Idempotent. Does not exit the process.
 */
export async function shutdown(): Promise<void> {
  // A shutdown before any start still releases whatever was loaded, and
  // leaves the bridge closed: a later start is refused.
  lifecycle ??= lifecycleFor(port, { signals: null, parentPid: null });
  await lifecycle.shutdown();
}
