import { Braces, Copy, LayoutGrid, Loader2, Redo2, RotateCcw, Save, Undo2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { graphDraftDirty, type GraphDesignerEditor } from "@/stores/graphDesignerStore";
import { cn } from "@/lib/utils";

/**
 * The editing bar of the designer (item 212): undo and redo (bounded
 * history), Save (compare-and-swap on the revision the edit started from),
 * Save as copy, Reload latest after a conflict, the JSON view and leaving the
 * editor. It says what the draft is based on, and when the stored template
 * has moved on since the edit started.
 */

export function GraphEditorToolbar({
  editor,
  storedRevision,
  jsonOpen,
  onUndo,
  onRedo,
  onSave,
  onSaveAsCopy,
  onReload,
  onToggleJson,
  onArrange,
  onClose,
}: {
  editor: GraphDesignerEditor;
  /** The stored template's revision as last read (null for a new draft). */
  storedRevision: number | null;
  jsonOpen: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onSaveAsCopy: () => void;
  onReload: () => void;
  onToggleJson: () => void;
  /** Lays the nodes out automatically (one undoable step). */
  onArrange: () => void;
  onClose: () => void;
}) {
  const dirty = graphDraftDirty(editor);
  const undo = editor.history.past.at(-1);
  const redo = editor.history.future.at(-1);
  const behind = storedRevision !== null && storedRevision > editor.baseRevision;
  return (
    <div
      role="toolbar"
      aria-label="Edit the graph"
      data-graph-editor-toolbar=""
      className="flex min-h-9 flex-wrap items-center gap-1 border-b border-border bg-flow-node/40 px-3 py-1"
    >
      <Button
        variant="ghost"
        size="sm"
        disabled={!undo}
        aria-keyshortcuts="Control+Z Meta+Z"
        title={undo ? `Undo: ${undo.label}` : "Nothing to undo"}
        onClick={onUndo}
      >
        <Undo2 className="size-3.5" /> Undo
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!redo}
        aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
        title={redo ? `Redo: ${redo.label}` : "Nothing to redo"}
        onClick={onRedo}
      >
        <Redo2 className="size-3.5" /> Redo
      </Button>
      <span
        data-graph-draft-state={dirty ? "dirty" : "saved"}
        className={cn("ml-2 text-xs", dirty ? "text-amber-300" : "text-muted-foreground")}
      >
        {editor.isNew
          ? "New graph, not saved yet"
          : dirty
            ? `Unsaved changes (based on revision ${editor.baseRevision})`
            : `Saved · revision ${editor.baseRevision}`}
      </span>
      {behind ? (
        <span className="text-xs text-amber-300" data-graph-draft-behind="">
          · revision {storedRevision} was saved elsewhere
        </span>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onArrange}
          title="Lay the nodes out by their edges, one band per loop"
        >
          <LayoutGrid className="size-3.5" /> Arrange
        </Button>
        <Button
          variant={jsonOpen ? "secondary" : "ghost"}
          size="sm"
          onClick={onToggleJson}
          aria-pressed={jsonOpen}
        >
          <Braces className="size-3.5" /> JSON
        </Button>
        {(editor.conflict || behind) && !editor.isNew ? (
          <Button variant="outline" size="sm" onClick={onReload} disabled={editor.saving}>
            <RotateCcw className="size-3.5" /> Reload latest
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={onSaveAsCopy} disabled={editor.saving}>
          <Copy className="size-3.5" /> Save as copy
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          disabled={editor.saving || (!dirty && !editor.isNew)}
          aria-keyshortcuts="Control+S Meta+S"
        >
          {editor.saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          Save
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Stop editing"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {editor.error ? (
        <div
          role="alert"
          data-graph-save-conflict={editor.conflict ? "" : undefined}
          className="w-full text-xs text-failure"
        >
          <p>{editor.error}</p>
          {editor.saveErrors.length > 0 ? (
            <ul className="mt-0.5 max-h-20 overflow-y-auto" data-graph-save-errors="">
              {editor.saveErrors.slice(0, 20).map((error, index) => (
                <li key={`${error.path}:${index}`}>
                  <span className="font-mono text-muted-foreground">{error.path || "$"}</span>{" "}
                  {error.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
