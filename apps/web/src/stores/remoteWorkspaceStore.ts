import { create } from "zustand";
import type { BackendId } from "@orkestrator/protocol/federation";
import type {
  RealmPanel,
  RealmSelectRequest,
  RealmUsageReading,
} from "@/lib/federation/workspace-realm";
import { getWindowScope } from "@/lib/node-scope/app-window-scope";
import type { NodeSelection } from "@/lib/node-scope/window-scope";
import { nodesInTree } from "./inTreeNodesStore";
import { isCommandNodeSelection, noteNodeSelectionRecents } from "./windowSelectionStore";

/**
 * Which other node's workspace realm the window's central region shows.
 *
 * The window stays on its command node. Opening an environment of another
 * node shows that node's workspace realm in the central region (see
 * `lib/federation/workspace-realm.ts`). A few realms stay open, hidden, so
 * going back to a node is instant; closing one only ends this window's view
 * of it.
 *
 * Which node is shown, and what is selected there, is the window's one
 * node-qualified selection (`windowSelectionStore`, plan item 3006): `active`
 * is derived from it (the selection while it is on an open realm's node), and
 * opening or a realm's report moves it. Selecting anything of the window's own
 * node moves the selection back, which ends `active`; the command node's
 * `uiStore` shows nothing while the selection is on another node. What stays
 * here is realm-only (open realms, their requests and title bars) and goes
 * with realms (plan item 6002).
 */

/**
 * Realms kept open per window, the shown one included. Nodes shown in the
 * window's own tree are not counted: the window's node-scope lifecycle (plan
 * item 4002) bounds them by its memory and byte budgets instead.
 */
export const MAX_OPEN_REALMS = 3;

export interface RemoteWorkspaceSelection {
  nodeId: string;
  projectId: string | null;
  environmentId: string | null;
  /** Reported by the owning realm, including Homes not yet in summaries. */
  projectHome?: boolean;
}

export interface RealmRequest {
  /** Increases with every request, so the same request twice is delivered twice. */
  seq: number;
  request: RealmSelectRequest;
}

/** What a realm last reported for the window's title bar. */
export interface RealmTitleBar {
  usage: RealmUsageReading | null;
  usageStale: boolean;
  panel: RealmPanel | null;
  /** Last panel request applied by this realm document. */
  requestSeq?: number;
  /** When the report arrived (`Date.now()`), so a realm that went quiet reads as stale. */
  receivedAt: number;
}

/** The window's title bar asking a realm to open or close one of its popovers. */
export interface RealmPanelMessage {
  seq: number;
  panel: RealmPanel;
  open: boolean;
  inset: number;
  /** A user dismissal asks for a focus handoff back to the shell trigger. */
  restoreFocus?: boolean;
}

interface RemoteWorkspaceState {
  /** The other node shown in the central region, or `null` for this window's own. */
  active: RemoteWorkspaceSelection | null;
  /** Nodes with an open realm, least recently shown first. */
  realms: string[];
  /** The latest request for each open realm. */
  requests: Record<string, RealmRequest>;
  /** What each open realm last reported for the window's title bar. */
  titleBars: Record<string, RealmTitleBar>;
  /** The title bar's latest popover request for each open realm. */
  panelRequests: Record<string, RealmPanelMessage>;
  /** Show a node's workspace, on what the user opened there. */
  open: (nodeId: string, request: Omit<RealmSelectRequest, "type">) => void;
  /** Return the central region to this window's own node. */
  showLocal: () => void;
  /** A realm reported its own selection. */
  noteRealmSelection: (
    nodeId: string,
    selection: { projectId: string | null; environmentId: string | null; projectHome?: boolean },
  ) => void;
  /** A realm went away (failed, or its node was removed). */
  closeRealm: (nodeId: string) => void;
  /** A realm reported what the window's title bar shows for it. */
  noteRealmTitleBar: (nodeId: string, titleBar: Omit<RealmTitleBar, "receivedAt">) => void;
  /** Ask a realm to open or close one of its title-bar popovers. */
  requestRealmPanel: (
    nodeId: string,
    panel: RealmPanel,
    open: boolean,
    inset: number,
    restoreFocus?: boolean,
  ) => void;
}

function pick<T>(record: Record<string, T>, ids: readonly string[]): Record<string, T> {
  const picked: Record<string, T> = {};
  for (const id of ids) if (record[id]) picked[id] = record[id];
  return picked;
}

let nextSeq = 1;

