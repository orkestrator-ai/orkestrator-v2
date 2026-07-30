import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./lib/native/web-gateway";
import { hydrateAgentModelCatalogCache } from "./lib/agent-model-catalog-cache";

function logReactRootError(
  label: string,
  error: unknown,
  errorInfo?: { componentStack?: string | null },
) {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  const componentStack = errorInfo?.componentStack ?? undefined;

  console.error(`[ReactRoot] ${label}`, {
    error,
    message,
    stack,
    componentStack,
  });
}

window.addEventListener("error", (event) => {
  console.error("[WindowError] Unhandled error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error,
    stack: event.error instanceof Error ? event.error.stack : undefined,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[WindowError] Unhandled promise rejection", {
    reason: event.reason,
    stack: event.reason instanceof Error ? event.reason.stack : undefined,
  });
});

async function startApp(): Promise<void> {
  let cacheTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      hydrateAgentModelCatalogCache(),
      new Promise<void>((resolve) => {
        // Do not leave a browser client on a blank page if its gateway is
        // unreachable. A late cache response still updates the stores.
        cacheTimeout = setTimeout(resolve, 2_000);
      }),
    ]);
  } catch (error) {
    // A missing/corrupt cache is non-fatal; the stores retain their bundled
    // fallbacks and the normal bridge discovery path will repair it later.
    console.warn("[App] Failed to restore the model catalogue cache:", error);
  } finally {
    if (cacheTimeout) clearTimeout(cacheTimeout);
  }

  ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
    onCaughtError: (error, errorInfo) => {
      logReactRootError("Caught error", error, errorInfo);
    },
    onUncaughtError: (error, errorInfo) => {
      logReactRootError("Uncaught error", error, errorInfo);
    },
    onRecoverableError: (error, errorInfo) => {
      logReactRootError("Recoverable error", error, errorInfo);
    },
  }).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

void startApp();
