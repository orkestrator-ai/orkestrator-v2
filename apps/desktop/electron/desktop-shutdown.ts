import {
  registerApplicationLoggingShutdown,
  type InstalledApplicationLogging,
} from "./application-logging.js";
import { BACKEND_EXIT_WAIT_MS, registerBackendShutdown } from "./backend-lifecycle.js";
import type { BackendProcess } from "./backend-process.js";
import { registerEssentialShutdown } from "./essential-logging.js";
import { installQuitSignalHandlers } from "./quit-signals.js";
import type { InstalledEssentialLog } from "@orkestrator/protocol/node/essential-log";

const ESSENTIAL_LOG_STOP_WAIT_MS = 2_000;

export function registerDesktopShutdown(options: {
  app: Parameters<typeof installQuitSignalHandlers>[0]["app"];
  backend: Pick<BackendProcess, "stop">;
  applicationLogging: Pick<InstalledApplicationLogging, "stop"> | null;
  essentialLog: Pick<InstalledEssentialLog, "stop" | "disableExitFlush"> | null;
  relaunchImage(image: string): void;
}) {
  const { app, backend, applicationLogging, essentialLog, relaunchImage } = options;
  const signalQuit = installQuitSignalHandlers({ app, normalBackendWaitMs: BACKEND_EXIT_WAIT_MS });
  // An overdue writer must not fall back to synchronous I/O on this exit.
  void signalQuit.holdsExpired.then(() => essentialLog?.disableExitFlush());
  const backendShutdown = registerBackendShutdown(app, backend, BACKEND_EXIT_WAIT_MS, signalQuit);

  const essentialShutdown =
    essentialLog &&
    registerEssentialShutdown({
      app,
      backendStopped: backendShutdown.stopped,
      essentialLog,
      timeoutMs: BACKEND_EXIT_WAIT_MS + ESSENTIAL_LOG_STOP_WAIT_MS,
      signalQuit,
      relaunchImage,
    });

  registerApplicationLoggingShutdown(
    app,
    applicationLogging,
    undefined,
    { settled: backendShutdown.stopped, timeoutMs: BACKEND_EXIT_WAIT_MS },
    signalQuit.holdsExpired,
  );
  return essentialShutdown;
}
