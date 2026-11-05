import { AlertCircle } from "lucide-react";

import { HumanPromptActions, humanPromptHeadline } from "@/components/chat/HumanPromptActions";
import { Button } from "@/components/ui/button";
import type { HumanPromptEntry } from "@orkestrator/protocol/human-prompts";

/**
 * Commands waiting on the user, as a strip of actionable rows: what is
 * asking, the link to open and the code to enter. Rendered in the tab the
 * command runs in and in the coordinator conversation that owns the worker,
 * from the same backend registry, so both clear when the command moves on.
 */
export function HumanPromptBanner<Entry extends HumanPromptEntry & { nodeId?: string }>({
  prompts,
  label,
  onOpen,
  canOpen,
}: {
  prompts: readonly Entry[];
  /** Where each prompt is, when the banner covers several environments. */
  label?: (entry: Entry) => string | undefined;
  /** Opens the tab a prompt belongs to, when the banner is shown somewhere else. */
  onOpen?: (entry: Entry) => void;
  /** Whether `onOpen` has anywhere to go for this entry; every entry when absent. */
  canOpen?: (entry: Entry) => boolean;
}) {
  if (prompts.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="shrink-0 space-y-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2"
      data-human-prompts={prompts.length}
    >
      {prompts.map((entry) => {
        const where = label?.(entry);
        return (
          <div
            key={`${entry.nodeId ?? ""}:${entry.environmentId}:${entry.id}`}
            className="min-w-0 space-y-1.5"
          >
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-amber-200">
              <AlertCircle className="size-3.5 shrink-0" aria-hidden="true" />
              <span className="font-medium">{humanPromptHeadline(entry.prompt)}</span>
              {where ? <span className="truncate text-amber-200/80">· {where}</span> : null}
              {entry.command ? (
                <code
                  className="min-w-0 truncate text-[11px] text-muted-foreground"
                  title={entry.command}
                >
                  {entry.command}
                </code>
              ) : null}
              {onOpen && (canOpen?.(entry) ?? true) ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto h-6 shrink-0 px-2 text-[11px]"
                  aria-label={`Open ${where ?? "the worker's tab"}`}
                  title="Open the worker's tab"
                  onClick={() => onOpen(entry)}
                >
                  Open
                </Button>
              ) : null}
            </div>
            {entry.prompt.url || entry.prompt.code ? (
              <HumanPromptActions prompt={entry.prompt} />
            ) : (
              <div
                className="truncate font-mono text-[11px] text-muted-foreground"
                title={entry.prompt.text}
              >
                {entry.prompt.text}
                {entry.source === "user-command" ? "" : " (answer it in the worker's tab)"}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
