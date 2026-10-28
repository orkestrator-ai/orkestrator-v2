export type BackendShutdownDependencies = {
  stopTailscaleServe?: () => Promise<void>;
  stopManagedWebClient?: () => Promise<void>;
  stopGateway: () => Promise<void>;
  stopBackend: () => Promise<void>;
  warn: (message: string) => void;
  /**
   * Records the shutdown. Without it a clean quit leaves no trace in the
   * desktop log and cannot be told apart from the backend being killed.
   */
  info?: (message: string) => void;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
      dependencies.info?.(`[Backend] Received ${signal}; shutting down`);
      if (dependencies.stopTailscaleServe) {
        await dependencies.stopTailscaleServe().catch((error: unknown) => {
          dependencies.warn(
            `[TailscaleServe] Failed to remove Serve configuration: ${errorMessage(error)}`,
          );
        });
      }
      if (dependencies.stopManagedWebClient) {
        await dependencies.stopManagedWebClient().catch((error: unknown) => {
          dependencies.warn(
            `[TailscaleServe] Failed to remove desktop web access: ${errorMessage(error)}`,
          );
        });
      }

      const fatalErrors: unknown[] = [];
      try {
        await dependencies.stopGateway();
      } catch (error) {
        fatalErrors.push(error);
        dependencies.warn(`[Backend] Failed to stop gateway: ${errorMessage(error)}`);
      }
      try {
        await dependencies.stopBackend();
      } catch (error) {
        fatalErrors.push(error);
        dependencies.warn(`[Backend] Failed to stop local servers: ${errorMessage(error)}`);
      }

      const code = fatalErrors.length > 0 ? 1 : signal === "SIGINT" ? 130 : 0;
      dependencies.info?.(`[Backend] Shutdown finished; exiting with ${code}`);
      dependencies.exit(code);
    })();
    return shutdownPromise;
  };
}
