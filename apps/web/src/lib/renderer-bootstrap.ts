import { desktopStartupMessage } from "@orkestrator/protocol/debug-logging";
import { startDesktopRenderer } from "./desktop-startup";

interface RendererModule {
  startRenderer(options?: { reportStartupError?: () => void }): Promise<void>;
}

interface RendererBootstrapTarget {
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  addEventListener(
    type: "unhandledrejection",
    listener: (event: PromiseRejectionEvent) => void,
  ): void;
}

interface RendererBootstrapOptions {
  target?: RendererBootstrapTarget;
  startDesktop?: typeof startDesktopRenderer;
  loadRenderer?: () => Promise<RendererModule>;
  logError?: (...values: unknown[]) => void;
}

/** Install startup diagnostics before loading any module that can mount the application. */
export async function bootstrapRenderer({
  target = window,
  startDesktop = startDesktopRenderer,
  loadRenderer = () => import("../renderer-entry"),
  logError = (...values) => console.error(...values),
}: RendererBootstrapOptions = {}): Promise<void> {
  let startupPending = true;
  const reportStartupError = () => {
    if (startupPending) logError(desktopStartupMessage("renderer-error"));
  };

  target.addEventListener("error", (event) => {
    reportStartupError();
    logError("[WindowError] Unhandled error", {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });
  target.addEventListener("unhandledrejection", (event) => {
    if (startupPending) logError(desktopStartupMessage("unhandled-rejection"));
    logError("[WindowError] Unhandled promise rejection", {
      reason: event.reason,
      stack: event.reason instanceof Error ? event.reason.stack : undefined,
    });
  });

  try {
    await startDesktop({
      start: async () => {
        const { startRenderer } = await loadRenderer();
        await startRenderer({ reportStartupError });
      },
    });
  } finally {
    startupPending = false;
  }
}
