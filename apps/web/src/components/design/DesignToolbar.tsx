import { cloneElement, useId, useRef, useState, type ReactElement, type Ref } from "react";
import {
  BotMessageSquare,
  Download,
  Eye,
  Focus,
  History,
  Keyboard,
  Layers,
  Maximize,
  MessageSquarePlus,
  Minus,
  MoreHorizontal,
  MousePointer2,
  PanelRight,
  Percent,
  Plus,
  Redo2,
  Save,
  SquarePlus,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { DESIGN_KEYBOARD_SHORTCUTS } from "@/lib/keyboard-shortcuts";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { DesignProjection } from "@/stores/designStore";

export interface DesignToolbarProps {
  projection: DesignProjection | undefined;
  /** Focus returns here when the layers drawer closes. */
  layersButtonRef?: Ref<HTMLButtonElement>;
  zoom: number;
  mode: "inspect" | "preview";
  narrow: boolean;
  /** A short pane (about 400% zoom): the tools collapse into one menu. */
  compact: boolean;
  layersOpen: boolean;
  inspectorOpen: boolean;
  historyOpen: boolean;
  canEdit: boolean;
  hasSelection: boolean;
  onToggleLayers: () => void;
  onToggleInspector: () => void;
  onToggleHistory: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoom100: () => void;
  onFitAll: () => void;
  onFitSelection: () => void;
  onAddFrame: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onExport: () => void;
  onDownload: () => void;
  onToggleMode: () => void;
  onRename: (name: string) => void;
  onAskAgent: () => void;
  onShortcuts: () => void;
  /** Whether the design tab's agent panel shows; omitted when the tab has none. */
  agentPanelOpen?: boolean;
  onToggleAgentPanel?: () => void;
}

/**
 * The design toolbar's hover tooltip: the app's shared tooltip (same delay and
 * look as every other toolbar), opened by hover or keyboard focus. The trigger
 * is a wrapper so disabled buttons still explain themselves on hover. A stable
 * description on the button reaches keyboard users without replacing the button
 * when it becomes disabled (dialogs must be able to restore focus to it).
 */
function ToolbarTooltip({
  label,
  shortcut,
  className,
  children,
}: {
  label: string;
  shortcut?: string;
  className?: string;
  children: ReactElement<{ "aria-describedby"?: string }>;
}) {
  const descriptionId = useId();
  const describedBy = [children.props["aria-describedby"], descriptionId].filter(Boolean).join(" ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex", className)} data-design-tooltip-trigger="">
          {cloneElement(children, { "aria-describedby": describedBy })}
        </span>
      </TooltipTrigger>
      <span id={descriptionId} className="sr-only">
        {label}
        {shortcut ? ` ${shortcut}` : ""}
      </span>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
        {shortcut && <span className="ml-2 text-muted-foreground">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function RenameField({
  name,
  disabled,
  onRename,
}: {
  name: string;
  disabled: boolean;
  onRename: (name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const trimmed = value.trim();
  const valid = trimmed.length > 0 && trimmed.length <= 120;
  if (!editing)
    return (
      <ToolbarTooltip label={disabled ? name : "Rename design"} className="mr-auto min-w-0">
        <button
          type="button"
          className="min-w-0 truncate rounded-sm px-1 text-left text-sm font-medium hover:bg-muted focus-hairline disabled:pointer-events-none disabled:hover:bg-transparent"
          disabled={disabled}
          aria-label={`Design name: ${name}. Rename`}
          onClick={() => {
            setValue(name);
            setEditing(true);
          }}
        >
          {name}
        </button>
      </ToolbarTooltip>
    );
  return (
    <form
      className="mr-auto flex min-w-0 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;
        setEditing(false);
        if (trimmed !== name) onRename(trimmed);
      }}
    >
      <Input
        autoFocus
        aria-label="Design name"
        aria-invalid={!valid}
        maxLength={120}
        className="h-7 w-48 text-sm"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            setEditing(false);
          }
        }}
      />
      {!valid && <span className="text-xs text-destructive">Enter 1–120 characters</span>}
    </form>
  );
}

interface DesignTool {
  /** Stable React key: the zoom item's label changes with the zoom. */
  id: string;
  /** Accessible name inline; the visible text in the overflow menu. */
  label: string;
  icon: LucideIcon;
  /** Shown inline instead of the icon. */
  text?: string;
  onSelect: () => void;
  /** The tooltip text; the label when omitted. */
  tooltip?: string;
  /** The keyboard shortcut, shown dimmed after the tooltip text. */
  shortcut?: string;
  disabled?: boolean;
  /** A toggle: aria-pressed inline, a checkbox item in the menu. */
  pressed?: boolean;
  /** Keeps the overflow menu open so the step can be repeated (zoom). */
  repeat?: boolean;
}

