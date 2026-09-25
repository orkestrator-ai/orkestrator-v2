import { useState, type Ref } from "react";
import {
  Download,
  Eye,
  History,
  Keyboard,
  Layers,
  Maximize,
  MessageSquarePlus,
  Minus,
  MousePointer2,
  PanelRight,
  Plus,
  Redo2,
  Save,
  Scan,
  SquarePlus,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { DesignProjection } from "@/stores/designStore";

export interface DesignToolbarProps {
  projection: DesignProjection | undefined;
  /** Focus returns here when the layers drawer closes. */
  layersButtonRef?: Ref<HTMLButtonElement>;
  zoom: number;
  mode: "inspect" | "preview";
  narrow: boolean;
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

export function DesignToolbar(props: DesignToolbarProps) {
  const { projection } = props;
  const history = projection?.workspace?.history;
  const canvas = projection?.canvas;
  const busyExport = projection?.busy.export ?? false;
  return (
    <header
      className="flex flex-wrap items-center gap-1 border-b border-divider px-2 py-2"
      role="toolbar"
      aria-label="Design tools"
    >
      <Button
        ref={props.layersButtonRef}
        variant="ghost"
        size="icon"
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
      <Button variant="ghost" size="icon" aria-label="Zoom out" onClick={props.onZoomOut}>
        <Minus className="size-4" />
      </Button>
      <button
        type="button"
        className="min-w-11 rounded-sm px-1 text-xs tabular-nums hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={`Zoom ${Math.round(props.zoom * 100)}%. Reset to 100%`}
        title="Zoom to 100% (Ctrl/⌘+0)"
        onClick={props.onZoom100}
      >
        {Math.round(props.zoom * 100)}%
      </button>
      <Button variant="ghost" size="icon" aria-label="Zoom in" onClick={props.onZoomIn}>
        <Plus className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Fit all frames"
        title="Fit all (Shift+1)"
        onClick={props.onFitAll}
      >
        <Maximize className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Zoom to selection"
        title="Zoom to selection (Shift+2)"
        disabled={!props.hasSelection}
        onClick={props.onFitSelection}
      >
        <Scan className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={props.mode === "preview" ? "Exit preview mode" : "Preview mode"}
        aria-pressed={props.mode === "preview"}
        title={
          props.mode === "preview"
            ? "Back to inspect (P or Esc)"
            : "Preview: scroll and hover the mockup (P)"
        }
        onClick={props.onToggleMode}
      >
        {props.mode === "preview" ? (
          <MousePointer2 className="size-4" />
        ) : (
          <Eye className="size-4" />
        )}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Add frame"
        disabled={!canvas || !props.canEdit}
        onClick={props.onAddFrame}
      >
        <SquarePlus className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Undo design change"
        title={
          history?.undoLabel
            ? `Undo ${history.undoLabel} (Ctrl/⌘+Z)`
            : (history?.undoBlockedReason ?? "Undo (Ctrl/⌘+Z)")
        }
        disabled={!canvas || !props.canEdit || !history?.canUndo}
        onClick={props.onUndo}
      >
        <Undo2 className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Redo design change"
        title={
          history?.redoLabel
            ? `Redo ${history.redoLabel} (Ctrl/⌘+Shift+Z)`
            : (history?.redoBlockedReason ?? "Redo (Ctrl/⌘+Shift+Z)")
        }
        disabled={!canvas || !props.canEdit || !history?.canRedo}
        onClick={props.onRedo}
      >
        <Redo2 className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Export design to repository"
        title="Export a revision to the repository (Save As)"
        disabled={!canvas || busyExport}
        onClick={props.onExport}
      >
        <Save className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Download orkdes"
        disabled={!canvas}
        onClick={props.onDownload}
      >
        <Download className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Design history"
        aria-pressed={props.historyOpen}
        disabled={!canvas || projection?.legacy === true}
        onClick={props.onToggleHistory}
      >
        <History className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label="Ask agent about the selection"
        disabled={!canvas}
        onClick={props.onAskAgent}
      >
        <MessageSquarePlus className="size-4" />
      </Button>
      {props.narrow && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Toggle inspector"
          aria-pressed={props.inspectorOpen}
          onClick={props.onToggleInspector}
        >
          <PanelRight className="size-4" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Keyboard shortcuts"
        onClick={props.onShortcuts}
      >
        <Keyboard className="size-4" />
      </Button>
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
  ["Escape", "Cancel a gesture, exit preview, clear selection, close panels"],
  ["Ctrl/⌘ + scroll, pinch", "Zoom at the pointer"],
  ["Scroll, Shift + scroll, middle-drag", "Pan the canvas"],
];
