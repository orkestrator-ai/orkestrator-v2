import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Menu, Wrench, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Accessible name of the collapsed tools trigger.
 *
 * Exported because the toolbar lives inside the tools popover: when a dialog
 * launched from there closes, the popover has usually collapsed and focus has
 * to land here instead of on a trigger the user can no longer see. Sharing the
 * label keeps that lookup from silently missing if this button is renamed.
 */
export const MOBILE_TOOLS_TRIGGER_LABEL = "Open tools";
export const MOBILE_TOOLS_TRIGGER_SELECTOR = `button[aria-label="${MOBILE_TOOLS_TRIGGER_LABEL}"]`;

/** The breakpoint at which `AppShell` swaps in this layout. */
export const MOBILE_SHELL_MEDIA_QUERY = "(max-width: 767px)";

interface MobileAppShellLayoutProps {
  selectedProjectId: string | null;
  selectedEnvironmentId: string | null;
  title: string;
  filesPanelOpen: boolean;
  centralPanelStyle: CSSProperties;
  actionBar: ReactNode;
  agentInfoButton: ReactNode;
  sidebar: ReactNode;
  filesPanel: ReactNode;
  children?: ReactNode;
  onTitleBarMouseDown: (event: MouseEvent<HTMLDivElement>) => void;
}

function usesNativeWindowDragRegion(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.orkestratorGateway?.desktop === true ||
    (Boolean(window.orkestrator) && window.orkestratorGateway?.enabled !== true)
  );
}

