import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, ImageIcon, Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { WorkspaceFilePickerDialog, type NativeAttachmentFileSearch } from "./NativeAttachmentMenu";
import {
  describePromptQueueEditConflict,
  queuedPromptAttachmentName,
  type PromptQueueEditConflict,
  type QueuedPromptStoredAttachment,
} from "@/lib/prompt-queue-edit";
import { cn } from "@/lib/utils";
import type { FileCandidate } from "@/types";

export interface QueuedPromptEditorProps {
  /** 1-based position of the prompt in the queue, for its label. */
  position?: number;
  length: number;
  text: string;
  attachments: readonly QueuedPromptStoredAttachment[];
  conflict?: PromptQueueEditConflict;
  busy: boolean;
  onTextChange: (text: string) => void;
  onRemoveAttachment: (path: string) => void;
  filePicker?: {
    search: NativeAttachmentFileSearch;
    select: (file: FileCandidate) => void;
  };
  onSave: () => void;
  onCancel: () => void;
  /** After a conflict: write this text over whatever the prompt holds now. */
  onOverwrite: () => void;
  /** After a conflict: drop this edit. */
  onDiscard: () => void;
}

const MAX_ROWS = 8;

/**
 * Edits a queued prompt where it stands in the queue. The composer below,
 * and any draft in it, is left alone; the prompt keeps its place, and the
 * backend holds it back from delivery until this edit is saved or cancelled.
 *
 * Mod+Enter saves and Escape cancels, both kept from reaching the tab.
 */
export function QueuedPromptEditor({
  position,
  length,
  text,
  attachments,
  conflict,
  busy,
  onTextChange,
  onRemoveAttachment,
  filePicker,
  onSave,
  onCancel,
  onOverwrite,
  onDiscard,
}: QueuedPromptEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const conflictId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) {
        if (conflict) onDiscard();
        else onCancel();
      }
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (!busy && !conflict) onSave();
    }
  };

  const rows = Math.min(MAX_ROWS, Math.max(2, text.split("\n").length));
  return (
    <div
      data-testid="compose-queue-editor"
      role="group"
      aria-label={
        position ? `Editing queued prompt ${position} of ${length}` : "Queued prompt edit"
      }
      className="flex flex-col gap-1.5 border-b border-border/40 px-3 py-2"
    >
      <textarea
        ref={textareaRef}
        value={text}
        rows={rows}
        onChange={(event) => onTextChange(event.target.value)}
        onKeyDown={handleKeyDown}
        aria-label={position ? `Queued prompt ${position} text` : "Queued prompt text"}
        aria-describedby={conflict ? `${conflictId} ${hintId}` : hintId}
        readOnly={busy}
        className="w-full resize-none rounded border border-border/60 bg-background/60 px-2 py-1 text-xs leading-relaxed text-foreground outline-none focus-hairline"
      />
      {attachments.length > 0 ? (
        <ul aria-label="Attachments" className="flex flex-wrap gap-1">
          {attachments.map((attachment) => {
            const name = queuedPromptAttachmentName(attachment);
            const Icon = attachment.type === "image" ? ImageIcon : Paperclip;
            return (
              <li
                key={attachment.path}
                data-testid="compose-queue-editor-attachment"
                className="inline-flex max-w-[16rem] items-center gap-1 rounded border border-border/60 bg-muted/40 py-px pr-0.5 pl-1.5 text-[11px] text-muted-foreground"
                title={attachment.path}
              >
                <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="truncate">{name}</span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(attachment.path)}
                  disabled={busy || Boolean(conflict)}
                  aria-label={`Remove attachment ${name}`}
                  className="rounded p-0.5 outline-none hover:text-failure focus-hairline disabled:opacity-50"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {conflict ? (
        <div
          id={conflictId}
          role="alert"
          data-testid="compose-queue-editor-conflict"
          className="flex items-start gap-1.5 text-[11px] text-failure"
        >
          <AlertCircle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{describePromptQueueEditConflict(conflict)}</span>
        </div>
      ) : null}
      <div className="flex items-center gap-2">
        {filePicker && !conflict ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 shrink-0 px-2 text-xs"
              disabled={busy || !filePicker.search.isAvailable}
              onClick={() => setPickerOpen(true)}
            >
              <Paperclip className="size-3" aria-hidden="true" />
              Attach file
            </Button>
            <WorkspaceFilePickerDialog
              open={pickerOpen}
              onOpenChange={setPickerOpen}
              fileSearch={filePicker.search}
              onSelectFile={filePicker.select}
              onCloseAutoFocus={() => textareaRef.current?.focus()}
              title="Attach workspace file"
              description="Choose a file to attach to this queued prompt."
            />
          </>
        ) : null}
        <span id={hintId} className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {conflict
            ? "Escape discards your edit."
            : "Held in its place until you save. ⌘/Ctrl+Enter saves, Escape cancels."}
        </span>
        {conflict ? (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onDiscard}
              disabled={busy}
            >
              Discard mine
            </Button>
            {conflict !== "missing" ? (
              <Button
                type="button"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={onOverwrite}
                disabled={busy}
                aria-busy={busy}
              >
                Use mine
              </Button>
            ) : null}
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              className={cn("h-6 px-2 text-xs")}
              onClick={onSave}
              disabled={busy}
              aria-busy={busy}
            >
              Save
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
