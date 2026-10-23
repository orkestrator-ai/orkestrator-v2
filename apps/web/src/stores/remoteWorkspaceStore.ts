import { create } from "zustand";
import type { RealmSelectRequest } from "@/lib/federation/workspace-realm";
import { useUIStore } from "./uiStore";

/**
 * Which other node's workspace the window's central region shows.
 *
 * The window stays on its command node. Opening an environment of another
 * node shows that node's workspace realm in the central region (see
 * `lib/federation/workspace-realm.ts`), while this window's own selection is
 * cleared so its own workspace shows nothing behind it. Selecting anything of
 * the window's own node again returns the region to it. A few realms stay
 * open, hidden, so going back to a node is instant; closing one only ends
 * this window's view of it.
 */

/** Realms kept open per window, the shown one included. */
export const MAX_OPEN_REALMS = 3;

export interface RemoteWorkspaceSelection {
  nodeId: string;
  projectId: string | null;
  environmentId: string | null;
}

export interface RealmRequest {
  /** Increases with every request, so the same request twice is delivered twice. */
  seq: number;
  request: RealmSelectRequest;
}

interface RemoteWorkspaceState {
  /** The other node shown in the central region, or `null` for this window's own. */
  active: RemoteWorkspaceSelection | null;
  /** Nodes with an open realm, least recently shown first. */
  realms: string[];
  /** The latest request for each open realm. */
  requests: Record<string, RealmRequest>;
  /** Show a node's workspace, on what the user opened there. */
  open: (nodeId: string, request: Omit<RealmSelectRequest, "type">) => void;
  /** Return the central region to this window's own node. */
  showLocal: () => void;
  /** A realm reported its own selection. */
  noteRealmSelection: (
    nodeId: string,
    selection: { projectId: string | null; environmentId: string | null },
  ) => void;
  /** A realm went away (failed, or its node was removed). */
  closeRealm: (nodeId: string) => void;
}

let nextSeq = 1;
/** Set while this store itself clears the window's own selection. */
let clearingLocalSelection = false;

export const useRemoteWorkspaceStore = create<RemoteWorkspaceState>()((set, get) => ({
  active: null,
  realms: [],
  requests: {},
  open: (nodeId, request) => {
    const realms = [...get().realms.filter((id) => id !== nodeId), nodeId].slice(-MAX_OPEN_REALMS);
    const requests: Record<string, RealmRequest> = {};
    for (const id of realms) {
      const existing = get().requests[id];
      if (existing && id !== nodeId) requests[id] = existing;
    }
    requests[nodeId] = { seq: nextSeq++, request: { type: "select", ...request } };
    set({
      active: {
        nodeId,
        projectId: request.projectId ?? null,
        environmentId: request.environmentId ?? null,
      },
      realms,
      requests,
    });
    clearLocalSelection();
  },
  showLocal: () => {
    if (get().active) set({ active: null });
  },
  noteRealmSelection: (nodeId, selection) => {
    const active = get().active;
    if (active?.nodeId !== nodeId) return;
    if (
      active.projectId === selection.projectId &&
      active.environmentId === selection.environmentId
    ) {
      return;
    }
    set({ active: { nodeId, ...selection } });
  },
  closeRealm: (nodeId) => {
    const { active, realms, requests } = get();
    if (!realms.includes(nodeId)) return;
    const { [nodeId]: _closed, ...rest } = requests;
    set({
      realms: realms.filter((id) => id !== nodeId),
      requests: rest,
      active: active?.nodeId === nodeId ? null : active,
    });
  },
}));

function clearLocalSelection(): void {
  const ui = useUIStore.getState();
  if (ui.selectedProjectId === null && ui.selectedEnvironmentId === null) return;
  clearingLocalSelection = true;
  try {
    ui.selectProject(null);
  } finally {
    clearingLocalSelection = false;
  }
}

/**
 * Any selection of the window's own node (a sidebar row, a shortcut, a
 * notification) brings the central region back to it. Returns the stop
 * function.
 */
export function startRemoteWorkspaceSelectionSync(): () => void {
  return useUIStore.subscribe((state, previous) => {
    if (clearingLocalSelection || !useRemoteWorkspaceStore.getState().active) return;
    const reselected = state.projectSelectionRevision !== previous.projectSelectionRevision;
    const environmentChosen =
      state.selectedEnvironmentId !== null &&
      state.selectedEnvironmentId !== previous.selectedEnvironmentId;
    if (reselected || environmentChosen) useRemoteWorkspaceStore.getState().showLocal();
  });
}

/** Whether another node's environment is the one the central region shows. */
export function useRemoteEnvironmentShown(nodeId: string, environmentId: string): boolean {
  return useRemoteWorkspaceStore(
    (state) => state.active?.nodeId === nodeId && state.active.environmentId === environmentId,
  );
}
