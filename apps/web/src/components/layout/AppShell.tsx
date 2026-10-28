import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePanelRef } from "react-resizable-panels";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Sidebar } from "./Sidebar";
import { ActionBar } from "./ActionBar";
import { OpenFileDialog } from "./OpenFileDialog";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { FilesPanel } from "@/components/files-panel";
import {
  useConfigStore,
  useEnvironmentStore,
  useFilesPanelStore,
  usePaneLayoutStore,
  useProjectStore,
  useUIStore,
  getAllLeaves,
} from "@/stores";
import { useMediaQuery } from "@/hooks";
import {
  PULL_REQUEST_PANEL_MIN_WIDTH_PX,
  PULL_REQUEST_PANEL_WIDTH_PX,
} from "@/stores/filesPanelStore";
import { DEFAULT_TERMINAL_APPEARANCE, resolveTerminalBackgroundColor } from "@/constants/terminal";
import { getCurrentWindow } from "@/lib/native/window";
import { cn } from "@/lib/utils";
import { MOBILE_SHELL_MEDIA_QUERY, MobileAppShellLayout } from "./MobileAppShellLayout";
import { getApplicationTitle } from "@/lib/application-title";
import { AgentInfoButton } from "./AgentInfoButton";
import { AgentMailButton } from "@/components/agent-mail/AgentMailButton";
import { AgentMailPanel } from "@/components/agent-mail/AgentMailPanel";
import { SystemUsageIndicator } from "./SystemUsageIndicator";
import { HostPark, HostSlot } from "./HostSlot";
import { AppDialogHost } from "./AppDialogHost";
import { RemoteWorkspaceRegion } from "@/components/federation/RemoteWorkspaceRegion";
import {
  RealmAgentInfoTrigger,
  RealmSystemUsageMeters,
  RealmTitleBarPanels,
  useRealmPanelDismiss,
} from "@/components/federation/RealmTitleBar";
import { useFederation } from "@/components/federation/FederationProvider";
import { isWorkspaceRealm } from "@/lib/federation/workspace-realm";
import { retainAppShortcutRouter, setUnhandledAppShortcut } from "@/lib/app-shortcuts";
import {
  useRemoteWorkspaceStore,
  type RemoteWorkspaceSelection,
} from "@/stores/remoteWorkspaceStore";

interface AppShellProps {
  children?: React.ReactNode;
}

/** Wide enough for a pull request opened in the panel; files views stay narrow by choice. */
const FILES_PANEL_MAX_SIZE = "960px";

/**
 * Widens a narrow files panel when it shows a pull request, once per opened
 * tab, so the user's own narrower width for files is otherwise kept.
 */
function useFilesPanelPullRequestWidth(open: boolean) {
  const panelRef = usePanelRef();
  const activeTab = useFilesPanelStore((state) => state.activeTab);
  const showsPullRequest = open && activeTab.startsWith("pull-request:");
  useEffect(() => {
    if (!showsPullRequest) return;
    // A panel that opens with this tab registers with its group after this
    // effect runs, and reading its size before then throws. Retry for a few
    // frames; widening is cosmetic, so giving up is safe.
    let frame = 0;
    let attempts = 0;
    const widen = () => {
      const panel = panelRef.current;
      try {
        if (panel && panel.getSize().inPixels < PULL_REQUEST_PANEL_MIN_WIDTH_PX) {
          panel.resize(`${PULL_REQUEST_PANEL_WIDTH_PX}px`);
        }
        if (panel) return;
      } catch {
        // Not laid out yet.
      }
      if (++attempts < 10) frame = requestAnimationFrame(widen);
    };
    frame = requestAnimationFrame(widen);
    return () => cancelAnimationFrame(frame);
  }, [panelRef, showsPullRequest, activeTab]);
  return panelRef;
}

