import { registerWillQuitHold } from "./application-logging.js";
import type { BackendHttpClient, BackendProcess } from "./backend-process.js";
import type { SignalQuitDeadlines } from "./quit-signals.js";
import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("desktop");

type WebClientBackend = Pick<
  BackendHttpClient,
  | "getWebClientStatus"
  | "setWebClientEnabled"
  | "resetWebClientServe"
  | "getTokenSettings"
  | "setToken"
>;

export function createBackendWebClientControls(getBackend: () => WebClientBackend | null) {
  const requireBackend = (): WebClientBackend => {
    const backend = getBackend();
    if (!backend) throw new Error("Backend is not initialized");
    return backend;
  };

  return {
    getWebClientStatus: () => requireBackend().getWebClientStatus(),
    setWebClientEnabled: (enabled: boolean) => requireBackend().setWebClientEnabled(enabled),
    resetWebClientServe: () => requireBackend().resetWebClientServe(),
    getGatewayTokenSettings: () => requireBackend().getTokenSettings(),
    setGatewayToken: (token: string) => requireBackend().setToken(token),
  };
}

/**
 * Longest the quit waits for the backend's drain. Its own steps are bounded
 * (environment lifecycle 10 s, local server grace 8 s), so this only cuts off
 * a backend that is stuck.
 */
export const BACKEND_EXIT_WAIT_MS = 20_000;

/**
 * The backend hold releases at its normal timeout. Other ordinary holds can
 * still observe a later close, including the AppImage relaunch confirmation.
 * During a signal quit they share the earlier deadline for waiting on the drain.
 */
export function registerBackendShutdown(
  app: Pick<Electron.App, "on" | "quit">,
  backendProcess: Pick<BackendProcess, "stop">,
  timeoutMs = BACKEND_EXIT_WAIT_MS,
  signalQuit?: SignalQuitDeadlines,
): { stopped(): Promise<void> } {
  const closed = Promise.withResolvers<void>();
  const stopped = signalQuit
    ? Promise.race([
        closed.promise,
        signalQuit.backendExpired.then(() => {
          throw new Error("The backend did not exit before the termination signal deadline");
        }),
      ])
    : closed.promise;
  // Each reader handles the outcome; this keeps an unread one from being fatal.
  stopped.catch(() => undefined);
  let stopRequested = false;
  app.on("before-quit", () => {
    if (stopRequested) return;
    stopRequested = true;
    log.info("quit.stopping-backend");
    try {
      closed.resolve(backendProcess.stop());
    } catch (error) {
      closed.reject(error);
    }
  });
  registerWillQuitHold(app, () => stopped, timeoutMs, signalQuit?.holdsExpired);
  return { stopped: () => stopped };
}
