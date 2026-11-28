import { registerWillQuitHold } from "./application-logging.js";
import type { BackendHttpClient, BackendProcess } from "./backend-process.js";
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
 * How long a quit waits for the backend's drain, measured from the moment the
 * quit began. A termination signal can shorten it while the quit is under way
 * (`quit-signals.ts`): the system stopping a session kills whatever is still
 * running a few seconds later, and the quit has to write `essential.stopped`
 * before that.
 */
export interface BackendQuitWait {
  /** Starts the clock; later calls keep the first start. */
  begin(): void;
  /**
   * Lowers the wait so it ends no later than `ms` from now. Never lengthens
   * it. Before `begin`, the lowered allowance applies from the start.
   */
  cap(ms: number): void;
  /** The wait now in force, in milliseconds from the start. */
  allowanceMs(): number;
  /** Resolves once the wait has run out. Only `begin` starts the clock. */
  readonly expired: Promise<void>;
}

export function createBackendQuitWait(
  defaultMs = BACKEND_EXIT_WAIT_MS,
  now: () => number = Date.now,
): BackendQuitWait {
  let allowance = defaultMs;
  let startedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const expired = Promise.withResolvers<void>();
  const arm = () => {
    if (startedAt === null || done) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(
      () => {
        done = true;
        expired.resolve();
      },
      Math.max(0, startedAt + allowance - now()),
    );
    timer.unref?.();
  };
  return {
    begin() {
      if (startedAt !== null) return;
      startedAt = now();
      arm();
    },
    cap(ms) {
      const fromStart = startedAt === null ? ms : now() - startedAt + ms;
      if (fromStart >= allowance) return;
      allowance = Math.max(0, fromStart);
      arm();
    },
    allowanceMs: () => allowance,
    expired: expired.promise,
  };
}

/**
 * Stops the backend when Electron begins quitting and holds the quit until it
 * has exited. The packaged backend runs from inside the app bundle, and an
 * update swaps that bundle as soon as this process exits; the relaunched app
 * would also start a second backend on the same data directory while the first
 * was still draining.
 *
 * `stopped()` settles when the backend has exited, or rejects when `wait` runs
 * out first, so every hold that waits on the drain (the log flushes, the
 * essential log's stop marker) is released by the same deadline, and a quit a
 * termination signal shortened still writes its marker. The hold's own
 * `timeoutMs` stays as the backstop.
 */
export function registerBackendShutdown(
  app: Pick<Electron.App, "on" | "quit">,
  backendProcess: Pick<BackendProcess, "stop">,
  timeoutMs = BACKEND_EXIT_WAIT_MS,
  wait: BackendQuitWait = createBackendQuitWait(timeoutMs),
): { stopped(): Promise<void> } {
  let stopped: Promise<void> | null = null;
  app.on("before-quit", () => {
    if (stopped) return;
    log.info("quit.stopping-backend");
    wait.begin();
    stopped = Promise.race([
      backendProcess.stop(),
      wait.expired.then(() => {
        throw new Error(`The backend did not exit within ${wait.allowanceMs()} ms of the quit`);
      }),
    ]);
    // Each reader handles the outcome; this keeps an unread one from being fatal.
    stopped.catch(() => undefined);
  });
  registerWillQuitHold(app, () => stopped ?? Promise.resolve(), timeoutMs);
  return { stopped: () => stopped ?? Promise.resolve() };
}
