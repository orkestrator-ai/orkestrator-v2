import { AlertCircle } from "lucide-react";

import { HumanPromptActions, humanPromptHeadline } from "@/components/chat/HumanPromptActions";
import type { HumanPromptEntry } from "@orkestrator/protocol/human-prompts";

/**
 * Commands waiting on the user, as a strip of actionable rows: what is
 * asking, the link to open and the code to enter. Rendered in the tab the
 * command runs in and in the coordinator conversation that owns the worker,
 * from the same backend registry, so both clear when the command moves on.
 */
export function HumanPromptBanner({
  prompts,
  label,
}: {
  prompts: readonly HumanPromptEntry[];
  /** Where each prompt is, when the banner covers several environments. */
  label?: (entry: HumanPromptEntry) => string | undefined;
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
          <div key={`${entry.environmentId}:${entry.id}`} className="min-w-0 space-y-1.5">
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
