import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Menu, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface MobileAppShellLayoutProps {
  selectedProjectId: string | null;
  selectedEnvironmentId: string | null;
  title: string;
  filesPanelOpen: boolean;
  centralPanelStyle: CSSProperties;
  actionBar: ReactNode;
  sidebar: ReactNode;
  filesPanel: ReactNode;
  children?: ReactNode;
  onTitleBarMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
}

export function MobileAppShellLayout({
  selectedProjectId,
  selectedEnvironmentId,
  title,
  filesPanelOpen,
  centralPanelStyle,
  actionBar,
  sidebar,
  filesPanel,
  children,
  onTitleBarMouseDown,
}: MobileAppShellLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const toolsTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreSidebarFocusRef = useRef(false);
  const restoreToolsFocusRef = useRef(false);

  const closeSidebar = () => {
    restoreSidebarFocusRef.current = true;
    setSidebarOpen(false);
  };

  const closeTools = () => {
    restoreToolsFocusRef.current = true;
    setToolsOpen(false);
  };

  useEffect(() => {
    restoreSidebarFocusRef.current = false;
    restoreToolsFocusRef.current = false;
    setSidebarOpen(false);
    setToolsOpen(false);
  }, [selectedEnvironmentId, selectedProjectId]);

  useEffect(() => {
    if (!sidebarOpen && restoreSidebarFocusRef.current) {
      restoreSidebarFocusRef.current = false;
      sidebarTriggerRef.current?.focus();
    }
  }, [sidebarOpen]);

  useEffect(() => {
    if (!toolsOpen && restoreToolsFocusRef.current) {
      restoreToolsFocusRef.current = false;
      toolsTriggerRef.current?.focus();
    }
  }, [toolsOpen]);

  useEffect(() => {
    if (!toolsOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) closeTools();
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toolsOpen]);

  return (
    <>
      <div
        className="relative flex h-11 w-full shrink-0 items-center justify-center border-b border-border/60 bg-black"
        data-backend-drag-region
        onMouseDown={onTitleBarMouseDown}
        style={{ WebkitAppRegion: "drag" } as CSSProperties}
      >
        <Button
          ref={sidebarTriggerRef}
          variant="ghost"
          size="icon"
          className="absolute left-1.5 h-9 w-9"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => setSidebarOpen((open) => !open)}
          aria-label={sidebarOpen ? "Close projects and environments" : "Open projects and environments"}
          aria-expanded={sidebarOpen}
          aria-controls="mobile-projects-drawer"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <span
          className="max-w-[calc(100%_-_6.5rem)] truncate text-sm font-medium text-foreground"
          data-backend-drag-region
        >
          {title}
        </span>
        <Button
          ref={toolsTriggerRef}
          variant={toolsOpen ? "secondary" : "ghost"}
          size="icon"
          className="absolute right-1.5 h-9 w-9"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => setToolsOpen((open) => !open)}
          aria-label={toolsOpen ? "Close tools" : "Open tools"}
          aria-expanded={toolsOpen}
          aria-haspopup="dialog"
          aria-controls="mobile-tools-popover"
        >
          <Wrench className="h-4.5 w-4.5" />
        </Button>

        {toolsOpen && (
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default bg-transparent"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            onClick={closeTools}
            aria-label="Close tools"
          />
        )}

        <div
          id="mobile-tools-popover"
          role="dialog"
          aria-label="Tools"
          aria-hidden={!toolsOpen}
          className={cn(
            "absolute right-2 top-[calc(100%+0.5rem)] z-50 w-[min(calc(100vw-1rem),22rem)] origin-top-right transition duration-150",
            toolsOpen
              ? "visible scale-100 opacity-100"
              : "pointer-events-none invisible scale-95 opacity-0",
          )}
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          onMouseDown={(event) => event.stopPropagation()}
          onClickCapture={(event) => {
            if ((event.target as Element).closest("button, [data-slot='context-menu-item']")) {
              closeTools();
            }
          }}
        >
          {actionBar}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full min-w-0 flex-col" style={centralPanelStyle}>
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background">{children}</main>
        </div>

        {sidebarOpen && (
          <div
            id="mobile-projects-drawer"
            className="absolute inset-0 z-50 flex"
            role="dialog"
            aria-modal="true"
            aria-label="Projects and environments"
          >
            <button
              type="button"
              className="absolute inset-0 bg-black/70 backdrop-blur-sm"
              onClick={closeSidebar}
              aria-label="Close projects and environments"
            />
            <aside className="mobile-sidebar relative h-full w-[min(88vw,22rem)] border-r border-border bg-[#18191c] shadow-2xl">
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-1 z-10 h-10 w-10"
                onClick={closeSidebar}
                aria-label="Close projects and environments"
              >
                <X className="h-4 w-4" />
              </Button>
              {sidebar}
            </aside>
          </div>
        )}

        {filesPanelOpen && (
          <aside className="absolute inset-0 z-40" aria-label="Workspace files">
            {filesPanel}
          </aside>
        )}
      </div>
    </>
  );
}
