import { createLogger } from "@orkestrator/protocol/logger";
import type { BackendQuitWait } from "./backend-lifecycle.js";

const log = createLogger("desktop");

/** The signals a system sends to stop a session: logout, reboot, shutdown, hangup. */
export const QUIT_SIGNALS = ["SIGTERM", "SIGHUP"] as const;
export type QuitSignal = (typeof QUIT_SIGNALS)[number];

/**
 * Longest a quit started by a termination signal waits for the backend's
 * drain. systemd gives a stopping unit `TimeoutStopSec` before SIGKILL, and
 * Omarchy sets that to 5 s for the whole user session; the rest of the budget
 * goes to closing the logs and writing `essential.stopped`. The backend got the
 * same stop from the system and goes on draining on its own.
 */
export const SIGNAL_QUIT_BACKEND_WAIT_MS = 3_000;

type SignalProcess = {
  on(signal: QuitSignal, listener: (signal: NodeJS.Signals) => void): unknown;
  removeListener(signal: QuitSignal, listener: (signal: NodeJS.Signals) => void): unknown;
};

/**
 * Quits on SIGTERM or SIGHUP with the backend wait capped, so a quit the
 * system started finishes, essential stop marker included, before the system
 * kills the process. Without this the quit waited up to 20 s for the backend,
 * and a session stop timeout of 5 s ended it first: the next start then read
 * the shutdown as a desktop that died (`logging:writer-died:desktop`).
 *
 * The first signal records itself in the essential log (`quit.signal-received`),
 * caps the wait (also when an ordinary quit is already under way) and calls
 * `app.quit()`. A later signal is logged and otherwise ignored: the quit it
 * would start is already running under the cap, and a logout can deliver both
 * SIGHUP and SIGTERM. A listener here replaces Electron's own handling, which
 * quit on the first signal and let the second kill the process.
 */
export function installQuitSignalHandlers(options: {
  app: Pick<Electron.App, "quit">;
  backendWait: Pick<BackendQuitWait, "cap">;
  process?: SignalProcess;
  waitMs?: number;
}): { received(): QuitSignal | null; dispose(): void } {
  const target: SignalProcess = options.process ?? process;
  const waitMs = options.waitMs ?? SIGNAL_QUIT_BACKEND_WAIT_MS;
  let first: QuitSignal | null = null;
  const listeners = QUIT_SIGNALS.map((signal) => {
    const listener = () => {
      if (first) {
        log.info("quit.signal-repeated", { signal, first });
        return;
      }
      first = signal;
      log.info("quit.signal-received", { signal, backendWaitMs: waitMs });
      options.backendWait.cap(waitMs);
      options.app.quit();
    };
    target.on(signal, listener);
    return [signal, listener] as const;
  });
  return {
    received: () => first,
    dispose() {
      for (const [signal, listener] of listeners) target.removeListener(signal, listener);
    },
  };
}
