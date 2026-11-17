import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ExternalLink,
  GripVertical,
  PanelBottom,
  PanelLeft,
  PanelRight,
  PanelTop,
  X,
  type LucideIcon,
} from "lucide-react";
import { AGENT_PLATFORM_LABELS, type AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, createSessionKey } from "@/lib/utils";
import { useNativeAgentProjectionStore } from "@/stores/nativeAgentProjectionStore";
import {
  DESIGN_AGENT_PANEL_SIZE,
  designAgentPanelSize,
  isDesignAgentDock,
  isHorizontalDock,
} from "@/stores/pane-layout-embedded";
import {
  DESIGN_AGENT_DOCKS,
  type DesignAgentDock,
  type DesignAgentPanelState,
} from "@/types/paneLayout";
import {
  dockFromArrowKey,
  dockFromPointer,
  isAgentPanelShortcut,
  keyboardPanelSize,
  panelLeads,
  resizedPanelSize,
} from "./design-agent-dock";

const DOCK_ICONS: Record<DesignAgentDock, LucideIcon> = {
  left: PanelLeft,
  right: PanelRight,
  top: PanelTop,
  bottom: PanelBottom,
};

const DOCK_LABELS: Record<DesignAgentDock, string> = {
  left: "Left",
  right: "Right",
  top: "Top",
  bottom: "Bottom",
};

/** Smallest the panel gets along its axis, whatever the percentage says. */
const PANEL_MIN_PX = { horizontal: 320, vertical: 160 } as const;

export interface DesignAgentDockProps {
  panel: DesignAgentPanelState;
  onPanelChange: (patch: Partial<DesignAgentPanelState>) => void;
  /** The design tab is the selected tab of a laid-out pane. */
  visible: boolean;
  /** The design tab is selected in the focused pane. */
  ownsGlobalShortcuts: boolean;
  /** Header label for the embedded agent; omitted when the design shows none. */
  agent?: { environmentId: string; tabId: string; platform: AgentPlatform | undefined };
  /** Makes the embedded agent an ordinary tab of its own again. */
  onPopOut?: () => void;
  /** Shows an agent tab opened from this design in the panel, if it has none. */
  onAdopt?: (tabId: string) => void;
  renderCanvas: (view: {
    ownsGlobalShortcuts: boolean;
    agentPanel: { open: boolean; onToggle: () => void; adopt?: (tabId: string) => void };
  }) => ReactNode;
  /** The agent conversation, or the empty state when there is none. */
  renderAgent: (view: { isActive: boolean; ownsGlobalShortcuts: boolean }) => ReactNode;
}

function AgentPanelTitle({ agent }: { agent: DesignAgentDockProps["agent"] }) {
  const title = useNativeAgentProjectionStore((state) =>
    agent ? state.projections.get(createSessionKey(agent.environmentId, agent.tabId))?.title : null,
  );
  const fallback = agent?.platform ? AGENT_PLATFORM_LABELS[agent.platform] : "Agent";
  return (
    <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
      {title?.trim() || fallback}
    </span>
  );
}

/**
 * The design tab's layout: the canvas plus its agent conversation in a panel
 * that docks to any edge, resizes and hides. The panel only hides: the agent
 * stays mounted (and its work carries on in the backend either way).
 */
