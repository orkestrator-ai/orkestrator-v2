import { createLogger, formatLogError } from "@orkestrator/protocol/logger";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowRight, Check, Copy, Download, FileText, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { writeText } from "@/lib/native/clipboard";
import { artifactFilename, downloadText } from "@/lib/chat/artifact-download";
import type { NativeMessagePart } from "@/lib/chat/native-message-types";
import { extractPlanMarkdown } from "@/lib/plan-tool";
import { planDisplayTitle, type PlanRevision } from "@/lib/plan-revisions";
import { markdownComponents } from "./NativeMessage.shared";
import { usePlanCardScope, type PlanCardActions } from "./plan-card-context";

const log = createLogger("web.chat");

const TOOL_STATE_COLORS = {
  success: "text-success",
  failure: "text-failure",
  pending: "text-yellow-600 animate-pulse",
} as const;

/**
 * Status chips. Deliberately no "ready" or "approved": the card orders what the
 * agent wrote, it does not certify that the provider will allow anything.
 */
const REVISION_STATE_LABELS = {
  current: "Current plan",
  superseded: "Superseded",
  drafting: "Drafting…",
  failed: "Failed",
} as const;

const REVISION_STATE_CLASSES = {
  current: "border-amber-500/40 bg-amber-500/15 text-amber-600 dark:text-amber-300",
  superseded: "border-border bg-muted text-muted-foreground",
  drafting: "border-yellow-600/30 bg-yellow-600/10 text-yellow-600 animate-pulse",
  failed: "border-failure/30 bg-failure/10 text-failure",
} as const;

interface PlanToolPartProps {
  toolName?: string;
  toolState?: "success" | "failure" | "pending";
  toolTitle?: string;
  toolArgs?: Record<string, unknown>;
  toolOutput?: string;
  toolError?: string;
  /** The original transcript part, before deferred details are materialized. */
  sourcePart?: Extract<NativeMessagePart, { type: "tool-invocation" }>;
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
  sourcePart,
  deferredDetails = false,
}: PlanToolPartProps) {
  const plan = deferredDetails ? "" : extractPlanMarkdown(toolArgs, toolOutput);
  const namedTitle = planDisplayTitle(toolName, toolTitle, plan);
  const title = namedTitle ?? "Plan";
  const scope = usePlanCardScope();
  const key = sourcePart && scope?.index.keyByPart.get(sourcePart);
  const revision = key ? scope?.index.byKey.get(key) : undefined;
  const total = scope?.index.total;
  const actions = key && scope?.actions?.planKey === key ? scope.actions : undefined;
  const superseded = revision?.state === "superseded";
  const hasBody = plan.trim().length > 0;
  // Outside an agent tab there is no ordering, so the tool state stands alone.
  const stateLabel = revision
    ? undefined
    : toolState === "pending"
      ? "writing..."
      : toolState === "failure"
        ? "failure"
        : toolState;

  return (
    <section
      aria-label={superseded ? `Superseded plan: ${title}` : `Implementation plan: ${title}`}
      data-plan-state={revision?.state}
      className={cn(
        "my-2 overflow-hidden rounded-lg border bg-card",
        revision?.state === "current" ? "border-amber-500/50" : "border-border",
      )}
    >
      <header
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2",
          superseded ? "bg-muted/40" : "bg-amber-500/10",
        )}
      >
        <FileText
          className={cn(
            "h-4 w-4 shrink-0",
            superseded ? "text-muted-foreground" : "text-amber-500",
          )}
        />
        <span
          className={cn(
            "min-w-[10rem] flex-1 truncate text-sm font-medium",
            superseded ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {title}
        </span>
        {revision ? <RevisionBadges revision={revision} total={total} /> : null}
        {stateLabel && (
          <span className={cn("shrink-0 text-xs", toolState ? TOOL_STATE_COLORS[toolState] : "")}>
            {stateLabel}
          </span>
        )}
        {hasBody ? <PlanExportControls plan={plan} title={title} /> : null}
      </header>
      {superseded ? (
        <p className="border-b border-border bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
          A newer plan replaced this one. It stays here for reference.
        </p>
      ) : null}
      <div className={cn("max-h-[32rem] overflow-auto px-3 py-3", superseded && "opacity-80")}>
        {hasBody ? (
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
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-failure" />
            <pre className="text-xs font-mono text-failure whitespace-pre-wrap break-all">
              {toolError}
            </pre>
          </div>
        )}
      </div>
      {actions && revision ? (
        <PlanImplementationFooter
          actions={actions}
          revision={revision}
          markdown={plan}
          canImplement={hasBody && !toolError && toolState !== "failure" && toolState !== "pending"}
        />
      ) : null}
    </section>
  );
}

