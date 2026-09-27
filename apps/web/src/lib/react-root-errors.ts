import type { RootOptions } from "react-dom/client";

interface ReactRootErrorOptions {
  reportStartupError?: () => void;
  logError?: (...values: unknown[]) => void;
}

/** Keep rich renderer-console errors while reserving startup markers for fatal root failures. */
export function createReactRootErrorOptions({
  reportStartupError = () => undefined,
  logError = (...values) => console.error(...values),
}: ReactRootErrorOptions = {}): RootOptions {
  const log = (label: string, error: unknown, errorInfo?: { componentStack?: string | null }) => {
    logError(`[ReactRoot] ${label}`, {
      error,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      componentStack: errorInfo?.componentStack ?? undefined,
    });
  };

  return {
    onCaughtError: (error, errorInfo) => {
      reportStartupError();
      log("Caught error", error, errorInfo);
    },
    onUncaughtError: (error, errorInfo) => {
      reportStartupError();
      log("Uncaught error", error, errorInfo);
    },
    onRecoverableError: (error, errorInfo) => {
      log("Recoverable error", error, errorInfo);
    },
  };
}
