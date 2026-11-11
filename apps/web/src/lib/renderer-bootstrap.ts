import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { reportRendererDebugLogging, reportWebInspectable } from "./debug-log";
import { startDesktopRenderer } from "./desktop-startup";
import { emitDesktopStartupMarker } from "./desktop-startup-marker";
import { startRendererDiagnostics } from "./renderer-diagnostics";
import { recordRendererFailure } from "./renderer-error-ring";

const log = createLogger("web.window");

/** The file alone: a script URL's directories and query add nothing the stack lacks. */
function sourceFile(filename: string | undefined): string | undefined {
  return filename?.split(/[?#]/, 1)[0]?.split("/").pop() || undefined;
}

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
  startDiagnostics?: typeof startRendererDiagnostics;
  target?: RendererBootstrapTarget;
  startDesktop?: typeof startDesktopRenderer;
  loadRenderer?: () => Promise<RendererModule>;
  emitMarker?: typeof emitDesktopStartupMarker;
}

/** Install startup diagnostics before loading any module that can mount the application. */
export async function bootstrapRenderer({
  startDiagnostics = startRendererDiagnostics,
  target = window,
  startDesktop = startDesktopRenderer,
  loadRenderer = () => import("../renderer-entry"),
  emitMarker = emitDesktopStartupMarker,
}: RendererBootstrapOptions = {}): Promise<void> {
  // Preload IPC is available before the backend connection check. DevTools must
  // remain reachable when that check fails; uploads still wait for readiness.
  reportRendererDebugLogging((window.orkestrator ?? window.orkestratorDesktopHost?.api)?.window);
  // The iOS app's shell: Safari's Web Inspector, the same switch.
  reportWebInspectable();
  let startupPending = true;
  const reportStartupError = () => {
    if (startupPending) emitMarker("renderer-error");
  };

  // The error ring is separate from the startup markers: it never writes to the
  // console and never uses the `desktop.startup` area.
  target.addEventListener("error", (event) => {
    reportStartupError();
    recordRendererFailure(event.error ?? event.message, "window");
    log.error("error.unhandled", {
      error: formatLogError(event.error ?? event.message),
      file: sourceFile(event.filename),
      line: event.lineno,
      column: event.colno,
    });
  });
  target.addEventListener("unhandledrejection", (event) => {
    if (startupPending) emitMarker("unhandled-rejection");
    recordRendererFailure(event.reason, "rejection");
    log.error("rejection.unhandled", { error: formatLogError(event.reason) });
  });

  try {
    await startDesktop({
      start: async () => {
        startDiagnostics();
        try {
          const { startRenderer } = await loadRenderer();
          await startRenderer({ reportStartupError });
        } catch (error) {
          recordRendererFailure(error, "window");
          throw error;
        }
      },
    });
  } finally {
    startupPending = false;
  }
}
