import { useState } from "react";
import {
  nativeAgentCapabilities,
  type NativeAgentSessionStateUpdate,
  type NativeAgentViewIdentity,
  type NativeAgentPendingSignIn,
} from "@orkestrator/protocol/native-agent";
import { AgentNativeTab } from "../../apps/web/src/components/native-agent/AgentNativeTab";
import { useEnvironmentStore } from "../../apps/web/src/stores/environmentStore";

const identity: NativeAgentViewIdentity = {
  backendInstanceId: "held-send-fixture",
  environmentId: "held-environment",
  platform: "codex",
  logicalSessionKey: "env-held-environment:held-tab",
  providerSessionId: "held-session",
  sourceGeneration: "generation-1",
};

function installBackend() {
  let ready = sessionStorage.getItem("held-send-ready") === "true";
  let authenticationRequired = sessionStorage.getItem("held-send-auth-required") === "true";
  let pendingSignIn = JSON.parse(
    sessionStorage.getItem("held-sign-in") ?? "null",
  ) as NativeAgentPendingSignIn | null;
  let dispatchCount = Number(sessionStorage.getItem("held-send-count") ?? "0");
  const waiting = new Set<(value: NativeAgentSessionStateUpdate) => void>();
  const snapshot = (): NativeAgentSessionStateUpdate => ({
    viewVersion: 1,
    status: "snapshot",
    token: "state-1",
    value: {
      identity,
      connection: "connected",
      turn: { phase: "idle" },
      interactions: [],
      composerControls: [],
      capabilities: nativeAgentCapabilities("codex"),
      notices: [],
      ...(authenticationRequired
        ? { readiness: { state: "authentication-required", message: "Sign in to continue" } }
        : {}),
    },
  });
  useEnvironmentStore.setState({
    environments: [
      {
        id: identity.environmentId,
        projectId: "held-project",
        name: "Held send fixture",
        order: 0,
        setupPhase: "ready",
      } as never,
    ],
  });
  window.orkestrator = {
    ...window.orkestrator!,
    listen: () => () => {},
    invoke: async <T,>(command: string, args?: Record<string, unknown>) => {
      let result: unknown;
      switch (command) {
        case "get_native_agent_sync_capabilities":
          result = {
            projectionSyncVersions: [1],
            historyPagingVersions: [1],
            progressiveViewVersions: [1],
          };
          break;
        case "adopt_native_agent_session":
          result = {};
          break;
        case "get_native_agent_session_state_update":
          result = ready
            ? snapshot()
            : await new Promise<NativeAgentSessionStateUpdate>((resolve) => waiting.add(resolve));
          break;
        case "get_native_agent_transcript_update":
          result = {
            viewVersion: 1,
            status: "snapshot",
            token: "transcript-1",
            value: {
              identity,
              freshness: "empty",
              messages: [],
              historyEpoch: "epoch-1",
              historyComplete: true,
            },
          };
          break;
        case "get_native_agent_discovery_update":
          result = {
            viewVersion: 1,
            status: "snapshot",
            token: "discovery-1",
            value: { identity, sections: {} },
          };
          break;
        case "dispatch_native_agent_intent":
          dispatchCount += 1;
          sessionStorage.setItem("held-send-count", String(dispatchCount));
          result = { outcome: "accepted", requestId: args?.requestId };
          break;
        case "get_compose_draft":
          result = JSON.parse(sessionStorage.getItem(String(args?.draftKey)) ?? "null");
          break;
        case "save_compose_draft":
          result = { revision: 1, value: args?.value };
          sessionStorage.setItem(String(args?.draftKey), JSON.stringify(result));
          break;
        case "delete_compose_draft":
          sessionStorage.removeItem(String(args?.draftKey));
          break;
        case "get_native_agent_model_catalog":
        case "get_file_tree":
        case "get_local_file_tree":
          result = [];
          break;
        // The agent information panel names the session's account.
        case "get_native_agent_session_account":
          result = null;
          break;
        case "list_agent_accounts":
          result = { accounts: [], active: { claude: "default", codex: "default" } };
          break;
        case "get_native_agent_auth_status":
          sessionStorage.setItem(
            "held-auth-reads",
            String(Number(sessionStorage.getItem("held-auth-reads") ?? "0") + 1),
          );
          // A refused API key remains signed in while the replacement is pending.
          result = { state: "signed-in", signIn: { kind: "browser-url" }, pendingSignIn };
          break;
        case "begin_native_agent_sign_in":
          pendingSignIn = {
            url: "https://auth.example.test/device",
            code: "SAME-CODE",
            expiresAt: Date.now() + 15 * 60_000,
          };
          // Fixture-only persistence models the bridge outliving a renderer reload.
          sessionStorage.setItem("held-sign-in", JSON.stringify(pendingSignIn));
          sessionStorage.setItem(
            "held-sign-in-count",
            String(Number(sessionStorage.getItem("held-sign-in-count") ?? "0") + 1),
          );
          result = pendingSignIn;
          break;
        case "cancel_native_agent_sign_in":
          pendingSignIn = null;
          sessionStorage.removeItem("held-sign-in");
          sessionStorage.setItem("held-sign-in-cancelled", "true");
          result = { cancelled: true };
          break;
        case "open_in_browser":
          throw new Error("Fixture browser opening failed");
        default:
          throw new Error(`Unexpected held-send fixture command: ${command}`);
      }
      return result as T;
    },
  };
  return {
    release: (requireSignIn = false) => {
      ready = true;
      authenticationRequired = requireSignIn;
      sessionStorage.setItem("held-send-auth-required", String(requireSignIn));
      sessionStorage.setItem("held-send-ready", "true");
      for (const resolve of Array.from(waiting)) resolve(snapshot());
      waiting.clear();
    },
    completeLogin: () => {
      pendingSignIn = null;
      sessionStorage.removeItem("held-sign-in");
      ready = true;
      authenticationRequired = false;
      sessionStorage.setItem("held-send-auth-required", "false");
      sessionStorage.setItem("held-send-ready", "true");
      for (const resolve of Array.from(waiting)) resolve(snapshot());
      waiting.clear();
    },
    count: () => dispatchCount,
  };
}

let backend: ReturnType<typeof installBackend> | undefined;

export function NativeHeldSendFixture() {
  const [transport] = useState(() => (backend ??= installBackend()));
  const [away, setAway] = useState(false);
  const [count, setCount] = useState(transport.count());
  return (
    <main className="flex h-screen flex-col bg-background text-foreground">
      <nav className="flex flex-wrap gap-3 p-2">
        <button onClick={() => setAway(!away)}>
          {away ? "Return to conversation" : "Switch environment"}
        </button>
        <button onClick={() => transport.release()}>Release session state</button>
        <button onClick={() => transport.release(true)}>Require sign in</button>
        <button onClick={() => transport.completeLogin()}>Complete sign in</button>
        <button onClick={() => setCount(transport.count())}>Read dispatch count</button>
        <output aria-label="Dispatch count">{count}</output>
      </nav>
      <section className="min-h-0 flex-1">
        {away ? (
          <p>Another environment is active</p>
        ) : (
          <AgentNativeTab
            tabId="held-tab"
            data={{
              platform: "codex",
              environmentId: identity.environmentId,
              sessionId: identity.providerSessionId,
              isLocal: true,
            }}
            isActive
          />
        )}
      </section>
    </main>
  );
}
