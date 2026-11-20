/**
 * The portal sidebar's cross-machine order, as the command node stores it
 * (`get_portal_layout`, `portal-layout-changed`). A drag shows its result at
 * once and is then written to the command node; another client's write
 * arrives as the event. A command node without the command keeps the order
 * for this page only.
 */

import { incompatibility } from "@orkestrator/protocol/contract/errors";
import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
  emptyPortalLayout,
  parsePortalLayout,
  PORTAL_LAYOUT_CHANGED_EVENT,
  type PortalLayout,
  type PortalLayoutUpdate,
  type RepositoryEnvironmentOrderUpdate,
} from "@orkestrator/protocol/portal-layout";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { NO_ARGS, portalNodesApi } from "@/lib/node-scope/domains/nodes";
import { commandScopeListen } from "./command-scope";

interface PortalLayoutState {
  layout: PortalLayout;
  loaded: boolean;
  error: string | null;
}

const store = createStore<PortalLayoutState>(() => ({
  layout: emptyPortalLayout(),
  loaded: false,
  error: null,
}));

/** Writes in flight; a read must not undo a drag the command node has not answered yet. */
let writing = 0;
let started = 0;
let generation = 0;
let readRevision = 0;
let unlisteners: Array<() => void> = [];

function apply(next: PortalLayout, fromRead = false): void {
  if (writing > 0) return;
  store.setState((state) =>
    state.loaded &&
    state.layout.revision > next.revision &&
    !(fromRead && state.layout.manualOrderSupported !== next.manualOrderSupported)
      ? state
      : { layout: next, loaded: true, error: null },
  );
}

/** A backend older than `command`, or one without the command-node portal. */
function unsupportedCommand(error: unknown, command: string): boolean {
  return (
    incompatibility(error, command) !== null || /not available in this backend/i.test(String(error))
  );
}

async function read(): Promise<void> {
  const request = ++readRevision;
  try {
    const layout = parsePortalLayout(await portalNodesApi().get_portal_layout(NO_ARGS));
    if (request === readRevision) apply(layout, true);
  } catch (error) {
    if (request !== readRevision || writing > 0) return;
    if (unsupportedCommand(error, "get_portal_layout"))
      store.setState((state) => ({
        layout: { ...state.layout, manualOrderSupported: undefined },
        loaded: true,
        error: null,
      }));
    else
      store.setState({
        loaded: false,
        error: "Could not load the sidebar order. Reconnect to retry.",
      });
  }
}

/** Start following the command node's layout; reference-counted. */
export function startPortalLayout(): () => void {
  started += 1;
  if (started === 1) {
    const current = ++generation;
    const subscriptions = [];
    for (const event of [PORTAL_LAYOUT_CHANGED_EVENT, NATIVE_EVENT_STREAM_CONNECTED_EVENT]) {
      subscriptions.push(
        commandScopeListen<unknown>(event, (payload) => {
          if (generation !== current) return;
          if (event === PORTAL_LAYOUT_CHANGED_EVENT) apply(parsePortalLayout(payload.payload));
          else void read();
        }).then((stop) => {
          if (started === 0 || generation !== current) stop();
          else unlisteners.push(stop);
        }),
      );
    }
    void Promise.all(subscriptions)
      .then(() => {
        if (started > 0 && generation === current) void read();
      })
      .catch(() => {
        if (generation === current)
          store.setState({
            loaded: false,
            error: "Could not follow the sidebar order. Reconnect to retry.",
          });
      });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    started -= 1;
    if (started > 0) return;
    generation += 1;
    readRevision += 1;
    for (const stop of unlisteners) stop();
    unlisteners = [];
  };
}

/** Shows `update` at once and writes it to the command node. */
export async function updatePortalLayout(update: PortalLayoutUpdate): Promise<void> {
  await writeLayout(
    (layout) => ({ ...layout, ...update }),
    () => portalNodesApi().update_portal_layout(update),
    true,
  );
}

export async function updateRepositoryEnvironmentOrder(
  update: RepositoryEnvironmentOrderUpdate,
): Promise<void> {
  const command = "update_repository_environment_order";
  if (!getPortalLayout().manualOrderSupported) throw manualOrderUnavailable();
  await writeLayout(
    (layout) => ({
      ...layout,
      environmentOrder: { ...layout.environmentOrder, [update.repositoryKey]: update.order },
    }),
    async () => {
      try {
        const saved = await portalNodesApi().update_repository_environment_order(update);
        if (saved?.manualOrderSupported !== true) throw manualOrderUnavailable();
      } catch (error) {
        if (unsupportedCommand(error, command)) throw manualOrderUnavailable();
        throw error;
      }
    },
    false,
  );
}

function manualOrderUnavailable(): Error {
  return new Error("Update the command node to save a Manual environment order.");
}

async function writeLayout(
  optimistic: (layout: PortalLayout) => PortalLayout,
  write: () => Promise<unknown>,
  allowPageFallback: boolean,
): Promise<void> {
  if (!store.getState().loaded)
    throw new Error("The sidebar order has not loaded. Reconnect to retry.");
  const next = optimistic(getPortalLayout());
  readRevision += 1;
  store.setState({ layout: next });
  writing += 1;
  let fallback = false;
  try {
    await write();
  } catch (error) {
    fallback = allowPageFallback && unsupportedCommand(error, "update_portal_layout");
    if (!fallback) throw error;
  } finally {
    writing -= 1;
    if (writing === 0 && !fallback) await read();
  }
}

export function getPortalLayout(): PortalLayout {
  return store.getState().layout;
}

export function useManualOrderSupported(): boolean {
  return useStore(store, (state) => state.loaded && state.layout.manualOrderSupported === true);
}

/**
 * Whether the command node keeps a Manual environment order. An unsupported
 * backend has completed the capability check. A failed check can be retried.
 */
export type ManualOrderAvailability = "loading" | "supported" | "unsupported" | "error";

export function useManualOrderAvailability(): ManualOrderAvailability {
  return useStore(store, (state) => {
    if (!state.loaded) return state.error ? "error" : "loading";
    return state.layout.manualOrderSupported === true ? "supported" : "unsupported";
  });
}

export function usePortalLayout(): PortalLayout {
  useEffect(() => startPortalLayout(), []);
  return useStore(store, (state) => state.layout);
}

/** Test seam. */
export const portalLayoutStore = store;
