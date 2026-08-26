import { useCallback, useEffect, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Circle,
  Loader2,
  RefreshCw,
  Square,
  Wrench,
} from "lucide-react";
import type { MultiReviewPhase, MultiReviewWorkflow } from "@orkestrator/protocol/multi-review";
import type { MultiReviewTabData } from "@/types/paneLayout";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StructuredReviewReportView } from "./StructuredReviewReportView";
import { StackedEyes } from "./MultiReviewLaunchDialog";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { hydrateMultiReviewWorkflow } from "@/lib/multi-review-persistence";
import { ADDRESS_ALL_REVIEW_PROMPT } from "@/lib/review-actions";
import { useOptionalTerminalContext, type CreateTabOptions } from "@/contexts/TerminalContext";
import { MultiReviewReviewerTab } from "./MultiReviewReviewerTab";
import * as backend from "@/lib/backend";

interface MultiReviewCommands {
  address: (workflowId: string) => Promise<MultiReviewWorkflow>;
  retry: (workflowId: string) => Promise<MultiReviewWorkflow>;
  cancel: (workflowId: string) => Promise<MultiReviewWorkflow>;
  stopReviewer: (workflowId: string, reviewerId: string) => Promise<MultiReviewWorkflow>;
}

const defaultCommands: MultiReviewCommands = {
  address: backend.addressMultiReview,
  retry: backend.retryMultiReview,
  cancel: backend.cancelMultiReview,
  stopReviewer: backend.stopMultiReviewReviewer,
};

interface MultiReviewTabProps {
  data: MultiReviewTabData;
  isActive: boolean;
  hydrateWorkflow?: typeof hydrateMultiReviewWorkflow;
  commands?: MultiReviewCommands;
  openReviewer?: (reviewerId: string, index: number) => void;
}

function phaseCopy(phase: MultiReviewPhase): string {
  const labels = {
    reviewing: "Independent reviews are running",
    consolidating: "The fix model is consolidating findings",
    ready: "Consolidated report ready",
    fixing: "The fix model is addressing every finding",
    interactive: "The fix model is working interactively",
    completed: "All findings were addressed",
    cancelling: "Cancelling Multi Review",
    cancelled: "Multi Review cancelled",
    failed: "Multi Review needs attention",
  } as const;
  return labels[phase];
}

/** Opens the idle consolidation session as a normal native agent tab. */
export function multiReviewFixSessionTabOptions(
  workflow: MultiReviewWorkflow,
): CreateTabOptions | null {
  const session = workflow.fixSession;
  if (!session?.providerSessionId) return null;
  return {
    agentLaunchMode: "native",
    resumeSessionId: session.providerSessionId,
    displayTitle: "Multi Review · Fix",
    isReviewTab: true,
    initialAgentModel: workflow.fixModel.model === "default" ? undefined : workflow.fixModel.model,
    initialReasoningEffort: workflow.fixModel.reasoningEffort,
    initialConversationMode: "build",
  };
}

/**
 * A reviewer only stops producing status while it is still supposed to be
 * working, so the notice is limited to those states: a settled reviewer keeps
 * its result rather than being relabelled by a stale stall flag.
 */
export function reviewerStatusNote(
  reviewer: MultiReviewWorkflow["reviewers"][number],
): { text: string; tone: "muted" | "warning" | "destructive" } | null {
  if (reviewer.status === "cancelled") {
    return { text: "Stopped · excluded from the consolidated report", tone: "muted" };
  }
  if (reviewer.error) return { text: reviewer.error, tone: "destructive" };
  if (reviewer.status === "running" && reviewer.stalledSince) {
    return {
      text: "No activity for a while — stop it to continue without this reviewer",
      tone: "warning",
    };
  }
  return null;
}

export function reviewerProgressSummary(reviewers: MultiReviewWorkflow["reviewers"]): string {
  const completed = reviewers.filter((reviewer) => reviewer.status === "completed").length;
  const stopped = reviewers.filter((reviewer) => reviewer.status === "cancelled").length;
  const activePanelSize = reviewers.length - stopped;
  const completion =
    activePanelSize === 0 ? `${completed} complete` : `${completed}/${activePanelSize} complete`;
  return stopped === 0 ? completion : `${completion} · ${stopped} stopped`;
}

const NOTE_TONE_CLASS = {
  muted: "text-muted-foreground",
  warning: "text-amber-500",
  destructive: "text-destructive",
} as const;