function RevisionBadges({ revision, total }: { revision: PlanRevision; total?: number }) {
  return (
    <>
      <span
        className={cn(
          "shrink-0 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none",
          REVISION_STATE_CLASSES[revision.state],
        )}
      >
        {REVISION_STATE_LABELS[revision.state]}
      </span>
      {revision.revision !== undefined && total !== undefined ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          Revision {revision.revision} of {total}
        </span>
      ) : null}
    </>
  );
}

function PlanExportControls({ plan, title }: { plan: string; title: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timeoutId = window.setTimeout(() => setCopied(false), 1200);
    return () => window.clearTimeout(timeoutId);
  }, [copied]);

  const copy = useCallback(async () => {
    try {
      await writeText(plan);
      setCopied(true);
    } catch (error) {
      log.error("plan.copy-failed", { error: formatLogError(error) });
      toast.error("Failed to copy the plan");
    }
  }, [plan]);

  const exportMarkdown = useCallback(() => {
    try {
      downloadText(plan, artifactFilename(title, "md"), "text/markdown");
    } catch (error) {
      log.error("plan.export-failed", { error: formatLogError(error) });
      toast.error("Failed to export the plan");
    }
  }, [plan, title]);

  return (
    <span className="flex shrink-0 items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
        onClick={() => void copy()}
        aria-label={copied ? "Copied plan Markdown" : "Copy plan as Markdown"}
        title={copied ? "Copied" : "Copy Markdown"}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
        onClick={exportMarkdown}
        aria-label="Export plan as Markdown file"
        title="Export .md"
      >
        <Download className="h-3.5 w-3.5" />
      </Button>
    </span>
  );
}

function PlanImplementationFooter({
  actions,
  revision,
  markdown,
  canImplement,
}: {
  actions: PlanCardActions;
  revision: PlanRevision;
  markdown: string;
  canImplement: boolean;
}) {
  const footer = useRef<HTMLElement>(null);
  const { reportVisibility } = actions;
  useEffect(() => {
    const element = footer.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) =>
        reportVisibility(
          revision,
          entry?.isIntersecting === true && entry.intersectionRatio >= 0.99,
        ),
      { threshold: 0.99 },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      reportVisibility(revision, false);
    };
  }, [reportVisibility, revision]);
  const subject =
    revision.revision !== undefined ? `revision ${revision.revision} of this plan` : "this plan";
  return (
    <footer
      ref={footer}
      className="flex flex-wrap items-center justify-between gap-2 border-t border-border bg-muted/30 px-3 py-2"
    >
      <p className="min-w-0 basis-[16rem] flex-1 text-xs text-muted-foreground">
        Implementing switches the session to build mode and asks the agent to implement {subject}.
        The agent's usual permission rules still apply.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void actions.switchToBuild()}
          disabled={actions.pending}
        >
          <ArrowRight className="mr-1.5 h-3.5 w-3.5" />
          Switch to Build
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={() => void actions.implement(revision, markdown)}
          disabled={actions.pending || !canImplement}
        >
          {actions.pending ? (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="mr-1.5 h-3.5 w-3.5" />
          )}
          Implement this plan
        </Button>
      </div>
    </footer>
  );
}
