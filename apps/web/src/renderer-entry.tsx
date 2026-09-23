import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./lib/native/web-gateway";
import { renderReactRoot } from "./lib/app-renderer";
import { startApp } from "./lib/app-startup";
import { createReactRootErrorOptions } from "./lib/react-root-errors";

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

export async function startRenderer({
  reportStartupError,
}: { reportStartupError?: () => void } = {}): Promise<void> {
  await startApp({ render: () => renderApp(reportStartupError) });
}