/** Names of the other node's project and environment the central region shows. */
function useRemoteWorkspaceNames(active: RemoteWorkspaceSelection | null) {
  const { portalState } = useFederation();
  return useMemo(() => {
    if (!active) return null;
    const node = portalState.nodes.find((candidate) => candidate.nodeId === active.nodeId);
    const project = node?.projects.find(
      (candidate) => candidate.ref.projectId === active.projectId,
    );
    const environment = node?.environments.find(
      (candidate) => candidate.ref.environmentId === active.environmentId,
    );
    return { projectName: project?.name ?? null, environmentName: environment?.name ?? null };
  }, [active, portalState.nodes]);
}

export function AppShell({ children }: AppShellProps) {
  const isMobile = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  // Another node's workspace inside a command node's window: only the
  // central region, without the window's title bar and sidebar.
  const [workspaceRealm] = useState(isWorkspaceRealm);
  // In the window: the other node whose workspace the central region shows.
  // The title bar, toolbar row and sidebar around it stay the command node's.
  const remoteWorkspace = useRemoteWorkspaceStore((state) =>
    workspaceRealm ? null : state.active,
  );
  const remoteNames = useRemoteWorkspaceNames(remoteWorkspace);
  const [centralColumn, setCentralColumn] = useState<HTMLDivElement | null>(null);
  const [mobileContent, setMobileContent] = useState<HTMLDivElement | null>(null);
  // The desktop and mobile layouts are different trees, so rendering `children`
  // in each would remount every pane at the 768px breakpoint, closing dialogs
  // and dropping pane state when a window narrows or a phone rotates. The
  // content renders once into this host instead, and the layouts only move it
  // (see `HostSlot`, which also keeps scroll offsets and focus across the move).
  const [contentHost] = useState(() => {
    const host = document.createElement("div");
    host.className = "h-full w-full";
    return host;
  });
  const contentParkRef = useRef<HTMLDivElement>(null);
  // The mobile drawer opens with the layout only on a phone-sized first load;
  // a window that narrows keeps showing what the user was working on.
  const [desktopShown, setDesktopShown] = useState(!isMobile);
  if (!isMobile && !desktopShown) setDesktopShown(true);
  const filesPanelOpen = useFilesPanelStore((state) => state.isOpen);
  const filesPanelRef = useFilesPanelPullRequestWidth(filesPanelOpen);
  const sidebarOpen = useUIStore((state) => state.sidebarOpen);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const paneEnvironments = usePaneLayoutStore((state) => state.environments);
  const activeProjectName = useProjectStore((state) =>
    selectedProjectId
      ? (state.projects.find((project) => project.id === selectedProjectId)?.name ?? null)
      : null,
  );
  const activeEnvironmentName = useEnvironmentStore((state) =>
    selectedEnvironmentId
      ? (state.environments.find((environment) => environment.id === selectedEnvironmentId)?.name ??
        null)
      : null,
  );
  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ??
    DEFAULT_TERMINAL_APPEARANCE;

  const panelBackgroundColor = resolveTerminalBackgroundColor(terminalAppearance.backgroundColor);

  const centralPanelThemeVars = useMemo(
    () =>
      ({
        "--color-background": panelBackgroundColor,
        "--color-card": panelBackgroundColor,
        "--color-popover": panelBackgroundColor,
        "--color-muted": panelBackgroundColor,
        "--color-secondary": panelBackgroundColor,
        "--color-accent": panelBackgroundColor,
        "--color-input": panelBackgroundColor,
      }) as React.CSSProperties,
    [panelBackgroundColor],
  );

  const handleTitleBarMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;

    void getCurrentWindow().startDragging();
  };

  const windowTitle = getApplicationTitle(
    remoteNames ? remoteNames.projectName : activeProjectName,
    isMobile,
    remoteNames ? remoteNames.environmentName : activeEnvironmentName,
    import.meta.env.VITE_ORKESTRATOR_PROFILE?.trim() || null,
  );
  const activeTab = useMemo(() => {
    if (!selectedEnvironmentId) return null;
    const environment = paneEnvironments.get(selectedEnvironmentId);
    if (!environment) return null;
    const leaves = getAllLeaves(environment.root);
    const activePane = leaves.find((leaf) => leaf.id === environment.activePaneId) ?? null;
    if (!activePane?.activeTabId) return null;
    return activePane.tabs.find((tab) => tab.id === activePane.activeTabId) ?? null;
  }, [paneEnvironments, selectedEnvironmentId]);

  // App shortcuts work wherever focus is in this document (`app-shortcuts.ts`).
  useEffect(() => retainAppShortcutRouter(), []);
  useEffect(() => {
    // ⌘K with the sidebar hidden shows it, with the search open. A realm
    // forwards ⌘K to the window; the phone layout's drawer stays closed.
    if (workspaceRealm || isMobile) return;
    return setUnhandledAppShortcut((id) => {
      const ui = useUIStore.getState();
      if (id !== "search-projects" || ui.sidebarOpen) return false;
      ui.toggleSidebar();
      return true;
    });
  }, [isMobile, workspaceRealm]);

  useEffect(() => {
    // A realm's document title is not shown; the window's is.
    if (!workspaceRealm) document.title = windowTitle;
  }, [windowTitle, workspaceRealm]);
  useRealmPanelDismiss(isMobile ? null : (remoteWorkspace?.nodeId ?? null));

  if (workspaceRealm) {
    return (
      <div className="flex h-full w-full flex-col overflow-hidden">
        <OpenFileDialog />
        <KeyboardShortcutsDialog />
        <AppDialogHost />
        {/* The node's tabs and their mail live here; the messages panel opens over the realm. */}
        <AgentMailPanel />
        <HostPark parkRef={contentParkRef} />
        {/*
          The window's title bar shows this node's host meters and agent
          button, as it does for its own node's environments; their popovers
          open here, under it.
        */}
        <RealmTitleBarPanels activeTab={activeTab} />
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
          <ResizablePanel defaultSize={filesPanelOpen ? 70 : 100} minSize={30}>
            <div className="flex h-full flex-col" style={centralPanelThemeVars}>
              <ActionBar />
              <main className="min-h-0 flex-1 overflow-hidden bg-background">
                <HostSlot host={contentHost} parkRef={contentParkRef} />
              </main>
            </div>
          </ResizablePanel>
          {filesPanelOpen && !isMobile && (
            <>
              <ResizableHandle />
              <ResizablePanel
                defaultSize={30}
                minSize="240px"
                maxSize={FILES_PANEL_MAX_SIZE}
                panelRef={filesPanelRef}
              >
                <FilesPanel />
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
        {createPortal(children, contentHost)}
      </div>
    );
  }

  const remoteShown = remoteWorkspace !== null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <OpenFileDialog />
      <KeyboardShortcutsDialog />
      {/* Outside both layouts, so a dialog outlives the drawer that requested it. */}
      <AppDialogHost />
      <AgentMailPanel />
      <HostPark parkRef={contentParkRef} />
      {isMobile ? (
        <MobileAppShellLayout
          selectedProjectId={selectedProjectId}
          selectedEnvironmentId={selectedEnvironmentId}
          title={windowTitle}
          filesPanelOpen={filesPanelOpen}
          centralPanelStyle={centralPanelThemeVars}
          actionBar={<ActionBar presentation="grid" />}
          agentInfoButton={
            <div className="flex items-center gap-1">
              <AgentMailButton />
              <AgentInfoButton activeTab={activeTab} mobile />
            </div>
          }
          sidebar={<Sidebar />}
          filesPanel={<FilesPanel />}
          initialSidebarOpen={!desktopShown}
          onTitleBarMouseDown={handleTitleBarMouseDown}
        >
          <div
            ref={setMobileContent}
            className={cn("h-full w-full", remoteShown && "invisible")}
            aria-hidden={remoteShown || undefined}
          >
            <HostSlot host={contentHost} parkRef={contentParkRef} />
          </div>
        </MobileAppShellLayout>
      ) : (
        <>
          <div
            className="relative flex h-[var(--desktop-title-bar-height)] w-full shrink-0 items-center justify-start gap-2 border-b border-border/80 bg-chrome pl-[var(--desktop-title-bar-inset)] pr-1.5"
            data-backend-drag-region
            onMouseDown={handleTitleBarMouseDown}
            style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          >
            {/*
              `--desktop-title-bar-inset` is 96px only on darwin, where
              `titleBarStyle: "hiddenInset"` owns the traffic lights. Other
              platforms keep a normal gutter. The bottom border matches the
              toolbar's own edge so the two chrome rows read as one frame.
            */}
            <span
              className="min-w-0 truncate text-xs font-medium text-muted-foreground"
              data-backend-drag-region
            >
              {windowTitle}
            </span>
            {/*
              The title bar is a drag region: every left mouse-down on it calls
              `startDragging()`. A nested control inherits that, so without the
              `no-drag` app region *and* the mouse-down stop the info button
              would drag the window instead of opening. `MobileAppShellLayout`
              wraps the same slot the same way. The slot is pushed right with
              `ml-auto` rather than being absolutely positioned, so the extra
              system meters always reserve their own space instead of
              overlapping the title.
            */}
            <div
              className="ml-auto flex shrink-0 items-center"
              data-testid="desktop-agent-info-slot"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              onMouseDown={(event) => event.stopPropagation()}
            >
              {/*
                Another node's workspace reports its agent and machine, so
                they show here as this node's do.
              */}
              {remoteWorkspace ? (
                <RealmSystemUsageMeters nodeId={remoteWorkspace.nodeId} region={centralColumn} />
              ) : (
                <SystemUsageIndicator />
              )}
              <span
                aria-hidden="true"
                data-testid="title-bar-usage-separator"
                className="mx-2 h-3 w-px self-center bg-border/50"
              />
              <div className="flex items-center gap-1">
                <AgentMailButton />
                {remoteWorkspace ? (
                  <RealmAgentInfoTrigger nodeId={remoteWorkspace.nodeId} region={centralColumn} />
                ) : (
                  <AgentInfoButton activeTab={activeTab} />
                )}
              </div>
            </div>
          </div>
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
            {/* Sidebar Panel */}
            {sidebarOpen && (
              <>
                <ResizablePanel defaultSize={28} minSize="280px" maxSize="400px">
                  <Sidebar />
                </ResizablePanel>

                {/* Resize Handle */}
                <ResizableHandle />
              </>
            )}

            {/* Main Content Panel */}
            <ResizablePanel defaultSize={filesPanelOpen && !remoteShown ? 50 : 78} minSize={30}>
              {/*
                Under another node's workspace this window's own stays mounted
                (its selection cleared), hidden; that workspace covers it.
              */}
              <div
                ref={setCentralColumn}
                className={cn("flex h-full flex-col", remoteShown && "invisible")}
                aria-hidden={remoteShown || undefined}
                style={centralPanelThemeVars}
              >
                <ActionBar />
                <main className={cn("flex-1 overflow-hidden bg-background")}>
                  <HostSlot host={contentHost} parkRef={contentParkRef} />
                </main>
              </div>
            </ResizablePanel>

            {/* Files Panel (conditional); another node's workspace has its own. */}
            {filesPanelOpen && !remoteShown && (
              <>
                <ResizableHandle />
                <ResizablePanel
                  defaultSize={22}
                  minSize="240px"
                  maxSize={FILES_PANEL_MAX_SIZE}
                  panelRef={filesPanelRef}
                >
                  <FilesPanel />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </>
      )}
      {/* Outside both layouts, so a realm is never moved (a moved frame reloads). */}
      <RemoteWorkspaceRegion anchor={isMobile ? mobileContent : centralColumn} />
      {/* After the layouts, so a slot holds the host before content effects run. */}
      {createPortal(children, contentHost)}
    </div>
  );
}
