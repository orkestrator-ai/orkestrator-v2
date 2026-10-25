import { useRef, useState, type Ref } from "react";
import {
  Download,
  Eye,
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
  Scan,
  SquarePlus,
  Undo2,
  type LucideIcon,
} from "lucide-react";
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
      <button
        type="button"
        className="mr-auto min-w-0 truncate rounded-sm px-1 text-left text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:hover:bg-transparent"
        disabled={disabled}
        title={disabled ? name : "Rename design"}
        aria-label={`Design name: ${name}. Rename`}
        onClick={() => {
          setValue(name);
          setEditing(true);
        }}
      >
        {name}
      </button>
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
  title?: string;
  disabled?: boolean;
  /** A toggle: aria-pressed inline, a checkbox item in the menu. */
  pressed?: boolean;
  /** Keeps the overflow menu open so the step can be repeated (zoom). */
  repeat?: boolean;
}

function toolsOf(props: DesignToolbarProps): DesignTool[] {
  const { projection } = props;
  const history = projection?.workspace?.history;
  const canvas = projection?.canvas;
  const busyExport = projection?.busy.export ?? false;
  const preview = props.mode === "preview";
  return [
    { id: "zoom-out", label: "Zoom out", icon: Minus, onSelect: props.onZoomOut, repeat: true },
    {
      id: "zoom-100",
      label: `Zoom ${Math.round(props.zoom * 100)}%. Reset to 100%`,
      icon: Percent,
      text: `${Math.round(props.zoom * 100)}%`,
      title: "Zoom to 100% (Ctrl/⌘+0)",
      onSelect: props.onZoom100,
      repeat: true,
    },
    { id: "zoom-in", label: "Zoom in", icon: Plus, onSelect: props.onZoomIn, repeat: true },
    {
      id: "fit-all",
      label: "Fit all frames",
      icon: Maximize,
      title: "Fit all (Shift+1)",
      onSelect: props.onFitAll,
    },
    {
      id: "fit-selection",
      label: "Zoom to selection",
      icon: Scan,
      title: "Zoom to selection (Shift+2)",
      disabled: !props.hasSelection,
      onSelect: props.onFitSelection,
    },
    {
      id: "preview",
      label: preview ? "Exit preview mode" : "Preview mode",
      icon: preview ? MousePointer2 : Eye,
      title: preview ? "Back to inspect (P or Esc)" : "Preview: scroll and hover the mockup (P)",
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
      title: history?.undoLabel
        ? `Undo ${history.undoLabel} (Ctrl/⌘+Z)`
        : (history?.undoBlockedReason ?? "Undo (Ctrl/⌘+Z)"),
      disabled: !canvas || !props.canEdit || !history?.canUndo,
      onSelect: props.onUndo,
    },
    {
      id: "redo",
      label: "Redo design change",
      icon: Redo2,
      title: history?.redoLabel
        ? `Redo ${history.redoLabel} (Ctrl/⌘+Shift+Z)`
        : (history?.redoBlockedReason ?? "Redo (Ctrl/⌘+Shift+Z)"),
      disabled: !canvas || !props.canEdit || !history?.canRedo,
      onSelect: props.onRedo,
    },
    {
      id: "export",
      label: "Export design to repository",
      icon: Save,
      title: "Export a revision to the repository (Save As)",
      disabled: !canvas || busyExport,
      onSelect: props.onExport,
    },
    {
      id: "download",
      label: "Download orkdes",
      icon: Download,
      disabled: !canvas,
      onSelect: props.onDownload,
    },
    {
      id: "history",
      label: "Design history",
      icon: History,
      pressed: props.historyOpen,
      disabled: !canvas || projection?.legacy === true,
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
        title={tool.title}
        disabled={tool.disabled}
        onSelect={onSelect}
      >
        <Icon />
        {tool.label}
      </DropdownMenuItem>
    ) : (
      <DropdownMenuCheckboxItem
        key={tool.id}
        title={tool.title}
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
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="size-8" aria-label="More design tools">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
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
  const { projection } = props;
  const canvas = projection?.canvas;
  const tools = toolsOf(props);
  const shortcuts: DesignTool = {
    id: "shortcuts",
    label: "Keyboard shortcuts",
    icon: Keyboard,
    onSelect: props.onShortcuts,
  };
  const iconClass = props.compact ? "size-8" : undefined;
  const iconButton = (tool: DesignTool) => {
    const Icon = tool.icon;
    return (
      <Button
        key={tool.id}
        variant="ghost"
        size="icon"
        aria-label={tool.label}
        aria-pressed={tool.pressed}
        title={tool.title}
        disabled={tool.disabled}
        onClick={tool.onSelect}
      >
        <Icon className="size-4" />
      </Button>
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
      <Button
        ref={props.layersButtonRef}
        variant="ghost"
        size="icon"
        className={iconClass}
        aria-label="Toggle layers"
        aria-pressed={props.layersOpen}
        onClick={props.onToggleLayers}
      >
        <Layers className="size-4" />
      </Button>
      {canvas ? (
        <RenameField
          key={canvas.name}
          name={canvas.name}
          disabled={!props.canEdit || projection?.legacy === true}
          onRename={props.onRename}
        />
      ) : (
        <span className="mr-auto truncate text-sm font-medium">Loading design…</span>
      )}
      {!props.compact &&
        tools.map((tool) =>
          tool.text ? (
            <button
              key={tool.id}
              type="button"
              className="min-w-11 rounded-sm px-1 text-xs tabular-nums hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              aria-label={tool.label}
              title={tool.title}
              onClick={tool.onSelect}
            >
              {tool.text}
            </button>
          ) : (
            iconButton(tool)
          ),
        )}
      {props.narrow && (
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
      )}
      {props.compact ? (
        <DesignToolsMenu tools={tools} shortcuts={shortcuts} />
      ) : (
        iconButton(shortcuts)
      )}
    </header>
  );
}

export const DESIGN_SHORTCUTS: Array<[string, string]> = [
  ["Arrow keys", "Move the focused frame (Shift: 10px)"],
  ["Alt + Arrow keys", "Resize the focused frame"],
  ["Ctrl/⌘ + Z", "Undo your last design edit"],
  ["Ctrl/⌘ + Shift + Z, Ctrl + Y", "Redo"],
  ["Shift + 1", "Fit all frames"],
  ["Shift + 2", "Zoom to selection"],
  ["Ctrl/⌘ + 0", "Zoom to 100%"],
  ["+ / −", "Zoom in / out"],
  ["P", "Toggle preview mode"],
  ["Click a frame title", "Select the frame"],
  ["Delete / Backspace", "Delete the selected frame"],
  ["Escape", "Cancel a gesture, exit preview, clear selection, close panels"],
  ["Ctrl/⌘ + scroll, pinch", "Zoom at the pointer"],
  ["Scroll, Shift + scroll, middle-drag", "Pan the canvas"],
];