/** `active` for `selection`: the selection while it is on an open realm's node. */
function activeFor(
  selection: NodeSelection | null,
  realms: readonly string[],
): RemoteWorkspaceSelection | null {
  if (!selection || !realms.includes(selection.nodeId)) return null;
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

/** Pending intent wins over reports from an earlier request. */
export function realmPanel(
  state: Pick<RemoteWorkspaceState, "panelRequests" | "titleBars">,
  nodeId: string,
): RealmPanel | null {
  const request = state.panelRequests[nodeId];
  const report = state.titleBars[nodeId];
  return request && request.seq > (report?.requestSeq ?? 0)
    ? request.open
      ? request.panel
      : null
    : (report?.panel ?? null);
}

export const useRemoteWorkspaceStore = create<RemoteWorkspaceState>()((set, get) => {
  /** Re-derives `active` from the window's selection. */
  const derive = () => {
    const next = activeFor(getWindowScope().selection.get(), get().realms);
    if (!sameActive(get().active, next)) set({ active: next });
  };
  return {
    active: null,
    realms: [],
    requests: {},
    titleBars: {},
    panelRequests: {},
    open: (nodeId, request) => {
      const order = [...get().realms.filter((id) => id !== nodeId), nodeId];
      // In-tree nodes are bounded by the scope lifecycle (4002), not this cap.
      const realms = nodesInTree() ? order : order.slice(-MAX_OPEN_REALMS);
      const requests: Record<string, RealmRequest> = {};
      for (const id of realms) {
        const existing = get().requests[id];
        if (existing && id !== nodeId) requests[id] = existing;
      }
      requests[nodeId] = { seq: nextSeq++, request: { type: "select", ...request } };
      const selection: NodeSelection = {
        nodeId: nodeId as BackendId,
        projectId: request.projectId ?? null,
        environmentId: request.environmentId ?? null,
      };
      set({
        active: activeFor(selection, realms),
        realms,
        requests,
        titleBars: pick(get().titleBars, realms),
        panelRequests: pick(get().panelRequests, realms),
      });
      // The window's own node shows nothing behind the realm: its `uiStore`
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
    noteRealmSelection: (nodeId, reported) => {
      const active = get().active;
      if (active?.nodeId !== nodeId) return;
      const selection: NodeSelection = {
        nodeId: nodeId as BackendId,
        projectId: reported.projectId,
        environmentId: reported.environmentId,
        ...(reported.projectHome ? { projectHome: true } : {}),
      };
      const next = activeFor(selection, get().realms);
      if (sameActive(active, next)) return;
      set({ active: next });
      getWindowScope().select(selection);
      derive();
      noteNodeSelectionRecents(selection);
    },
    closeRealm: (nodeId) => {
      const { realms, requests, titleBars, panelRequests } = get();
      if (!realms.includes(nodeId)) return;
      const { [nodeId]: _closed, ...rest } = requests;
      const { [nodeId]: _titleBar, ...otherTitleBars } = titleBars;
      const { [nodeId]: _panelRequest, ...otherPanelRequests } = panelRequests;
      set({
        active: get().active?.nodeId === nodeId ? null : get().active,
        realms: realms.filter((id) => id !== nodeId),
        requests: rest,
        titleBars: otherTitleBars,
        panelRequests: otherPanelRequests,
      });
      const windowScope = getWindowScope();
      if (windowScope.selection.get()?.nodeId === nodeId) windowScope.select(null);
      derive();
    },
    noteRealmTitleBar: (nodeId, titleBar) => {
      if (!get().realms.includes(nodeId)) return;
      const previous = get().titleBars[nodeId];
      const report =
        previous && (previous.requestSeq ?? 0) > (titleBar.requestSeq ?? 0)
          ? { ...titleBar, panel: previous.panel, requestSeq: previous.requestSeq }
          : titleBar;
      set({ titleBars: { ...get().titleBars, [nodeId]: { ...report, receivedAt: Date.now() } } });
    },
    requestRealmPanel: (nodeId, panel, open, inset, restoreFocus) => {
      if (!get().realms.includes(nodeId)) return;
      set({
        panelRequests: {
          ...get().panelRequests,
          [nodeId]: {
            seq: nextSeq++,
            panel,
            open,
            inset,
            ...(restoreFocus ? { restoreFocus: true } : {}),
          },
        },
      });
    },
  };
});

/**
 * Keeps `active` derived from the window's selection while realms are open:
 * any selection of the window's own node (a sidebar row, a shortcut, a
 * notification) moves the selection back to it and so brings the central
 * region back. Returns the stop.
 */
export function startRemoteWorkspaceSelectionSync(): () => void {
  const windowScope = getWindowScope();
  return windowScope.selection.subscribe((selection) => {
    const state = useRemoteWorkspaceStore.getState();
    const next = activeFor(selection, state.realms);
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
