import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  parseReviewReconciliation,
  parseStructuredReviewReport,
  REVIEW_RECONCILIATION_JSON_SCHEMA,
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  type ReviewFindingPool,
} from "@orkestrator/protocol/structured-review";
import type {
  JsonSchema,
  StructuredOutputResult,
} from "@orkestrator/protocol/structured-output";
import {
  AlertCircle,
  Archive,
  CheckCircle2,
  CirclePause,
  ExternalLink,
  Loader2,
  OctagonX,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEnvironmentStore } from "@/stores/environmentStore";
import {
  hasReviewFindings,
  isLoopedReviewActivePhase,
  useLoopedReviewStore,
  type LoopedReviewDispatch,
  type LoopedReviewSessionPhase,
  type LoopedReviewWorkflow,
  type ReviewPackage,
} from "@/stores/loopedReviewStore";
import type { LoopedReviewTabData } from "@/types/paneLayout";
import {
  hydrateLoopedReviewWorkflow,
  persistLoopedReviewWorkflowNow,
} from "@/lib/looped-review-persistence";
import {
  connectStructuredReviewAgent,
  type NativeStructuredAgent,
} from "@/lib/structured-review-agent";
import {
  createDiscoveryPrompt,
  createFixPoolPrompt,
  createLoopedReviewPrPrompt,
  createReconciliationPrompt,
  createReviewPackagePrompt,
  REVIEW_FIX_RESULT_JSON_SCHEMA,
  REVIEW_PACKAGE_JSON_SCHEMA,
  REVIEW_PR_RESULT_JSON_SCHEMA,
  type ReviewFixResult,
  type ReviewPrResult,
} from "@/lib/looped-review-prompts";
import { StructuredReviewReportView } from "./StructuredReviewReportView";
import { cn } from "@/lib/utils";
import { createUuid } from "@/lib/uuid";

