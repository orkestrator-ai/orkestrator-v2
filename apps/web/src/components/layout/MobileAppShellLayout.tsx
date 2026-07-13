import { useEffect, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface MobileAppShellLayoutProps {
  selectedProjectId: string | null;
  selectedEnvironmentId: string | null;
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
  filesPanelOpen,
  centralPanelStyle,
  actionBar,
  sidebar,
  filesPanel,
  children,
  onTitleBarMouseDown,
}: MobileAppShellLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    setSidebarOpen(false);
  }, [selectedEnvironmentId, selectedProjectId]);

  return (
    <>
      <div
        className="relative flex h-11 w-full shrink-0 items-center justify-center border-b border-border/60 bg-black"
        data-backend-drag-region
        onMouseDown={onTitleBarMouseDown}
        style={{ WebkitAppRegion: "drag" } as CSSProperties}
      >
        <Button
          variant="ghost"
          size="icon"
          className="absolute left-1.5 h-9 w-9"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={() => setSidebarOpen(true)}
          aria-label="Open projects and environments"
        >
          <Menu className="h-5 w-5" />
        </Button>
        <span className="text-xs font-medium text-muted-foreground" data-backend-drag-region>
          Orkestrator AI
        </span>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="flex h-full min-w-0 flex-col" style={centralPanelStyle}>
          {actionBar}
          <main className="min-h-0 min-w-0 flex-1 overflow-hidden bg-background">{children}</main>
        </div>

        {sidebarOpen && (
          <div className="absolute inset-0 z-50 flex" role="dialog" aria-modal="true" aria-label="Projects and environments">
            <button
              type="button"
              className="absolute inset-0 bg-black/70 backdrop-blur-sm"
              onClick={() => setSidebarOpen(false)}
              aria-label="Close projects and environments"
            />
            <aside className="mobile-sidebar relative h-full w-[min(88vw,22rem)] border-r border-border bg-[#18191c] shadow-2xl">
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-2 top-2 z-10 h-10 w-10"
                onClick={() => setSidebarOpen(false)}
                aria-label="Close projects and environments"
              >
                <X className="h-5 w-5" />
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
