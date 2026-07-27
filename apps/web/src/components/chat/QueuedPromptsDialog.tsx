import type { ReactNode } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

interface QueuedPromptsDialogProps<TQueued extends { id: string; text: string }> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messages: TQueued[];
  /**
   * Per-agent summary line under the prompt text — effort, mode, model, and so
   * on. Everything else about the row is identical across agents.
   */
  renderMeta?: (message: TQueued) => ReactNode;
  /**
   * Pull the entry back into the composer for editing. Every agent supports
   * this; OpenCode's dialog used to render the text as static markup, so a
   * queued prompt could only be deleted and retyped.
   */
  onEdit: (message: TQueued) => void;
  onMove: (fromIndex: number, toIndex: number) => void;
  onRemove: (messageId: string) => void;
}

/**
 * Queue manager shared by the three compose bars.
 */
export function QueuedPromptsDialog<
  TQueued extends { id: string; text: string },
>({
  open,
  onOpenChange,
  messages,
  renderMeta,
  onEdit,
  onMove,
  onRemove,
}: QueuedPromptsDialogProps<TQueued>) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Queued Prompts</DialogTitle>
          <DialogDescription>
            Review pending prompts. Click a message to edit it, or reorder and
            remove items.
          </DialogDescription>
        </DialogHeader>

        {messages.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Queue is empty.
          </div>
        ) : (
          <ScrollArea className="max-h-[380px] pr-3">
            <div className="space-y-2">
              {messages.map((message, index) => (
                <div
                  key={message.id}
                  className="rounded-md border border-border bg-muted/20 p-3"
                >
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0 text-xs font-medium text-muted-foreground">
                      #{index + 1}
                    </div>

                    <div className="min-w-0 flex-1">
                      <button
                        type="button"
                        onClick={() => onEdit(message)}
                        title="Click to edit this message"
                        className="-mx-1 line-clamp-4 w-full cursor-pointer rounded px-1 text-left text-sm break-words whitespace-pre-wrap transition-colors hover:bg-muted/50"
                      >
                        {message.text}
                      </button>
                      {renderMeta && (
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                          {renderMeta(message)}
                        </div>
                      )}
                    </div>

                    <div className="flex shrink-0 flex-col gap-1">
                      <button
                        type="button"
                        onClick={() => onMove(index, index - 1)}
                        disabled={index === 0}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        title="Move up"
                      >
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onMove(index, index + 1)}
                        disabled={index === messages.length - 1}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                        title="Move down"
                      >
                        <ChevronDown className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemove(message.id)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-destructive"
                        title="Remove queued prompt"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