export function MobileAppShellLayout({
  selectedProjectId,
  selectedEnvironmentId,
  title,
  filesPanelOpen,
  centralPanelStyle,
  actionBar,
  agentInfoButton,
  sidebar,
  filesPanel,
  children,
  onTitleBarMouseDown,
}: MobileAppShellLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [titleTooltipOpen, setTitleTooltipOpen] = useState(false);
  const previousSelectionRef = useRef({ selectedEnvironmentId, selectedProjectId });
  const titlePointerTypeRef = useRef<string | null>(null);
  const titleTooltipWasOpenOnPointerDownRef = useRef(false);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const toolsTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreSidebarFocusRef = useRef(false);
  const restoreToolsFocusRef = useRef(false);
  const titleUsesNativeDragRegion = usesNativeWindowDragRegion();

  const closeSidebar = () => {
    restoreSidebarFocusRef.current = true;
    setSidebarOpen(false);
  };

  const handleSidebarOpenChange = (open: boolean) => {
    if (!open) {
      restoreSidebarFocusRef.current = true;
    }
    setSidebarOpen(open);
  };

  const closeTools = () => {
    restoreToolsFocusRef.current = true;
    setToolsOpen(false);
  };

  useEffect(() => {
    const previousSelection = previousSelectionRef.current;
    previousSelectionRef.current = { selectedEnvironmentId, selectedProjectId };
    if (
      previousSelection.selectedEnvironmentId === selectedEnvironmentId &&
      previousSelection.selectedProjectId === selectedProjectId
    ) {
      return;
    }

    restoreSidebarFocusRef.current = false;
    restoreToolsFocusRef.current = false;
    setSidebarOpen(false);
    setToolsOpen(false);
    setTitleTooltipOpen(false);
    titlePointerTypeRef.current = null;
    titleTooltipWasOpenOnPointerDownRef.current = false;
  }, [selectedEnvironmentId, selectedProjectId]);

  useEffect(() => {
    setTitleTooltipOpen(false);
    titlePointerTypeRef.current = null;
    titleTooltipWasOpenOnPointerDownRef.current = false;
  }, [title]);

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
    <DialogPrimitive.Root open={sidebarOpen} onOpenChange={handleSidebarOpenChange}>
      <div
        className="relative flex h-11 w-full shrink-0 items-center justify-center border-b border-border/60 bg-black"
        data-backend-drag-region
        onMouseDown={onTitleBarMouseDown}
        style={{ WebkitAppRegion: "drag" } as CSSProperties}
      >
        <DialogPrimitive.Trigger asChild>
          <Button
            ref={sidebarTriggerRef}
            variant="ghost"
            size="icon"
            className="absolute left-1.5 h-9 w-9"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            onMouseDown={(event) => event.stopPropagation()}
            aria-label={
              sidebarOpen ? "Close projects and environments" : "Open projects and environments"
            }
            aria-expanded={sidebarOpen}
            aria-controls="mobile-projects-drawer"
          >
            <Menu className="h-5 w-5" />
          </Button>
        </DialogPrimitive.Trigger>
        <Tooltip open={titleTooltipOpen} onOpenChange={setTitleTooltipOpen}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="ml-12 min-w-0 flex-1 truncate px-1 text-center text-sm font-medium text-foreground"
              data-backend-drag-region={titleUsesNativeDragRegion ? "" : undefined}
              style={
                {
                  WebkitAppRegion: titleUsesNativeDragRegion ? "drag" : "no-drag",
                } as CSSProperties
              }
              onMouseDown={(event) => {
                if (!titleUsesNativeDragRegion) event.stopPropagation();
              }}
              onPointerDown={(event) => {
                titlePointerTypeRef.current = event.pointerType;
                titleTooltipWasOpenOnPointerDownRef.current = titleTooltipOpen;
              }}
              onPointerCancel={() => {
                titlePointerTypeRef.current = null;
                titleTooltipWasOpenOnPointerDownRef.current = false;
              }}
              onClick={(event) => {
                const pointerType = titlePointerTypeRef.current;
                const wasOpen = titleTooltipWasOpenOnPointerDownRef.current;
                titlePointerTypeRef.current = null;
                titleTooltipWasOpenOnPointerDownRef.current = false;

                // Radix intentionally closes tooltips on activation. Touch and
                // pen do not have a preceding hover, so toggle from the state
                // captured before Radix's pointer-down close. Mouse and keyboard
                // activations retain Radix's standard close behavior.
                if (pointerType === "touch" || pointerType === "pen") {
                  event.preventDefault();
                  setTitleTooltipOpen(!wasOpen);
                }
              }}
              aria-label={title}
              aria-expanded={titleTooltipOpen}
            >
              {title}
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            sideOffset={6}
            className="max-w-[calc(100vw-1rem)] break-words text-center"
          >
            {title}
          </TooltipContent>
        </Tooltip>
        <div
          className="mr-1.5 flex h-9 shrink-0 items-center gap-1"
          data-testid="mobile-title-actions"
          style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Button
            ref={toolsTriggerRef}
            variant={toolsOpen ? "secondary" : "ghost"}
            size="icon"
            className="h-9 w-9"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            onClick={() => setToolsOpen((open) => !open)}
            aria-label={toolsOpen ? "Close tools" : MOBILE_TOOLS_TRIGGER_LABEL}
            aria-expanded={toolsOpen}
            aria-haspopup="dialog"
            aria-controls="mobile-tools-popover"
          >
            <Wrench className="h-4.5 w-4.5" />
          </Button>
          <div
            className="flex h-9 items-center gap-1"
            data-testid="mobile-agent-info-slot"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            {agentInfoButton}
          </div>
        </div>

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

        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay
            data-slot="mobile-projects-overlay"
            className="fixed bottom-0 left-0 right-0 top-11 z-50 bg-black/70 backdrop-blur-sm"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            onClick={closeSidebar}
          />
          <DialogPrimitive.Content
            id="mobile-projects-drawer"
            className="fixed bottom-0 left-0 top-0 z-50 w-[min(88vw,22rem)] bg-transparent outline-none"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              sidebarCloseRef.current?.focus();
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (restoreSidebarFocusRef.current) {
                restoreSidebarFocusRef.current = false;
                sidebarTriggerRef.current?.focus();
              }
            }}
          >
            <DialogPrimitive.Title className="sr-only">
              Projects and environments
            </DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">
              Choose a project or environment to open in the workspace.
            </DialogPrimitive.Description>
            <DialogPrimitive.Close asChild>
              <Button
                variant="ghost"
                size="icon"
                className="fixed left-1.5 top-1 z-[60] h-9 w-9"
                aria-label="Close projects and environments"
                aria-controls="mobile-projects-drawer"
              >
                <Menu className="h-5 w-5" />
              </Button>
            </DialogPrimitive.Close>
            <aside className="mobile-sidebar absolute bottom-0 left-0 top-11 w-full border-r border-border bg-sidebar shadow-2xl">
              <DialogPrimitive.Close asChild>
                <Button
                  ref={sidebarCloseRef}
                  variant="ghost"
                  size="icon"
                  className="absolute right-2 top-1 z-10 h-10 w-10"
                  aria-label="Close projects and environments"
                >
                  <X className="h-4 w-4" />
                </Button>
              </DialogPrimitive.Close>
              {sidebar}
            </aside>
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>

        {filesPanelOpen && (
          <aside className="absolute inset-0 z-40" aria-label="Workspace files">
            {filesPanel}
          </aside>
        )}
      </div>
    </DialogPrimitive.Root>
  );
}