export function DesignAgentDock({
  panel,
  onPanelChange,
  visible,
  ownsGlobalShortcuts,
  agent,
  onPopOut,
  onAdopt,
  renderCanvas,
  renderAgent,
}: DesignAgentDockProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeStart = useRef<{ x: number; y: number; size: number; container: number } | null>(
    null,
  );
  const [liveSize, setLiveSize] = useState<number | null>(null);
  const [dragDock, setDragDock] = useState<DesignAgentDock | null>(null);
  /** Which side last had the pointer or focus: it takes the tab's shortcuts. */
  const [region, setRegion] = useState<"canvas" | "agent">("canvas");
  const { dock, open } = panel;
  const horizontal = isHorizontalDock(dock);
  const leads = panelLeads(dock);
  const size = liveSize ?? designAgentPanelSize(panel);
  const agentOwns = ownsGlobalShortcuts && open && region === "agent";

  const toggle = useCallback(() => onPanelChange({ open: !open }), [onPanelChange, open]);
  const moveTo = useCallback(
    (next: DesignAgentDock) => {
      if (next === dock) return;
      // A size along one axis means nothing along the other.
      onPanelChange(
        isHorizontalDock(next) === horizontal ? { dock: next } : { dock: next, size: undefined },
      );
    },
    [dock, horizontal, onPanelChange],
  );

  useEffect(() => {
    if (!ownsGlobalShortcuts) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isAgentPanelShortcut(event)) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [ownsGlobalShortcuts, toggle]);

  const DockIcon = DOCK_ICONS[dock];
  const previewDock = dragDock && dragDock !== dock ? dragDock : null;
  const previewSize = previewDock
    ? isHorizontalDock(previewDock) === horizontal
      ? size
      : designAgentPanelSize({ dock: previewDock, open: true })
    : 0;

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute inset-0 flex min-h-0 min-w-0",
        horizontal ? "flex-row" : "flex-col",
        !visible && "hidden",
      )}
      data-agent-dock={dock}
      data-agent-panel-open={open || undefined}
    >
      <section
        aria-label="Agent panel"
        className={cn(
          "relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden bg-background",
          !open && "hidden",
        )}
        style={{
          order: leads ? 0 : 2,
          flexBasis: `${size}%`,
          ...(horizontal
            ? { minWidth: PANEL_MIN_PX.horizontal, maxWidth: `${DESIGN_AGENT_PANEL_SIZE.max}%` }
            : { minHeight: PANEL_MIN_PX.vertical, maxHeight: `${DESIGN_AGENT_PANEL_SIZE.max}%` }),
        }}
        onPointerDownCapture={() => setRegion("agent")}
        onFocusCapture={() => setRegion("agent")}
      >
        <header className="flex h-8 shrink-0 items-center gap-1 border-b border-divider px-1">
          <button
            type="button"
            aria-label="Move agent panel"
            title="Drag to dock the agent panel to any edge (or use the arrow keys)"
            aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
            className={cn(
              "grid size-6 shrink-0 touch-none place-content-center rounded-sm text-muted-foreground hover:bg-muted focus-hairline",
              dragDock ? "cursor-grabbing" : "cursor-grab",
            )}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              setDragDock(dock);
            }}
            onPointerMove={(event) => {
              const rect = containerRef.current?.getBoundingClientRect();
              if (!dragDock || !rect) return;
              setDragDock(dockFromPointer(rect, event.clientX, event.clientY));
            }}
            onPointerUp={(event) => {
              if (!dragDock) return;
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
              moveTo(dragDock);
              setDragDock(null);
            }}
            onPointerCancel={() => setDragDock(null)}
            onLostPointerCapture={() => setDragDock(null)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && dragDock) {
                event.preventDefault();
                setDragDock(null);
                return;
              }
              const next = dockFromArrowKey(event.key);
              if (!next) return;
              event.preventDefault();
              moveTo(next);
            }}
          >
            <GripVertical className="size-3.5" />
          </button>
          <AgentPanelTitle agent={agent} />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-6"
                aria-label={`Agent panel position: ${DOCK_LABELS[dock]}`}
                title="Agent panel position"
              >
                <DockIcon className="size-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Dock agent panel</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={dock}
                onValueChange={(value) => {
                  if (isDesignAgentDock(value)) moveTo(value);
                }}
              >
                {DESIGN_AGENT_DOCKS.map((candidate) => {
                  const Icon = DOCK_ICONS[candidate];
                  return (
                    <DropdownMenuRadioItem key={candidate} value={candidate}>
                      <Icon />
                      {DOCK_LABELS[candidate]}
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {onPopOut && (
            <Button
              variant="ghost"
              size="icon"
              className="size-6"
              aria-label="Open agent in its own tab"
              title="Open agent in its own tab"
              onClick={onPopOut}
            >
              <ExternalLink className="size-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="Hide agent panel"
            title="Hide agent panel (Ctrl/⌘+.)"
            onClick={() => {
              setRegion("canvas");
              onPanelChange({ open: false });
            }}
          >
            <X className="size-3.5" />
          </Button>
        </header>
        <div className="relative min-h-0 flex-1">
          {renderAgent({ isActive: visible && open, ownsGlobalShortcuts: agentOwns })}
        </div>
      </section>
      {open && (
        <div
          role="separator"
          aria-label="Resize agent panel"
          aria-orientation={horizontal ? "vertical" : "horizontal"}
          aria-valuemin={DESIGN_AGENT_PANEL_SIZE.min}
          aria-valuemax={DESIGN_AGENT_PANEL_SIZE.max}
          aria-valuenow={Math.round(size)}
          tabIndex={0}
          style={{ order: 1 }}
          className={cn(
            "relative z-30 shrink-0 touch-none bg-divider hover:bg-primary/50 focus-visible:bg-primary/50 focus-visible:outline-none",
            horizontal
              ? "w-px cursor-col-resize after:absolute after:inset-y-0 after:-left-1 after:w-2"
              : "h-px cursor-row-resize after:absolute after:inset-x-0 after:-top-1 after:h-2",
          )}
          onPointerDown={(event) => {
            const rect = containerRef.current?.getBoundingClientRect();
            if (event.button !== 0 || !rect) return;
            event.preventDefault();
            event.currentTarget.focus();
            event.currentTarget.setPointerCapture(event.pointerId);
            resizeStart.current = {
              x: event.clientX,
              y: event.clientY,
              size,
              container: horizontal ? rect.width : rect.height,
            };
          }}
          onPointerMove={(event) => {
            const start = resizeStart.current;
            if (!start) return;
            setLiveSize(
              resizedPanelSize({
                dock,
                startSize: start.size,
                deltaPx: horizontal ? event.clientX - start.x : event.clientY - start.y,
                containerPx: start.container,
              }),
            );
          }}
          onPointerUp={(event) => {
            if (!resizeStart.current) return;
            resizeStart.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId))
              event.currentTarget.releasePointerCapture(event.pointerId);
            if (liveSize !== null) onPanelChange({ size: liveSize });
            setLiveSize(null);
          }}
          onPointerCancel={() => {
            resizeStart.current = null;
            setLiveSize(null);
          }}
          onKeyDown={(event) => {
            const next = keyboardPanelSize(dock, size, event.key);
            if (next === null) return;
            event.preventDefault();
            onPanelChange({ size: next });
          }}
        />
      )}
      <div
        className="relative min-h-0 min-w-0 flex-1"
        style={{ order: leads ? 2 : 0 }}
        onPointerDownCapture={() => setRegion("canvas")}
        onFocusCapture={() => setRegion("canvas")}
      >
        {renderCanvas({
          ownsGlobalShortcuts: ownsGlobalShortcuts && !agentOwns,
          agentPanel: { open, onToggle: toggle, ...(onAdopt ? { adopt: onAdopt } : {}) },
        })}
      </div>
      {previewDock && (
        <div
          aria-hidden
          data-dock-preview={previewDock}
          className="pointer-events-none absolute z-40 grid place-content-center rounded-sm border-2 border-primary bg-primary/10 text-xs font-medium text-primary"
          style={
            previewDock === "left"
              ? { left: 0, top: 0, bottom: 0, width: `${previewSize}%` }
              : previewDock === "right"
                ? { right: 0, top: 0, bottom: 0, width: `${previewSize}%` }
                : previewDock === "top"
                  ? { left: 0, right: 0, top: 0, height: `${previewSize}%` }
                  : { left: 0, right: 0, bottom: 0, height: `${previewSize}%` }
          }
        >
          Dock {DOCK_LABELS[previewDock].toLowerCase()}
        </div>
      )}
    </div>
  );
}

/** What the panel shows for a design with no agent conversation in it. */
export function DesignAgentPanelEmpty({
  candidates,
  onEmbed,
}: {
  /** Open agent tabs linked to this design that could be shown here. */
  candidates: ReadonlyArray<{ tabId: string; label: string }>;
  onEmbed: (tabId: string) => void;
}) {
  return (
    <div className="absolute inset-0 overflow-auto p-4 text-sm">
      <p className="font-medium">No agent in this design</p>
      <p className="mt-1 text-muted-foreground">
        Use <span className="font-medium text-foreground">Ask agent</span> in the toolbar to bring a
        conversation into this design.
      </p>
      {candidates.length > 0 && (
        <ul className="mt-4 flex flex-col gap-2" aria-label="Conversations linked to this design">
          {candidates.map((candidate) => (
            <li key={candidate.tabId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
              <Button size="sm" variant="outline" onClick={() => onEmbed(candidate.tabId)}>
                Show here
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