function MultiReviewOverviewTab({
  data,
  isActive,
  hydrateWorkflow = hydrateMultiReviewWorkflow,
  commands = defaultCommands,
  openReviewer,
}: MultiReviewTabProps) {
  const createTab = useOptionalTerminalContext()?.createTab;
  const workflow = useMultiReviewStore((state) => state.workflows.get(data.workflowId));
  const replaceWorkflow = useMultiReviewStore((state) => state.replaceWorkflow);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [stoppingReviewerId, setStoppingReviewerId] = useState<string | null>(null);

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

  const openFixSession = (
    target: MultiReviewWorkflow | undefined = workflow,
  ): "opened" | "no-session" | "tab-unavailable" => {
    if (!target) return "no-session";
    const options = multiReviewFixSessionTabOptions(target);
    if (!options) return "no-session";
    return createTab?.(target.fixModel.agent, options) === true ? "opened" : "tab-unavailable";
  };

  const openFixSessionError = (outcome: "no-session" | "tab-unavailable"): string =>
    outcome === "no-session"
      ? "The consolidation session is no longer available"
      : "The environment is not ready or the maximum tab count was reached.";

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

  /**
   * Stopping one reviewer is deliberately not the workflow-wide `run` gate: the
   * remaining reviewers keep working, and the backend answers with the
   * authoritative snapshot that already excludes this one.
   */
  const stopReviewer = async (reviewerId: string) => {
    if (stoppingReviewerId !== null || !workflow) return;
    setStoppingReviewerId(reviewerId);
    setError(null);
    try {
      replaceWorkflow(await commands.stopReviewer(workflow.id, reviewerId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStoppingReviewerId(null);
    }
  };

  // The backend commits the handoff intent and owns provider adoption, dispatch,
  // and retries. Presentation waits for the authoritative acknowledgement so a
  // missing provider session can never make the tab create an empty fallback.
  const addressAll = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      // The workflow id is enough to record the intent. Eligibility, provider
      // adoption and prompt dispatch all belong to the backend; a stale local
      // snapshot or an unavailable tab presenter must never suppress the click.
      const handedOff = await commands.address(data.workflowId);
      replaceWorkflow(handedOff);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  const openInteractiveFixSession = async () => {
    if (pending || !workflow) return;
    setPending(true);
    setError(null);
    try {
      // Opening is presentation-only. A pending dispatch is owned and retried
      // by the backend supervisor even when no review component is mounted.
      const outcome = openFixSession(workflow);
      if (outcome !== "opened") setError(openFixSessionError(outcome));
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
          {error ? (
            <AlertCircle className="mx-auto mb-3 size-6 text-destructive" />
          ) : (
            <Loader2 className="mx-auto mb-3 size-6 animate-spin text-cyan-400" />
          )}
          <p className="text-sm text-muted-foreground">{error ?? "Restoring Multi Review…"}</p>
          {error && (
            <Button className="mt-4" variant="outline" size="sm" onClick={() => void hydrate()}>
              <RefreshCw className="mr-2 size-3.5" />
              Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  const busy =
    workflow.phase === "reviewing" ||
    workflow.phase === "consolidating" ||
    workflow.phase === "fixing" ||
    workflow.phase === "cancelling";
  const fixSessionStalled =
    (workflow.phase === "consolidating" || workflow.phase === "fixing") &&
    workflow.fixSession?.stalledSince !== undefined;
  const canCancel =
    workflow.phase !== "completed" &&
    workflow.phase !== "cancelled" &&
    workflow.phase !== "cancelling" &&
    workflow.phase !== "interactive";

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border/60 px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-cyan-400/25 bg-cyan-500/10 text-cyan-300">
            <StackedEyes className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Multi Review</h1>
            <p
              className={`truncate text-xs ${fixSessionStalled ? "text-amber-500" : "text-muted-foreground"}`}
            >
              {fixSessionStalled ? "No activity from the fix model" : phaseCopy(workflow.phase)}
            </p>
          </div>
        </div>
        {busy && <Loader2 className="size-4 shrink-0 animate-spin text-cyan-400" />}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
          {fixSessionStalled && (
            <section
              role="status"
              aria-live="polite"
              className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/8 p-4"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/12 text-amber-500">
                <AlertTriangle className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-amber-500">Fix model appears stalled</h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  No new activity has arrived. Cancel now, or wait for the workflow to stop
                  automatically and then retry.
                </p>
              </div>
            </section>
          )}
          <section className="rounded-xl border border-border/60 bg-card/35 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold">Review panel</h2>
              <span className="text-xs text-muted-foreground">
                {reviewerProgressSummary(workflow.reviewers)}
              </span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {workflow.reviewers.map((reviewer, index) => {
                const note = reviewerStatusNote(reviewer);
                const stoppable = reviewer.status === "pending" || reviewer.status === "running";
                return (
                  <div
                    key={reviewer.id}
                    className="flex items-center rounded-lg border border-border/45 bg-background/40 transition-colors has-[button:enabled:hover]:border-cyan-400/35"
                  >
                    <button
                      type="button"
                      disabled={!reviewer.providerSessionId || (!openReviewer && !createTab)}
                      aria-label={`Open Reviewer ${index + 1} transcript`}
                      className="flex min-w-0 flex-1 items-center gap-2.5 rounded-l-lg px-3 py-2.5 text-left transition-colors enabled:cursor-pointer enabled:hover:bg-cyan-500/5 disabled:cursor-default"
                      onClick={() => {
                        if (openReviewer) {
                          openReviewer(reviewer.id, index);
                          return;
                        }
                        createTab?.("multi-review", {
                          multiReviewId: workflow.id,
                          multiReviewReviewerId: reviewer.id,
                          displayTitle: `Reviewer ${index + 1}`,
                        });
                      }}
                    >
                      {reviewer.status === "completed" ? (
                        <CheckCircle2 className="size-4 shrink-0 text-emerald-500" />
                      ) : reviewer.status === "failed" ? (
                        <AlertCircle className="size-4 shrink-0 text-destructive" />
                      ) : reviewer.status === "cancelled" ? (
                        <Square className="size-4 shrink-0 text-muted-foreground" />
                      ) : reviewer.status === "running" ? (
                        <Loader2 className="size-4 shrink-0 animate-spin text-cyan-400" />
                      ) : (
                        <Circle className="size-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium">
                          Reviewer {index + 1} · {reviewer.agent}
                        </p>
                        <p className="truncate text-[11px] text-muted-foreground">
                          {reviewer.model}
                          {reviewer.reasoningEffort ? ` · ${reviewer.reasoningEffort}` : ""}
                        </p>
                        {/* The workflow error generalizes a shared cause; this is
                            the only place the reviewer's own outcome is legible. */}
                        {note ? (
                          <p
                            className={`truncate text-[11px] ${NOTE_TONE_CLASS[note.tone]}`}
                            title={note.text}
                          >
                            {note.text}
                          </p>
                        ) : null}
                      </div>
                    </button>
                    {stoppable && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="mr-1.5 size-7 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={`Stop Reviewer ${index + 1}`}
                        title="Stop this reviewer; the review continues without it"
                        disabled={stoppingReviewerId !== null}
                        onClick={() => void stopReviewer(reviewer.id)}
                      >
                        {stoppingReviewerId === reviewer.id ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <Square className="size-3.5" />
                        )}
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </section>

          {workflow.consolidatedReport && (
            <StructuredReviewReportView
              report={workflow.consolidatedReport}
              heading="Consolidated Multi Review"
              collapsibleSections
              sectionExpansionKey={`multi-review/${workflow.id}/consolidated-report-section`}
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

          {workflow.addressPromptPending === true && !workflow.error && (
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground">
              The fix request was recorded and will be delivered in the background. Open the fix
              session when delivery completes.
            </div>
          )}
        </div>
      </ScrollArea>

      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border/60 bg-background/90 px-4 py-3 sm:px-5">
        {workflow.phase === "failed" && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void run(() => commands.retry(workflow.id))}
          >
            <RefreshCw className="mr-2 size-4" />
            Retry failed stage
          </Button>
        )}
        {canCancel && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => void run(() => commands.cancel(workflow.id))}
          >
            <Square className="mr-2 size-4" />
            {workflow.phase === "ready" || workflow.phase === "failed" ? "Abandon" : "Cancel"}
          </Button>
        )}
        {workflow.phase === "interactive" &&
          workflow.addressPromptPending !== true &&
          workflow.fixSession?.providerSessionId && (
            <Button
              variant="outline"
              disabled={pending || !createTab}
              onClick={() => {
                void openInteractiveFixSession();
              }}
            >
              Open fix session
            </Button>
          )}
        {workflow.phase === "ready" && (
          <Button disabled={pending} onClick={() => void addressAll()}>
            <Wrench className="mr-2 size-4" />
            {ADDRESS_ALL_REVIEW_PROMPT}
          </Button>
        )}
      </footer>
    </div>
  );
}

export function MultiReviewTab(props: MultiReviewTabProps) {
  if (props.data.reviewerId) {
    return (
      <MultiReviewReviewerTab
        data={{ ...props.data, reviewerId: props.data.reviewerId }}
        isActive={props.isActive}
      />
    );
  }
  return <MultiReviewOverviewTab {...props} />;
}
