import { useEffect, useMemo, useState } from "react";
import { Menu, X } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import {
  DEFAULT_TERMINAL_APPEARANCE,
  resolveTerminalBackgroundColor,
} from "@/constants/terminal";
import { getCurrentWindow } from "@/lib/native/window";
import { cn } from "@/lib/utils";

interface AppShellProps {
  children?: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const isMobile = useMediaQuery("(max-width: 767px)");
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
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

  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [selectedEnvironmentId, selectedProjectId]);

  return (
    <div className="flex h-dvh w-screen flex-col overflow-hidden">
      <OpenFileDialog />
      {/* Custom title bar - replaces macOS title bar (Overlay mode) */}
      <div
        className="relative flex h-11 w-full shrink-0 items-center justify-center border-b border-border/60 bg-black md:h-7 md:border-b-0"
        data-backend-drag-region
        onMouseDown={handleTitleBarMouseDown}
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        {isMobile && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-1.5 h-9 w-9"
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => setMobileSidebarOpen(true)}
            aria-label="Open projects and environments"
          >
            <Menu className="h-5 w-5" />
          </Button>
        )}
        <span className="text-xs font-medium text-muted-foreground" data-backend-drag-region>
          Orkestrator AI
        </span>
      </div>
      {isMobile ? (
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="flex h-full min-w-0 flex-col" style={centralPanelThemeVars}>
            <ActionBar />
            <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background">
              {children}
            </main>
          </div>

          {mobileSidebarOpen && (
            <div className="absolute inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Projects and environments">
              <button
                type="button"
                className="absolute inset-0 bg-black/70 backdrop-blur-sm"
                onClick={() => setMobileSidebarOpen(false)}
                aria-label="Close projects and environments"
              />
              <aside className="mobile-sidebar relative h-full w-[min(88vw,22rem)] border-r border-border bg-[#18191c] shadow-2xl">
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-2 z-10 h-10 w-10"
                  onClick={() => setMobileSidebarOpen(false)}
                  aria-label="Close projects and environments"
                >
                  <X className="h-5 w-5" />
                </Button>
                <Sidebar />
              </aside>
            </div>
          )}

          {filesPanelOpen && (
            <aside className="absolute inset-0 z-40" aria-label="Workspace files">
              <FilesPanel />
            </aside>
          )}
        </div>
      ) : (
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
      )}
    </div>
  );
}
