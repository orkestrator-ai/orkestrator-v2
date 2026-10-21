import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  LOCAL_CONNECTION_ID,
  connectionDisplayName,
  type ConnectionList,
  type ConnectionSummary,
} from "@orkestrator/protocol/connections";
import { subscribeToConnections } from "@/lib/connections";
import { FALLBACK_MACHINE_COLOR, defaultMachineColor } from "@orkestrator/protocol/backend-profile";
import { createDesktopBackendClient, desktopBackendsApi } from "@/lib/federation/backend-client";
import { BackendClientRegistry } from "@/lib/federation/registry";
import type { SummaryPersistence } from "@/lib/federation/backend-runtime";
import { isMachinePanelRealm } from "@/lib/federation/panel-realm";
import {
  browserFederationList,
  createBrowserMachineClient,
  subscribeToBrowserMachines,
} from "@/lib/federation/browser-machines";

export interface FederationContextValue {
  registry: BackendClientRegistry;
  list: ConnectionList | null;
  /** The machine this window is bound to (its own workspace realm). */
  bound: ConnectionSummary | null;
  /** Multi-machine views are on and this client can observe other machines. */
  enabled: boolean;
  /** This client can observe other machines at all (desktop or hosted browser). */
  supported: boolean;
  kind: "desktop" | "browser" | "none";
  /** Name and colour of this window's own machine, for its rows' dots. */
  boundMachine: { name: string; colorToken: string } | null;
}

const FederationContext = createContext<FederationContextValue | null>(null);

const SUMMARY_KEY_PREFIX = "federation-summary:v1:";

/** Last-known machine summaries in this client's storage (names and states only). */
function localSummaryPersistence(): SummaryPersistence | null {
  if (typeof window === "undefined") return null;
  const key = (backendId: string) => `${SUMMARY_KEY_PREFIX}${backendId}`;
  return {
    load: (backendId) => {
      const text = window.localStorage.getItem(key(backendId));
      return text ? (JSON.parse(text) as unknown) : null;
    },
    save: (backendId, value) => window.localStorage.setItem(key(backendId), JSON.stringify(value)),
    remove: (backendId) => window.localStorage.removeItem(key(backendId)),
  };
}

function clientKind(): FederationContextValue["kind"] {
  if (typeof window === "undefined" || isMachinePanelRealm()) return "none";
  if (desktopBackendsApi()) return "desktop";
  // A hosted browser page served by a backend can add other machines
  // directly over HTTPS; a native mobile shell keeps one machine per view.
  if (
    window.orkestratorGateway?.enabled &&
    !window.__orkestratorClientPlatform?.endsWith("wkwebview")
  ) {
    return "browser";
  }
  return "none";
}

/**
 * Owns the renderer's machine runtimes. It lives above any one workspace:
 * runtimes are created from the connection layer's list and disposed when
 * a machine is forgotten, never when a component unmounts.
 */
export function FederationProvider({ children }: { children: ReactNode }) {
  const [kind] = useState(clientKind);
  const registry = useMemo(
    () =>
      new BackendClientRegistry((connection) => {
        if (kind === "desktop") return createDesktopBackendClient(connection.id);
        if (kind === "browser") return createBrowserMachineClient(connection.id);
        return null;
      }, localSummaryPersistence()),
    [kind],
  );
  const [list, setList] = useState<ConnectionList | null>(null);

  useEffect(() => {
    if (kind === "none") return;
    let active = true;
    const apply = (next: ConnectionList) => {
      if (!active) return;
      setList(next);
      registry.sync(next, { enabled: next.features?.federation !== false });
    };
    if (kind === "desktop") {
      const api = window.orkestrator?.connections;
      void api
        ?.list()
        .then(apply)
        .catch(() => undefined);
      const unsubscribe = subscribeToConnections(apply);
      return () => {
        active = false;
        unsubscribe();
        registry.dispose();
      };
    }
    apply(browserFederationList());
    const unsubscribe = subscribeToBrowserMachines(() => apply(browserFederationList()));
    return () => {
      active = false;
      unsubscribe();
      registry.dispose();
    };
  }, [kind, registry]);

  const value = useMemo<FederationContextValue>(() => {
    const bound =
      list?.connections.find((connection) => connection.id === list.activeConnectionId) ?? null;
    const others =
      list?.connections.filter((connection) => connection.id !== list.activeConnectionId) ?? [];
    return {
      registry,
      list,
      bound,
      supported: kind !== "none",
      enabled: kind !== "none" && list?.features?.federation !== false && others.length > 0,
      kind,
      boundMachine: bound
        ? {
            name: machineDisplayName(bound),
            colorToken:
              bound.profile?.colorToken ??
              (bound.backendId && bound.identity === "verified"
                ? defaultMachineColor(bound.backendId)
                : FALLBACK_MACHINE_COLOR),
          }
        : null,
    };
  }, [kind, list, registry]);

  return <FederationContext.Provider value={value}>{children}</FederationContext.Provider>;
}

const INACTIVE_REGISTRY = new BackendClientRegistry(() => null);

const INACTIVE: FederationContextValue = {
  registry: INACTIVE_REGISTRY,
  list: null,
  bound: null,
  enabled: false,
  supported: false,
  kind: "none",
  boundMachine: null,
};

export function useFederation(): FederationContextValue {
  return useContext(FederationContext) ?? INACTIVE;
}

/** Display name of a machine: device alias, then canonical profile, then host. */
export function machineDisplayName(connection: ConnectionSummary | null | undefined): string {
  if (!connection) return "This machine";
  if (connection.nickname) return connection.nickname;
  if (connection.profile?.displayName) return connection.profile.displayName;
  if (connection.id === LOCAL_CONNECTION_ID) return "This computer";
  return connectionDisplayName(connection);
}
