export type BackendShutdownDependencies = {
  stopTailscaleServe?: () => Promise<void>;
  stopManagedWebClient?: () => Promise<void>;
  stopGateway: () => Promise<void>;
  stopBackend: () => Promise<void>;
  warn: (message: string) => void;
  exit: (code: number) => void;
};

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

      dependencies.exit(fatalErrors.length > 0 ? 1 : signal === "SIGINT" ? 130 : 0);
    })();
    return shutdownPromise;
  };
}
