import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import "./lib/native/web-gateway";

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
