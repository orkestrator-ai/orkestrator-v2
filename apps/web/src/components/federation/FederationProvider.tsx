import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import {
  FALLBACK_MACHINE_COLOR,
  defaultMachineColor,
  type BackendProfile,
} from "@orkestrator/protocol/backend-profile";
import type { BackendId } from "@orkestrator/protocol/federation";
import {
  getWorkspaceProfile,
  listenWorkspaceProfile,
  portalStore,
  type PortalState,
  type PortalStore,
} from "@/lib/portal/portal-store";
import { workspaceTarget } from "@/lib/portal/portal-transport";

/**
 * The machine the window's workspace is on: the command node the client
 * connected to, or the node whose environment the user opened.
 */
export interface BoundMachine {
  /** Same as `backendId`: views key every machine by its node identity. */
  connectionId: string;
  backendId: BackendId;
  name: string;
  colorToken: string;
}

export interface FederationContextValue {
  /** The command node's view of its other nodes. */
  portal: PortalStore;
  portalState: PortalState;
  bound: BoundMachine | null;
  /** This node commands at least one other node, so multi-machine views are shown. */
  enabled: boolean;
  /** This client can show other machines at all. */
  supported: boolean;
  kind: "desktop" | "browser" | "none";
  /** Name and colour of this realm's own machine, for its rows' dots. */
  boundMachine: { name: string; colorToken: string } | null;
}

const FederationContext = createContext<FederationContextValue | null>(null);

function clientKind(): FederationContextValue["kind"] {
  if (typeof window === "undefined") return "none";
  return window.orkestrator?.isolatedViewState ? "desktop" : "browser";
}

/**
 * Multi-machine views of the backend this client is connected to. That
 * backend is the command node: it keeps the registry, the connections and
 * the live read model. This provider only reads it, so web, iOS and the
 * desktop all see the same portal served by the same node.
 */
export function FederationProvider({ children }: { children: ReactNode }) {
  const [kind] = useState(clientKind);
  const portalState = useStore(portalStore.store);
  const [profile, setProfile] = useState<BackendProfile | null>(null);

  useEffect(() => {
    if (kind === "none") return;
    return portalStore.start();
  }, [kind]);

  useEffect(() => {
    if (kind === "none") return;
    let active = true;
    let stop: (() => void) | null = null;
    void getWorkspaceProfile()
      .then((value) => {
        if (active) setProfile(value);
      })
      .catch(() => undefined);
    void listenWorkspaceProfile((next) => {
      setProfile((current) => (current && current.revision > next.revision ? current : next));
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    });
    return () => {
      active = false;
      stop?.();
    };
  }, [kind]);

  const value = useMemo<FederationContextValue>(() => {
    const boundId = (workspaceTarget()?.nodeId as BackendId | undefined) ?? portalState.selfId;
    const bound: BoundMachine | null = boundId
      ? {
          connectionId: boundId,
          backendId: boundId,
          name: profile?.displayName ?? "This machine",
          colorToken: profile?.colorToken ?? defaultMachineColor(boundId),
        }
      : null;
    return {
      portal: portalStore,
      portalState,
      bound,
      supported: kind !== "none",
      enabled: kind !== "none" && (portalState.nodes.length > 0 || workspaceTarget() !== null),
      kind,
      boundMachine: bound
        ? { name: bound.name, colorToken: bound.colorToken ?? FALLBACK_MACHINE_COLOR }
        : null,
    };
  }, [kind, portalState, profile]);

  return <FederationContext.Provider value={value}>{children}</FederationContext.Provider>;
}

const INACTIVE: FederationContextValue = {
  portal: portalStore,
  portalState: portalStore.getState(),
  bound: null,
  enabled: false,
  supported: false,
  kind: "none",
  boundMachine: null,
};

export function useFederation(): FederationContextValue {
  return useContext(FederationContext) ?? INACTIVE;
}
