import { useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { RICH_KIND_MODULES } from "@orkestrator/protocol/rich-interactions";
import type { NativeInteractionReceiptPart } from "@/lib/chat/native-message-types";

/**
 * A decision the user sent through an interaction card, shown in their own
 * message as a compact receipt. The agent-facing summary is one click away so
 * the user can see exactly what the agent received.
 */
export function InteractionReceiptPart({ part }: { part: NativeInteractionReceiptPart }) {
  const [open, setOpen] = useState(false);
  const { interaction } = part;
  const module = RICH_KIND_MODULES[interaction.kind];
  return (
    <div
      className="my-1 rounded-md border border-primary/25 bg-primary/[0.04] text-sm"
      data-interaction-receipt={interaction.receiptId}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left focus-hairline"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <CheckCircle2 className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 truncate font-medium">{interaction.title}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {module?.title ?? interaction.kind} · {interaction.actionId} · rev {interaction.revision}
        </span>
        {open ? (
          <ChevronDown className="ml-auto size-3.5" aria-hidden />
        ) : (
          <ChevronRight className="ml-auto size-3.5" aria-hidden />
        )}
      </button>
      {open ? (
        <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-primary/15 px-3 py-2 text-xs text-foreground/85">
          {part.content}
        </pre>
      ) : null}
    </div>
  );
}
