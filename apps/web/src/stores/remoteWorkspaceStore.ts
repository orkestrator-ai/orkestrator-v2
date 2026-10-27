import { create } from "zustand";
import {
  environmentKey,
  environmentRef,
  projectKey,
  projectRef,
  type BackendId,
} from "@orkestrator/protocol/federation";
import { useMachineViewStore } from "./machineViewStore";
import type {
  RealmPanel,
  RealmSelectRequest,
  RealmUsageReading,
} from "@/lib/federation/workspace-realm";
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
    selection: { projectId: string | null; environmentId: string | null },
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
/** Set while this store itself clears the window's own selection. */
let clearingLocalSelection = false;

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

export const useRemoteWorkspaceStore = create<RemoteWorkspaceState>()((set, get) => ({
  active: null,
  realms: [],
  requests: {},
  titleBars: {},
  panelRequests: {},
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
      titleBars: pick(get().titleBars, realms),
      panelRequests: pick(get().panelRequests, realms),
    });
    clearLocalSelection();
    noteRemoteSelection(nodeId, request.projectId ?? null, request.environmentId ?? null);
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
    noteRemoteSelection(nodeId, selection.projectId, selection.environmentId);
  },
  closeRealm: (nodeId) => {
    const { active, realms, requests, titleBars, panelRequests } = get();
    if (!realms.includes(nodeId)) return;
    const { [nodeId]: _closed, ...rest } = requests;
    const { [nodeId]: _titleBar, ...otherTitleBars } = titleBars;
    const { [nodeId]: _panelRequest, ...otherPanelRequests } = panelRequests;
    set({
      realms: realms.filter((id) => id !== nodeId),
      requests: rest,
      titleBars: otherTitleBars,
      panelRequests: otherPanelRequests,
      active: active?.nodeId === nodeId ? null : active,
    });
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
}));

/** Shell-owned bookkeeping also covers navigation reported by the active realm. */
function noteRemoteSelection(
  nodeId: string,
  projectId: string | null,
  environmentId: string | null,
): void {
  const views = useMachineViewStore.getState();
  const backendId = nodeId as BackendId;
  const selectedProjectKey = projectId ? projectKey(projectRef(backendId, projectId)) : null;
  views.recordRecent([
    ...(environmentId ? [environmentKey(environmentRef(backendId, environmentId))] : []),
    ...(selectedProjectKey ? [selectedProjectKey] : []),
  ]);
  if (environmentId || views.revealedProject?.key !== selectedProjectKey) {
    views.revealProject(null);
  }
}

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
