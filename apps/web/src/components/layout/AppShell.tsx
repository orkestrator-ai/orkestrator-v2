import { useEffect, useMemo } from "react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Sidebar } from "./Sidebar";
import { ActionBar } from "./ActionBar";
import { OpenFileDialog } from "./OpenFileDialog";
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
  DEFAULT_TERMINAL_APPEARANCE,
  resolveTerminalBackgroundColor,
} from "@/constants/terminal";
import { getCurrentWindow } from "@/lib/native/window";
import { cn } from "@/lib/utils";
import { MobileAppShellLayout } from "./MobileAppShellLayout";
import { getApplicationTitle } from "@/lib/application-title";
import { AgentInfoButton } from "./AgentInfoButton";

interface AppShellProps {
  children?: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const filesPanelOpen = useFilesPanelStore((state) => state.isOpen);
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
  const paneEnvironments = usePaneLayoutStore((state) => state.environments);
  const activeProjectName = useProjectStore((state) =>
    selectedProjectId
      ? state.projects.find((project) => project.id === selectedProjectId)?.name ?? null
      : null,
  );
  const activeEnvironmentName = useEnvironmentStore((state) =>
    selectedEnvironmentId
      ? state.environments.find((environment) => environment.id === selectedEnvironmentId)?.name ?? null
      : null,
  );
  const terminalAppearance =
    useConfigStore((state) => state.config.global.terminalAppearance) ??
    DEFAULT_TERMINAL_APPEARANCE;

  const panelBackgroundColor = resolveTerminalBackgroundColor(
    terminalAppearance.backgroundColor,
  );

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
    activeProjectName,
    isMobile,
    activeEnvironmentName,
  );
  const activeTab = useMemo(() => {
    if (!selectedEnvironmentId) return null;
    const environment = paneEnvironments.get(selectedEnvironmentId);
    if (!environment) return null;
    const leaves = getAllLeaves(environment.root);
    const activePane =
      leaves.find((leaf) => leaf.id === environment.activePaneId) ?? null;
    if (!activePane?.activeTabId) return null;
    return activePane.tabs.find((tab) => tab.id === activePane.activeTabId) ?? null;
  }, [paneEnvironments, selectedEnvironmentId]);

  useEffect(() => {
    document.title = windowTitle;
  }, [windowTitle]);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <OpenFileDialog />
      {isMobile ? (
        <MobileAppShellLayout
          selectedProjectId={selectedProjectId}
          selectedEnvironmentId={selectedEnvironmentId}
          title={windowTitle}
          filesPanelOpen={filesPanelOpen}
          centralPanelStyle={centralPanelThemeVars}
          actionBar={<ActionBar presentation="grid" />}
          agentInfoButton={<AgentInfoButton activeTab={activeTab} mobile />}
          sidebar={<Sidebar />}
          filesPanel={<FilesPanel />}
          onTitleBarMouseDown={handleTitleBarMouseDown}
        >
          {children}
        </MobileAppShellLayout>
      ) : (
        <>
          <div
            className="relative flex h-[34px] w-full shrink-0 items-center justify-center bg-black"
            data-backend-drag-region
            onMouseDown={handleTitleBarMouseDown}
            style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
          >
            <span className="text-xs font-medium text-muted-foreground" data-backend-drag-region>
              {windowTitle}
            </span>
            {/*
              The title bar is a drag region: every left mouse-down on it calls
              `startDragging()`. A nested control inherits that, so without the
              `no-drag` app region *and* the mouse-down stop the info button
              would drag the window instead of opening. `MobileAppShellLayout`
              wraps the same slot the same way.
            */}
            <div
              className="absolute right-1 top-1"
              data-testid="desktop-agent-info-slot"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <AgentInfoButton activeTab={activeTab} />
            </div>
          </div>
          <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        {/* Sidebar Panel */}
        <ResizablePanel defaultSize={28} minSize="280px" maxSize="400px">
          <Sidebar />
        </ResizablePanel>

        {/* Resize Handle */}
        <ResizableHandle />

        {/* Main Content Panel */}
        <ResizablePanel defaultSize={filesPanelOpen ? 50 : 78} minSize={30}>
          <div className="flex h-full flex-col" style={centralPanelThemeVars}>
            <ActionBar />
            <main className={cn("flex-1 overflow-hidden bg-background")}>
              {children}
            </main>
          </div>
        </ResizablePanel>

        {/* Files Panel (conditional) */}
        {filesPanelOpen && (
          <>
            <ResizableHandle />
            <ResizablePanel defaultSize={22} minSize="240px" maxSize="500px">
              <FilesPanel />
            </ResizablePanel>
          </>
        )}
          </ResizablePanelGroup>
        </>
      )}
    </div>
  );
}
