/**
 * Change projections of resources on other nodes, for portal views (the
 * sidebar badge of another machine's environment).
 *
 * The same backend projections the node's own clients show, read through the
 * command node (`changes_get_view` via `invoke_on_node`) and kept current by
 * that node's relayed `change-projection-changed` events. As in
 * `lib/changes/subscriptions.ts`, nothing is counted here, a resource is held
 * only while a view shows it, and there are no timers: reads happen when the
 * node subscription says to (first subscription, then any possible gap).
 */

import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
  CHANGE_PROJECTION_CHANGED_EVENT,
  environmentChangeResourceKey,
  isChangeProjection,
  isChangeProjectionEvent,
  type ChangeProjection,
  type ChangeViewResult,
} from "@orkestrator/protocol/change-resources";
import type { BackendId, EnvironmentRef } from "@orkestrator/protocol/federation";
import { portalStore } from "@/lib/portal/portal-store";
import { subscribeNodeEvents } from "./node-events";

const MAX_CONCURRENT_READS = 6;

interface NodeChangeProjectionState {
  projections: Map<string, ChangeProjection>;
}

export const nodeChangeProjectionStore = createStore<NodeChangeProjectionState>(() => ({
  projections: new Map(),
}));

function storeKey(nodeId: BackendId, resourceKey: string): string {
  return `${nodeId}\0${resourceKey}`;
}

interface ResourceInterest {
  count: number;
  version: number;
}

interface NodeInterest {
  /** Resource key → views holding it and its snapshot invalidation version. */
  resources: Map<string, ResourceInterest>;
  release: () => void;
  /** Advances on every resync; fences reads started before it. */
  epoch: number;
}

const nodes = new Map<BackendId, NodeInterest>();
const queue: Array<{ nodeId: BackendId; resourceKey: string }> = [];
const queued = new Set<string>();
const running = new Set<string>();
let active = 0;

function apply(nodeId: BackendId, projection: ChangeProjection): void {
  const key = storeKey(nodeId, projection.resourceKey);
  nodeChangeProjectionStore.setState((state) => {
    const existing = state.projections.get(key);
    // Within one owner generation a lower revision never replaces a higher one.
    if (
      existing &&
      existing.ownerGeneration === projection.ownerGeneration &&
      existing.revision > projection.revision
    ) {
      return state;
    }
    const projections = new Map(state.projections);
    projections.set(key, projection);
    return { projections };
  });
}

function forget(nodeId: BackendId, resourceKey: string): void {
  const key = storeKey(nodeId, resourceKey);
  if (!nodeChangeProjectionStore.getState().projections.has(key)) return;
  nodeChangeProjectionStore.setState((state) => {
    const projections = new Map(state.projections);
    projections.delete(key);
    return { projections };
  });
}

function drain(): void {
  while (active < MAX_CONCURRENT_READS && queue.length > 0) {
    const available = queue.findIndex(
      ({ nodeId, resourceKey }) => !running.has(storeKey(nodeId, resourceKey)),
    );
    if (available < 0) return;
    const { nodeId, resourceKey } = queue.splice(available, 1)[0]!;
    queued.delete(storeKey(nodeId, resourceKey));
    const interest = nodes.get(nodeId);
    if (!interest?.resources.has(resourceKey)) continue;
    const resource = interest.resources.get(resourceKey)!;
    const key = storeKey(nodeId, resourceKey);
    active++;
    running.add(key);
    void read(nodeId, resourceKey, interest, resource).finally(() => {
      running.delete(key);
      active--;
      drain();
    });
  }
}

