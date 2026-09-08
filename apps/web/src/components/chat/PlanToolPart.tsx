import { AlertCircle, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { extractPlanMarkdown, firstMarkdownHeading, getPlanToolLabel } from "@/lib/plan-tool";
import { markdownComponents } from "./NativeMessage.shared";

const TOOL_STATE_COLORS = {
  success: "text-success",
  failure: "text-failure",
  pending: "text-yellow-600 animate-pulse",
} as const;

interface PlanToolPartProps {
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
  /** Output exists behind a detail reference and loads with this row. */
  deferredDetails?: boolean;
}

export function PlanToolPart({
  toolName,
  toolState,
  toolTitle,
  toolArgs,
  toolOutput,
  toolError,
  deferredDetails = false,
}: PlanToolPartProps) {
  const plan = extractPlanMarkdown(toolArgs, toolOutput);
  const title =
    getPlanToolLabel(toolName, toolTitle) === "Plan"
      ? (firstMarkdownHeading(plan) ?? "Plan")
      : getPlanToolLabel(toolName, toolTitle);
  const stateLabel =
    toolState === "pending" ? "writing..." : toolState === "failure" ? "failure" : toolState;

  return (
    <section
      aria-label="Implementation plan"
      className="my-2 overflow-hidden rounded-lg border border-border bg-card"
    >
      <header className="flex items-center gap-2 border-b border-border bg-amber-500/10 px-3 py-2">
        <FileText className="h-4 w-4 shrink-0 text-amber-500" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
        {stateLabel && (
          <span className={cn("shrink-0 text-xs", toolState ? TOOL_STATE_COLORS[toolState] : "")}>
            {stateLabel}
          </span>
        )}
      </header>
      <div className="max-h-[32rem] overflow-auto px-3 py-3">
        {plan ? (
          <MessageMarkdown
            content={plan}
            components={markdownComponents}
            className="text-sm prose-invert prose-p:my-2 prose-headings:my-3 prose-ul:my-2 prose-ol:my-2 prose-pre:my-2"
          />
        ) : toolError ? null : toolState === "pending" ? (
          <p className="text-xs text-muted-foreground">Writing plan…</p>
        ) : deferredDetails ? (
          <p className="text-xs text-muted-foreground">Loading plan…</p>
        ) : (
          <p className="text-xs text-muted-foreground">No plan content.</p>
        )}
        {toolError && (
          <div className="mt-2 flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
            <pre className="text-xs font-mono text-destructive whitespace-pre-wrap break-all">
              {toolError}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}
