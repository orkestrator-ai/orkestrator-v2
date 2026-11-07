import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { requestAppShortcut } from "@/lib/app-shortcuts";
import { openBugReport } from "@/lib/bug-report/open-bug-report";
import { openCoordinatorWorkTarget } from "@/lib/coordinator-work-navigation";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import {
  parseRealmMessage,
  type RealmSelectRequest,
  type ShellToRealmMessage,
} from "@/lib/federation/workspace-realm";
import { MOBILE_SHELL_MEDIA_QUERY } from "@/lib/mobile-shell";
import { isGlobalSettingsSection, requestGlobalSettings } from "@/lib/settings-navigation";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { useWindowGrouping } from "./useWindowGrouping";
import {
  useRemoteWorkspaceStore,
  realmPanel,
  type RealmRequest,
} from "@/stores/remoteWorkspaceStore";

/**
 * The window's side of the realm protocol for one node, whatever carries it:
 * a desktop view, a browser frame (`RemoteWorkspaceRegion`), or the in-memory
 * loopback of a node shown in the window's own tree (`InTreeWorkspace`).
 */

export function nodeName(
  nodes: readonly { nodeId: string; view: { displayName: string } }[],
  id: string,
) {
  return nodes.find((node) => node.nodeId === id)?.view.displayName || "the machine";
}

function selectRequest(request: RealmRequest | undefined): Omit<RealmSelectRequest, "type"> {
  if (!request) return {};
  const { type: _type, ...rest } = request.request;
  return rest;
}

/**
 * Delivery of the window's requests to one realm: the request the realm was
 * opened with is in its URL; later ones are sent once the realm says it is
 * listening, and each at most once. The realm also follows the window's
 * sidebar, which its toolbar toggles, its files panel state, which is one
 * state for every machine, its grouping, which decides whether the node's
 * coordinator opens directly, and whether it is shown: a hidden realm's own
 * Page Visibility still reads visible, so it is told to defer its reads.
 *
 * A node in the window's own tree (`inTree`, plan item 4005) shares the
 * window's document and stores, so what the window's stores already hold is
 * read there directly and not sent (report Appendix C): the sidebar is
 * `uiChromeStore`'s, the files panel's open state `filesPanelChromeStore`'s,
 * and the grouping `useWindowGrouping`'s (`machineViewStore`). Visibility is
 * not sent either: a hidden node is the scope's tier (plan item 4002). Nor
 * is the window's request (`select`): the node's `WorkspaceRealmHost` reads
 * `requests[nodeId]` here and applies it once the node's stores have what it
 * needs.
 */
export interface RealmRequestsOptions {
  /** The node is shown in the window's own tree (`InTreeWorkspace`), over a loopback. */
  readonly inTree?: boolean;
}

