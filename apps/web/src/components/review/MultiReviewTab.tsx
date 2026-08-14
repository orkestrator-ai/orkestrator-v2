import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, Circle, Loader2, RefreshCw, Square, Wrench } from "lucide-react";
import type { MultiReviewPhase, MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { MultiReviewTabData } from "@/types/paneLayout";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StructuredReviewReportView } from "./StructuredReviewReportView";
import { StackedEyes } from "./MultiReviewLaunchDialog";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { hydrateMultiReviewWorkflow } from "@/lib/multi-review-persistence";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import * as backend from "@/lib/backend";

interface MultiReviewCommands {
  address: (workflowId: string) => Promise<MultiReviewWorkflow>;
  retry: (workflowId: string) => Promise<MultiReviewWorkflow>;
  cancel: (workflowId: string) => Promise<MultiReviewWorkflow>;
}

const defaultCommands: MultiReviewCommands = {
  address: backend.addressMultiReview,
  retry: backend.retryMultiReview,
  cancel: backend.cancelMultiReview,
};

interface MultiReviewTabProps {
  data: MultiReviewTabData;
  isActive: boolean;
  hydrateWorkflow?: typeof hydrateMultiReviewWorkflow;
  commands?: MultiReviewCommands;
}

function phaseCopy(phase: MultiReviewPhase): string {
  const labels = {
    reviewing: "Independent reviews are running",
    consolidating: "The fix model is consolidating findings",
    ready: "Consolidated report ready",
    fixing: "The fix model is addressing every finding",
    completed: "All findings were addressed",
    cancelling: "Cancelling Multi Review",
    cancelled: "Multi Review cancelled",
    failed: "Multi Review needs attention",
  } as const;
  return labels[phase];
}

export function MultiReviewTab({
  data,
  isActive,
  hydrateWorkflow = hydrateMultiReviewWorkflow,
  commands = defaultCommands,
}: MultiReviewTabProps) {
  const workflow = useMultiReviewStore((state) => state.workflows.get(data.workflowId));
  const replaceWorkflow = useMultiReviewStore((state) => state.replaceWorkflow);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const hydrate = useCallback(async () => {
    setError(null);
    try {
      const result = await hydrateWorkflow(data.workflowId);
      if (!result) setError("The authoritative Multi Review workflow could not be found.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [data.workflowId, hydrateWorkflow]);

  useEffect(() => {
    void hydrate();
  }, [hydrate, isActive]);

  const run = async (command: () => Promise<NonNullable<typeof workflow>>) => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      replaceWorkflow(await command());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  if (!workflow) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          {error ? <AlertCircle className="mx-auto mb-3 size-6 text-destructive" /> : <Loader2 className="mx-auto mb-3 size-6 animate-spin text-cyan-400" />}
          <p className="text-sm text-muted-foreground">{error ?? "Restoring Multi Review…"}</p>
          {error && <Button className="mt-4" variant="outline" size="sm" onClick={() => void hydrate()}><RefreshCw className="mr-2 size-3.5" />Retry</Button>}
        </div>
      </div>
    );
  }

  const busy = workflow.phase === "reviewing" || workflow.phase === "consolidating"
    || workflow.phase === "fixing" || workflow.phase === "cancelling";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border/60 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-cyan-400/25 bg-cyan-500/10 text-cyan-300">
            <StackedEyes className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Multi Review</h1>
            <p className="truncate text-xs text-muted-foreground">{phaseCopy(workflow.phase)}</p>
          </div>
        </div>
        {busy && <Loader2 className="size-4 shrink-0 animate-spin text-cyan-400" />}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
          <section className="rounded-xl border border-border/60 bg-card/35 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Review panel</h2>
              <span className="text-xs text-muted-foreground">{workflow.reviewers.filter((item) => item.status === "completed").length}/{workflow.reviewers.length} complete</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {workflow.reviewers.map((reviewer, index) => (
                <div key={reviewer.id} className="flex items-center gap-2.5 rounded-lg border border-border/45 bg-background/40 px-3 py-2.5">
                  {reviewer.status === "completed" ? <CheckCircle2 className="size-4 text-emerald-500" />
                    : reviewer.status === "failed" ? <AlertCircle className="size-4 text-destructive" />
                      : reviewer.status === "cancelled" ? <Square className="size-4 text-muted-foreground" />
                        : reviewer.status === "running" ? <Loader2 className="size-4 animate-spin text-cyan-400" />
                          : <Circle className="size-4 text-muted-foreground" />}
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">Reviewer {index + 1} · {reviewer.agent}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{reviewer.model}{reviewer.reasoningEffort ? ` · ${reviewer.reasoningEffort}` : ""}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {workflow.consolidatedReport && (
            <StructuredReviewReportView
              report={workflow.consolidatedReport}
              heading="Consolidated Multi Review"
            />
          )}

          {workflow.fixResult && (
            <section className="rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4">
              <h2 className="text-sm font-semibold">Fix result</h2>
              <p className="mt-2 text-sm text-foreground/85">{workflow.fixResult.summary}</p>
            </section>
          )}

          {(error || workflow.error) && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error ?? workflow.error}
            </div>
          )}
        </div>
      </ScrollArea>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 bg-background/90 px-4 py-3 sm:px-5">
        {workflow.phase === "failed" && (
          <Button variant="outline" disabled={pending} onClick={() => void run(() => commands.retry(workflow.id))}>
            <RefreshCw className="mr-2 size-4" />Retry failed stage
          </Button>
        )}
        {busy && workflow.phase !== "cancelling" && (
          <Button variant="outline" disabled={pending} onClick={() => void run(() => commands.cancel(workflow.id))}>
            <Square className="mr-2 size-4" />Cancel
          </Button>
        )}
        {workflow.phase === "ready" && (
          <Button disabled={pending} onClick={() => void run(() => commands.address(workflow.id))}>
            <Wrench className="mr-2 size-4" />{ADDRESS_ALL_REVIEW_PROMPT}
          </Button>
        )}
      </footer>
    </div>
  );
}
