import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { requestAppShortcut } from "@/lib/app-shortcuts";
import { openBugReport } from "@/lib/bug-report/open-bug-report";
import { openMachineWorkspace } from "@/lib/federation/open-workspace";
import {
  frameEnvelope,
  parseRealmMessage,
  readFrameEnvelope,
  realmSearchParams,
  type RealmGrouping,
  type RealmSelectRequest,
  type ShellToRealmMessage,
} from "@/lib/federation/workspace-realm";
import { MOBILE_SHELL_MEDIA_QUERY } from "@/lib/mobile-shell";
import { isGlobalSettingsSection, requestGlobalSettings } from "@/lib/settings-navigation";
import { useFilesPanelStore } from "@/stores/filesPanelStore";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { useUIStore } from "@/stores/uiStore";
import {
  closeLeafWorkspace,
  keepWorkspaceAlive,
  openLeafWorkspace,
  type LeafWorkspace,
} from "@/lib/portal/workspaces";
import { removeRealmWorkspace, writeRealmWorkspace } from "@/lib/portal/workspace-target-storage";
import { cn } from "@/lib/utils";
import {
  startRemoteWorkspaceSelectionSync,
  useRemoteWorkspaceStore,
  realmPanel,
  type RealmRequest,
} from "@/stores/remoteWorkspaceStore";
import { useFederation } from "./FederationProvider";
import { useOverlayOverRegion } from "./useOverlayOverRegion";

type Rect = { x: number; y: number; width: number; height: number };

/** How long to wait for a backdrop after the live view steps aside. */
const STILL_CAPTURE_TIMEOUT_MS = 250;

/**
 * The central region's workspaces of other nodes (see
 * `lib/federation/workspace-realm.ts`). It is rendered once, outside the
 * window's layouts, and placed over `anchor` — the central region of the
 * current layout — so a realm is never moved in the page (a moved frame would
 * reload). Realms that are not shown stay open behind it, hidden.
 */
export function RemoteWorkspaceRegion({ anchor }: { anchor: HTMLElement | null }) {
  const { kind, portalState } = useFederation();
  const realms = useRemoteWorkspaceStore((state) => state.realms);
  const activeNodeId = useRemoteWorkspaceStore((state) => state.active?.nodeId ?? null);
  const rect = useAnchorRect(activeNodeId ? anchor : null);

  // While another node's workspace may be shown, a selection of the window's
  // own brings the central region back to it.
  const anyRealm = realms.length > 0;
  useEffect(() => (anyRealm ? startRemoteWorkspaceSelectionSync() : undefined), [anyRealm]);
  // A machine removed from the command node takes its realm with it.
  useEffect(() => {
    if (!portalState.loaded) return;
    for (const nodeId of realms) {
      if (!portalState.nodes.some((node) => node.nodeId === nodeId)) {
        useRemoteWorkspaceStore.getState().closeRealm(nodeId);
      }
    }
  }, [portalState.loaded, portalState.nodes, realms]);

  if (kind === "none" || realms.length === 0) return null;
  const shown = activeNodeId !== null && rect !== null;
  return (
    <div
      className={cn("fixed z-10 bg-background", !shown && "hidden")}
      style={rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : {}}
      data-testid="remote-workspace-region"
      data-node={activeNodeId ?? undefined}
    >
      {realms.map((nodeId) =>
        kind === "desktop" ? (
          <NativeRealm
            key={nodeId}
            nodeId={nodeId}
            shown={shown && nodeId === activeNodeId}
            rect={rect}
          />
        ) : (
          <FrameRealm key={nodeId} nodeId={nodeId} shown={shown && nodeId === activeNodeId} />
        ),
      )}
    </div>
  );
}

