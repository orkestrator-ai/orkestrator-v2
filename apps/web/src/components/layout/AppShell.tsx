import { useMemo } from "react";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { Sidebar } from "./Sidebar";
import { ActionBar } from "./ActionBar";
import { OpenFileDialog } from "./OpenFileDialog";
import { FilesPanel } from "@/components/files-panel";
import { useConfigStore, useFilesPanelStore, useUIStore } from "@/stores";
import { useMediaQuery } from "@/hooks";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  resolveTerminalBackgroundColor,
} from "@/constants/terminal";
import { getCurrentWindow } from "@/lib/native/window";
import { cn } from "@/lib/utils";
import { MobileAppShellLayout } from "./MobileAppShellLayout";

interface AppShellProps {
  children?: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const { isOpen: filesPanelOpen } = useFilesPanelStore();
  const selectedProjectId = useUIStore((state) => state.selectedProjectId);
  const selectedEnvironmentId = useUIStore((state) => state.selectedEnvironmentId);
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

  return (
    <div className="flex h-dvh w-screen flex-col overflow-hidden">
      <OpenFileDialog />
      {isMobile ? (
        <MobileAppShellLayout
          selectedProjectId={selectedProjectId}
          selectedEnvironmentId={selectedEnvironmentId}
          filesPanelOpen={filesPanelOpen}
          centralPanelStyle={centralPanelThemeVars}
          actionBar={<ActionBar />}
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
              Orkestrator AI
            </span>
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
