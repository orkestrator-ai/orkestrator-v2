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
import { useRemoteWorkspaceStore } from "@/stores/remoteWorkspaceStore";
import { useAppDialogStore } from "@/stores/appDialogStore";

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
export { MOBILE_SHELL_MEDIA_QUERY } from "@/lib/mobile-shell";

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
  /** Whether the projects drawer starts open. Defaults to open. */
  initialSidebarOpen?: boolean;
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
  initialSidebarOpen = true,
  children,
  onTitleBarMouseDown,
}: MobileAppShellLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(initialSidebarOpen);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [titleTooltipOpen, setTitleTooltipOpen] = useState(false);
  const previousSelectionRef = useRef({ selectedEnvironmentId, selectedProjectId });
  const titlePointerTypeRef = useRef<string | null>(null);
  const titleTooltipWasOpenOnPointerDownRef = useRef(false);
  const tooltipPointerTypeRef = useRef<string | null>(null);
  const sidebarTriggerRef = useRef<HTMLButtonElement>(null);
  const sidebarCloseRef = useRef<HTMLButtonElement>(null);
  const toolsTriggerRef = useRef<HTMLButtonElement>(null);
  const restoreSidebarFocusRef = useRef(false);
  const restoreToolsFocusRef = useRef(false);
  const appDialogOpenerRef = useRef<HTMLButtonElement | null>(null);
  /** Bumped when a shell-requested dialog closes; the trigger takes focus after that commit. */
  const [appDialogFocusReturn, setAppDialogFocusReturn] = useState(0);
  const titleUsesNativeDragRegion = usesNativeWindowDragRegion();

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

  const toolsOpenRef = useRef(toolsOpen);
  useEffect(() => {
    toolsOpenRef.current = toolsOpen;
  }, [toolsOpen]);

  const sidebarOpenRef = useRef(sidebarOpen);
  useEffect(() => {
    sidebarOpenRef.current = sidebarOpen;
  }, [sidebarOpen]);

  // App dialogs render outside both mobile surfaces. Collapse the originating
  // surface without stealing focus, then restore its trigger after the commit
  // that unmounts the dialog and its focus trap (including cached lazy dialogs).
  useEffect(
    () =>
      useAppDialogStore.subscribe((state, previous) => {
        if (state.request && !previous.request) {
          if (sidebarOpenRef.current) {
            appDialogOpenerRef.current = sidebarTriggerRef.current;
            restoreSidebarFocusRef.current = false;
            setSidebarOpen(false);
          } else if (toolsOpenRef.current) {
            appDialogOpenerRef.current = toolsTriggerRef.current;
            restoreToolsFocusRef.current = false;
            setToolsOpen(false);
          }
        } else if (!state.request && previous.request && appDialogOpenerRef.current) {
          setAppDialogFocusReturn((count) => count + 1);
        }
      }),
    [],
  );

  useEffect(() => {
    if (appDialogFocusReturn > 0) {
      appDialogOpenerRef.current?.focus();
      appDialogOpenerRef.current = null;
    }
  }, [appDialogFocusReturn]);

  // Realm dialogs live in another document and never update the local dialog
  // store. Yield on each request even when local selection was already empty.
  useEffect(
    () =>
      useRemoteWorkspaceStore.subscribe((state, previous) => {
        const nodeId = state.active?.nodeId;
        if (!nodeId) return;
        const next = state.requests[nodeId];
        if (!next || next === previous.requests[nodeId]) return;
        if (
          !next.request.dialog &&
          !next.request.createEnvironmentProjectId &&
          !next.request.addProject
        )
          return;
        restoreSidebarFocusRef.current = false;
        restoreToolsFocusRef.current = false;
        setSidebarOpen(false);
        setToolsOpen(false);
      }),
    [],
  );

  // A new title closes its tooltip and forgets the pointer that opened it.
  const [tooltipTitle, setTooltipTitle] = useState(title);
  if (tooltipTitle !== title) {
    setTooltipTitle(title);
    setTitleTooltipOpen(false);
  }
  useEffect(() => {
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
            // A tap on the bubble is not outside the tooltip, so Radix keeps it
            // open. Chromium only closed it because the focused title blurred;
            // WebKit and iOS Safari never focus a tapped button. Close it when
            // the touch ends, not when it starts: the bubble must still be
            // mounted so cancelling `touchend` also cancels the tap's mouse
            // events and click, which would otherwise land on the workspace
            // control under the bubble. For pen input, remember pointer-down
            // rather than relying on click being a PointerEvent. Keep the
            // bubble mounted through click so that it remains the target.
            onPointerDown={(event) => {
              tooltipPointerTypeRef.current = event.pointerType;
              // Avoid blurring the title and unmounting the bubble mid-press.
              if (event.pointerType === "pen") event.preventDefault();
            }}
            onPointerCancel={() => {
              tooltipPointerTypeRef.current = null;
            }}
            onTouchEnd={(event) => {
              event.preventDefault();
              tooltipPointerTypeRef.current = null;
              setTitleTooltipOpen(false);
            }}
            onClick={(event) => {
              const pointerType = tooltipPointerTypeRef.current;
              tooltipPointerTypeRef.current = null;
              if (pointerType === "pen") {
                event.preventDefault();
                event.stopPropagation();
                setTitleTooltipOpen(false);
              }
            }}
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
          {/*
            No click handler here: Radix already closes the drawer on a press
            outside its content, and only when the drawer is the top layer. A
            tap that opens a row's actions menu ends with a click that lands on
            this overlay, because the drawer stops taking pointer events once
            the menu opens above it; closing on that click shut the drawer and
            the menu together.
          */}
          <DialogPrimitive.Overlay
            data-slot="mobile-projects-overlay"
            className="fixed bottom-0 left-0 right-0 top-11 z-50 bg-black/70 backdrop-blur-sm"
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
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
