import { createStore } from "zustand/vanilla";
import { projectKey, type ProjectRef } from "@orkestrator/protocol/federation";
import { MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT } from "@orkestrator/protocol/node-summaries";
import type { PortalStore } from "@/lib/portal/portal-store";
import { reorderFederatedEnvironments } from "./federated-actions";
import { sameOrder } from "./remote-order";

const OPTIMISTIC_ORDER_MS = 10_000;
const MAX_PENDING_PROJECTS = 128;
const MAX_ORDER_BYTES = 256 * 1024;
const encoder = new TextEncoder();

function orderBytes(ref: ProjectRef, ids: readonly string[]): number {
  let bytes = 0;
  for (const value of [ref.backendId, ref.projectId, ...ids]) {
    // Bound the encoding allocation too, before measuring UTF-8 bytes.
    if (value.length > MAX_ORDER_BYTES) return Infinity;
    bytes += encoder.encode(value).byteLength;
    if (bytes > MAX_ORDER_BYTES) return bytes;
  }
  return bytes;
}

type Write = { ref: ProjectRef; ids: readonly string[]; onError: (error: unknown) => void };
type Pending = { latest: Write; writing: boolean; cleanup?: () => void };

/**
 * One active write and one latest pending order per owner/project. Owned by
 * the portal, so hiding or remounting a sidebar neither cancels nor duplicates
 * a write. Only an acknowledged write can release the next one; an ambiguous
 * outcome discards queued work rather than racing a possibly still running write.
 */
export function createRemoteOrderWrites(portal: PortalStore) {
  const store = createStore<ReadonlyMap<string, readonly string[]>>(() => new Map());
  const pending = new Map<string, Pending>();

  const forget = (key: string, entry: Pending) => {
    if (pending.get(key) !== entry) return;
    entry.cleanup?.();
    pending.delete(key);
    store.setState((current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    }, true);
  };

  const settle = (key: string, entry: Pending, write: Write) => {
    const reconcile = () => {
      const node = portal.node(write.ref.backendId);
      if (!node || node.truncated) return;
      const ids = node.environments
        .filter((environment) => environment.projectId === write.ref.projectId)
        .sort((left, right) => left.order - right.order)
        .map((environment) => environment.ref.environmentId);
      if (sameOrder(ids, write.ids)) forget(key, entry);
    };
    // Subscribe first, then read the authoritative snapshot.
    const unsubscribe = portal.store.subscribe(reconcile);
    const timer = setTimeout(() => forget(key, entry), OPTIMISTIC_ORDER_MS);
    entry.cleanup = () => {
      clearTimeout(timer);
      unsubscribe();
    };
    reconcile();
  };

  const send = (key: string, entry: Pending, write: Write) => {
    entry.writing = true;
    void reorderFederatedEnvironments(portal, write.ref, write.ids).then(
      () => {
        entry.writing = false;
        if (entry.latest !== write) send(key, entry, entry.latest);
        else settle(key, entry, write);
      },
      (error: unknown) => {
        forget(key, entry);
        write.onError(error);
      },
    );
  };

  return {
    store,
    submit(ref: ProjectRef, ids: readonly string[], onError: Write["onError"]) {
      const key = projectKey(ref);
      if (
        ids.length > MAX_SUMMARY_ENVIRONMENTS_PER_PROJECT ||
        orderBytes(ref, ids) > MAX_ORDER_BYTES
      ) {
        onError(new Error("This environment order is too large to submit."));
        return;
      }
      if (!pending.has(key) && pending.size >= MAX_PENDING_PROJECTS) {
        onError(new Error("Too many pending environment reorders. Try again once they finish."));
        return;
      }
      const write: Write = { ref, ids: [...ids], onError };
      let entry = pending.get(key);
      if (entry) {
        entry.cleanup?.();
        entry.cleanup = undefined;
        entry.latest = write;
      } else {
        entry = { latest: write, writing: false };
        pending.set(key, entry);
      }
      store.setState((current) => new Map(current).set(key, write.ids), true);
      if (!entry.writing) send(key, entry, write);
    },
  };
}

const controllers = new WeakMap<PortalStore, ReturnType<typeof createRemoteOrderWrites>>();

export function remoteOrdersFor(portal: PortalStore) {
  let controller = controllers.get(portal);
  if (!controller) {
    controller = createRemoteOrderWrites(portal);
    controllers.set(portal, controller);
  }
  return controller;
}
