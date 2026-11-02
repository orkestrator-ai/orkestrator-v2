import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BACKEND_PROFILE_CHANGED_EVENT,
  parseBackendProfile,
  type BackendProfile,
} from "@orkestrator/protocol/backend-profile";
import {
  NODE_STATUS_CHANGED_EVENT,
  NODES_CHANGED_EVENT,
  type NodeListResult,
  type NodeStatus,
} from "@orkestrator/protocol/command-nodes";
import type { ConnectionList } from "@orkestrator/protocol/connections";
import { getNodeStatus, listNodes, nodeErrorText } from "@/lib/backend/command-nodes";
import { subscribeToConnections } from "@/lib/connections";
import { usePortalLayout } from "@/lib/portal/portal-layout";
import { portalInvoke, portalListen, workspaceTarget } from "@/lib/portal/portal-transport";
import { buildMachineList, type MachineEntry } from "./machine-list";

export type ConnectionsApi = NonNullable<NonNullable<Window["orkestrator"]>["connections"]>;

export function getConnectionsApi(): ConnectionsApi | null {
  return window.orkestrator?.connections ?? null;
}

/** The command node's address as a browser client sees it, when it is an ordinary origin. */
function browserAddress(): string | null {
  if (typeof window === "undefined") return null;
  const { protocol, host } = window.location;
  return protocol === "https:" || protocol === "http:" ? host : null;
}

/**
 * Everything the Machines page lists, kept current: the command node's
 * status and registry over the portal channel, its own profile, and (on the
 * desktop) this device's saved connections.
 */
export function useMachines() {
  const api = getConnectionsApi();
  const [connections, setConnections] = useState<ConnectionList | null>(null);
  const [connectionsError, setConnectionsError] = useState<string | null>(null);
  const [status, setStatus] = useState<NodeStatus | null>(null);
  const [nodes, setNodes] = useState<NodeListResult | null>(null);
  const [nodesError, setNodesError] = useState<string | null>(null);
  const [selfProfile, setSelfProfile] = useState<BackendProfile | null>(null);
  const [loaded, setLoaded] = useState(false);

  // State is set from the promise callbacks, never synchronously in an effect.
  const loadConnections = useCallback(
    (): Promise<void> =>
      api
        ? api.list().then(
            (list) => {
              setConnections(list);
              setConnectionsError(null);
            },
            (error: unknown) =>
              setConnectionsError(error instanceof Error ? error.message : String(error)),
          )
        : Promise.resolve(),
    [api],
  );

  const loadNodes = useCallback(
    (): Promise<void> =>
      Promise.allSettled([
        getNodeStatus(),
        listNodes(),
        portalInvoke<unknown>("get_backend_profile"),
      ]).then(([nextStatus, nextNodes, profile]) => {
        if (nextStatus.status === "fulfilled") setStatus(nextStatus.value);
        if (nextNodes.status === "fulfilled") setNodes(nextNodes.value);
        if (profile.status === "fulfilled") {
          try {
            setSelfProfile(parseBackendProfile(profile.value));
          } catch {
            // An older backend without a profile keeps the saved name.
          }
        }
        const failure =
          nextStatus.status === "rejected"
            ? nextStatus.reason
            : nextNodes.status === "rejected"
              ? nextNodes.reason
              : null;
        setNodesError(failure ? nodeErrorText(failure) : null);
      }),
    [],
  );

  const refresh = useCallback(
    (): Promise<void> => Promise.all([loadConnections(), loadNodes()]).then(() => setLoaded(true)),
    [loadConnections, loadNodes],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => subscribeToConnections(setConnections), []);

  useEffect(() => {
    const unlisten: Array<() => void> = [];
    let cancelled = false;
    const keep = (stop: () => void) => {
      if (cancelled) stop();
      else unlisten.push(stop);
    };
    for (const event of [NODES_CHANGED_EVENT, NODE_STATUS_CHANGED_EVENT]) {
      void portalListen(event, () => void loadNodes()).then(keep);
    }
    void portalListen<unknown>(BACKEND_PROFILE_CHANGED_EVENT, ({ payload }) => {
      try {
        const next = parseBackendProfile(payload);
        setSelfProfile((current) => (current && current.revision > next.revision ? current : next));
      } catch {
        // A malformed event changes nothing.
      }
    }).then(keep);
    return () => {
      cancelled = true;
      for (const stop of unlisten) stop();
    };
  }, [loadNodes]);

  const layout = usePortalLayout();
  const workspaceNodeId = workspaceTarget()?.nodeId ?? null;
  const entries = useMemo<MachineEntry[]>(
    () =>
      buildMachineList({
        status,
        nodes,
        connections,
        selfProfile,
        workspaceNodeId,
        selfAddress: api ? null : browserAddress(),
        machineOrder: layout.machineOrder,
      }),
    [api, connections, layout.machineOrder, nodes, selfProfile, status, workspaceNodeId],
  );

  return {
    api,
    entries,
    layout,
    connections,
    connectionsError,
    status,
    nodes,
    nodesError,
    selfProfile,
    loaded,
    refresh,
    reloadNodes: loadNodes,
  };
}
