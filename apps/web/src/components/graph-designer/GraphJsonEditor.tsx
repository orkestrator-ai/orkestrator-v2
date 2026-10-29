import { useEffect } from "react";
import { Loader2, RotateCcw, Save, X } from "lucide-react";
import type { AgentPlatform } from "@orkestrator/protocol/agent-platforms";
import type { GraphCapabilityCeiling } from "@orkestrator/protocol/graphs/capability-profiles";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useGraphDesignerStore, type GraphDesignerEditor } from "@/stores/graphDesignerStore";

/**
 * JSON editing of a user template (P1.10: "Duplicate" gives a user template
 * the user can then edit as JSON). The draft compiles in the browser as it
 * changes, so the canvas and compile panel follow it; Save writes it with
 * compare-and-swap on the revision the edit started from, and a lost race
 * keeps the text and says so. Item 212 replaces this with canvas editing.
 */

/** Wait this long after the last keystroke before compiling the draft. */
export const GRAPH_DRAFT_COMPILE_DELAY_MS = 250;

export function GraphJsonEditor({
  tabId,
  editor,
  providers,
  ceiling,
}: {
  tabId: string;
  editor: GraphDesignerEditor;
  providers: readonly AgentPlatform[];
  ceiling?: GraphCapabilityCeiling;
}) {
  const editDraft = useGraphDesignerStore((state) => state.editDraft);
  const compileDraft = useGraphDesignerStore((state) => state.compileDraft);
  const saveDraft = useGraphDesignerStore((state) => state.saveDraft);
  const reloadDraft = useGraphDesignerStore((state) => state.reloadDraft);
  const closeEditor = useGraphDesignerStore((state) => state.closeEditor);

  useEffect(() => {
    const timer = setTimeout(
      () => compileDraft(tabId, { providers, ...(ceiling ? { ceiling } : {}) }),
      GRAPH_DRAFT_COMPILE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [tabId, editor.text, providers, ceiling, compileDraft]);

  return (
    <section
      aria-label="Template JSON"
      data-graph-json-editor=""
      className="flex min-h-0 flex-col gap-2 p-3"
    >
      <header className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-foreground">Edit as JSON</h3>
        <span className="text-[11px] text-muted-foreground">
          based on revision {editor.baseRevision}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-6 w-6"
          aria-label="Close the JSON editor"
          onClick={() => closeEditor(tabId)}
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <Textarea
        aria-label="Template JSON"
        value={editor.text}
        spellCheck={false}
        onChange={(event) => editDraft(tabId, event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "s") {
            event.preventDefault();
            void saveDraft(tabId);
          }
        }}
        className="min-h-48 flex-1 resize-none font-mono text-[11px] leading-4"
      />
      {editor.parseErrors.length > 0 ? (
        <ul role="alert" data-graph-json-errors="" className="max-h-24 overflow-y-auto text-[11px]">
          {editor.parseErrors.map((error, index) => (
            <li key={`${error.path}:${index}`}>
              <span className="font-mono text-muted-foreground">{error.path}</span>{" "}
              <span className="text-failure">{error.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {editor.error ? (
        <p
          role="alert"
          data-graph-save-conflict={editor.conflict ? "" : undefined}
          className="text-[11px] text-failure"
        >
          {editor.error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        {editor.conflict ? (
          <Button variant="outline" size="sm" onClick={() => void reloadDraft(tabId)}>
            <RotateCcw className="size-3.5" />
            Reload latest
          </Button>
        ) : null}
        <Button
          size="sm"
          className="ml-auto"
          disabled={editor.saving}
          onClick={() => void saveDraft(tabId)}
        >
          {editor.saving ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Save className="size-3.5" />
          )}
          Save
        </Button>
      </div>
    </section>
  );
}