async function read(
  nodeId: BackendId,
  resourceKey: string,
  interest: NodeInterest,
  resource: ResourceInterest,
): Promise<void> {
  const epoch = interest.epoch;
  const version = resource.version;
  const current = nodeChangeProjectionStore
    .getState()
    .projections.get(storeKey(nodeId, resourceKey));
  try {
    const result = await portalStore.invokeOnNode<ChangeViewResult>(nodeId, "changes_get_view", {
      resourceKey,
      ...(current
        ? { knownGeneration: current.ownerGeneration, knownRevision: current.revision }
        : {}),
    });
    if (
      nodes.get(nodeId) !== interest ||
      interest.epoch !== epoch ||
      interest.resources.get(resourceKey) !== resource ||
      resource.version !== version
    )
      return;
    if (result.kind === "projection" || result.kind === "reset") {
      if (isChangeProjection(result.projection) && result.projection.resourceKey === resourceKey)
        apply(nodeId, result.projection);
    } else if (result.kind === "deleted") {
      forget(nodeId, resourceKey);
    }
  } catch {
    // A node without change tracking, or one that is not reachable: the view
    // keeps its last-known projection or shows none.
  }
}

function requestRead(nodeId: BackendId, resourceKey: string): void {
  const key = storeKey(nodeId, resourceKey);
  if (queued.has(key)) return;
  queued.add(key);
  queue.push({ nodeId, resourceKey });
  drain();
}

function nodeInterest(nodeId: BackendId): NodeInterest {
  const existing = nodes.get(nodeId);
  if (existing) return existing;
  const interest: NodeInterest = { resources: new Map(), release: () => undefined, epoch: 0 };
  nodes.set(nodeId, interest);
  interest.release = subscribeNodeEvents(nodeId, {
    events: [CHANGE_PROJECTION_CHANGED_EVENT],
    onResync: () => {
      interest.epoch++;
      for (const resourceKey of interest.resources.keys()) requestRead(nodeId, resourceKey);
    },
    onEvent: (_event, payload) => {
      if (!isChangeProjectionEvent(payload)) return;
      const resourceKey =
        payload.kind === "projection" ? payload.projection.resourceKey : payload.resourceKey;
      const resource = interest.resources.get(resourceKey);
      if (!resource) return;
      if (payload.kind !== "content-invalidated") resource.version++;
      switch (payload.kind) {
        case "projection":
          if (interest.resources.has(payload.projection.resourceKey))
            apply(nodeId, payload.projection);
          break;
        case "deleted":
          forget(nodeId, payload.resourceKey);
          break;
        case "reset":
          if (interest.resources.has(payload.resourceKey)) requestRead(nodeId, payload.resourceKey);
          break;
        case "content-invalidated":
          // Counts are unchanged; portal views show no file bodies.
          break;
      }
    },
  });
  return interest;
}

/** Register interest in one resource on a node; returns the release function. */
export function subscribeNodeChangeResource(nodeId: BackendId, resourceKey: string): () => void {
  const interest = nodeInterest(nodeId);
  let resource = interest.resources.get(resourceKey);
  const count = resource?.count ?? 0;
  if (resource) resource.count++;
  else {
    resource = { count: 1, version: 0 };
    interest.resources.set(resourceKey, resource);
  }
  // A resource added to a node already subscribed has missed nothing it held.
  if (count === 0 && interest.epoch > 0) requestRead(nodeId, resourceKey);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = --resource.count;
    if (remaining > 0) {
      return;
    }
    interest.resources.delete(resourceKey);
    forget(nodeId, resourceKey);
    if (interest.resources.size === 0 && nodes.get(nodeId) === interest) {
      nodes.delete(nodeId);
      interest.release();
    }
  };
}

/** The `environment-net` projection of another node's environment, while shown. */
export function useNodeEnvironmentChangeProjection(
  ref: EnvironmentRef | null | undefined,
): ChangeProjection | undefined {
  const nodeId = ref?.backendId;
  const resourceKey = ref ? environmentChangeResourceKey(ref.environmentId) : null;
  useEffect(() => {
    if (!nodeId || !resourceKey) return;
    return subscribeNodeChangeResource(nodeId, resourceKey);
  }, [nodeId, resourceKey]);
  return useStore(nodeChangeProjectionStore, (state) =>
    nodeId && resourceKey ? state.projections.get(storeKey(nodeId, resourceKey)) : undefined,
  );
}

/** Test seam. */
export function resetNodeChangeProjectionsForTests(): void {
  for (const interest of nodes.values()) interest.release();
  nodes.clear();
  queue.length = 0;
  queued.clear();
  running.clear();
  active = 0;
  nodeChangeProjectionStore.setState({ projections: new Map() });
}
