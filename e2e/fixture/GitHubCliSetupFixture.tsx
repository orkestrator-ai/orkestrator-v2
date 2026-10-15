import { useState } from "react";
import { GitHubCliSetup } from "../../apps/web/src/components/github/GitHubCliSetup";

type State = {
  statusReady: boolean;
  pollFailed: boolean;
  pending: boolean;
  authenticated: boolean;
};
const storageKey = "github-cli-setup-fixture-v1";
const initial: State = {
  statusReady: false,
  pollFailed: false,
  pending: false,
  authenticated: false,
};
function read(): State {
  return JSON.parse(localStorage.getItem(storageKey) ?? JSON.stringify(initial));
}
function write(state: State) {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function installFixture() {
  window.orkestrator = {
    ...window.orkestrator!,
    invoke: async <T,>(command: string): Promise<T> => {
      const state = read();
      switch (command) {
        case "get_github_cli_status":
          if (!state.statusReady) {
            throw new Error("Status temporarily unavailable");
          }
          return {
            installed: true,
            authenticated: state.authenticated,
            canSignIn: true,
            reminderDismissed: false,
          } as T;
        case "start_github_cli_login":
          write({ ...state, pending: true });
          return {
            state: "pending",
            operationId: "fixture-login",
            userCode: "A1B2-C3D4",
            url: "https://github.com/login/device",
          } as T;
        case "get_github_cli_login":
          if (state.pending && !state.pollFailed) {
            write({ ...state, pollFailed: true });
            throw new Error("Poll temporarily unavailable");
          }
          return (
            state.pending
              ? {
                  state: "pending",
                  operationId: "fixture-login",
                  userCode: "A1B2-C3D4",
                  url: "https://github.com/login/device",
                }
              : { state: state.authenticated ? "succeeded" : "idle" }
          ) as T;
        case "cancel_github_cli_login":
          write({ ...state, pending: false });
          return { state: "idle" } as T;
        default:
          throw new Error(`Unexpected GitHub setup fixture command: ${command}`);
      }
    },
  };
  return true;
}

export function GitHubCliSetupFixture() {
  useState(installFixture);
  const [visible, setVisible] = useState(true);
  return (
    <main className="space-y-4 p-4">
      <button type="button" onClick={() => write({ ...read(), statusReady: true })}>
        Restore status service
      </button>
      <button type="button" onClick={() => setVisible(!visible)}>
        {visible ? "Hide setup" : "Show setup"}
      </button>
      <button
        type="button"
        onClick={() => write({ ...read(), pending: false, authenticated: true })}
      >
        Complete sign-in
      </button>
      {visible ? <GitHubCliSetup pollIntervalMs={500} /> : null}
    </main>
  );
}
