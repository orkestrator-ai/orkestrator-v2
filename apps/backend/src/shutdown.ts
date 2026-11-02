import { createLogger, formatLogError } from "@orkestrator/protocol/logger";

const log = createLogger("backend");

export type BackendShutdownDependencies = {
  stopTailscaleServe?: () => Promise<void>;
  stopManagedWebClient?: () => Promise<void>;
  stopGateway: () => Promise<void>;
  stopBackend: () => Promise<void>;
  exit: (code: number) => void;
};

/** Stops file logging before flushing the console, preserving the requested exit code. */
export function createBackendExitHandler(dependencies: {
  stopLogging: () => Promise<void>;
  flushConsole: (timeoutMs: number) => Promise<void>;
  exit: (code: number) => void;
}): (code: number) => Promise<void> {
  return async (code) => {
    try {
      await dependencies.stopLogging();
    } finally {
      try {
        await dependencies.flushConsole(2_000);
      } finally {
        dependencies.exit(code);
      }
    }
  };
}

/**
 * Creates an idempotent signal handler. Optional public-access cleanup is
 * best-effort, while gateway/backend failures produce a non-zero exit after all
 * cleanup paths have still been attempted.
 */
export function createBackendShutdownHandler(
  dependencies: BackendShutdownDependencies,
): (signal: NodeJS.Signals) => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;

  return (signal) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      // Without this a clean quit cannot be told apart from the backend being killed.
      log.info("shutdown.signal-received", { signal });
      if (dependencies.stopTailscaleServe) {
        await dependencies.stopTailscaleServe().catch((error: unknown) => {
          log.warn("shutdown.step-failed", {
            step: "tailscale-serve",
            error: formatLogError(error),
          });
        });
      }
      if (dependencies.stopManagedWebClient) {
        await dependencies.stopManagedWebClient().catch((error: unknown) => {
          log.warn("shutdown.step-failed", {
            step: "managed-web-client",
            error: formatLogError(error),
          });
        });
      }

      const fatalErrors: unknown[] = [];
      try {
        await dependencies.stopGateway();
      } catch (error) {
        fatalErrors.push(error);
        log.warn("shutdown.step-failed", { step: "gateway", error: formatLogError(error) });
      }
      try {
        await dependencies.stopBackend();
      } catch (error) {
        fatalErrors.push(error);
        log.warn("shutdown.step-failed", { step: "local-servers", error: formatLogError(error) });
      }

      const code = fatalErrors.length > 0 ? 1 : signal === "SIGINT" ? 130 : 0;
      log.info("shutdown.finished", { code });
      dependencies.exit(code);
    })();
    return shutdownPromise;
  };
}
