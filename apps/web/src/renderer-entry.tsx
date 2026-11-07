import React from "react";
import ReactDOM from "react-dom/client";
import "./lib/native/web-gateway";
import App from "./App";
import { renderReactRoot } from "./lib/app-renderer";
import { startApp } from "./lib/app-startup";
import { primeCommandScopeSnapshot } from "./lib/node-snapshots";
import { createReactRootErrorOptions } from "./lib/react-root-errors";
const runtimeProfile = import.meta.env.VITE_ORKESTRATOR_PROFILE?.trim();
if (runtimeProfile) {
  document.body.dataset.orkestratorDevProfile = runtimeProfile;
  document.title = `Orkestrator AI — DEV [${runtimeProfile}]`;
}
// Plan item 2013's scope proof, for agent-test (`dev:test`) dev renderers only;
// a production build drops this branch and its chunk.
if (import.meta.env.DEV && import.meta.env.VITE_ORKESTRATOR_PROFILE_FLAVOR === "agent-test") {
  void import("./lib/node-scope/scope-proof-harness").then(({ installScopeProofHarness }) =>
    installScopeProofHarness(),
  );
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
  // Plan item 4003: the command node's snapshot is read while startup waits
  // for the catalogues, so `App` can paint from it before the first read.
  primeCommandScopeSnapshot();
  await startApp({ render: () => renderApp(reportStartupError) });
}