/** A tool's tooltip with its shortcut, for the overflow menu's native title. */
function toolTitle(tool: DesignTool): string {
  const text = tool.tooltip ?? tool.label;
  return tool.shortcut ? `${text} (${tool.shortcut})` : text;
}

function toolsOf(props: DesignToolbarProps): DesignTool[] {
  const { projection } = props;
  const history = projection?.workspace?.history;
  const canvas = projection?.canvas;
  const busyExport = projection?.busy.export ?? false;
  const preview = props.mode === "preview";
  return [
    {
      id: "zoom-out",
      label: "Zoom out",
      icon: Minus,
      shortcut: "-",
      onSelect: props.onZoomOut,
      repeat: true,
    },
    {
      id: "zoom-100",
      label: `Zoom ${Math.round(props.zoom * 100)}%. Reset to 100%`,
      icon: Percent,
      text: `${Math.round(props.zoom * 100)}%`,
      tooltip: "Zoom to 100%",
      shortcut: "Ctrl/⌘+0",
      onSelect: props.onZoom100,
      repeat: true,
    },
    {
      id: "zoom-in",
      label: "Zoom in",
      icon: Plus,
      shortcut: "+",
      onSelect: props.onZoomIn,
      repeat: true,
    },
    {
      id: "fit-all",
      label: "Fit all frames",
      icon: Maximize,
      shortcut: "Shift+1",
      onSelect: props.onFitAll,
    },
    {
      id: "fit-selection",
      label: "Zoom to selection",
      // Fit all is the bare frame corners; this one has a target inside them.
      icon: Focus,
      tooltip: props.hasSelection ? undefined : "Zoom to selection (select a frame first)",
      shortcut: "Shift+2",
      disabled: !props.hasSelection,
      onSelect: props.onFitSelection,
    },
    {
      id: "preview",
      label: preview ? "Exit preview mode" : "Preview mode",
      icon: preview ? MousePointer2 : Eye,
      tooltip: preview ? "Back to inspect" : "Preview: scroll and hover the mockup",
      shortcut: preview ? "P or Esc" : "P",
      pressed: preview,
      onSelect: props.onToggleMode,
    },
    {
      id: "add-frame",
      label: "Add frame",
      icon: SquarePlus,
      disabled: !canvas || !props.canEdit,
      onSelect: props.onAddFrame,
    },
    {
      id: "undo",
      label: "Undo design change",
      icon: Undo2,
      tooltip: history?.undoLabel
        ? `Undo ${history.undoLabel}`
        : (history?.undoBlockedReason ?? "Undo"),
      shortcut: "Ctrl/⌘+Z",
      disabled: !canvas || !props.canEdit || !history?.canUndo,
      onSelect: props.onUndo,
    },
    {
      id: "redo",
      label: "Redo design change",
      icon: Redo2,
      tooltip: history?.redoLabel
        ? `Redo ${history.redoLabel}`
        : (history?.redoBlockedReason ?? "Redo"),
      shortcut: "Ctrl/⌘+Shift+Z",
      disabled: !canvas || !props.canEdit || !history?.canRedo,
      onSelect: props.onRedo,
    },
    {
      id: "export",
      label: "Export design to repository",
      icon: Save,
      tooltip: "Export a revision to the repository (Save As)",
      disabled: !canvas || busyExport,
      onSelect: props.onExport,
    },
    {
      id: "download",
      label: "Download orkdes",
      icon: Download,
      tooltip: "Download the design as an .orkdes file",
      disabled: !canvas,
      onSelect: props.onDownload,
    },
    {
      id: "history",
      label: "Design history",
      icon: History,
      pressed: props.historyOpen,
      disabled: !canvas,
      onSelect: props.onToggleHistory,
    },
    {
      id: "ask-agent",
      label: "Ask agent about the selection",
      icon: MessageSquarePlus,
      disabled: !canvas,
      onSelect: props.onAskAgent,
    },
  ];
}

/**
 * The tools behind one button, for panes too short for the wrapped toolbar
 * (about 400% zoom). An action runs once the menu has closed and focus is
 * back on the trigger, so a dialog it opens returns focus there.
 */
