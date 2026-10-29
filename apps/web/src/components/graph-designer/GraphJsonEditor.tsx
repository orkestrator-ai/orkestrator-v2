import { useState } from "react";
import { X } from "lucide-react";
import type { FieldError } from "@orkestrator/protocol/field-validation";
import { graphTemplateExportText } from "@orkestrator/protocol/graphs/library";
import type { GraphTemplateV1 } from "@orkestrator/protocol/graphs/template";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { parseGraphDraft } from "@/stores/graphDesignerStore";

/**
 * The draft as JSON (P1.10's JSON editing, kept beside the canvas in item
 * 212). The text shows the draft; typing a valid template replaces the draft
 * as one undoable edit, so the canvas, the forms and the compile panel
 * follow. Text that is not a template stays here, with the reasons, until it
 * is fixed; an edit made elsewhere (canvas, undo) replaces it.
 */

export function GraphJsonEditor({
  draft,
  onChange,
  onClose,
}: {
  draft: GraphTemplateV1;
  onChange: (template: GraphTemplateV1) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(() => graphTemplateExportText(draft));
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [shown, setShown] = useState(draft);
  if (draft !== shown) {
    // The draft changed elsewhere (or this editor's own edit landed).
    setShown(draft);
    setText(graphTemplateExportText(draft));
    setErrors([]);
  }
  const change = (next: string) => {
    setText(next);
    const parsed = parseGraphDraft(next);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    setErrors([]);
    setShown(parsed.template);
    onChange(parsed.template);
  };
  return (
    <section
      aria-label="Template JSON"
      data-graph-json-editor=""
      className="flex min-h-0 flex-col gap-2 p-3"
    >
      <header className="flex items-center gap-2">
        <h3 className="text-xs font-semibold text-foreground">Edit as JSON</h3>
        <span className="text-[11px] text-muted-foreground">valid text replaces the draft</span>
        <Button
          variant="ghost"
          size="icon"
          className="ml-auto h-6 w-6"
          aria-label="Close the JSON view"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <Textarea
        aria-label="Template JSON"
        value={text}
        spellCheck={false}
        onChange={(event) => change(event.target.value)}
        className="min-h-48 flex-1 resize-none font-mono text-[11px] leading-4"
      />
      {errors.length > 0 ? (
        <ul role="alert" data-graph-json-errors="" className="max-h-24 overflow-y-auto text-[11px]">
          {errors.map((error, index) => (
            <li key={`${error.path}:${index}`}>
              <span className="font-mono text-muted-foreground">{error.path}</span>{" "}
              <span className="text-failure">{error.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
