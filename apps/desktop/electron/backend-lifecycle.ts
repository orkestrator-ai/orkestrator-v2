import { registerWillQuitHold } from "./application-logging.js";
import type { BackendHttpClient, BackendProcess } from "./backend-process.js";
import { createLogger } from "@orkestrator/protocol/logger";
import type { InstalledEssentialLog } from "@orkestrator/protocol/node/essential-log";

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
 * Stops the backend when Electron begins quitting and holds the quit until it
 * has exited. The packaged backend runs from inside the app bundle, and an
 * update swaps that bundle as soon as this process exits; the relaunched app
 * would also start a second backend on the same data directory while the first
 * was still draining.
 */
export function registerBackendShutdown(
  app: Pick<Electron.App, "on" | "quit">,
  backendProcess: Pick<BackendProcess, "stop">,
  timeoutMs = BACKEND_EXIT_WAIT_MS,
): { stopped(): Promise<void> } {
  let stopped: Promise<void> | null = null;
  app.on("before-quit", () => {
    if (!stopped) {
      log.info("quit.stopping-backend");
      stopped = backendProcess.stop();
    }
  });
  registerWillQuitHold(app, () => stopped ?? Promise.resolve(), timeoutMs);
  return { stopped: () => stopped ?? Promise.resolve() };
}

/** Longest an update waits for the essential log's `essential.stopped` to reach disk. */
export const ESSENTIAL_LOG_HANDOVER_WAIT_MS = 2_000;

/**
 * AppImageUpdater spawns the replacement before app.quit: drain the backend,
 * hand over the essential log, then unlock, all before allowing that spawn.
 *
 * The single-instance lock is what makes this process the essential log's
 * writer (`claimDesktopLogging`). The replacement writes its own
 * `essential.started` as soon as it wins the lock, so this process must have
 * written `essential.stopped` by then: otherwise the file reads as a desktop
 * that died (`logging:writer-died:desktop`) on every update. Entries this
 * process logs after the handover are not written; its backend has already
 * exited, so they are only the end of its own quit.
 */
export async function prepareAppImageInstall(
  app: Pick<Electron.App, "releaseSingleInstanceLock">,
  backend: Pick<BackendProcess, "stop">,
  essentialLog?: Pick<InstalledEssentialLog, "stop"> | null,
  handoverWaitMs = ESSENTIAL_LOG_HANDOVER_WAIT_MS,
): Promise<void> {
  await backend.stop();
  if (essentialLog) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      essentialLog.stop().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, handoverWaitMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  app.releaseSingleInstanceLock();
}
