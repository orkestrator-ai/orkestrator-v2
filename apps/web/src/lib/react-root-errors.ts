import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { RootOptions } from "react-dom/client";

const log = createLogger("web.react");

type RootErrorEvent = "root.caught-error" | "root.uncaught-error" | "root.recoverable-error";

interface ReactRootErrorOptions {
  reportStartupError?: () => void;
}

function logRootError(
  event: RootErrorEvent,
  error: unknown,
  errorInfo?: { componentStack?: string | null },
): void {
  log.error(event, {
    error: formatLogError(error),
    componentStack: errorInfo?.componentStack ?? undefined,
  });
}

/** Keep renderer-console errors while reserving startup markers for fatal root failures. */
export function createReactRootErrorOptions({
  reportStartupError = () => undefined,
}: ReactRootErrorOptions = {}): RootOptions {
  return {
    onCaughtError: (error, errorInfo) => {
      reportStartupError();
      logRootError("root.caught-error", error, errorInfo);
    },
    onUncaughtError: (error, errorInfo) => {
      reportStartupError();
      logRootError("root.uncaught-error", error, errorInfo);
    },
    onRecoverableError: (error, errorInfo) => {
      logRootError("root.recoverable-error", error, errorInfo);
    },
  };
}