interface LoopedReviewTabProps {
  data: LoopedReviewTabData;
  isActive: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseReviewPackage(value: unknown): ReviewPackage {
  if (
    !isRecord(value)
    || typeof value.id !== "string"
    || typeof value.round !== "number"
    || typeof value.preparedAt !== "string"
    || typeof value.targetBranch !== "string"
    || typeof value.baseRef !== "string"
    || typeof value.headRef !== "string"
    || typeof value.completeDiff !== "string"
    || !Array.isArray(value.changedFiles)
    || !Array.isArray(value.validation)
    || !Array.isArray(value.skippedFiles)
    || !Array.isArray(value.uncommittedFiles)
    || !Array.isArray(value.limitations)
  ) {
    throw new Error("Review package failed runtime validation");
  }
  return value as unknown as ReviewPackage;
}

function parseFixResult(value: unknown): ReviewFixResult {
  if (
    !isRecord(value)
    || typeof value.complete !== "boolean"
    || typeof value.summary !== "string"
    || !Array.isArray(value.filesChanged)
    || !Array.isArray(value.commandsRun)
    || !Array.isArray(value.limitations)
  ) {
    throw new Error("Fix result failed runtime validation");
  }
  return value as unknown as ReviewFixResult;
}

function parsePrResult(value: unknown): ReviewPrResult {
  if (
    !isRecord(value)
    || value.status !== "created"
    || typeof value.url !== "string"
    || !/^https:\/\/[^/\s]+\/.+/i.test(value.url)
    || typeof value.summary !== "string"
  ) {
    throw new Error("PR result failed runtime validation");
  }
  return value as unknown as ReviewPrResult;
}

function phaseLabel(workflow: LoopedReviewWorkflow): string {
  switch (workflow.phase) {
    case "preparing": return "Preparing immutable review package";
    case "discovering": return "Discovering findings";
    case "reconciling": return "Reconciling this pass";
    case "fixing": return "Fixing active pool";
    case "creating-pr": return "Creating pull request";
    case "paused": return "Paused";
    case "failed": return "Needs attention";
    case "cancelled": return "Cancelled";
    case "completed": return "Completed";
  }
}

function sessionLabel(
  phase: LoopedReviewSessionPhase,
  round: number,
  pass?: number,
): string {
  if (phase === "preparation") return `Round ${round} · Package preparation`;
  if (phase === "discovery") return `Round ${round} · Review pass ${pass}`;
  if (phase === "fix") return `Round ${round} · Fix session`;
  return "Final · PR creation";
}

function dispatchMaterial(
  workflow: LoopedReviewWorkflow,
  dispatch: LoopedReviewDispatch,
): { prompt: string; schema: JsonSchema } {
  const round = workflow.rounds.find(
    (candidate) => candidate.round === workflow.currentRound,
  );
  if (dispatch.kind === "prepare") {
    return {
      prompt: createReviewPackagePrompt({
        round: workflow.currentRound,
        packageId: `review-package-${workflow.id}-r${workflow.currentRound}`,
        targetBranch: workflow.targetBranch,
        context: workflow.context,
      }),
      schema: REVIEW_PACKAGE_JSON_SCHEMA as unknown as JsonSchema,
    };
  }
  if (dispatch.kind === "discover") {
    if (!round?.package) throw new Error("Current round has no review package");
    return {
      prompt: createDiscoveryPrompt({
        reviewPackage: round.package,
        reviewInstruction: workflow.reviewInstruction,
      }),
      schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as unknown as JsonSchema,
    };
  }
  if (dispatch.kind === "reconcile") {
    const pass = round?.passes.find(
      (candidate) =>
        candidate.pass === workflow.currentPass
        && candidate.sessionId === dispatch.sessionId,
    );
    if (!pass?.report) throw new Error("Current pass has no validated report");
    return {
      prompt: createReconciliationPrompt({
        report: pass.report,
        pool: workflow.activePool,
      }),
      schema: REVIEW_RECONCILIATION_JSON_SCHEMA as unknown as JsonSchema,
    };
  }
  if (dispatch.kind === "fix") {
    return {
      prompt: createFixPoolPrompt({
        pool: workflow.activePool,
        targetBranch: workflow.targetBranch,
      }),
      schema: REVIEW_FIX_RESULT_JSON_SCHEMA as unknown as JsonSchema,
    };
  }
  return {
    prompt: createLoopedReviewPrPrompt(workflow.targetBranch),
    schema: REVIEW_PR_RESULT_JSON_SCHEMA as unknown as JsonSchema,
  };
}

function activePoolCount(pool: ReviewFindingPool): number {
  return pool.issues.length + pool.coverageGaps.length;
}

function PoolView({
  pool,
  archived = false,
}: {
  pool: ReviewFindingPool;
  archived?: boolean;
}) {
  const count = activePoolCount(pool);
  if (count === 0) {
    return <p className="text-sm text-muted-foreground">No pooled findings.</p>;
  }
  return (
    <div className="space-y-2">
      {pool.issues.map((issue) => (
        <div
          key={issue.poolId}
          className={cn(
            "rounded-lg border p-3 text-sm",
            archived
              ? "border-border/60 bg-muted/15"
              : "border-amber-500/25 bg-amber-500/5",
          )}
        >
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <code>{issue.poolId}</code>
            <span>{issue.severity}</span>
            <span>{issue.confidence}%</span>
            <span>{issue.category}</span>
          </div>
          <p className="mt-1 font-medium text-foreground">{issue.title}</p>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {issue.file}{issue.line ? `:${issue.line}` : ""}
          </p>
          <p className="mt-2 text-foreground/80">{issue.description}</p>
        </div>
      ))}
      {pool.coverageGaps.map((gap) => (
        <div
          key={gap.poolId}
          className={cn(
            "rounded-lg border p-3 text-sm",
            archived
              ? "border-border/60 bg-muted/15"
              : "border-sky-500/25 bg-sky-500/5",
          )}
        >
          <code className="text-xs text-muted-foreground">{gap.poolId}</code>
          <p className="mt-1 font-mono text-xs text-foreground">{gap.file}</p>
          <p className="mt-1 text-foreground/80">{gap.untestedBehavior}</p>
        </div>
      ))}
    </div>
  );
}

export function LoopedReviewTab({ data, isActive: _isActive }: LoopedReviewTabProps) {
  const workflow = useLoopedReviewStore(
    (state) => state.workflows.get(data.workflowId),
  );
  const environment = useEnvironmentStore(
    (state) => state.getEnvironmentById(data.environmentId),
  );
  const [hydrating, setHydrating] = useState(!workflow);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const advanceInFlightRef = useRef(false);
  const agentRef = useRef<NativeStructuredAgent | null>(null);
  const nullResultPollsRef = useRef(new Map<string, number>());
  const [pollTick, setPollTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (workflow) {
      setHydrating(false);
      return;
    }
    setHydrating(true);
    void hydrateLoopedReviewWorkflow(data.workflowId)
      .then((restored) => {
        if (cancelled) return;
        setHydrating(false);
        if (!restored) {
          setConnectionError("The authoritative looped-review workflow could not be found.");
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setHydrating(false);
        setConnectionError(
          error instanceof Error ? error.message : "Failed to restore looped review",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [data.workflowId, workflow]);

  useEffect(() => {
    if (!workflow || !isLoopedReviewActivePhase(workflow.phase)) return;
    const timer = setTimeout(() => setPollTick((value) => value + 1), 1_000);
    return () => clearTimeout(timer);
  }, [workflow, workflow?.dispatch, workflow?.phase, workflow?.updatedAt]);

  const connect = useCallback(async (
    current: LoopedReviewWorkflow,
  ): Promise<NativeStructuredAgent> => {
    if (agentRef.current?.provider === current.agent) return agentRef.current;
    if (!environment) throw new Error("Review environment is unavailable");
    const agent = await connectStructuredReviewAgent(current, environment);
    agentRef.current = agent;
    return agent;
  }, [environment]);

  const createPhaseSession = useCallback(async (
    current: LoopedReviewWorkflow,
    phase: LoopedReviewSessionPhase,
    pass?: number,
  ): Promise<string> => {
    const agent = await connect(current);
    const label = sessionLabel(phase, current.currentRound, pass);
    const providerSessionId = await agent.createSession(phase, label);
    const id = useLoopedReviewStore.getState().addSession(current.id, {
      phase,
      round: current.currentRound,
      pass,
      providerSessionId,
    });
    if (!id) throw new Error(`Could not attach ${label}`);
    return id;
  }, [connect]);

  const beginDispatch = useCallback(async (
    current: LoopedReviewWorkflow,
    kind: LoopedReviewDispatch["kind"],
    sessionId: string,
  ) => {
    const phase = current.phase;
    if (!isLoopedReviewActivePhase(phase)) return;
    const dispatchId = createUuid();
    const requestId = createUuid();
    const claimed = useLoopedReviewStore.getState().claimDispatch(current.id, {
      id: dispatchId,
      requestId,
      sessionId,
      phase,
      kind,
    });
    if (!claimed) return;
    // The prepared lease is durable before the provider sees a byte. Recovery
    // can therefore query/resend the same request ID without duplicating a turn.
    await persistLoopedReviewWorkflowNow(current.id);
  }, []);

  const startCurrentPhase = useCallback(async (
    current: LoopedReviewWorkflow,
  ) => {
    if (current.phase === "preparing") {
      const sessionId = await createPhaseSession(current, "preparation");
      await beginDispatch(current, "prepare", sessionId);
      return;
    }
    if (current.phase === "discovering") {
      const pass = current.currentPass + 1;
      const sessionId = await createPhaseSession(current, "discovery", pass);
      useLoopedReviewStore.getState().startPass(current.id, sessionId);
      const latest = useLoopedReviewStore.getState().workflows.get(current.id)!;
      await beginDispatch(latest, "discover", sessionId);
      return;
    }
    if (current.phase === "reconciling") {
      if (!current.activeSessionId) {
        throw new Error("Reconciliation lost its discovery session");
      }
      await beginDispatch(current, "reconcile", current.activeSessionId);
      return;
    }
    if (current.phase === "fixing") {
      if (!hasReviewFindings(current.activePool)) {
        throw new Error("Fixing phase has no active findings");
      }
      const sessionId = await createPhaseSession(current, "fix");
      await beginDispatch(current, "fix", sessionId);
      return;
    }
    if (current.phase === "creating-pr") {
      if (hasReviewFindings(current.activePool)) {
        throw new Error("PR creation is blocked while the active pool is non-empty");
      }
      const sessionId = await createPhaseSession(current, "pr");
      useLoopedReviewStore.getState().startPr(current.id, sessionId);
      const latest = useLoopedReviewStore.getState().workflows.get(current.id)!;
      await beginDispatch(latest, "pr", sessionId);
    }
  }, [beginDispatch, createPhaseSession]);

  const applyResult = useCallback((
    current: LoopedReviewWorkflow,
    dispatch: LoopedReviewDispatch,
    result: StructuredOutputResult,
  ) => {
    const store = useLoopedReviewStore.getState();
    const session = current.sessions.find(
      (candidate) => candidate.id === dispatch.sessionId,
    );
    if (!session) throw new Error("Structured result belongs to an unknown workflow session");
    if (!result.ok) {
      store.updateSession(current.id, session.id, {
        status: "error",
        error: result.error.message,
        completedAt: new Date().toISOString(),
      });
      store.failWorkflow(current.id, {
        code: "structured-output",
        message: result.error.message,
        retryPhase: dispatch.phase,
      });
      return;
    }

    store.updateSession(current.id, session.id, {
      status: "idle",
      completedAt:
        dispatch.kind === "discover"
          ? undefined
          : new Date().toISOString(),
    });
    if (dispatch.kind === "prepare") {
      const reviewPackage = parseReviewPackage(result.value);
      if (
        reviewPackage.round !== current.currentRound
        || reviewPackage.targetBranch !== current.targetBranch
      ) {
        throw new Error("Prepared package does not match the active review round");
      }
      store.clearDispatch(current.id, dispatch.id);
      store.setPreparedPackage(current.id, reviewPackage);
      return;
    }
    if (dispatch.kind === "discover") {
      const report = parseStructuredReviewReport(result.value);
      store.clearDispatch(current.id, dispatch.id);
      store.recordReport(current.id, session.id, report);
      return;
    }
    if (dispatch.kind === "reconcile") {
      const reconciliation = parseReviewReconciliation(result.value);
      store.clearDispatch(current.id, dispatch.id);
      store.recordReconciliation(current.id, session.id, reconciliation);
      return;
    }
    if (dispatch.kind === "fix") {
      const fixResult = parseFixResult(result.value);
      if (!fixResult.complete) {
        throw new Error(
          fixResult.limitations[0]
          ?? "The fix session did not resolve the complete active pool",
        );
      }
      store.clearDispatch(current.id, dispatch.id);
      store.completeFix(current.id, session.id);
      return;
    }
    const prResult = parsePrResult(result.value);
    store.clearDispatch(current.id, dispatch.id);
    store.completePr(current.id, prResult.url);
  }, []);

  const advance = useCallback(async () => {
    const current = useLoopedReviewStore.getState().workflows.get(data.workflowId);
    if (
      !current
      || !environment
      || !isLoopedReviewActivePhase(current.phase)
      || advanceInFlightRef.current
    ) {
      return;
    }
    advanceInFlightRef.current = true;
    try {
      setConnectionError(null);
      const agent = await connect(current);
      if (!current.dispatch) {
        await startCurrentPhase(current);
        return;
      }

      const dispatch = current.dispatch;
      const session = current.sessions.find(
        (candidate) => candidate.id === dispatch.sessionId,
      );
      if (!session) throw new Error("Active dispatch lost its agent session");
      const material = dispatchMaterial(current, dispatch);

      if (dispatch.state === "prepared") {
        const accepted = await agent.send(
          session.providerSessionId,
          material.prompt,
          material.schema,
          dispatch.requestId,
        );
        if (!accepted.accepted) {
          throw new Error(accepted.error ?? "Native provider rejected the prompt");
        }
        useLoopedReviewStore.getState().markDispatchSent(current.id, dispatch.id);
        await persistLoopedReviewWorkflowNow(current.id);
        return;
      }

      const result = await agent.getResult(
        session.providerSessionId,
        dispatch.requestId,
      );
      if (result) {
        nullResultPollsRef.current.delete(dispatch.id);
        applyResult(current, dispatch, result);
        return;
      }

      const status = await agent.getStatus(session.providerSessionId);
      if (status === "error") {
        throw new Error("Native provider session failed before returning structured output");
      }
      const polls = (nullResultPollsRef.current.get(dispatch.id) ?? 0) + 1;
      nullResultPollsRef.current.set(dispatch.id, polls);
      // An idle snapshot can race the bridge recording its result. Give it a
      // short reconciliation window, then fail visibly instead of treating
      // transcript text as structured success.
      if (status === "idle" && polls >= 5) {
        throw new Error("Native provider completed without a structured result");
      }
    } catch (error) {
      const latest = useLoopedReviewStore.getState().workflows.get(data.workflowId);
      if (!latest || !isLoopedReviewActivePhase(latest.phase)) return;
      const message = error instanceof Error ? error.message : String(error);
      const sessionId = latest.dispatch?.sessionId ?? latest.activeSessionId;
      if (sessionId) {
        useLoopedReviewStore.getState().updateSession(latest.id, sessionId, {
          status: "error",
          error: message,
          completedAt: new Date().toISOString(),
        });
      }
      const kind = latest.dispatch?.kind;
      useLoopedReviewStore.getState().failWorkflow(latest.id, {
        code:
          kind === "prepare" ? "package"
          : kind === "reconcile" ? "reconciliation"
          : kind === "fix" ? "fix"
          : kind === "pr" ? "pr"
          : "provider",
        message,
        retryPhase: latest.phase,
      });
    } finally {
      advanceInFlightRef.current = false;
    }
  }, [
    applyResult,
    connect,
    data.workflowId,
    environment,
    startCurrentPhase,
  ]);

  useEffect(() => {
    void advance();
  }, [advance, pollTick, workflow?.phase, workflow?.dispatch, workflow?.updatedAt]);

  const handleCancel = useCallback(async () => {
    const current = useLoopedReviewStore.getState().workflows.get(data.workflowId);
    if (!current) return;
    const session = current.sessions.find(
      (candidate) => candidate.id === current.activeSessionId,
    );
    if (session) {
      try {
        const agent = await connect(current);
        await agent.abort(session.providerSessionId);
      } catch {
        // Cancellation still wins locally; a late result cannot advance a
        // terminal cancelled workflow.
      }
    }
    useLoopedReviewStore.getState().cancelWorkflow(current.id);
  }, [connect, data.workflowId]);

  const sessionById = useMemo(
    () => new Map(workflow?.sessions.map((session) => [session.id, session]) ?? []),
    [workflow?.sessions],
  );

  if (hydrating) {
    return (
      <div className="absolute inset-0 grid place-items-center" role="status">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Restoring looped review…
        </div>
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="absolute inset-0 grid place-items-center p-6">
        <div className="max-w-md rounded-xl border border-red-500/30 bg-red-500/5 p-5 text-center">
          <AlertCircle className="mx-auto size-6 text-red-400" />
          <h2 className="mt-3 font-semibold">Looped review unavailable</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {connectionError ?? "The workflow snapshot is missing."}
          </p>
          <Button
            className="mt-4"
            variant="outline"
            onClick={() => {
              setHydrating(true);
              setConnectionError(null);
              void hydrateLoopedReviewWorkflow(data.workflowId)
                .finally(() => setHydrating(false));
            }}
          >
            <RefreshCw className="mr-2 size-4" />
            Retry restore
          </Button>
        </div>
      </div>
    );
  }

  const activeSession = workflow.activeSessionId
    ? sessionById.get(workflow.activeSessionId)
    : undefined;
  const busy = isLoopedReviewActivePhase(workflow.phase);

  return (
    <div className="absolute inset-0 overflow-y-auto bg-background" aria-label="Looped code review workflow">
      <header className="sticky top-0 z-20 border-b border-border/80 bg-background/95 px-4 py-3 backdrop-blur @md:px-6">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="font-semibold">Looped Code Review</h1>
              <span className="rounded-full border border-cyan-500/30 bg-cyan-500/8 px-2 py-0.5 text-[11px] font-medium text-cyan-300">
                {workflow.agent} native
              </span>
              <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                {workflow.model}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground" aria-live="polite">
              Round {workflow.currentRound} · pass {workflow.currentPass || "—"}/{workflow.currentAllowance} · {phaseLabel(workflow)}
              {activeSession ? ` · session ${activeSession.providerSessionId}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {busy && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => useLoopedReviewStore.getState().pauseWorkflow(workflow.id)}
              >
                <CirclePause className="mr-1.5 size-4" />
                Pause
              </Button>
            )}
            {workflow.phase === "paused" && (
              <Button
                size="sm"
                onClick={() => useLoopedReviewStore.getState().resumeWorkflow(workflow.id)}
              >
                <Play className="mr-1.5 size-4" />
                Resume
              </Button>
            )}
            {workflow.phase === "failed" && (
              <Button
                size="sm"
                onClick={() => useLoopedReviewStore.getState().retryWorkflow(workflow.id)}
              >
                <RotateCcw className="mr-1.5 size-4" />
                Retry phase
              </Button>
            )}
            {(busy || workflow.phase === "paused" || workflow.phase === "failed") && (
              <Button size="sm" variant="destructive" onClick={() => void handleCancel()}>
                <Square className="mr-1.5 size-3.5" />
                Cancel
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-5 p-4 pb-16 @md:p-6">
        {busy && (
          <div className="flex items-center gap-3 rounded-xl border border-cyan-500/20 bg-cyan-500/5 p-4" role="status">
            <Loader2 className="size-5 animate-spin text-cyan-400" />
            <div>
              <p className="text-sm font-medium">{phaseLabel(workflow)}</p>
              <p className="text-xs text-muted-foreground">
                State is persisted outside this tab; it will continue while you work elsewhere.
              </p>
            </div>
          </div>
        )}

        {workflow.phase === "paused" && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4" role="status">
            <p className="font-medium text-amber-300">Workflow paused</p>
            <p className="mt-1 text-sm text-muted-foreground">
              The current session and dispatch state are preserved. Resume to reconcile its authoritative result.
            </p>
          </div>
        )}

        {workflow.phase === "failed" && workflow.failure && (
          <div className="rounded-xl border border-red-500/35 bg-red-500/5 p-4" role="alert">
            <div className="flex gap-3">
              <OctagonX className="mt-0.5 size-5 shrink-0 text-red-400" />
              <div>
                <p className="font-medium text-red-300">Phase failed · {workflow.failure.code}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-foreground/80">
                  {workflow.failure.message}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Retry starts only this phase. Completed rounds and pools will not rerun.
                </p>
              </div>
            </div>
          </div>
        )}

        {workflow.phase === "cancelled" && (
          <div className="rounded-xl border border-border bg-muted/20 p-4" role="status">
            <p className="font-medium">Workflow cancelled</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Reports, pools, packages, and session history remain available below.
            </p>
          </div>
        )}

        {workflow.phase === "completed" && (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4" role="status">
            <div className="flex gap-3">
              <CheckCircle2 className="size-5 text-emerald-400" />
              <div>
                <p className="font-medium text-emerald-300">Review complete and PR created</p>
                {workflow.pr.url && (
                  <a
                    href={workflow.pr.url}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex items-center gap-1 text-sm text-cyan-300 underline-offset-4 hover:underline"
                  >
                    {workflow.pr.url}
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </div>
            </div>
          </div>
        )}

        <section className="rounded-xl border border-border/80 bg-card/35 p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Active finding pool</h2>
            <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
              {activePoolCount(workflow.activePool)} findings
            </span>
          </div>
          <PoolView pool={workflow.activePool} />
        </section>

        {workflow.rounds.map((round) => (
          <section
            key={round.round}
            className="overflow-hidden rounded-xl border border-border/80 bg-card/25"
            aria-label={`Review round ${round.round}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-muted/15 px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold">Round {round.round}</h2>
                <p className="text-xs text-muted-foreground">
                  {round.allowance}-pass allowance · {round.status}
                </p>
              </div>
              {round.package && (
                <div className="text-right text-xs text-muted-foreground">
                  <p className="font-mono">{round.package.headRef.slice(0, 12)}</p>
                  <p>{round.package.validation.length} validation commands</p>
                </div>
              )}
            </div>
            <div className="space-y-5 p-4">
              {round.package && (
                <details className="rounded-lg border border-border/70 bg-background/30 p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Immutable review package
                  </summary>
                  <dl className="mt-3 grid gap-2 text-xs @md:grid-cols-2">
                    <div><dt className="text-muted-foreground">Base</dt><dd className="break-all font-mono">{round.package.baseRef}</dd></div>
                    <div><dt className="text-muted-foreground">Head</dt><dd className="break-all font-mono">{round.package.headRef}</dd></div>
                    <div><dt className="text-muted-foreground">Changed files</dt><dd>{round.package.changedFiles.length}</dd></div>
                    <div><dt className="text-muted-foreground">Diff size</dt><dd>{round.package.completeDiff.length.toLocaleString()} characters</dd></div>
                  </dl>
                  {!!round.package.limitations.length && (
                    <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-amber-300">
                      {round.package.limitations.map((limitation) => (
                        <li key={limitation}>{limitation}</li>
                      ))}
                    </ul>
                  )}
                </details>
              )}

              {round.passes.length === 0 && (
                <p className="text-sm text-muted-foreground">No completed passes yet.</p>
              )}
              {round.passes.map((pass, index) => {
                const session = sessionById.get(pass.sessionId);
                return (
                  <div key={`${pass.pass}-${pass.sessionId}-${index}`} className="relative pl-6">
                    <div className="absolute bottom-0 left-2 top-0 w-px bg-border" aria-hidden="true" />
                    <div className="absolute left-[0.3rem] top-1.5 size-3 rounded-full border-2 border-background bg-cyan-400" aria-hidden="true" />
                    <div className="mb-3">
                      <h3 className="text-sm font-semibold">
                        Pass {pass.pass} · {pass.status}
                      </h3>
                      <p className="text-xs text-muted-foreground">
                        Fresh discovery session {session?.providerSessionId ?? pass.sessionId}
                      </p>
                    </div>
                    {pass.report && (
                      <StructuredReviewReportView
                        report={pass.report}
                        heading={`Round ${round.round}, pass ${pass.pass} report`}
                      />
                    )}
                    {pass.reconciliation && (
                      <details className="mt-3 rounded-lg border border-border/70 bg-background/30 p-3">
                        <summary className="cursor-pointer text-sm font-medium">
                          Reconciliation operations
                        </summary>
                        <pre className="mt-3 max-h-72 overflow-auto text-xs text-foreground/75">
                          {JSON.stringify(pass.reconciliation, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        {workflow.archivedPools.map((archive) => (
          <section
            key={`${archive.round}-${archive.fixSessionId}`}
            className="rounded-xl border border-border/70 bg-muted/10 p-4"
            aria-label={`Archived findings from round ${archive.round}`}
          >
            <div className="mb-3 flex items-center gap-2">
              <Archive className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold">Archived pool · round {archive.round}</h2>
              <span className="text-xs text-muted-foreground">
                fixed in session {archive.fixSessionId}
              </span>
            </div>
            <PoolView pool={archive.pool} archived />
          </section>
        ))}
      </main>
    </div>
  );
}
