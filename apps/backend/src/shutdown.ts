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
