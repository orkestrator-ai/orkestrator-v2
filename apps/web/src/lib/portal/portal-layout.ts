/**
 * The portal sidebar's cross-machine order, as the command node stores it
 * (`get_portal_layout`, `portal-layout-changed`). A drag shows its result at
 * once and is then written to the command node; another client's write
 * arrives as the event. A command node without the command keeps the order
 * for this page only.
 */

import { useEffect } from "react";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";
import {
  emptyPortalLayout,
  parsePortalLayout,
  PORTAL_LAYOUT_CHANGED_EVENT,
  type PortalLayout,
  type PortalLayoutUpdate,
} from "@orkestrator/protocol/portal-layout";
import { NATIVE_EVENT_STREAM_CONNECTED_EVENT } from "@/lib/native/events";
import { portalInvoke, portalListen } from "./portal-transport";

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

function apply(next: PortalLayout): void {
  if (writing > 0) return;
  store.setState((state) =>
    state.loaded && state.layout.revision > next.revision
      ? state
      : { layout: next, loaded: true, error: null },
  );
}

function unsupportedCommand(error: unknown): boolean {
  return /unknown command|not available in this backend/i.test(String(error));
}

async function read(): Promise<void> {
  const request = ++readRevision;
  try {
    const layout = parsePortalLayout(await portalInvoke<unknown>("get_portal_layout"));
    if (request === readRevision) apply(layout);
  } catch (error) {
    if (request !== readRevision || writing > 0) return;
    if (unsupportedCommand(error)) store.setState({ loaded: true, error: null });
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
        portalListen<unknown>(event, (payload) => {
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
  if (!store.getState().loaded)
    throw new Error("The sidebar order has not loaded. Reconnect to retry.");
  readRevision += 1;
  store.setState((state) => ({ layout: { ...state.layout, ...update }, loaded: true }));
  writing += 1;
  let unsupported = false;
  try {
    await portalInvoke<unknown>("update_portal_layout", { ...update });
  } catch (error) {
    unsupported = unsupportedCommand(error);
    if (!unsupported) throw error;
  } finally {
    writing -= 1;
    // Answers can arrive out of order; the stored layout is the one to show.
    if (writing === 0 && !unsupported) await read();
  }
}

export function getPortalLayout(): PortalLayout {
  return store.getState().layout;
}

export function usePortalLayout(): PortalLayout {
  useEffect(() => startPortalLayout(), []);
  return useStore(store, (state) => state.layout);
}

/** Test seam. */
export const portalLayoutStore = store;
