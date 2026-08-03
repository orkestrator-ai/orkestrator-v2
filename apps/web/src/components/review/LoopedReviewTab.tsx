import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Archive, CheckCircle2, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import type { ReviewFindingPool } from "@orkestrator/protocol/structured-review";
import { Button } from "@/components/ui/button";
import { useOptionalTerminalContext } from "@/contexts";
import { StructuredReviewReportView } from "./StructuredReviewReportView";
import type { LoopedReviewTabData } from "@/types/paneLayout";
import {
  hasReviewFindings,
  isLoopedReviewActivePhase,
  useLoopedReviewStore,
  type LoopedReviewSession,
  type LoopedReviewSessionPhase,
  type LoopedReviewWorkflow,
} from "@/stores/loopedReviewStore";
import { hydrateLoopedReviewWorkflow } from "@/lib/looped-review-persistence";
import * as backend from "@/lib/backend";

interface LoopedReviewTabProps {
  data: LoopedReviewTabData;
  isActive: boolean;
  hydrateWorkflow?: typeof hydrateLoopedReviewWorkflow;
  commands?: LoopedReviewCommands;
}

interface LoopedReviewCommands {
  pause: (workflowId: string) => Promise<LoopedReviewWorkflow>;
  resume: (workflowId: string) => Promise<LoopedReviewWorkflow>;
  retry: (workflowId: string) => Promise<LoopedReviewWorkflow>;
  cancel: (workflowId: string) => Promise<LoopedReviewWorkflow>;
  providerSession: typeof backend.getLoopedReviewProviderSession;
}

const defaultCommands: LoopedReviewCommands = {
  pause: backend.pauseLoopedReview,
  resume: backend.resumeLoopedReview,
  retry: backend.retryLoopedReview,
  cancel: backend.cancelLoopedReview,
  providerSession: backend.getLoopedReviewProviderSession,
};

function phaseLabel(workflow: LoopedReviewWorkflow): string {
  const labels: Record<LoopedReviewWorkflow["phase"], string> = {
    preparing: "Preparing immutable review package",
    discovering: "Discovering findings",
    reconciling: "Reconciling this pass",
    fixing: "Fixing active pool",
    "creating-pr": "Creating pull request",
    cancelling: "Cancelling provider work",
    paused: "Paused", failed: "Needs attention", cancelled: "Cancelled", completed: "Completed",
  };
  return labels[workflow.phase];
}

function sessionLabel(phase: LoopedReviewSessionPhase, round: number, pass?: number): string {
  if (phase === "preparation") return `Round ${round} · Package preparation`;
  if (phase === "discovery") return `Round ${round} · Review pass ${pass}`;
  if (phase === "fix") return `Round ${round} · Fix session`;
  return "Final · PR creation";
}