function DesignToolsMenu({ tools, shortcuts }: { tools: DesignTool[]; shortcuts: DesignTool }) {
  const deferred = useRef<(() => void) | null>(null);
  const item = (tool: DesignTool) => {
    const onSelect = (event: Event) => {
      if (tool.repeat) {
        event.preventDefault();
        tool.onSelect();
      } else deferred.current = tool.onSelect;
    };
    const Icon = tool.icon;
    return tool.pressed === undefined ? (
      <DropdownMenuItem
        key={tool.id}
        title={toolTitle(tool)}
        disabled={tool.disabled}
        onSelect={onSelect}
      >
        <Icon />
        {tool.label}
      </DropdownMenuItem>
    ) : (
      <DropdownMenuCheckboxItem
        key={tool.id}
        title={toolTitle(tool)}
        checked={tool.pressed}
        disabled={tool.disabled}
        onSelect={onSelect}
      >
        {tool.label}
      </DropdownMenuCheckboxItem>
    );
  };
  return (
    <DropdownMenu>
      <ToolbarTooltip label="More design tools">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="size-8" aria-label="More design tools">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
      </ToolbarTooltip>
      <DropdownMenuContent
        align="end"
        onCloseAutoFocus={() => {
          const run = deferred.current;
          deferred.current = null;
          run?.();
        }}
      >
        {tools.map(item)}
        <DropdownMenuSeparator />
        {item(shortcuts)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function DesignToolbar(props: DesignToolbarProps) {
  const { projection, layersButtonRef } = props;
  const canvas = projection?.canvas;
  const tools = toolsOf(props);
  const shortcuts: DesignTool = {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    icon: Keyboard,
    shortcut: "?",
    onSelect: props.onShortcuts,
  };
  const iconClass = props.compact ? "size-8" : undefined;
  const iconButton = (tool: DesignTool) => {
    const Icon = tool.icon;
    return (
      <ToolbarTooltip key={tool.id} label={tool.tooltip ?? tool.label} shortcut={tool.shortcut}>
        <Button
          variant="ghost"
          size="icon"
          aria-label={tool.label}
          aria-pressed={tool.pressed}
          disabled={tool.disabled}
          onClick={tool.onSelect}
        >
          <Icon className="size-4" />
        </Button>
      </ToolbarTooltip>
    );
  };
  return (
    <header
      className={`flex items-center gap-1 border-b border-divider px-2 ${
        props.compact ? "py-1" : "flex-wrap py-2"
      }`}
      role="toolbar"
      aria-label="Design tools"
      data-compact={props.compact || undefined}
    >
      <ToolbarTooltip label={props.layersOpen ? "Hide layers" : "Show layers"}>
        <Button
          ref={layersButtonRef}
          variant="ghost"
          size="icon"
          className={iconClass}
          aria-label="Toggle layers"
          aria-pressed={props.layersOpen}
          onClick={props.onToggleLayers}
        >
          <Layers className="size-4" />
        </Button>
      </ToolbarTooltip>
      {props.onToggleAgentPanel && (
        <ToolbarTooltip
          label={props.agentPanelOpen ? "Hide agent panel" : "Show agent panel"}
          shortcut="Ctrl/⌘+."
        >
          <Button
            variant="ghost"
            size="icon"
            className={iconClass}
            aria-label={props.agentPanelOpen ? "Hide agent panel" : "Show agent panel"}
            aria-pressed={props.agentPanelOpen}
            onClick={props.onToggleAgentPanel}
          >
            <BotMessageSquare className="size-4" />
          </Button>
        </ToolbarTooltip>
      )}
      {canvas ? (
        <RenameField
          key={canvas.name}
          name={canvas.name}
          disabled={!props.canEdit}
          onRename={props.onRename}
        />
      ) : (
        <span className="mr-auto truncate text-sm font-medium">Loading design…</span>
      )}
      {!props.compact &&
        tools.map((tool) =>
          tool.text ? (
            <ToolbarTooltip
              key={tool.id}
              label={tool.tooltip ?? tool.label}
              shortcut={tool.shortcut}
            >
              <button
                type="button"
                className="min-w-11 rounded-sm px-1 text-xs tabular-nums hover:bg-muted focus-hairline"
                aria-label={tool.label}
                onClick={tool.onSelect}
              >
                {tool.text}
              </button>
            </ToolbarTooltip>
          ) : (
            iconButton(tool)
          ),
        )}
      {props.narrow && (
        <ToolbarTooltip label={props.inspectorOpen ? "Hide inspector" : "Show inspector"}>
          <Button
            variant="ghost"
            size="icon"
            className={iconClass}
            aria-label="Toggle inspector"
            aria-pressed={props.inspectorOpen}
            onClick={props.onToggleInspector}
          >
            <PanelRight className="size-4" />
          </Button>
        </ToolbarTooltip>
      )}
      {props.compact ? (
        <DesignToolsMenu tools={tools} shortcuts={shortcuts} />
      ) : (
        iconButton(shortcuts)
      )}
    </header>
  );
}

const modifierNames: Record<string, string> = { "⌘": "Ctrl/⌘", "⇧": "Shift", "⌥": "Alt" };

export const DESIGN_SHORTCUTS: Array<[string, string]> = DESIGN_KEYBOARD_SHORTCUTS.map(
  (shortcut) => [
    shortcut.mac.map((key) => modifierNames[key] ?? key).join(" + "),
    shortcut.description,
  ],
);
