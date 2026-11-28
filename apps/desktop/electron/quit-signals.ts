import { createLogger } from "@orkestrator/protocol/logger";

const log = createLogger("desktop");

export const QUIT_SIGNALS = ["SIGTERM", "SIGHUP"] as const;
export type QuitSignal = (typeof QUIT_SIGNALS)[number];

// Omarchy gives the user session 5 s before SIGKILL. Reserve time after the
// backend drain for the essential marker, then leave room for Electron to exit.
export const SIGNAL_QUIT_BACKEND_WAIT_MS = 3_000;
const SIGNAL_QUIT_HOLDS_MS = 4_500;
const SIGNAL_QUIT_EXIT_MS = 4_750;

export interface SignalQuitDeadlines {
  readonly started: Promise<void>;
  readonly backendExpired: Promise<void>;
  readonly holdsExpired: Promise<void>;
}

type SignalProcess = Pick<NodeJS.Process, "on" | "removeListener">;

export function installQuitSignalHandlers(options: {
  app: Pick<Electron.App, "on" | "removeListener" | "quit" | "exit">;
  normalBackendWaitMs: number;
  process?: SignalProcess;
  now?: () => number;
  timing?: { backendMs: number; holdsMs: number; exitMs: number };
}): SignalQuitDeadlines & { dispose(): void } {
  const { app, normalBackendWaitMs, now = () => performance.now() } = options;
  const {
    backendMs = SIGNAL_QUIT_BACKEND_WAIT_MS,
    holdsMs = SIGNAL_QUIT_HOLDS_MS,
    exitMs = SIGNAL_QUIT_EXIT_MS,
  } = options.timing ?? {};
  const target = options.process ?? process;
  const started = Promise.withResolvers<void>();
  const backendExpired = Promise.withResolvers<void>();
  const holdsExpired = Promise.withResolvers<void>();
  const timers: ReturnType<typeof setTimeout>[] = [];
  let first: QuitSignal | undefined;
  let beforeQuitAt: number | undefined;
  const noteBeforeQuit = () => {
    beforeQuitAt ??= now();
  };
  const ignoreUnloadVeto = (_event: Electron.Event, contents: Electron.WebContents) => {
    contents.on("will-prevent-unload", (event) => {
      // Electron's preventDefault here ignores the page's beforeunload veto.
      if (first) event.preventDefault();
    });
  };
  const at = (deadline: number, run: () => void) => {
    const remaining = deadline - now();
    if (remaining <= 0) {
      run();
      return;
    }
    const timer = setTimeout(run, Math.ceil(remaining));
    timer.unref();
    timers.push(timer);
  };
  const clearTimers = () => {
    for (const timer of timers.splice(0)) clearTimeout(timer);
  };

  app.on("before-quit", noteBeforeQuit);
  app.on("web-contents-created", ignoreUnloadVeto);
  app.on("quit", clearTimers);
  const listeners = QUIT_SIGNALS.map((signal) => {
    const listener = () => {
      if (first) {
        log.info("quit.signal-repeated", { signal, first });
        return;
      }
      const receivedAt = now();
      first = signal;
      const backendDeadline = Math.min(
        receivedAt + backendMs,
        (beforeQuitAt ?? receivedAt) + normalBackendWaitMs,
      );
      log.info("quit.signal-received", {
        signal,
        backendWaitMs: Math.max(0, Math.ceil(backendDeadline - receivedAt)),
        quitAlreadyRequested: beforeQuitAt !== undefined,
      });
      at(backendDeadline, backendExpired.resolve);
      at(receivedAt + holdsMs, holdsExpired.resolve);
      // Also covers a window that never answers its close request.
      at(receivedAt + exitMs, () => app.exit(0));
      started.resolve();
      app.quit();
    };
    target.on(signal, listener);
    return [signal, listener] as const;
  });
  const rearmListeners = () => {
    // Electron installs native shutdown handlers in PostCreateMainMessageLoop.
    // Reopen Node's signal watchers after that setup so Node receives signals.
    for (const [signal, listener] of listeners) {
      target.removeListener(signal, listener);
      target.on(signal, listener);
    }
  };
  app.on("ready", rearmListeners);

  return {
    started: started.promise,
    backendExpired: backendExpired.promise,
    holdsExpired: holdsExpired.promise,
    dispose() {
      first = undefined;
      clearTimers();
      app.removeListener("before-quit", noteBeforeQuit);
      app.removeListener("web-contents-created", ignoreUnloadVeto);
      app.removeListener("quit", clearTimers);
      app.removeListener("ready", rearmListeners);
      for (const [signal, listener] of listeners) target.removeListener(signal, listener);
    },
  };
}
