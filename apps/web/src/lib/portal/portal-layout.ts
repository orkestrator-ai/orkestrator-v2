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
}

const store = createStore<PortalLayoutState>(() => ({
  layout: emptyPortalLayout(),
  loaded: false,
}));

/** Writes in flight; a read must not undo a drag the command node has not answered yet. */
let writing = 0;
let started = 0;
let unlisteners: Array<() => void> = [];

function apply(next: PortalLayout): void {
  if (writing > 0) return;
  store.setState((state) =>
    state.loaded && state.layout.revision > next.revision ? state : { layout: next, loaded: true },
  );
}

async function read(): Promise<void> {
  try {
    apply(parsePortalLayout(await portalInvoke<unknown>("get_portal_layout")));
  } catch {
    // An older command node: the default order, kept for this page only.
    store.setState({ loaded: true });
  }
}

/** Start following the command node's layout; reference-counted. */
export function startPortalLayout(): () => void {
  started += 1;
  if (started === 1) {
    void read();
    for (const event of [PORTAL_LAYOUT_CHANGED_EVENT, NATIVE_EVENT_STREAM_CONNECTED_EVENT]) {
      void portalListen<unknown>(event, (payload) => {
        if (event === PORTAL_LAYOUT_CHANGED_EVENT) apply(parsePortalLayout(payload.payload));
        else void read();
      }).then((stop) => {
        if (started === 0) stop();
        else unlisteners.push(stop);
      });
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    started -= 1;
    if (started > 0) return;
    for (const stop of unlisteners) stop();
    unlisteners = [];
  };
}

/** Shows `update` at once and writes it to the command node. */
export async function updatePortalLayout(update: PortalLayoutUpdate): Promise<void> {
  store.setState((state) => ({ layout: { ...state.layout, ...update }, loaded: true }));
  writing += 1;
  let unsupported = false;
  try {
    await portalInvoke<unknown>("update_portal_layout", { ...update });
  } catch (error) {
    unsupported = /unknown command|not available in this backend/i.test(String(error));
    if (!unsupported) throw error;
  } finally {
    writing -= 1;
    // Answers can arrive out of order; the stored layout is the one to show.
    if (writing === 0 && !unsupported) void read();
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
