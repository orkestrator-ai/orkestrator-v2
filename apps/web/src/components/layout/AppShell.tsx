import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import { Sidebar } from "./Sidebar";
import { ActionBar } from "./ActionBar";
import { OpenFileDialog } from "./OpenFileDialog";
import { KeyboardShortcutsDialog } from "./KeyboardShortcutsDialog";
import { FilesPanel } from "@/components/files-panel";
import { useEnvironmentStore, useProjectStore, useUIStore } from "@/stores";
import { useUIChromeStore } from "@/stores/uiChromeStore";
import { useMediaQuery } from "@/hooks";
import { useMachineViewStore } from "@/stores/machineViewStore";
import { sidebarPanelConstraints, sidebarPanelMode } from "@/lib/sidebar-width";
import { useSidebarPanelMotion } from "./useSidebarPanelMotion";
import { useFilesPanelChromeStore } from "@/stores/filesPanelChromeStore";
import { getCurrentWindow } from "@/lib/native/window";
import { cn } from "@/lib/utils";
import { MOBILE_SHELL_MEDIA_QUERY, MobileAppShellLayout } from "./MobileAppShellLayout";
import { getApplicationTitle } from "@/lib/application-title";
import {
  useEnvironmentIdNameSignal,
  useShimmerRequiresChecks,
} from "@/hooks/useEnvironmentNameSignal";
import { isNodeEnvironmentReadyToMerge } from "@/lib/pr-merge-readiness";
import { viewFromNodeSummary } from "@/components/federation/useMachineViews";
import { AgentInfoButton } from "./AgentInfoButton";
import { AgentMailButton } from "@/components/agent-mail/AgentMailButton";
import { AgentMailPanel } from "@/components/agent-mail/AgentMailPanel";
import { SystemUsageIndicator } from "./SystemUsageIndicator";
import { HostPark, HostSlot } from "./HostSlot";
import { AppDialogHost } from "./AppDialogHost";
import { GlobalSettingsHost } from "./GlobalSettingsHost";
import { BugReportSheetHost } from "@/components/bug-report/BugReportSheet";
import { MachineCpuReadings } from "@/components/federation/MachineCpuReadings";
import { RemoteWorkspaceRegion } from "@/components/federation/RemoteWorkspaceRegion";
import { useFederation } from "@/components/federation/FederationProvider";
import { NodeTitleBarAgentInfo, NodeTitleBarUsage, useShownInTreeNode } from "./ShownNodeTitleBar";
import {
  retainAppShortcutRouter,
  setShownAppShortcutWorkspace,
  setUnhandledAppShortcut,
} from "@/lib/app-shortcuts";
import { useScopesWithCommandFallback } from "@/lib/node-scope/providers";
import { shownNodeScope } from "@/lib/node-scope/shown-scope";
import {
  useRemoteWorkspaceStore,
  type RemoteWorkspaceSelection,
} from "@/stores/remoteWorkspaceStore";
import {
  FILES_PANEL_MAX_SIZE,
  useCentralPanelThemeVars,
  useFilesPanelPullRequestWidth,
  useWorkspaceActiveTab,
} from "./NodeWorkspaceLayout";

interface AppShellProps {
  children?: React.ReactNode;
}

/** Names of the other node's project and environment the central region shows. */
function useRemoteWorkspaceNames(active: RemoteWorkspaceSelection | null) {
  const { portalState } = useFederation();
  const requireChecks = useShimmerRequiresChecks();
  return useMemo(() => {
    if (!active) return null;
    const node = portalState.nodes.find((candidate) => candidate.nodeId === active.nodeId);
    const project = node?.projects.find(
      (candidate) => candidate.ref.projectId === active.projectId,
    );
    const environment = node?.environments.find(
      (candidate) => candidate.ref.environmentId === active.environmentId,
    );
    return {
      projectName: project?.name ?? null,
      environmentName: environment?.name ?? null,
      readyToMerge:
        node && environment
          ? isNodeEnvironmentReadyToMerge(environment, viewFromNodeSummary(node), requireChecks)
          : false,
    };
  }, [active, portalState.nodes, requireChecks]);
}

