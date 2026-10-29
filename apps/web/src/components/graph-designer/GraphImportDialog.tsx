import { useRef, useState, type ChangeEvent } from "react";
import { FileUp, Loader2 } from "lucide-react";
import type { FieldError } from "@orkestrator/protocol/field-validation";
import type { GraphTemplateImportResult } from "@orkestrator/protocol/graphs/library";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/**
 * JSON import (P1.10): pasted text or a `.graph.json` file goes to
 * `graph_template_import`, which validates it with the template guard and
 * saves it as a new user template. Refused text keeps the dialog open with the
 * guard's errors and their paths.
 */

/** Files above this are refused before reading; the backend's guard has its own byte limit. */
const MAX_IMPORT_FILE_BYTES = 2 * 1024 * 1024;

export function GraphImportDialog({
  open,
  onOpenChange,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (text: string) => Promise<GraphTemplateImportResult>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [omitted, setOmitted] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setErrors([]);
    setOmitted(0);
    setFailure(null);
  };

  const readFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    reset();
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setFailure(`${file.name} is larger than ${MAX_IMPORT_FILE_BYTES / 1024 / 1024} MiB.`);
      return;
    }
    setText(await file.text());
  };

  const submit = async () => {
    if (!text.trim() || busy) return;
    reset();
    setBusy(true);
    try {
      const result = await onImport(text);
      if (result.ok) {
        setText("");
        onOpenChange(false);
      } else {
        setErrors(result.errors);
        setOmitted(result.omittedErrors);
      }
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>Import a graph template</DialogTitle>
          <DialogDescription>
            Paste template JSON or choose a <span className="font-mono">.graph.json</span> file. It
            is saved as a new template of yours; a taken id gets a suffix.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="graph-import-text">Template JSON</Label>
            <Textarea
              id="graph-import-text"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                if (errors.length > 0 || failure) reset();
              }}
              spellCheck={false}
              placeholder='{ "format": "orkestrator.graph", "formatVersion": 1, … }'
              className="h-64 font-mono text-xs"
            />
          </div>
          {errors.length > 0 ? (
            <div role="alert" data-graph-import-errors="" className="flex flex-col gap-1">
              <p className="text-xs font-medium text-failure">The template was not imported:</p>
              <ul className="max-h-40 overflow-y-auto text-xs">
                {errors.map((error, index) => (
                  <li key={`${error.path}:${index}`} data-graph-import-error={error.code}>
                    <span className="font-mono text-muted-foreground">{error.path}</span>{" "}
                    <span className="text-foreground">{error.message}</span>
                  </li>
                ))}
                {omitted > 0 ? <li className="text-muted-foreground">{omitted} more.</li> : null}
              </ul>
            </div>
          ) : null}
          {failure ? (
            <p role="alert" className="text-xs text-failure">
              {failure}
            </p>
          ) : null}
          <DialogFooter className="items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              aria-label="Template file"
              onChange={(event) => void readFile(event)}
            />
            <Button
              type="button"
              variant="outline"
              className="sm:mr-auto"
              onClick={() => fileRef.current?.click()}
            >
              <FileUp className="size-4" />
              Choose file…
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!text.trim() || busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              Import
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
