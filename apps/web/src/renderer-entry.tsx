import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/native/web-gateway";
import App from "./App";
import { renderReactRoot } from "./lib/app-renderer";
import { startApp } from "./lib/app-startup";
import { createReactRootErrorOptions } from "./lib/react-root-errors";
import { reportRendererDebugLogging } from "./lib/debug-log";
import { invoke } from "./lib/native/backend";
import { RECORD_RENDERER_ERRORS_COMMAND } from "@orkestrator/protocol/renderer-errors";
import { rendererErrorRing, rendererErrorRoute } from "./lib/renderer-error-ring";
import { startRendererErrorUpload } from "./lib/renderer-error-upload";

const runtimeProfile = import.meta.env.VITE_ORKESTRATOR_PROFILE?.trim();
if (runtimeProfile) {
  document.body.dataset.orkestratorDevProfile = runtimeProfile;
  document.title = `Orkestrator AI — DEV [${runtimeProfile}]`;
}

function renderApp(reportStartupError?: () => void): void {
  renderReactRoot({
    document,
    createRoot: ReactDOM.createRoot,
    rootOptions: createReactRootErrorOptions({ reportStartupError }),
    children: (
      <React.StrictMode>
        <App />
      </React.StrictMode>
    ),
  });
}

/**
 * A desktop window's own renderer sends its error ring to the backend it drives.
 * A workspace realm and a browser tab keep theirs in memory: whose log they
 * belong in is an open question (docs/todo, 6300).
 */
function startRendererDiagnostics(): void {
  reportRendererDebugLogging();
  if (window.orkestrator && rendererErrorRoute() === "window") {
    startRendererErrorUpload({
      ring: rendererErrorRing,
      send: (entries) => invoke(RECORD_RENDERER_ERRORS_COMMAND, { entries }),
    });
  }
}

export async function startRenderer({
  reportStartupError,
}: { reportStartupError?: () => void } = {}): Promise<void> {
  startRendererDiagnostics();
  await startApp({ render: () => renderApp(reportStartupError) });
}
