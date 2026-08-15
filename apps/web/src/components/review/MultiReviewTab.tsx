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
import {
  useOptionalTerminalContext,
  type CreateTabOptions,
} from "@/contexts/TerminalContext";
import { MultiReviewReviewerTab } from "./MultiReviewReviewerTab";
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
  sendAddressPrompt: boolean,
): CreateTabOptions | null {
  const session = workflow.fixSession;
  if (!session?.providerSessionId) return null;
  return {
    agentLaunchMode: "native",
    resumeSessionId: session.providerSessionId,
    ...(sendAddressPrompt ? { initialPrompt: ADDRESS_ALL_REVIEW_PROMPT } : {}),
    displayTitle: "Multi Review · Fix",
    isReviewTab: true,
    initialAgentModel: workflow.fixModel.model === "default" ? undefined : workflow.fixModel.model,
    initialReasoningEffort: workflow.fixModel.reasoningEffort,
    initialConversationMode: "build",
  };
}

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
  /** The handoff committed but its tab never opened, so nothing sent the prompt. */
  const [addressPromptPending, setAddressPromptPending] = useState(false);

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
    sendAddressPrompt: boolean,
    target: MultiReviewWorkflow | undefined = workflow,
  ): "opened" | "no-session" | "tab-unavailable" => {
    if (!target) return "no-session";
    const options = multiReviewFixSessionTabOptions(target, sendAddressPrompt);
    if (!options) return "no-session";
    return createTab?.(target.fixModel.agent, options) === true
      ? "opened"
      : "tab-unavailable";
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

  // Creating the tab dispatches the address prompt, so it has to be the last
  // step. Opening first left a window where the fix agent was already editing
  // the worktree while the durable workflow still said `ready` — which keeps
  // Address all clickable (a second tab, a second prompt, one session) and
  // keeps Abandon offered, and abandoning a `ready` workflow aborts nothing
  // because the fix session is idle. Committing first cannot strand the user:
  // `interactive` renders Open fix session, which carries the prompt whenever
  // the handoff has not managed to dispatch one yet.
  const addressAll = async () => {
    if (pending || !workflow) return;
    setPending(true);
    setError(null);
    try {
      if (!multiReviewFixSessionTabOptions(workflow, true)) {
        setError("The consolidation session is no longer available");
        return;
      }
      const handedOff = await commands.address(workflow.id);
      replaceWorkflow(handedOff);
      if (openFixSession(true, handedOff) !== "opened") {
        setAddressPromptPending(true);
        setError(
          "The fix session was handed off, but a tab could not be opened. "
          + "Close a tab, then use Open fix session to continue.",
        );
      }
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
  const canCancel = workflow.phase !== "completed" && workflow.phase !== "cancelled"
    && workflow.phase !== "cancelling" && workflow.phase !== "interactive";

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
                <button
                  key={reviewer.id}
                  type="button"
                  disabled={!reviewer.providerSessionId || (!openReviewer && !createTab)}
                  aria-label={`Open Reviewer ${index + 1} transcript`}
                  className="flex items-center gap-2.5 rounded-lg border border-border/45 bg-background/40 px-3 py-2.5 text-left transition-colors enabled:cursor-pointer enabled:hover:border-cyan-400/35 enabled:hover:bg-cyan-500/5 disabled:cursor-default"
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
                  {reviewer.status === "completed" ? <CheckCircle2 className="size-4 text-emerald-500" />
                    : reviewer.status === "failed" ? <AlertCircle className="size-4 text-destructive" />
                      : reviewer.status === "cancelled" ? <Square className="size-4 text-muted-foreground" />
                        : reviewer.status === "running" ? <Loader2 className="size-4 animate-spin text-cyan-400" />
                          : <Circle className="size-4 text-muted-foreground" />}
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">Reviewer {index + 1} · {reviewer.agent}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{reviewer.model}{reviewer.reasoningEffort ? ` · ${reviewer.reasoningEffort}` : ""}</p>
                    {/* The workflow error generalizes a shared cause; this is the
                        only place the reviewer's own failure is legible. */}
                    {reviewer.error ? (
                      <p className="truncate text-[11px] text-destructive" title={reviewer.error}>
                        {reviewer.error}
                      </p>
                    ) : null}
                  </div>
                </button>
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
        {canCancel && (
          <Button variant="outline" disabled={pending} onClick={() => void run(() => commands.cancel(workflow.id))}>
            <Square className="mr-2 size-4" />
            {workflow.phase === "ready" || workflow.phase === "failed" ? "Abandon" : "Cancel"}
          </Button>
        )}
        {workflow.phase === "interactive" && workflow.fixSession?.providerSessionId && (
          <Button
            variant="outline"
            disabled={pending || !createTab}
            onClick={() => {
              setError(null);
              const outcome = openFixSession(addressPromptPending);
              if (outcome === "opened") setAddressPromptPending(false);
              else setError(openFixSessionError(outcome));
            }}
          >
            Open fix session
          </Button>
        )}
        {workflow.phase === "ready" && (
          <Button
            disabled={pending || !createTab}
            onClick={() => void addressAll()}
          >
            <Wrench className="mr-2 size-4" />{ADDRESS_ALL_REVIEW_PROMPT}
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