/** The anchor's viewport rect, following resizes of the window and its panels. */
function useAnchorRect(anchor: HTMLElement | null): Rect | null {
  const [measured, setMeasured] = useState<{ anchor: HTMLElement; rect: Rect } | null>(null);
  useLayoutEffect(() => {
    if (!anchor) return;
    let frame = 0;
    const measure = () => {
      const next = anchor.getBoundingClientRect();
      setMeasured((current) =>
        current?.anchor === anchor &&
        current.rect.x === next.left &&
        current.rect.y === next.top &&
        current.rect.width === next.width &&
        current.rect.height === next.height
          ? current
          : {
              anchor,
              rect: { x: next.left, y: next.top, width: next.width, height: next.height },
            },
      );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(anchor);
    // Panels to its left change its position without changing its size.
    if (anchor.parentElement) observer.observe(anchor.parentElement);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [anchor]);
  return anchor && measured?.anchor === anchor ? measured.rect : null;
}

function nodeName(nodes: readonly { nodeId: string; view: { displayName: string } }[], id: string) {
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
 * state for every machine, and its grouping, which decides whether the node's
 * coordinator opens directly.
 */
function useRealmRequests(nodeId: string, send: ((message: ShellToRealmMessage) => void) | null) {
  const request = useRemoteWorkspaceStore((state) => state.requests[nodeId]);
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const filesPanelOpen = useFilesPanelStore((state) => state.isOpen);
  // The phone layout's files panel is a full-screen sheet of this window's own
  // node, and a realm shows none there, so the state is only shared on desktop.
  const phoneLayout = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  const storedGrouping = useMachineViewStore((state) => state.grouping);
  const sortMode = useUIStore((state) => state.environmentSortMode);
  const grouping: RealmGrouping = sortMode === "activity" ? "activity" : storedGrouping;
  const delivered = useRef(0);
  const ready = useRef(false);
  const selection = useRef<Omit<RealmSelectRequest, "type">>({});
  // The latest values, for the callbacks below; kept current after each render.
  const latest = useRef({ request, sidebarOpen, filesPanelOpen, phoneLayout, grouping, send });
  useLayoutEffect(() => {
    latest.current = { request, sidebarOpen, filesPanelOpen, phoneLayout, grouping, send };
  });

  const flush = useCallback(() => {
    const { request: current, send: deliver } = latest.current;
    if (!deliver || !ready.current || !current || current.seq <= delivered.current) return;
    delivered.current = current.seq;
    selection.current = selectRequest(current);
    deliver(current.request);
  }, []);

  useEffect(() => {
    flush();
  }, [flush, request, send]);

  useEffect(() => {
    if (send && ready.current) send({ type: "sidebar", open: sidebarOpen });
  }, [send, sidebarOpen]);

  useEffect(() => {
    if (send && ready.current && !phoneLayout) send({ type: "filesPanel", open: filesPanelOpen });
  }, [send, filesPanelOpen, phoneLayout]);

  useEffect(() => {
    if (send && ready.current) send({ type: "grouping", grouping });
  }, [send, grouping]);

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
        latest.current.send?.({ type: "sidebar", open: latest.current.sidebarOpen });
        if (!latest.current.phoneLayout) {
          latest.current.send?.({ type: "filesPanel", open: latest.current.filesPanelOpen });
        }
        latest.current.send?.({ type: "grouping", grouping: latest.current.grouping });
        flush();
        flushPanel();
      } else if (message.type === "selection") {
        selection.current = {
          projectId: message.projectId ?? undefined,
          environmentId: message.environmentId ?? undefined,
        };
        useRemoteWorkspaceStore.getState().noteRealmSelection(nodeId, message);
      } else if (message.type === "sidebar") {
        const ui = useUIStore.getState();
        if (ui.sidebarOpen !== message.open) ui.toggleSidebar();
      } else if (message.type === "filesPanel") {
        if (latest.current.phoneLayout) return;
        if (useFilesPanelStore.getState().isOpen !== message.open) {
          useFilesPanelStore.setState({ isOpen: message.open });
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
      } else {
        openMachineWorkspace({
          connectionId: message.nodeId,
          projectId: message.projectId,
          ...(message.environmentId ? { environmentId: message.environmentId } : {}),
          ...(message.boardTab ? { boardTab: message.boardTab } : {}),
          title: message.title,
        });
      }
    },
    [flush, flushPanel, nodeId],
  );

  return { restart, onMessage };
}

function RealmStatus({
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

/**
 * Desktop: a child view of this window with its own connection scope, bound
 * to the node's workspace by the main process and placed over the region.
 */
function NativeRealm({
  nodeId,
  shown,
  rect,
}: {
  nodeId: string;
  shown: boolean;
  rect: Rect | null;
}) {
  const { portalState } = useFederation();
  const [api] = useState(() => window.orkestrator?.workspaceViews ?? null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(
    api ? null : "This window cannot show other machines' workspaces.",
  );
  const [loaded, setLoaded] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // A native view paints above the page, so it steps aside for this window's
  // dialogs and menus that reach over it. A captured still fills in the
  // backdrop when available; the overlay must be usable immediately.
  const overlay = useOverlayOverRegion(shown && viewId ? rect : null);
  const [still, setStill] = useState<{ overlay: number; url: string | null } | null>(null);
  const send = useMemo(
    () =>
      viewId
        ? (message: ShellToRealmMessage) => {
            void api?.send(viewId, message).catch(() => undefined);
          }
        : null,
    [api, viewId],
  );
  const { restart, onMessage } = useRealmRequests(nodeId, send);

  useEffect(() => {
    if (!api) return;
    let disposed = false;
    let opened: string | null = null;
    const unsubscribe = api.onEvent((event) => {
      if (event.viewId !== opened) return;
      if (event.type === "message") {
        if (parseRealmMessage(event.message)?.type === "ready") setLoaded(true);
        onMessage(event.message);
        return;
      }
      // Also close defensively when paired with a main process that only notifies.
      if (event.type !== "closed" && opened) void api.close(opened).catch(() => undefined);
      opened = null;
      setViewId(null);
      restart();
      // Closed by the window's main process (its command node changed): gone.
      if (event.type === "closed") {
        useRemoteWorkspaceStore.getState().closeRealm(nodeId);
        return;
      }
      setFailure(
        event.type === "crashed"
          ? "This workspace stopped responding."
          : "This workspace could not load.",
      );
    });
    void api
      .open({ nodeId, request: restart() })
      .then((result) => {
        if (disposed) {
          void api.close(result.viewId).catch(() => undefined);
          return;
        }
        opened = result.viewId;
        setViewId(result.viewId);
      })
      .catch((error: unknown) => {
        if (!disposed) setFailure(error instanceof Error ? error.message : String(error));
      });
    return () => {
      disposed = true;
      unsubscribe();
      if (opened) void api.close(opened).catch(() => undefined);
    };
  }, [api, attempt, nodeId, onMessage, restart]);

  useEffect(() => {
    if (overlay === null || !api || !viewId) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bound how long this overlay episode waits for a backdrop.
    const giveUp = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), STILL_CAPTURE_TIMEOUT_MS);
    });
    void Promise.race([api.capture(viewId).catch(() => null), giveUp]).then((url) => {
      clearTimeout(timer);
      if (current) setStill({ overlay, url });
    });
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [api, overlay, viewId]);
  const covered = overlay !== null;

  useEffect(() => {
    if (!api || !viewId) return;
    const visible = shown && !covered && rect !== null && rect.width > 0 && rect.height > 0;
    if (rect) void api.setBounds(viewId, rect).catch(() => undefined);
    void api.setVisible(viewId, visible).catch(() => undefined);
  }, [api, covered, rect, shown, viewId]);

  if (shown && covered && still?.overlay === overlay && still.url) {
    return (
      <img
        src={still.url}
        alt=""
        aria-hidden="true"
        draggable={false}
        className="pointer-events-none absolute inset-0 h-full w-full select-none"
        data-testid="workspace-realm-still"
      />
    );
  }
  if (!shown || (viewId && loaded && !failure)) return null;
  return (
    <div className="absolute inset-0" data-testid="native-workspace-realm">
      <RealmStatus
        failure={failure}
        machine={nodeName(portalState.nodes, nodeId)}
        onRetry={() => {
          setFailure(null);
          setLoaded(false);
          setAttempt((value) => value + 1);
        }}
      />
    </div>
  );
}

/**
 * Browser and iOS: a same-origin frame of this client, on a short-lived
 * workspace grant from the command node. It talks to the node directly when
 * it can, otherwise through the command node's relay. Closing it revokes the
 * grant; the node's work keeps running.
 */
function FrameRealm({ nodeId, shown }: { nodeId: string; shown: boolean }) {
  const { boundMachine, portalState } = useFederation();
  const [opened, setOpened] = useState<{
    workspace: LeafWorkspace;
    request: Omit<RealmSelectRequest, "type">;
  } | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const workspaceId = opened?.workspace.workspaceId ?? null;
  // The name only labels the path; a late profile load must not reopen the workspace.
  const commandNodeName = useEffectEvent(() => boundMachine?.name ?? "");

  const send = useMemo(
    () =>
      workspaceId
        ? (message: ShellToRealmMessage) => {
            frameRef.current?.contentWindow?.postMessage(
              frameEnvelope(workspaceId, message),
              window.location.origin,
            );
          }
        : null,
    [workspaceId],
  );
  const { restart, onMessage } = useRealmRequests(nodeId, send);

  useEffect(() => {
    let disposed = false;
    let current: LeafWorkspace | null = null;
    let stopRenewal: (() => void) | null = null;
    const release = (workspace: LeafWorkspace) => {
      removeRealmWorkspace(workspace.workspaceId);
      void closeLeafWorkspace(workspace.workspaceId);
    };
    const open = async (): Promise<void> => {
      const workspace = await openLeafWorkspace(nodeId as never, {
        commandNodeName: commandNodeName(),
      });
      if (disposed) {
        void closeLeafWorkspace(workspace.workspaceId);
        return;
      }
      try {
        writeRealmWorkspace(workspace);
      } catch (error) {
        await closeLeafWorkspace(workspace.workspaceId);
        throw error;
      }
      const previous = current;
      current = workspace;
      stopRenewal?.();
      // A lapsed grant is replaced; the frame reloads on the new one.
      stopRenewal = keepWorkspaceAlive(workspace.workspaceId, open);
      setOpened({ workspace, request: restart() });
      if (previous) release(previous);
    };
    open().catch((error: unknown) => {
      if (!disposed) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => {
      disposed = true;
      stopRenewal?.();
      if (current) release(current);
      setOpened(null);
    };
  }, [attempt, nodeId, restart]);

  useEffect(() => {
    if (!workspaceId) return;
    const listener = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const envelope = readFrameEnvelope(event.data);
      if (envelope?.workspaceId === workspaceId) onMessage(envelope.message);
    };
    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, [onMessage, workspaceId]);

  const src = useMemo(() => {
    if (!opened) return null;
    const url = new URL(window.location.href);
    url.hash = "";
    const search = realmSearchParams(opened.request);
    search.set("workspace", opened.workspace.workspaceId);
    url.search = search.toString();
    return url.toString();
  }, [opened]);

  return (
    <div className={cn("absolute inset-0", !shown && "hidden")} data-testid="frame-workspace-realm">
      {failure || !src ? (
        <RealmStatus
          failure={failure}
          machine={nodeName(portalState.nodes, nodeId)}
          onRetry={() => {
            setFailure(null);
            setAttempt((value) => value + 1);
          }}
        />
      ) : (
        <iframe
          ref={frameRef}
          className="absolute inset-0 h-full w-full border-0"
          title={`Workspace on ${nodeName(portalState.nodes, nodeId)}`}
          src={src}
          allow="clipboard-read; clipboard-write"
          data-connection-path={opened?.workspace.path}
        />
      )}
    </div>
  );
}