function PoolView({ pool }: { pool: ReviewFindingPool }) {
  if (!hasReviewFindings(pool)) return <p className="text-sm text-muted-foreground">No pooled findings.</p>;
  return (
    <div className="space-y-2">
      {pool.issues.map((issue) => (
        <article key={issue.poolId} className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-sm">
          <p className="text-xs text-muted-foreground">{issue.poolId} · {issue.severity} · {issue.confidence}%</p>
          <p className="mt-1 font-medium">{issue.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{issue.file}{issue.line ? `:${issue.line}` : ""}</p>
          <p className="mt-2 text-foreground/80">{issue.description}</p>
          <p className="mt-2 text-xs"><span className="font-medium">Evidence:</span> {issue.evidence}</p>
          <p className="mt-1 text-xs"><span className="font-medium">Suggested fix:</span> {issue.suggestion}</p>
          <p className="mt-1 text-xs"><span className="font-medium">Verification:</span> {issue.verification}</p>
        </article>
      ))}
      {pool.coverageGaps.map((gap) => (
        <article key={gap.poolId} className="rounded-lg border border-sky-500/25 bg-sky-500/5 p-3 text-sm">
          <p className="text-xs text-muted-foreground">{gap.poolId} · {gap.file}</p>
          <p className="mt-1">{gap.untestedBehavior}</p>
        </article>
      ))}
    </div>
  );
}

export function LoopedReviewTab({
  data,
  hydrateWorkflow = hydrateLoopedReviewWorkflow,
  commands = defaultCommands,
}: LoopedReviewTabProps) {
  const terminal = useOptionalTerminalContext();
  const workflow = useLoopedReviewStore((state) => state.workflows.get(data.workflowId));
  const replaceWorkflow = useLoopedReviewStore((state) => state.replaceWorkflow);
  const [hydrating, setHydrating] = useState(!workflow);
  const [error, setError] = useState<string | null>(null);
  const [commandPending, setCommandPending] = useState(false);
  const restoreGeneration = useRef(0);

  const restoreWorkflow = useCallback(async () => {
    const generation = ++restoreGeneration.current;
    setHydrating(true);
    setError(null);
    try {
      const restored = await hydrateWorkflow(data.workflowId);
      if (restoreGeneration.current !== generation) return;
      setHydrating(false);
      if (!restored) {
        setError("The authoritative looped-review workflow could not be found.");
      }
    } catch (reason) {
      if (restoreGeneration.current !== generation) return;
      setHydrating(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, [data.workflowId, hydrateWorkflow]);

  useEffect(() => {
    if (workflow) {
      ++restoreGeneration.current;
      setHydrating(false);
      setError(null);
      return;
    }
    void restoreWorkflow();
    return () => { ++restoreGeneration.current; };
  }, [restoreWorkflow, workflow]);

  const runCommand = async (command: () => Promise<LoopedReviewWorkflow>) => {
    setCommandPending(true);
    setError(null);
    try { replaceWorkflow(await command()); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setCommandPending(false); }
  };

  const openProviderSession = async (session: LoopedReviewSession) => {
    setCommandPending(true);
    setError(null);
    try {
      const resolved = await commands.providerSession(workflow!.id, session.id);
      if (!resolved) throw new Error("The provider session is no longer available");
      const created = terminal?.createTab?.(workflow!.agent, {
        agentLaunchMode: "native",
        displayTitle: `${sessionLabel(session.phase, session.round, session.pass)} · Provider`,
        isReviewTab: true,
        resumeSessionId: resolved.providerSessionId,
      });
      if (!created) throw new Error("A provider-session tab could not be opened");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setCommandPending(false);
    }
  };

  const sessionById = useMemo(() => new Map(
    workflow?.sessions.map((session) => [session.id, session]) ?? [],
  ), [workflow?.sessions]);

  if (hydrating) return <div className="absolute inset-0 grid place-items-center" role="status">
    <span className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Restoring looped review…</span>
  </div>;
  if (!workflow) return <div className="absolute inset-0 grid place-items-center p-6">
    <div className="max-w-md rounded-xl border border-red-500/30 p-5 text-center">
      <AlertCircle className="mx-auto size-6 text-red-400" />
      <p className="mt-3 font-semibold">Looped review unavailable</p>
      <p className="mt-2 text-sm text-muted-foreground">{error ?? "The workflow snapshot is missing."}</p>
      <Button className="mt-4" variant="outline" disabled={hydrating} onClick={() => void restoreWorkflow()}>
        <RefreshCw className="mr-2 size-4" />Retry restore
      </Button>
    </div>
  </div>;

  const activeSession = workflow.activeSessionId ? sessionById.get(workflow.activeSessionId) : undefined;
  const history = workflow.sessions.flatMap((session) =>
    (session.interactionTranscript ?? []).map((entry) => ({ session, entry: entry as {
      id: string; title: string; body?: string; kind: string; outcome: string;
    } }))
  );

  return <div className="absolute inset-0 overflow-y-auto bg-background" aria-label="Looped code review workflow">
    <header className="sticky top-0 z-20 border-b bg-background/95 px-5 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-semibold">Looped Code Review</h1>
          <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
            Round {workflow.currentRound} · pass {workflow.currentPass || "—"}/{workflow.currentAllowance} · {phaseLabel(workflow)}
            {activeSession ? ` · session ${activeSession.providerSessionId}` : ""}
          </p>
        </div>
        <div className="flex gap-2">
          {isLoopedReviewActivePhase(workflow.phase) && <Button size="sm" variant="outline" disabled={commandPending}
            onClick={() => void runCommand(() => commands.pause(workflow.id))}>Pause</Button>}
          {workflow.phase === "paused" && <Button size="sm" disabled={commandPending}
            onClick={() => void runCommand(() => commands.resume(workflow.id))}>Resume</Button>}
          {workflow.phase === "failed" && <Button size="sm" disabled={commandPending}
            onClick={() => void runCommand(() => commands.retry(workflow.id))}>Retry phase</Button>}
          {(isLoopedReviewActivePhase(workflow.phase) || workflow.phase === "paused" || workflow.phase === "failed")
            && <Button size="sm" variant="destructive" disabled={commandPending}
              onClick={() => void runCommand(() => commands.cancel(workflow.id))}>Cancel</Button>}
          {activeSession && <Button size="sm" variant="outline" disabled={commandPending}
            onClick={() => void openProviderSession(activeSession)}><ExternalLink className="mr-1.5 size-4" />Provider session</Button>}
        </div>
      </div>
    </header>

    <main className="mx-auto max-w-5xl space-y-5 p-5">
      {error && <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-300">{error}</div>}
      {workflow.phase === "paused" && <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <h2 className="font-medium text-amber-300">Workflow paused</h2>
        <p className="mt-1 text-sm text-muted-foreground">Backend progress is paused at {workflow.pausedFromPhase ?? "the current phase"}.</p>
      </section>}
      {workflow.phase === "cancelling" && <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
        <h2 className="flex items-center gap-2 font-medium text-amber-300"><Loader2 className="size-4 animate-spin" />Cancellation in progress</h2>
        <p className="mt-1 text-sm text-muted-foreground">Waiting for provider work from {workflow.cancellingFromPhase ?? "the active phase"} to stop.</p>
      </section>}
      {workflow.phase === "cancelled" && <section className="rounded-xl border p-4">
        <h2 className="font-medium">Workflow cancelled</h2>
      </section>}
      {workflow.phase === "failed" && workflow.failure && <section role="alert" className="rounded-xl border border-red-500/30 bg-red-500/5 p-4">
        <h2 className="font-medium text-red-300">Phase failed</h2>
        <p className="mt-1 text-sm text-muted-foreground">{workflow.failure.message}</p>
      </section>}
      {workflow.phase === "completed" && <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
        <h2 className="flex items-center gap-2 font-medium text-emerald-300"><CheckCircle2 className="size-4" />Review complete</h2>
        {workflow.pr.url && <a className="mt-2 inline-block text-sm text-cyan-300 underline" href={workflow.pr.url} target="_blank" rel="noreferrer">{workflow.pr.url}</a>}
      </section>}

      <section className="rounded-xl border p-4">
        <h2 className="font-medium">Active finding pool</h2>
        <div className="mt-3"><PoolView pool={workflow.activePool} /></div>
      </section>

      {history.length > 0 && <section className="rounded-xl border p-4">
        <h2 className="font-medium">Unattended interaction history ({workflow.autoDeclineCount ?? 0} auto-declined)</h2>
        <div className="mt-3 space-y-2">{history.map(({ session, entry }) => <article key={`${session.id}:${entry.id}`} className="rounded-lg border p-3 text-sm">
          <p className="font-medium">{entry.title}</p>
          <p className="text-xs text-muted-foreground">{sessionLabel(session.phase, session.round, session.pass)} · {entry.kind} · {entry.outcome}</p>
          {entry.body && <p className="mt-2 text-muted-foreground">{entry.body}</p>}
        </article>)}</div>
      </section>}

      {workflow.rounds.map((round) => <section key={round.round} className="rounded-xl border p-4">
        <h2 className="font-medium">Round {round.round} · {round.status}</h2>
        <div className="mt-3 space-y-4">{round.passes.map((pass) => <div key={pass.pass}>
          <h3 className="text-sm font-medium">Pass {pass.pass} · {pass.status}</h3>
          {pass.report && <div className="mt-2"><StructuredReviewReportView report={pass.report} /></div>}
        </div>)}</div>
      </section>)}

      {workflow.archivedPools.map((archive) => <section key={`${archive.round}:${archive.fixedAt}`} className="rounded-xl border p-4">
        <h2 className="flex items-center gap-2 font-medium"><Archive className="size-4" />Archived pool · round {archive.round}</h2>
        {archive.fixSummary && <p className="mt-2 text-sm text-muted-foreground">{archive.fixSummary}</p>}
        {archive.fixNotes && archive.fixNotes.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {archive.fixNotes.map((note) => <li key={note}>{note}</li>)}
        </ul>}
        <div className="mt-3"><PoolView pool={archive.pool} /></div>
      </section>)}
    </main>
  </div>;
}