export function useRealmRequests(
  nodeId: string,
  send: ((message: ShellToRealmMessage) => void) | null,
  shown: boolean,
  { inTree = false }: RealmRequestsOptions = {},
) {
  const request = useRemoteWorkspaceStore((state) => state.requests[nodeId]);
  const sidebarOpen = useUIChromeStore((state) => state.sidebarOpen);
  const filesPanelOpen = useFilesPanelChromeStore((state) => state.isOpen);
  // The phone layout's files panel is a full-screen sheet of this window's own
  // node, and a realm shows none there, so the state is only shared on desktop.
  const phoneLayout = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  const grouping = useWindowGrouping();
  const delivered = useRef(0);
  const ready = useRef(false);
  const selection = useRef<Omit<RealmSelectRequest, "type">>({});
  // The latest values, for the callbacks below; kept current after each render.
  const latest = useRef({
    request,
    sidebarOpen,
    filesPanelOpen,
    phoneLayout,
    grouping,
    shown,
    send,
  });
  useLayoutEffect(() => {
    latest.current = { request, sidebarOpen, filesPanelOpen, phoneLayout, grouping, shown, send };
  });

  const flush = useCallback(() => {
    // In the window's tree the node's host reads the request from the window's store.
    if (inTree) return;
    const { request: current, send: deliver } = latest.current;
    if (!deliver || !ready.current || !current || current.seq <= delivered.current) return;
    delivered.current = current.seq;
    selection.current = selectRequest(current);
    deliver(current.request);
  }, [inTree]);

  useEffect(() => {
    flush();
  }, [flush, request, send]);

  useEffect(() => {
    if (send && ready.current && !inTree) send({ type: "sidebar", open: sidebarOpen });
  }, [inTree, send, sidebarOpen]);

  useEffect(() => {
    if (send && ready.current && !phoneLayout && !inTree)
      send({ type: "filesPanel", open: filesPanelOpen });
  }, [inTree, send, filesPanelOpen, phoneLayout]);

  useEffect(() => {
    if (send && ready.current && !inTree) send({ type: "grouping", grouping });
  }, [inTree, send, grouping]);

  // In the window's tree the document's visibility is the window's; whether
  // the node is shown is the window's selection, which its scope's tier follows (4002).
  useEffect(() => {
    if (send && ready.current && !inTree) send({ type: "visibility", hidden: !shown });
  }, [inTree, send, shown]);

  // Retain only the latest intent while a document is loading or restarting.
  const panelRequest = useRemoteWorkspaceStore((state) => state.panelRequests[nodeId]);
  const deliveredPanel = useRef(0);
  const flushPanel = useCallback(
    (allowFocusReturn = false) => {
      const current = useRemoteWorkspaceStore.getState().panelRequests[nodeId];
      const deliver = latest.current.send;
      if (!deliver || !ready.current || !current || current.seq <= deliveredPanel.current) return;
      deliveredPanel.current = current.seq;
      const { seq, panel, open, inset, restoreFocus } = current;
      deliver({
        type: "panel",
        seq,
        panel,
        open,
        inset,
        ...(restoreFocus && allowFocusReturn ? { restoreFocus } : {}),
      });
    },
    [nodeId],
  );
  useEffect(() => {
    flushPanel(true);
  }, [flushPanel, panelRequest, send]);

  /** A new realm document: it was opened on the latest request and is not listening yet. */
  const restart = useCallback(() => {
    const wasReady = ready.current;
    ready.current = false;
    // Cancel the previous document's pending opens as well as its reported panel.
    const state = useRemoteWorkspaceStore.getState();
    const panel = realmPanel(state, nodeId);
    if (wasReady && panel) state.requestRealmPanel(nodeId, panel, false, 0);
    const titleBar = state.titleBars[nodeId];
    if (titleBar) state.noteRealmTitleBar(nodeId, { ...titleBar, panel: null });
    // The new document's URL carries the whole request (every field crosses
    // both encoders; `@orkestrator/protocol/realm-request`), so it counts as
    // delivered and is not sent again on `ready`.
    const request = latest.current.request;
    if (request && request.seq > delivered.current) {
      delivered.current = request.seq;
      selection.current = selectRequest(request);
      return selection.current;
    }
    // Before readiness, an effect replay or failed load must keep the initial
    // landing tab (and any dialog) on the document that actually opens.
    // After readiness, dialogs are one-shot; a replacement resumes the selection.
    if (wasReady) {
      const { projectId, environmentId } = selection.current;
      selection.current = { projectId, environmentId };
    }
    return selection.current;
  }, [nodeId]);

  const onMessage = useCallback(
    (value: unknown) => {
      const message = parseRealmMessage(value);
      if (!message) return;
      if (message.type === "ready") {
        ready.current = true;
        if (!inTree) latest.current.send?.({ type: "sidebar", open: latest.current.sidebarOpen });
        if (!latest.current.phoneLayout && !inTree) {
          latest.current.send?.({ type: "filesPanel", open: latest.current.filesPanelOpen });
        }
        if (!inTree) latest.current.send?.({ type: "grouping", grouping: latest.current.grouping });
        if (!inTree) latest.current.send?.({ type: "visibility", hidden: !latest.current.shown });
        flush();
        flushPanel();
      } else if (message.type === "selection") {
        selection.current = {
          projectId: message.projectId ?? undefined,
          environmentId: message.environmentId ?? undefined,
        };
        useRemoteWorkspaceStore.getState().noteRealmSelection(nodeId, message);
      } else if (message.type === "sidebar") {
        // In the window's tree the toolbar writes the window's store itself.
        if (!inTree) useUIChromeStore.getState().setSidebarOpen(message.open);
      } else if (message.type === "filesPanel") {
        if (latest.current.phoneLayout || inTree) return;
        if (useFilesPanelChromeStore.getState().isOpen !== message.open) {
          useFilesPanelChromeStore.setState({ isOpen: message.open });
        }
      } else if (message.type === "settings") {
        if (isGlobalSettingsSection(message.section)) requestGlobalSettings(message.section);
      } else if (message.type === "bugReport") {
        openBugReport(message.nodeId);
      } else if (message.type === "shortcut") {
        // ⌘K typed in the realm: the search it opens is this window's.
        requestAppShortcut(message.shortcut);
      } else if (message.type === "panelDismissed") {
        const state = useRemoteWorkspaceStore.getState();
        const request = state.panelRequests[nodeId];
        // A delayed close from a replaced panel or hidden realm cannot steal focus.
        if (
          state.active?.nodeId === nodeId &&
          request?.open &&
          request.panel === message.panel &&
          request.seq === message.seq
        ) {
          state.requestRealmPanel(nodeId, message.panel, false, request.inset, true);
        }
      } else if (message.type === "titleBar") {
        useRemoteWorkspaceStore.getState().noteRealmTitleBar(nodeId, {
          usage: message.usage,
          usageStale: message.usageStale,
          panel: message.panel,
          requestSeq: message.requestSeq,
        });
      } else if (message.workTarget && message.environmentId) {
        openCoordinatorWorkTarget({
          type: "remote",
          nodeId: message.nodeId,
          projectId: message.projectId,
          environmentId: message.environmentId,
          title: message.title,
          workTarget: message.workTarget,
        });
      } else {
        openMachineWorkspace({
          connectionId: message.nodeId,
          projectId: message.projectId,
          ...(message.environmentId ? { environmentId: message.environmentId } : {}),
          ...(message.boardTab ? { boardTab: message.boardTab } : {}),
          title: message.title,
          workTarget: message.workTarget,
        });
      }
    },
    [flush, flushPanel, inTree, nodeId],
  );

  return { restart, onMessage };
}

export function RealmStatus({
  failure,
  machine,
  onRetry,
}: {
  failure: string | null;
  machine: string;
  onRetry: () => void;
}) {
  if (!failure) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
        Opening {machine}…
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm"
    >
      <p className="flex items-center gap-2 text-destructive">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        {failure}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
