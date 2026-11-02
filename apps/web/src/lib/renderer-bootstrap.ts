import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { startDesktopRenderer } from "./desktop-startup";
import { emitDesktopStartupMarker } from "./desktop-startup-marker";

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
  target?: RendererBootstrapTarget;
  startDesktop?: typeof startDesktopRenderer;
  loadRenderer?: () => Promise<RendererModule>;
  emitMarker?: typeof emitDesktopStartupMarker;
}

/** Install startup diagnostics before loading any module that can mount the application. */
export async function bootstrapRenderer({
  target = window,
  startDesktop = startDesktopRenderer,
  loadRenderer = () => import("../renderer-entry"),
  emitMarker = emitDesktopStartupMarker,
}: RendererBootstrapOptions = {}): Promise<void> {
  let startupPending = true;
  const reportStartupError = () => {
    if (startupPending) emitMarker("renderer-error");
  };

  target.addEventListener("error", (event) => {
    reportStartupError();
    log.error("error.unhandled", {
      error: formatLogError(event.error ?? event.message),
      file: sourceFile(event.filename),
      line: event.lineno,
      column: event.colno,
    });
  });
  target.addEventListener("unhandledrejection", (event) => {
    if (startupPending) emitMarker("unhandled-rejection");
    log.error("rejection.unhandled", { error: formatLogError(event.reason) });
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
