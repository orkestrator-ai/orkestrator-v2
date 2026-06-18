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
import { useConfigStore, useFilesPanelStore } from "@/stores";
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
  const { isOpen: filesPanelOpen } = useFilesPanelStore();
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
    <div className="flex h-screen w-screen flex-col overflow-hidden">
      <OpenFileDialog />
      {/* Custom title bar - replaces macOS title bar (Overlay mode) */}
      <div
        className="flex h-7 w-full shrink-0 items-center justify-center bg-black"
        data-electron-drag-region
        onMouseDown={handleTitleBarMouseDown}
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <span className="text-xs font-medium text-muted-foreground" data-electron-drag-region>
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
    </div>
  );
}
