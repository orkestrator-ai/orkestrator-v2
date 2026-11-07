import { create } from "zustand";
import type { BackendId } from "@orkestrator/protocol/federation";
import type { WorkspaceRequest } from "@/lib/federation/workspace-request";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { NodeSelection } from "@/lib/node-scope/window-scope";
import { isCommandNodeSelection, noteNodeSelectionRecents } from "./windowSelectionStore";

/**
 * Which other nodes' workspaces the window's central region holds, which one
 * it shows, and what the window last asked each to show.
 *
 * The window stays on its command node. Opening an environment of another
 * node shows that node's workspace in the central region, in the window's
 * own tree (`InTreeWorkspace`). Opened nodes stay held, hidden, so going back
 * is instant; the window's node-scope lifecycle (plan item 4002) bounds them
 * by its memory and byte budgets. Closing one only ends this window's view
 * of it.
 *
 * Which node is shown, and what is selected there, is the window's one
 * node-qualified selection (`windowSelectionStore`, plan item 3006): `active`
 * is derived from it (the selection while it is on a held node), and opening
 * moves it. Selecting anything of the window's own node moves the selection
 * back, which ends `active`; the command node's `uiStore` shows nothing while
 * the selection is on another node.
 */

export interface RemoteWorkspaceSelection {
  nodeId: string;
  projectId: string | null;
  environmentId: string | null;
  /** The environment is its project's home, including Homes not yet in summaries. */
  projectHome?: boolean;
}

export interface NodeWorkspaceRequest {
  /** Increases with every request, so the same request twice is applied twice. */
  seq: number;
  request: WorkspaceRequest;
}

interface RemoteWorkspaceState {
  /** The other node shown in the central region, or `null` for this window's own. */
  active: RemoteWorkspaceSelection | null;
  /** Nodes the region holds, least recently shown first. */
  openNodes: string[];
  /** The latest request for each held node, which its `NodeWorkspaceHost` applies. */
  requests: Record<string, NodeWorkspaceRequest>;
  /** Show a node's workspace, on what the user opened there. */
  open: (nodeId: string, request: WorkspaceRequest) => void;
  /** Return the central region to this window's own node. */
  showLocal: () => void;
  /** A node's workspace went away (its node was removed from the command node). */
  closeNode: (nodeId: string) => void;
}

let nextSeq = 1;

/** `active` for `selection`: the selection while it is on a held node. */
function activeFor(
  selection: NodeSelection | null,
  openNodes: readonly string[],
): RemoteWorkspaceSelection | null {
  if (!selection || !openNodes.includes(selection.nodeId)) return null;
  if (isCommandNodeSelection(getWindowScope(), selection)) return null;
  return {
    nodeId: selection.nodeId,
    projectId: selection.projectId,
    environmentId: selection.environmentId,
    ...(selection.projectHome ? { projectHome: true } : {}),
  };
}

function sameActive(
  a: RemoteWorkspaceSelection | null,
  b: RemoteWorkspaceSelection | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.nodeId === b.nodeId &&
    a.projectId === b.projectId &&
    a.environmentId === b.environmentId &&
    Boolean(a.projectHome) === Boolean(b.projectHome)
  );
}

export const useRemoteWorkspaceStore = create<RemoteWorkspaceState>()((set, get) => {
  /** Re-derives `active` from the window's selection. */
  const derive = () => {
    const next = activeFor(getWindowScope().selection.get(), get().openNodes);
    if (!sameActive(get().active, next)) set({ active: next });
  };
  return {
    active: null,
    openNodes: [],
    requests: {},
    open: (nodeId, request) => {
      const openNodes = [...get().openNodes.filter((id) => id !== nodeId), nodeId];
      const requests = {
        ...get().requests,
        [nodeId]: { seq: nextSeq++, request },
      };
      const selection: NodeSelection = {
        nodeId: nodeId as BackendId,
        projectId: request.projectId ?? null,
        environmentId: request.environmentId ?? null,
      };
      set({ active: activeFor(selection, openNodes), openNodes, requests });
      // The window's own node shows nothing behind it: its `uiStore`
      // projects no selection while the selection is on another node.
      getWindowScope().select(selection);
      derive();
      noteNodeSelectionRecents(selection);
    },
    showLocal: () => {
      if (!get().active) return;
      const windowScope = getWindowScope();
      if (!isCommandNodeSelection(windowScope, windowScope.selection.get()))
        windowScope.select(null);
      derive();
    },
    closeNode: (nodeId) => {
      const { openNodes, requests } = get();
      if (!openNodes.includes(nodeId)) return;
      const { [nodeId]: _closed, ...rest } = requests;
      set({
        active: get().active?.nodeId === nodeId ? null : get().active,
        openNodes: openNodes.filter((id) => id !== nodeId),
        requests: rest,
      });
      const windowScope = getWindowScope();
      if (windowScope.selection.get()?.nodeId === nodeId) windowScope.select(null);
      derive();
    },
  };
});

/**
 * Keeps `active` derived from the window's selection while nodes are held:
 * any selection of the window's own node (a sidebar row, a shortcut, a
 * notification) moves the selection back to it and so brings the central
 * region back. Returns the stop.
 */
export function startRemoteWorkspaceSelectionSync(): () => void {
  const windowScope = getWindowScope();
  return windowScope.selection.subscribe((selection) => {
    const state = useRemoteWorkspaceStore.getState();
    const next = activeFor(selection, state.openNodes);
    if (!sameActive(state.active, next)) useRemoteWorkspaceStore.setState({ active: next });
  });
}

/** Whether another node's environment is the one the central region shows. */
export function useRemoteEnvironmentShown(nodeId: string, environmentId: string): boolean {
  return useRemoteWorkspaceStore(
    (state) => state.active?.nodeId === nodeId && state.active.environmentId === environmentId,
  );
}

/**
 * Whether another node's project is what the central region shows: the
 * project with its home, or with nothing else selected, as this window's own
 * project row is selected.
 */
export function useRemoteProjectHomeShown(
  nodeId: string,
  projectId: string,
  homeEnvironmentId: string | undefined,
): boolean {
  return useRemoteWorkspaceStore(
    (state) =>
      state.active?.nodeId === nodeId &&
      state.active.projectId === projectId &&
      (state.active.environmentId === null ||
        state.active.projectHome === true ||
        state.active.environmentId === homeEnvironmentId),
  );
}
