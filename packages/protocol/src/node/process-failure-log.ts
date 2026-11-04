import { createLogger, formatLogError } from "../logger.js";

/**
 * The essential log's record of a failure that reached the top of a process. See
 * docs/architecture/logging.md, "The essential event log".
 */

const log = createLogger("process");

/** For `installFatalRejectionGuard`'s `onRejection`. A repeating fault is throttled. */
export function logUnhandledRejection(reason: unknown): void {
  log.throttled("error", "rejection.unhandled", {
    error: reason,
    fields: () => ({ error: formatLogError(reason, { message: false }) }),
  });
}

export interface UncaughtExceptionTarget {
  on(
    event: "uncaughtExceptionMonitor",
    listener: (error: unknown, origin: string) => void,
  ): unknown;
  off(
    event: "uncaughtExceptionMonitor",
    listener: (error: unknown, origin: string) => void,
  ): unknown;
}

/**
 * Writes one entry as an uncaught exception ends this process.
 *
 * A monitor, because under Bun 1.4.4 an `uncaughtException` listener that returns
 * keeps the process running, which turns a crash into a process in an unknown
 * state. A monitor runs first and changes nothing: Bun still prints its dump and
 * exits 1. A throw from one exits 7, so nothing may escape this listener. The
 * real-run test in `apps/backend/src/uncaught-exception.integration.test.ts` pins
 * all of that against the runtime.
 */
export function installUncaughtExceptionLog(
  target: UncaughtExceptionTarget = process as unknown as UncaughtExceptionTarget,
): () => void {
  const listener = (error: unknown, origin: string): void => {
    try {
      log.error("uncaught-exception", { origin, error: formatLogError(error, { message: false }) });
    } catch {
      // The process has to die the way it would have, not with exit 7.
    }
  };
  target.on("uncaughtExceptionMonitor", listener);
  return () => {
    target.off("uncaughtExceptionMonitor", listener);
  };
}
