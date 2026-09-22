import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./lib/native/web-gateway";
import { renderReactRoot } from "./lib/app-renderer";
import { startApp } from "./lib/app-startup";
import { desktopStartupMessage } from "@orkestrator/protocol/debug-logging";

const runtimeProfile = import.meta.env.VITE_ORKESTRATOR_PROFILE?.trim();
if (runtimeProfile) {
  document.body.dataset.orkestratorDevProfile = runtimeProfile;
  document.title = `Orkestrator AI — DEV [${runtimeProfile}]`;
}

function logReactRootError(
  label: string,
  error: unknown,
  errorInfo?: { componentStack?: string | null },
) {
  console.error(desktopStartupMessage("renderer-error"));
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

function renderApp(): void {
  renderReactRoot({
    document,
    createRoot: ReactDOM.createRoot,
    rootOptions: {
      onCaughtError: (error, errorInfo) => {
        logReactRootError("Caught error", error, errorInfo);
      },
      onUncaughtError: (error, errorInfo) => {
        logReactRootError("Uncaught error", error, errorInfo);
      },
      onRecoverableError: (error, errorInfo) => {
        logReactRootError("Recoverable error", error, errorInfo);
      },
    },
    children: (
      <React.StrictMode>
        <App />
      </React.StrictMode>
    ),
  });
}

export async function startRenderer(): Promise<void> {
  await startApp({ render: renderApp });
}
