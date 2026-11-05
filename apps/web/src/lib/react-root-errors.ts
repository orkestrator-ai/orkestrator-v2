import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import type { RootOptions } from "react-dom/client";
import { boundaryOf, recordRendererFailure } from "./renderer-error-ring";

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
    // Every boundary's catch passes through here, so the error ring needs no
    // call in each boundary: the boundary instance names itself.
    onCaughtError: (error, errorInfo) => {
      reportStartupError();
      recordRendererFailure(error, boundaryOf(errorInfo.errorBoundary), errorInfo.componentStack);
      logRootError("root.caught-error", error, errorInfo);
    },
    onUncaughtError: (error, errorInfo) => {
      reportStartupError();
      recordRendererFailure(error, "root", errorInfo.componentStack);
      logRootError("root.uncaught-error", error, errorInfo);
    },
    onRecoverableError: (error, errorInfo) => {
      recordRendererFailure(error, "recoverable", errorInfo.componentStack);
      logRootError("root.recoverable-error", error, errorInfo);
    },
  };
}
