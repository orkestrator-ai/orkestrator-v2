import { terminals } from "@/lib/node-scope/domains/terminals";
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import type { BackendId } from "@orkestrator/protocol/federation";
import {
  normalizeRemoteHumanPromptEntry,
  type HumanPromptEntry,
} from "@orkestrator/protocol/human-prompts";
import { RESOURCE_CHANGED_EVENT } from "@orkestrator/protocol/resource-events";

import { subscribeNodeEvents } from "@/lib/federation/node-events";
import { portalStore } from "@/lib/portal/portal-store";
import { onResourceResync, onViewSafetyCheck } from "@/lib/resource-sync";
import { routedBackendClient } from "@/lib/portal/routed-backend-client";

/** A waiting prompt of a worker on another node, and which node. */
export type RemoteHumanPromptEntry = HumanPromptEntry & { nodeId: string };

export interface RemoteWorkerRef {
  nodeId: string;
  environmentId: string;
}

/** Entries kept per node, so one node's answer cannot grow the banner without limit. */
export const MAX_REMOTE_PROMPTS_PER_NODE = 32;

const EMPTY: RemoteHumanPromptEntry[] = [];

/**
 * Prompts waiting on the user in workers on other nodes: `list_human_prompts`
 * through each node's link, the read a window opened on that node makes itself.
 *
 * Re-read on that node's `human-prompt` hint, on its resync, whenever its
 * summaries refresh, and on this client's own resync and safety checks. The
 * answer is checked (`normalizeRemoteHumanPromptEntry`) and held in this hook's
 * state only: it never joins the node summaries, which deliberately carry no
 * prompts, and nothing here persists or logs it. A node that cannot answer,
 * including one that predates the command, shows nothing new and keeps its last
 * reading until it is reported unavailable, when its prompts drop out: a link
 * nobody can confirm is still waiting is not worth showing.
 */
export function useRemoteHumanPrompts(
  workers: readonly RemoteWorkerRef[],
): RemoteHumanPromptEntry[] {
  const [state, setState] = useState<{
    key: string;
    byNode: ReadonlyMap<string, RemoteHumanPromptEntry[]>;
  } | null>(null);
  const nodes = useStore(portalStore.store, (store) => store.nodes);
  const key = Array.from(
    new Set(workers.map((worker) => `${worker.nodeId}\u0000${worker.environmentId}`)),
  )
    .sort()
    .join("\u0001");
  const involved = useMemo(
    () => new Set(key ? key.split("\u0001").map((item) => item.split("\u0000")[0]!) : []),
    [key],
  );
  const stamp = nodes
    .filter((node) => involved.has(node.nodeId))
    .map((node) => `${node.nodeId}:${node.loadedAt ?? ""}:${node.available}`)
    .join("|");
  const readAll = useRef<(() => void) | null>(null);
  const lastStamp = useRef(stamp);

  useEffect(() => {
    if (!key) return;
    const wanted = new Map<string, Set<string>>();
    for (const item of key.split("\u0001")) {
      const [nodeId, environmentId] = item.split("\u0000") as [string, string];
      const set = wanted.get(nodeId) ?? new Set<string>();
      set.add(environmentId);
      wanted.set(nodeId, set);
    }
    let disposed = false;
    const sequence = new Map<string, number>();
    const read = (nodeId: string, environmentIds: ReadonlySet<string>) => {
      if (
        !portalStore.store.getState().nodes.some((node) => node.nodeId === nodeId && node.available)
      ) {
        sequence.set(nodeId, (sequence.get(nodeId) ?? 0) + 1);
        setState((current) => {
          if (!current?.byNode.has(nodeId)) return current;
          const byNode = new Map(current.byNode);
          byNode.delete(nodeId);
          return { ...current, byNode };
        });
        return;
      }
      const request = (sequence.get(nodeId) ?? 0) + 1;
      sequence.set(nodeId, request);
      // The `terminals` domain client over the routed call (plan item 7002):
      // no negotiated range, so today's call, its answer normalised below.
      void terminals(routedBackendClient(portalStore, nodeId as BackendId))
        .list_human_prompts({ environmentIds: Array.from(environmentIds) })
        .then((answer: { prompts?: unknown } | undefined) => {
          if (disposed || sequence.get(nodeId) !== request) return;
          const prompts = (Array.isArray(answer?.prompts) ? answer.prompts : [])
            .map(normalizeRemoteHumanPromptEntry)
            .filter((entry): entry is HumanPromptEntry =>
              Boolean(entry && environmentIds.has(entry.environmentId)),
            )
            .slice(0, MAX_REMOTE_PROMPTS_PER_NODE)
            .map((entry) => ({ ...entry, nodeId }));
          setState((current) => {
            const byNode = new Map(current?.key === key ? current.byNode : []);
            byNode.set(nodeId, prompts);
            return { key, byNode };
          });
        })
        .catch(() => undefined);
    };
    const all = () => {
      for (const [nodeId, environmentIds] of wanted) read(nodeId, environmentIds);
    };
    readAll.current = all;
    all();
    const stops = Array.from(wanted, ([nodeId, environmentIds]) =>
      subscribeNodeEvents(nodeId as BackendId, {
        events: [RESOURCE_CHANGED_EVENT],
        onResync: () => read(nodeId, environmentIds),
        onEvent: (_event, payload) => {
          const change = payload as { resource?: unknown; id?: unknown } | null;
          if (
            change?.resource === "human-prompt" &&
            typeof change.id === "string" &&
            environmentIds.has(change.id)
          )
            read(nodeId, environmentIds);
        },
      }),
    );
    const offSafety = onViewSafetyCheck(all);
    const offResync = onResourceResync(all);
    return () => {
      disposed = true;
      readAll.current = null;
      for (const stop of stops) stop();
      offSafety();
      offResync();
    };
  }, [key]);

  // A summary refresh is the node's own "something moved"; the mount read above covers the first.
  useEffect(() => {
    if (lastStamp.current === stamp) return;
    lastStamp.current = stamp;
    readAll.current?.();
  }, [stamp]);

  return useMemo(() => {
    if (!state || state.key !== key) return EMPTY;
    const available = new Set(
      nodes.filter((node) => node.available).map((node) => node.nodeId as string),
    );
    return Array.from(state.byNode)
      .filter(([nodeId]) => available.has(nodeId))
      .flatMap(([, prompts]) => prompts);
  }, [key, nodes, state]);
}
