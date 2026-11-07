import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";

import {
  ENVIRONMENT_ATTENTION_EVENT,
  isEnvironmentAttentionEvent,
  type EnvironmentAttentionEvent,
} from "@orkestrator/protocol/environment-attention";
import type { BackendId } from "@orkestrator/protocol/federation";

import { BoundedKeySet } from "@/lib/bounded-hydration";
import { subscribeNodeEvents } from "@/lib/federation/node-events";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { isWorkspaceRealm } from "@/lib/federation/workspace-realm";
import { portalStore } from "@/lib/portal/portal-store";
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";

/** `(nodeId, attentionId)` pairs remembered so a re-delivered event never alerts twice. */
export const REMOTE_ATTENTION_DEDUPE_LIMIT = 256;

const SEPARATOR = "\u0001";

/** Other nodes the window has no open realm for, sorted and joined. */
function silentNodesKey(nodeIds: readonly string[], selfId: string | null, realms: string): string {
  const open = new Set(realms ? realms.split(SEPARATOR) : []);
  return Array.from(new Set(nodeIds))
    .filter((nodeId) => nodeId !== selfId && !open.has(nodeId))
    .sort()
    .join(SEPARATOR);
}

/**
 * `environment-attention` from every other node this window has no open realm
 * for, through `subscribeNodeEvents`. A realm is its node's own renderer and
 * alerts for it, so a node is dropped here while its realm is open and picked
 * up again when it closes; a realm renderer itself subscribes to nothing.
 *
 * Each `(nodeId, attentionId)` reaches `onAttention` once, across
 * resubscriptions. A resync reads nothing: attention missed while the link was
 * down is not replayed, because a late sound is not state.
 *
 * Kept free of the sound and notification decisions so the window service that
 * later replaces realms (plan 5001) can lift it unchanged.
 */
export function useRemoteNodeAttention(
  onAttention: (nodeId: string, event: EnvironmentAttentionEvent) => void,
): void {
  const [shell] = useState(() => !isWorkspaceRealm());
  const realms = useRemoteWorkspaceStore((state) => state.realms.join(SEPARATOR));
  const key = useStore(portalStore.store, (state) =>
    shell
      ? silentNodesKey(
          state.nodes.map((node) => node.nodeId as string),
          state.selfId,
          realms,
        )
      : "",
  );
  const handler = useRef(onAttention);
  useEffect(() => {
    handler.current = onAttention;
  });
  const seen = useRef<BoundedKeySet | null>(null);
  const subscriptions = useRef<Map<string, () => void> | null>(null);

  useEffect(() => {
    const live = (subscriptions.current ??= new Map());
    const keys = (seen.current ??= new BoundedKeySet(REMOTE_ATTENTION_DEDUPE_LIMIT));
    const wanted = new Set(key ? key.split(SEPARATOR) : []);
    for (const [nodeId, stop] of Array.from(live)) {
      if (wanted.has(nodeId)) continue;
      live.delete(nodeId);
      stop();
    }
    for (const nodeId of wanted) {
      if (live.has(nodeId)) continue;
      live.set(
        nodeId,
        subscribeNodeEvents(nodeId as BackendId, {
          events: [ENVIRONMENT_ATTENTION_EVENT],
          // Nothing to re-read: missed attention stays missed.
          onResync: () => undefined,
          onEvent: (event, payload) => {
            // The payload crosses two process boundaries; validate rather than trust.
            if (event !== ENVIRONMENT_ATTENTION_EVENT || !isEnvironmentAttentionEvent(payload))
              return;
            if (!keys.add(`${nodeId}\u0000${payload.attentionId}`)) return;
            handler.current(nodeId, payload);
          },
        }),
      );
    }
  }, [key]);

  useEffect(() => {
    const live = (subscriptions.current ??= new Map());
    return () => {
      for (const stop of Array.from(live.values())) stop();
      live.clear();
    };
  }, []);
}

/**
 * How a desktop notification names and opens another node's environment: from
 * that node's summary, since this window's own stores do not hold it, and
 * through its realm (`openMachineWorkspace`) until the node can open in-tree.
 */
export function remoteAttentionTarget(
  nodeId: string,
  projectId: string,
  environmentId: string,
): { nodeId: string; label: string | null; open: () => void } {
  const node = portalStore.store.getState().nodes.find((candidate) => candidate.nodeId === nodeId);
  const project = node?.projects.find((candidate) => candidate.ref.projectId === projectId);
  const environment = node?.environments.find(
    (candidate) => candidate.ref.environmentId === environmentId,
  );
  const environmentName = environment?.isProjectHome ? "Project home" : environment?.name;
  const label =
    [node?.view.displayName, project?.name, environmentName].filter(Boolean).join(" · ") || null;
  return {
    nodeId,
    label,
    open: () =>
      openMachineWorkspace({
        connectionId: nodeId,
        projectId,
        environmentId,
        ...(environment?.isProjectHome ? { boardTab: "home" as const } : {}),
        title: label ?? "Machine",
      }),
  };
}
