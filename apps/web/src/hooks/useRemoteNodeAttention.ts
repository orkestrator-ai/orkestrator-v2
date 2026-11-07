import { useEffect, useRef } from "react";

import type { EnvironmentAttentionEvent } from "@orkestrator/protocol/environment-attention";

import { startWindowAttention, type AttentionSource } from "@/lib/federation/window-attention";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { portalStore } from "@/lib/portal/portal-store";

/**
 * `environment-attention` from every other node of this window, through the
 * window's attention service (`lib/federation/window-attention.ts`, plan item
 * 5001): a leaf shown in the window's own tree on its warm or live scope, any
 * other node through the command node's relay (`subscribeNodeEvents`).
 *
 * Each `(nodeId, attentionId)` reaches `onAttention` once, across sources and
 * resubscriptions. A resync reads nothing: attention missed while the link was
 * down is not replayed, because a late sound is not state.
 */
export function useRemoteNodeAttention(
  onAttention: (nodeId: string, event: EnvironmentAttentionEvent, source: AttentionSource) => void,
): void {
  const { windowScope } = useScopesWithCommandFallback();
  const handler = useRef(onAttention);
  useEffect(() => {
    handler.current = onAttention;
  });

  useEffect(() => {
    const service = startWindowAttention({
      windowScope,
      onAttention: (nodeId, event, source) => handler.current(nodeId, event, source),
    });
    return () => service.stop();
  }, [windowScope]);
}

/**
 * How a desktop notification names and opens another node's environment: from
 * that node's summary (every tier has one), and opens it through
 * `openMachineWorkspace`, in the window's own tree.
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
