/**
 * Reads of another node's environment for portal views, on request: the full
 * record and its agent summary for a hover card, read through the command
 * node while the card is open and kept current by the node's relayed events.
 */

import { useEffect, useState } from "react";
import type { AgentRegistrySnapshot } from "@orkestrator/protocol/agent-registry";
import type { BackendId, EnvironmentRef } from "@orkestrator/protocol/federation";
import {
  NATIVE_AGENT_ACTIVITY_EVENT,
  parseNativeAgentActivityAnnouncement,
} from "@orkestrator/protocol/native-agent-observation";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";
import type { AgentSummarySource } from "@/components/environments/EnvironmentAgentSummary";
import { portalStore } from "@/lib/portal/portal-store";
import type { Environment } from "@/types";
import { subscribeNodeEvents } from "./node-events";

/** Coalesces a burst of changes into one read. */
const REFRESH_DEBOUNCE_MS = 250;

function changedResource(payload: unknown): { resource: unknown; id: unknown } | null {
  return payload && typeof payload === "object"
    ? (payload as { resource: unknown; id: unknown })
    : null;
}

const agentSources = new Map<BackendId, AgentSummarySource>();

/** The agent summary source for one node's environments (stable per node). */
export function nodeAgentSummarySource(nodeId: BackendId): AgentSummarySource {
  let source = agentSources.get(nodeId);
  if (!source) {
    source = {
      resyncOnSubscribe: true,
      read: (environmentId) =>
        portalStore.invokeOnNode<AgentRegistrySnapshot>(nodeId, "get_agent_registry", {
          environmentId,
        }),
      subscribe: (environmentId, refresh) =>
        subscribeNodeEvents(nodeId, {
          events: [NATIVE_AGENT_ACTIVITY_EVENT, RESOURCE_CHANGED_EVENT],
          onResync: () => refresh(true),
          onEvent: (event, payload) => {
            if (event === NATIVE_AGENT_ACTIVITY_EVENT) {
              const announcement = parseNativeAgentActivityAnnouncement(payload);
              if (announcement?.environmentId === environmentId) refresh();
              return;
            }
            const change = changedResource(payload);
            if (
              (change?.resource === "environment" || change?.resource === "pane-layout") &&
              change.id === environmentId
            ) {
              refresh();
            }
          },
        }),
    };
    agentSources.set(nodeId, source);
  }
  return source;
}

/**
 * Another node's full environment record while `open`, or `null` until read
 * (or when the node cannot answer). Nothing is read while closed.
 */
export function useNodeEnvironment(ref: EnvironmentRef, open: boolean): Environment | null {
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const { backendId: nodeId, environmentId } = ref;

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let latest = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      const request = ++latest;
      void portalStore
        .invokeOnNode<Environment | null>(nodeId, "get_environment", { environmentId })
        .then((value) => {
          if (!cancelled && request === latest) setEnvironment(value ?? null);
        })
        .catch(() => undefined);
    };
    const refresh = () => {
      latest++;
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, REFRESH_DEBOUNCE_MS);
    };
    const stop = subscribeNodeEvents(nodeId, {
      events: [RESOURCE_CHANGED_EVENT],
      onResync: () => {
        if (timer) clearTimeout(timer);
        read();
      },
      onEvent: (_event, payload) => {
        const change = changedResource(payload);
        if (change?.resource === "environment" && change.id === environmentId) refresh();
      },
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      stop();
    };
  }, [nodeId, environmentId, open]);

  return environment;
}