export function AppShell({ children }: AppShellProps) {
  const isMobile = useMediaQuery(MOBILE_SHELL_MEDIA_QUERY);
  // The other node whose workspace the central region shows. The title bar,
  // toolbar row and sidebar around it stay the command node's.
  const remoteWorkspace = useRemoteWorkspaceStore((state) => state.active);
  const remoteNames = useRemoteWorkspaceNames(remoteWorkspace);
  // Another node shown in this window's tree has its own ⌘⇧P
  // (`InTreeWorkspace`), and the title bar's meters and popovers are its
  // scope's (plan item 5002).
  const shownInTree = useShownInTreeNode(remoteWorkspace?.nodeId ?? null);
  const inTreeShown = shownInTree !== null;
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
  const filesPanelOpen = useFilesPanelChromeStore((state) => state.isOpen);
  const filesPanelRef = useFilesPanelPullRequestWidth(filesPanelOpen);
  const sidebarOpen = useUIChromeStore((state) => state.sidebarOpen);
  // The phone layout's drawer stays a full list; the choice is kept for desktop widths.
  const compactSidebar = useMachineViewStore((state) => state.grouping === "compact") && !isMobile;
  const sidebarMode = sidebarPanelMode({ sidebarOpen, compact: compactSidebar });
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [sidebarPanelElement, setSidebarPanelElement] = useState<HTMLDivElement | null>(null);
  const sidebarMotion = useSidebarPanelMotion({
    mode: sidebarMode,
    reducedMotion,
    sidebarElement: sidebarPanelElement,
    mainElement: centralColumn,
  });
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
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
  const localNameSignal = useEnvironmentIdNameSignal(selectedEnvironmentId);
  const centralPanelThemeVars = useCentralPanelThemeVars();

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
  const activeTab = useWorkspaceActiveTab();

  // App shortcuts work wherever focus is in this document (`app-shortcuts.ts`).
  useEffect(() => retainAppShortcutRouter(), []);
  // One key router for every node the window shows in its tree: a workspace's
  // shortcut (⌘T) goes to the workspace on show (plan item 5003).
  const { windowScope } = useScopesWithCommandFallback();
  useEffect(() => setShownAppShortcutWorkspace(() => shownNodeScope(windowScope)), [windowScope]);
  useEffect(() => {
    // ⌘K with the sidebar hidden shows it, with the search open. The phone
    // layout's drawer stays closed.
    if (isMobile) return;
    return setUnhandledAppShortcut((id) => {
      const chrome = useUIChromeStore.getState();
      if (chrome.sidebarOpen) return false;
      if (id !== "search-projects" && id !== "rotate-sidebar-grouping") return false;
      // Compact has no search to wait for, and it must not open on leaving compact.
      if (id === "search-projects" && useMachineViewStore.getState().grouping === "compact") {
        return false;
      }
      chrome.toggleSidebar();
      return true;
    });
  }, [isMobile]);

  useEffect(() => {
    document.title = windowTitle;
  }, [windowTitle]);

  const remoteShown = remoteWorkspace !== null;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <OpenFileDialog enabled={!inTreeShown} />
      <KeyboardShortcutsDialog />
      {/* Outside both layouts, so a dialog outlives the drawer that requested it. */}
      <AppDialogHost />
      <GlobalSettingsHost />
      {/* This node's sheet, and an in-tree node's on its scope (plan item 5003). */}
      <BugReportSheetHost />
      <AgentMailPanel />
      <HostPark parkRef={contentParkRef} />
      {isMobile ? (
        <MobileAppShellLayout
          selectedProjectId={selectedProjectId}
          selectedEnvironmentId={selectedEnvironmentId}
          title={windowTitle}
          titleEnvironmentName={remoteNames ? remoteNames.environmentName : activeEnvironmentName}
          titleNameSignal={
            remoteNames ? (remoteNames.readyToMerge ? "merge-ready" : null) : localNameSignal
          }
          filesPanelOpen={filesPanelOpen && !remoteShown}
          centralPanelStyle={centralPanelThemeVars}
          actionBar={<ActionBar presentation="grid" />}
          agentInfoButton={
            <div className="flex items-center gap-1">
              <AgentMailButton />
              {shownInTree ? (
                <NodeTitleBarAgentInfo scope={shownInTree.scope} mobile />
              ) : (
                <AgentInfoButton activeTab={activeTab} mobile />
              )}
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
              <MachineCpuReadings />
              {/*
                Another node's workspace reports its agent and machine, so
                they show here as this node's do.
              */}
              {shownInTree ? (
                <NodeTitleBarUsage scope={shownInTree.scope} />
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
                {shownInTree ? (
                  <NodeTitleBarAgentInfo scope={shownInTree.scope} />
                ) : (
                  <AgentInfoButton activeTab={activeTab} />
                )}
              </div>
            </div>
          </div>
          <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-0 flex-1"
            data-sidebar-width-animating={sidebarMotion.animating || undefined}
            onPointerDownCapture={(event) => {
              if ((event.target as Element).closest?.("[data-separator]"))
                sidebarMotion.settleNow();
            }}
          >
            {/* Sidebar Panel: stays mounted so that showing and hiding it can animate. */}
            <ResizablePanel
              defaultSize={28}
              {...sidebarPanelConstraints(sidebarMode)}
              panelRef={sidebarMotion.panelRef}
              elementRef={setSidebarPanelElement}
              style={sidebarMotion.pins ? { overflow: "hidden" } : undefined}
            >
              {sidebarMotion.contentShown ? (
                <div
                  className="h-full"
                  style={sidebarMotion.pins ? { width: sidebarMotion.pins.sidebar } : undefined}
                >
                  <Sidebar />
                </div>
              ) : null}
            </ResizablePanel>

            {/* Resize Handle: compact's width is fixed. */}
            {sidebarMotion.contentShown ? (
              <ResizableHandle
                disabled={sidebarMode !== "full"}
                className={sidebarMode !== "full" ? "cursor-default" : undefined}
              />
            ) : null}

            {/* Main Content Panel */}
            <ResizablePanel
              defaultSize={filesPanelOpen && !remoteShown ? 50 : 78}
              minSize={30}
              style={sidebarMotion.pins ? { overflow: "hidden" } : undefined}
            >
              {/*
                Under another node's workspace this window's own stays mounted
                (its selection cleared), hidden; that workspace covers it.
              */}
              <div
                ref={setCentralColumn}
                className={cn("flex h-full flex-col", remoteShown && "invisible")}
                aria-hidden={remoteShown || undefined}
                style={
                  sidebarMotion.pins
                    ? { ...centralPanelThemeVars, width: sidebarMotion.pins.main }
                    : centralPanelThemeVars
                }
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
      {/* Outside both layouts, so another node's workspace keeps its state across them. */}
      <RemoteWorkspaceRegion anchor={isMobile ? mobileContent : centralColumn} />
      {/* After the layouts, so a slot holds the host before content effects run. */}
      {createPortal(children, contentHost)}
    </div>
  );
}
