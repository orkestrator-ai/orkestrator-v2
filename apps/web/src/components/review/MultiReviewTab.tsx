import { ReviewValidationStatus } from "./ReviewValidationStatus";
import { WorkflowResultStatus } from "./WorkflowResultStatus";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleAlert,
  FileWarning,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Wrench,
} from "lucide-react";
import {
  MULTI_REVIEW_FIX_TAB_TITLE,
  MULTI_REVIEW_REVIEW_TAB_TITLE,
  type MultiReviewPhase,
  type MultiReviewStepKind,
  type MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import type { MultiReviewTabData } from "@/types/paneLayout";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { StructuredReviewReportView } from "./StructuredReviewReportView";
import { StackedEyes } from "./MultiReviewLaunchDialog";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { hydrateMultiReviewWorkflow } from "@/lib/multi-review-persistence";
import { useOptionalTerminalContext, type CreateTabOptions } from "@/contexts/TerminalContext";
import { MultiReviewReviewerTab } from "./MultiReviewReviewerTab";
import * as backend from "@/lib/backend";
import { MultiReviewFixPromptDialog } from "./MultiReviewFixPromptDialog";
import { useReviewModelCatalog } from "@/hooks/useBuildLaunchOptions";
import { formatElapsed } from "@/lib/format-elapsed";
import { formatTokenCount } from "@/lib/context-usage";

interface MultiReviewCommands {
  address: (workflowId: string) => Promise<MultiReviewWorkflow>;
  customFix?: (
    workflowId: string,
    fixModel: MultiReviewWorkflow["fixModel"],
    instruction: string,
  ) => Promise<MultiReviewWorkflow>;
  retry: (workflowId: string) => Promise<MultiReviewWorkflow>;
  cancel: (workflowId: string) => Promise<MultiReviewWorkflow>;
  stopReviewer: (workflowId: string, reviewerId: string) => Promise<MultiReviewWorkflow>;
  restartReviewer?: (workflowId: string, reviewerId: string) => Promise<MultiReviewWorkflow>;
  unstickReviewer?: (workflowId: string, reviewerId: string) => Promise<MultiReviewWorkflow>;
}

const defaultCommands: MultiReviewCommands = {
  address: backend.addressMultiReview,
  customFix: (workflowId, fixModel, instruction) =>
    backend.startMultiReviewCustomFix({ workflowId, fixModel, instruction }),
  retry: backend.retryMultiReview,
  cancel: backend.cancelMultiReview,
  stopReviewer: backend.stopMultiReviewReviewer,
  restartReviewer: backend.restartMultiReviewReviewer,
  unstickReviewer: backend.unstickMultiReviewReviewer,
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
    preparing: "Discovering validation, running checks, and preparing shared evidence",
    reviewing: "Independent read-only reviews are running",
    consolidating: "The review preparation model is consolidating findings",
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

/**
 * Opens the idle consolidation session as a normal native agent tab. If that
 * provider session was deleted, the native tab asks the backend to seed and
 * record a fresh replacement before exposing it to the user.
 */
export function multiReviewFixSessionTabOptions(
  workflow: MultiReviewWorkflow,
): CreateTabOptions | null {
  const session = workflow.fixSession;
  if (!session?.providerSessionId) return null;
  return {
    tabId: workflow.fixTabId ?? `multi-review-fix:${workflow.id}`,
    activateExistingTab: true,
    agentLaunchMode: "native",
    resumeSessionId: session.providerSessionId,
    displayTitle: MULTI_REVIEW_FIX_TAB_TITLE,
    isReviewTab: true,
    hideStructuredOutput: true,
    initialAgentModel: workflow.fixModel.model === "default" ? undefined : workflow.fixModel.model,
    initialReasoningEffort: workflow.fixModel.reasoningEffort,
    initialConversationMode: "build",
    // A backend-owned turn is in flight. Seeding a fresh replacement for a
    // missing provider session would show an empty tab that looks like the
    // supervisor's work, so only the real session may be attached to.
    ...(session.status === "running" ? { requireExistingResumeSession: true } : {}),
  };
}

/** Opens the shared preparation/consolidation conversation, never the Fix tab. */
export function multiReviewReviewSessionTabOptions(
  workflow: MultiReviewWorkflow,
): CreateTabOptions | null {
  const session =
    workflow.reviewSession ?? (workflow.reviewModel ? undefined : workflow.fixSession);
  const selection = workflow.reviewModel ?? workflow.fixModel;
  if (!session?.providerSessionId) return null;
  return {
    tabId: `multi-review-review:${workflow.id}`,
    activateExistingTab: true,
    agentLaunchMode: "native",
    resumeSessionId: session.providerSessionId,
    displayTitle: MULTI_REVIEW_REVIEW_TAB_TITLE,
    isReviewTab: true,
    hideStructuredOutput: true,
    initialAgentModel: selection.model === "default" ? undefined : selection.model,
    initialReasoningEffort: selection.reasoningEffort,
    initialConversationMode: "plan",
    ...(session.status === "running" ? { requireExistingResumeSession: true } : {}),
  };
}

/**
 * The supervisor drives preparation and consolidation in one coordinator
 * session, then performs fixing in a separate session. Each card needs both a
 * label and the state that decides its icon and whether its session can open.
 */
export type MultiReviewStepState =
  | "not-started"
  | "running"
  | "complete"
  | "failed"
  | "cancelling"
  | "cancelled";

export interface MultiReviewStepStatus {
  label: string;
  state: MultiReviewStepState;
}

const PACKAGE_PRODUCED_PHASES: ReadonlySet<MultiReviewPhase> = new Set<MultiReviewPhase>([
  "reviewing",
  "consolidating",
  "ready",
  "fixing",
  "interactive",
  "completed",
]);

function step(label: string, state: MultiReviewStepState): MultiReviewStepStatus {
  return { label, state };
}

/**
 * A cancelled workflow cancels every step it had not already finished. Settling
 * to `cancelled` clears the active request, so there is no per-step record left
 * to attribute the stop to, and reporting the steps individually would be a
 * guess rather than a reading.
 */
function cancellationStep(phase: MultiReviewPhase): MultiReviewStepStatus | null {
  if (phase === "cancelling") return step("Cancelling", "cancelling");
  if (phase === "cancelled") return step("Cancelled", "cancelled");
  return null;
}

/** Keep preparation visible as a completed step after the workflow moves on. */
export function reviewPackageGenerationStep(workflow: MultiReviewWorkflow): MultiReviewStepStatus {
  if (workflow.phase === "preparing") return step("Generating package", "running");
  // Workflows persisted before file-backed packages were introduced can have
  // advanced beyond preparation without carrying a reviewPackage pointer, so a
  // phase or a dispatched reviewer stands in as the evidence. A reviewer only
  // receives a session once the package it reads exists.
  const produced =
    workflow.reviewPackage !== undefined ||
    PACKAGE_PRODUCED_PHASES.has(workflow.phase) ||
    workflow.reviewers.some(
      (reviewer) => reviewer.providerSessionId !== undefined || reviewer.report !== undefined,
    );
  if (produced) return step("Package ready", "complete");
  const cancelled = cancellationStep(workflow.phase);
  if (cancelled) return cancelled;
  // Nothing was produced and nothing downstream ever started, so preparation is
  // the only step this workflow can have been running when it failed.
  if (workflow.phase === "failed") return step("Failed", "failed");
  return step("Not started", "not-started");
}

/** Consolidation is a separate step which waits for the independent reviewers. */
export function consolidationStep(workflow: MultiReviewWorkflow): MultiReviewStepStatus {
  if (workflow.consolidatedReport !== undefined) return step("Complete", "complete");
  if (workflow.phase === "consolidating") return step("Consolidating findings", "running");
  if (workflow.phase === "reviewing") return step("Waiting for reviews", "not-started");
  if (workflow.phase === "preparing") return step("Waiting for review package", "not-started");
  const cancelled = cancellationStep(workflow.phase);
  if (cancelled) return cancelled;
  // `fail` preserves the request that was in flight, and only a consolidation
  // turn can fail here. A preparation or reviewer failure leaves this step
  // unrun, so claiming it failed would contradict the card and the panel that
  // show the real cause.
  if (workflow.phase === "failed" && workflow.activeRequest?.kind === "consolidate") {
    return step("Failed", "failed");
  }
  return step("Not started", "not-started");
}

/** The fix turn is the last step, and only the user can start it. */
export function fixStep(workflow: MultiReviewWorkflow): MultiReviewStepStatus {
  if (workflow.phase === "completed") return step("Complete", "complete");
  if (workflow.phase === "fixing") return step("Addressing findings", "running");
  if (workflow.phase === "interactive") return step("Interactive fix session", "running");
  const cancelled = cancellationStep(workflow.phase);
  if (cancelled) return cancelled;
  const dispatched =
    workflow.activeRequest?.kind === "fix" ||
    workflow.fixResult !== undefined ||
    workflow.addressPromptPending === true;
  if (workflow.phase === "failed" && dispatched) return step("Failed", "failed");
  if (workflow.phase === "ready") return step("Ready to start", "not-started");
  return step("Not started", "not-started");
}

export type MultiReviewStepKey = "package" | "consolidation" | "fix";

/**
 * Which step owns the fix session's clock. The three steps share one provider
 * session and every dispatch resets `startedAt`, so a runtime shown against the
 * wrong card would be the next step's elapsed time under a settled step's name.
 */
export function fixSessionRuntimeStep(workflow: MultiReviewWorkflow): MultiReviewStepKey | null {
  switch (workflow.phase) {
    // The reviewers run without the fix session, so it still holds preparation's
    // finished timings for the whole review stage.
    case "preparing":
    case "reviewing":
      return "package";
    case "consolidating":
    case "ready":
      return "consolidation";
    case "fixing":
    case "completed":
      return "fix";
    // The address turn has not been dispatched yet, so the session still carries
    // consolidation's timings and no step may claim them.
    case "interactive":
      return workflow.addressPromptPending === true ? null : "fix";
    default:
      break;
  }
  // Cancellation clears the active request, so only a failure still says which
  // turn was in flight.
  switch (workflow.activeRequest?.kind) {
    case "prepare":
      return "package";
    case "consolidate":
      return "consolidation";
    case "fix":
      return "fix";
    default:
      return null;
  }
}

export function fixSessionRuntimeSummary(
  session: NonNullable<MultiReviewWorkflow["fixSession"]>,
  now = Date.now(),
): string | null {
  const startedAt = Date.parse(session.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  const running = session.status === "running";
  const completedAt = session.completedAt ? Date.parse(session.completedAt) : Number.NaN;
  if (!running && !Number.isFinite(completedAt)) return null;
  const end = running ? now : completedAt;
  return formatElapsed(Math.max(0, Math.floor((end - startedAt) / 1_000)));
}

type FixSessionOpenOutcome = "opened" | "no-session" | "environment-unavailable" | "tab-rejected";

function openFixSessionError(
  outcome: Exclude<FixSessionOpenOutcome, "opened">,
  source: "automatic" | "manual",
): string {
  if (outcome === "no-session") return "The consolidation session is no longer available";
  if (outcome === "environment-unavailable") {
    return source === "automatic"
      ? "The fix request was delivered, but this environment cannot open agent tabs right now. When it is ready, use Open fix session."
      : "The environment is not ready to open the fix session.";
  }
  return source === "automatic"
    ? "The fix request was delivered, but its tab could not be opened. Close another tab if needed, then use Open fix session."
    : "The fix session tab could not be opened. Close another tab if the workspace is at its limit, then try again.";
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

/**
 * The one runtime line every card shows: elapsed time, then what the turn cost.
 *
 * A turn that never recorded an end is not given one here — an unsettled turn
 * that is no longer running has no honest elapsed time, so only its measured
 * consumption is reported.
 */
function runtimeSummary(
  timing: { startedAt?: string; completedAt?: string; tokenCount?: number },
  running: boolean,
  now: number,
): string | null {
  if (!timing.startedAt) return null;
  const startedAt = Date.parse(timing.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  const tokens =
    timing.tokenCount === undefined ? null : `${formatTokenCount(timing.tokenCount)} tokens`;
  const completedAt = timing.completedAt ? Date.parse(timing.completedAt) : Number.NaN;
  const activelyRunning = running && !Number.isFinite(completedAt);
  if (!activelyRunning && !Number.isFinite(completedAt)) return tokens;
  const end = activelyRunning ? now : completedAt;
  const elapsed = formatElapsed(Math.max(0, Math.floor((end - startedAt) / 1_000)));
  if (!tokens) return activelyRunning ? `${elapsed} · Tokens pending` : elapsed;
  return `${elapsed} · ${tokens}`;
}

export function reviewerRuntimeSummary(
  reviewer: MultiReviewWorkflow["reviewers"][number],
  now = Date.now(),
): string | null {
  return runtimeSummary(reviewer, reviewer.status === "running", now);
}

const STEP_REQUEST_KIND: Record<MultiReviewStepKey, MultiReviewStepKind> = {
  package: "prepare",
  consolidation: "consolidate",
  fix: "fix",
};

/**
 * Preparation, consolidation and the fix turn each report their own runtime.
 *
 * The backend records them per step because the three share one provider
 * session whose clock and token counter every dispatch resets. Workflows that
 * predate those records still have only the shared session, which can be read
 * for whichever step is using it now.
 */
export function multiReviewStepRuntimeSummary(
  workflow: MultiReviewWorkflow,
  step: MultiReviewStepKey,
  running: boolean,
  now = Date.now(),
): string | null {
  if (workflow.stepRuntimes) {
    // A step this workflow has records for but no record of has not run yet,
    // and must not borrow the shared session's clock from the step that has.
    const runtime = workflow.stepRuntimes[STEP_REQUEST_KIND[step]];
    return runtime ? runtimeSummary(runtime, running, now) : null;
  }
  if (fixSessionRuntimeStep(workflow) !== step) return null;
  if (step === "fix") {
    return workflow.fixSession ? fixSessionRuntimeSummary(workflow.fixSession, now) : null;
  }
  const session =
    workflow.reviewSession ?? (workflow.reviewModel ? undefined : workflow.fixSession);
  return session ? fixSessionRuntimeSummary(session, now) : null;
}

const NOTE_TONE_CLASS = {
  muted: "text-muted-foreground",
  warning: "text-amber-500",
  destructive: "text-destructive",
} as const;

function findingCountLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`} found`;
}

function reviewerTranscriptLabel(
  reviewer: MultiReviewWorkflow["reviewers"][number],
  index: number,
): string {
  const action = `Open Reviewer ${index + 1} transcript`;
  if (!reviewer.report) return action;
  return `${action}, ${findingCountLabel(reviewer.report.issues.length, "issue")}, ${findingCountLabel(reviewer.report.testCoverageGaps.length, "coverage gap")}`;
}

const STEP_ICON_CLASS = "size-4 shrink-0";

function MultiReviewStepIcon({
  state,
  stalled,
}: {
  state: MultiReviewStepState;
  stalled: boolean;
}) {
  if (stalled) return <AlertTriangle className={`${STEP_ICON_CLASS} text-amber-500`} />;
  switch (state) {
    case "running":
      return <Loader2 className={`${STEP_ICON_CLASS} animate-spin text-primary`} />;
    case "failed":
      return <AlertCircle className={`${STEP_ICON_CLASS} text-destructive`} />;
    case "cancelling":
    case "cancelled":
      return <Square className={`${STEP_ICON_CLASS} text-muted-foreground`} />;
    case "complete":
      return <CheckCircle2 className={`${STEP_ICON_CLASS} text-emerald-500`} />;
    default:
      return <Circle className={`${STEP_ICON_CLASS} text-muted-foreground`} />;
  }
}

/**
 * The three steps share one provider session, so a step that has been reached
 * stays openable after it settles. Failure is the case that matters: it is the
 * only way to read why a preparation or consolidation turn stopped, and the tab
 * is the only surface offering it.
 */
function stepOpenTitle(
  status: MultiReviewStepStatus,
  hasSession: boolean,
  sessionName: string,
  notStartedTitle: string,
): string {
  if (status.state === "not-started") return notStartedTitle;
  if (!hasSession) return `The ${sessionName} session has not opened yet`;
  if (status.state === "failed") return `Open the failed ${sessionName} session in a new tab`;
  return `Open the ${sessionName} session in a new tab`;
}

function MultiReviewStepSection({
  heading,
  name,
  status,
  stalled,
  model,
  runtime,
  runtimeLabel,
  openLabel,
  openTitle,
  canOpen,
  onOpen,
}: {
  heading: string;
  name: string;
  status: MultiReviewStepStatus;
  stalled: boolean;
  model: MultiReviewWorkflow["fixModel"];
  runtime: string | null;
  runtimeLabel: string;
  openLabel: string;
  openTitle: string;
  canOpen: boolean;
  onOpen: () => void;
}) {
  return (
    <section className="rounded-xl border border-border/60 bg-card/35 p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{heading}</h2>
        <span className="text-xs text-muted-foreground">{status.label}</span>
      </div>
      <div className="flex items-center rounded-lg border border-border/45 bg-background/40 transition-colors has-[button:enabled:hover]:border-cyan-400/35">
        <button
          type="button"
          disabled={!canOpen}
          aria-label={openLabel}
          title={openTitle}
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors enabled:cursor-pointer enabled:hover:bg-cyan-500/5 disabled:cursor-default"
          onClick={onOpen}
        >
          <MultiReviewStepIcon state={status.state} stalled={stalled} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium">
              {name} · {model.agent}
            </p>
            <p className="truncate text-[11px] text-muted-foreground">
              {model.model}
              {model.reasoningEffort ? ` · ${model.reasoningEffort}` : ""}
            </p>
            {runtime ? (
              <p
                className="mt-0.5 truncate font-mono text-[10px] tabular-nums text-muted-foreground"
                aria-label={runtimeLabel}
              >
                {runtime}
              </p>
            ) : null}
          </div>
        </button>
      </div>
    </section>
  );
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
  const [presentationNotice, setPresentationNotice] = useState<string | null>(null);
  const [openAfterDelivery, setOpenAfterDelivery] = useState(false);
  const [pending, setPending] = useState(false);
  const [stoppingReviewerId, setStoppingReviewerId] = useState<string | null>(null);
  const [reviewerAction, setReviewerAction] = useState<{
    reviewerId: string;
    kind: "restart" | "unstick";
  } | null>(null);
  const [customFixPromptOpen, setCustomFixPromptOpen] = useState(false);
  const [customFixPending, setCustomFixPending] = useState(false);
  const [customFixError, setCustomFixError] = useState<string | null>(null);
  const modelCatalog = useReviewModelCatalog(workflow?.projectId ?? "", customFixPromptOpen);
  const [reviewPanelNow, setReviewPanelNow] = useState(() => Date.now());
  const mountedRef = useRef(false);
  const isActiveRef = useRef(isActive);

  const hasRunningReviewer = workflow?.reviewers.some(
    (reviewer) => reviewer.status === "running" && reviewer.startedAt,
  );
  const hasRunningFixSession =
    workflow?.fixSession?.status === "running" ||
    workflow?.reviewSession?.status === "running" ||
    (workflow?.phase === "interactive" &&
      workflow.stepRuntimes?.fix !== undefined &&
      workflow.stepRuntimes.fix.completedAt === undefined);
  const hasRunningValidation =
    workflow?.validationRun?.status === "planned" || workflow?.validationRun?.status === "running";
  const hasLiveClock = Boolean(hasRunningReviewer || hasRunningFixSession || hasRunningValidation);

  useEffect(() => {
    if (!isActive || !hasLiveClock) return;
    setReviewPanelNow(Date.now());
    const interval = window.setInterval(() => setReviewPanelNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasLiveClock, isActive]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    isActiveRef.current = isActive;
    // The user navigated away after requesting the handoff. Delivery continues
    // in the backend, but a hidden review tab must never change pane focus.
    if (!isActive) setOpenAfterDelivery(false);
  }, [isActive]);

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

  const openFixSession = useCallback(
    (target: MultiReviewWorkflow | undefined): FixSessionOpenOutcome => {
      if (!target) return "no-session";
      const options = multiReviewFixSessionTabOptions(target);
      if (!options) return "no-session";
      if (!createTab) return "environment-unavailable";
      return createTab(target.fixModel.agent, options) ? "opened" : "tab-rejected";
    },
    [createTab],
  );

  const presentFixSession = useCallback(
    (target: MultiReviewWorkflow | undefined, source: "automatic" | "manual") => {
      setPresentationNotice(null);
      const outcome = openFixSession(target);
      if (outcome === "opened") {
        setError(null);
        return;
      }
      if (outcome === "no-session") {
        setError(openFixSessionError(outcome, source));
        return;
      }
      setError(null);
      setPresentationNotice(openFixSessionError(outcome, source));
    },
    [openFixSession],
  );

  const presentReviewSession = useCallback(
    (target: MultiReviewWorkflow | undefined) => {
      setPresentationNotice(null);
      if (!target) {
        setError("The review preparation session is no longer available");
        return;
      }
      const options = multiReviewReviewSessionTabOptions(target);
      if (!options) {
        setError("The review preparation session is no longer available");
        return;
      }
      if (!createTab) {
        setError("The environment is not ready to open the review preparation session.");
        return;
      }
      const selection = target.reviewModel ?? target.fixModel;
      if (!createTab(selection.agent, options)) {
        setError(
          "The review preparation tab could not be opened. Close another tab if the workspace is at its limit, then try again.",
        );
        return;
      }
      setError(null);
    },
    [createTab],
  );

  useEffect(() => {
    if (!openAfterDelivery || !workflow || workflow.addressPromptPending === true) return;
    setOpenAfterDelivery(false);
    if (isActive && workflow.phase === "interactive") presentFixSession(workflow, "automatic");
  }, [isActive, openAfterDelivery, presentFixSession, workflow]);

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
    if (stoppingReviewerId !== null || reviewerAction !== null || pending || !workflow) return;
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

  const runReviewerAction = async (
    reviewerId: string,
    kind: "restart" | "unstick",
    command: MultiReviewCommands["restartReviewer"] | MultiReviewCommands["unstickReviewer"],
  ) => {
    if (!workflow || !command || reviewerAction !== null || stoppingReviewerId !== null || pending)
      return;
    setReviewerAction({ reviewerId, kind });
    setError(null);
    try {
      replaceWorkflow(await command(workflow.id, reviewerId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setReviewerAction(null);
    }
  };

  // The backend commits the handoff intent and owns provider adoption, dispatch,
  // and retries. Presentation waits for the authoritative delivery acknowledgement
  // so the provider session is live and the address turn is ordered first.
  const addressAll = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    setPresentationNotice(null);
    try {
      // The workflow id is enough to record the intent. Eligibility, provider
      // adoption and prompt dispatch all belong to the backend; a stale local
      // snapshot or an unavailable tab presenter must never suppress the click.
      const handedOff = await commands.address(data.workflowId);
      replaceWorkflow(handedOff);
      if (mountedRef.current && isActiveRef.current) setOpenAfterDelivery(true);
    } catch (reason) {
      if (mountedRef.current) {
        setOpenAfterDelivery(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  const openInteractiveFixSession = async () => {
    if (pending || !workflow) return;
    setPending(true);
    setError(null);
    setPresentationNotice(null);
    try {
      // Opening is presentation-only. A pending dispatch is owned and retried
      // by the backend supervisor even when no review component is mounted.
      presentFixSession(workflow, "manual");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  };

  const startCustomFix = async (selection: MultiReviewWorkflow["fixModel"], prompt: string) => {
    if (customFixPending) return;
    if (!workflow?.consolidatedReport) {
      setCustomFixError("The consolidated review report is no longer available.");
      return;
    }
    setCustomFixPending(true);
    setCustomFixError(null);
    try {
      const customFix = commands.customFix ?? defaultCommands.customFix!;
      replaceWorkflow(await customFix(workflow.id, selection, prompt));
      if (mountedRef.current) {
        setCustomFixError(null);
        setCustomFixPromptOpen(false);
        if (isActiveRef.current) setOpenAfterDelivery(true);
      }
    } catch (reason) {
      if (mountedRef.current) {
        setCustomFixError(reason instanceof Error ? reason.message : String(reason));
      }
    } finally {
      if (mountedRef.current) setCustomFixPending(false);
    }
  };

  if (!workflow) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          {error ? (
            <AlertCircle className="mx-auto mb-3 size-6 text-destructive" />
          ) : (
            <Loader2 className="mx-auto mb-3 size-6 animate-spin text-primary" />
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
    workflow.phase === "preparing" ||
    workflow.phase === "reviewing" ||
    workflow.phase === "consolidating" ||
    workflow.phase === "fixing" ||
    workflow.phase === "cancelling";
  const reviewSessionStalled =
    (workflow.phase === "preparing" || workflow.phase === "consolidating") &&
    (workflow.reviewSession ?? (workflow.reviewModel ? undefined : workflow.fixSession))
      ?.stalledSince !== undefined;
  const fixSessionStalled =
    workflow.phase === "fixing" && workflow.fixSession?.stalledSince !== undefined;
  const packageStatus = reviewPackageGenerationStep(workflow);
  const consolidationStatus = consolidationStep(workflow);
  const fixStatus = fixStep(workflow);
  const stepRuntime = (step: MultiReviewStepKey, status: MultiReviewStepStatus): string | null =>
    multiReviewStepRuntimeSummary(workflow, step, status.state === "running", reviewPanelNow);
  const reviewSelection = workflow.reviewModel ?? workflow.fixModel;
  const hasReviewSession = Boolean(
    (workflow.reviewSession ?? (workflow.reviewModel ? undefined : workflow.fixSession))
      ?.providerSessionId,
  );
  const hasFixSession = Boolean(workflow.fixSession?.providerSessionId);
  const canOpenReviewStep = (status: MultiReviewStepStatus): boolean =>
    status.state !== "not-started" && hasReviewSession && Boolean(createTab);
  const canOpenFixStep = (status: MultiReviewStepStatus): boolean =>
    status.state !== "not-started" && hasFixSession && Boolean(createTab);
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
              className={`truncate text-xs ${reviewSessionStalled || fixSessionStalled ? "text-amber-500" : "text-muted-foreground"}`}
            >
              {reviewSessionStalled
                ? "No activity from the review preparation model"
                : fixSessionStalled
                  ? "No activity from the fix model"
                  : phaseCopy(workflow.phase)}
            </p>
            {workflow.activeRequest?.resultSubmission && (
              <WorkflowResultStatus
                state={workflow.activeRequest.resultSubmission}
                kind={
                  workflow.activeRequest.kind === "prepare"
                    ? "validation-plan"
                    : workflow.activeRequest.kind === "consolidate"
                      ? "consolidated-review"
                      : "fix-result"
                }
                className="mt-0.5"
              />
            )}
          </div>
        </div>
        {busy && <Loader2 className="size-4 shrink-0 animate-spin text-primary" />}
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6">
          {(reviewSessionStalled || fixSessionStalled) && (
            <section
              role="status"
              aria-live="polite"
              className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/8 p-4"
            >
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-amber-500/12 text-amber-500">
                <AlertTriangle className="size-4" />
              </span>
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-amber-500">
                  {reviewSessionStalled
                    ? "Review preparation model appears stalled"
                    : "Fix model appears stalled"}
                </h2>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  No new activity has arrived. Cancel now, or wait for the workflow to stop
                  automatically and then retry.
                </p>
              </div>
            </section>
          )}
          <MultiReviewStepSection
            heading="Review package generation"
            name="Preparation"
            status={packageStatus}
            stalled={workflow.phase === "preparing" && reviewSessionStalled}
            model={reviewSelection}
            runtime={stepRuntime("package", packageStatus)}
            runtimeLabel="Review package generation runtime"
            openLabel="Open review package generation session"
            openTitle={stepOpenTitle(
              packageStatus,
              hasReviewSession,
              "review package generation",
              "Review package generation has not started yet",
            )}
            canOpen={canOpenReviewStep(packageStatus)}
            onOpen={() => presentReviewSession(workflow)}
          />
          {workflow.validationRun && (
            <ReviewValidationStatus run={workflow.validationRun} now={reviewPanelNow} />
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
                const runtimeSummary = reviewerRuntimeSummary(reviewer, reviewPanelNow);
                const stoppable =
                  workflow.phase === "reviewing" &&
                  (reviewer.status === "pending" || reviewer.status === "running");
                const canRestart =
                  (workflow.phase === "reviewing" ||
                    workflow.phase === "consolidating" ||
                    workflow.phase === "ready" ||
                    workflow.phase === "failed") &&
                  workflow.activeRequest?.kind !== "prepare" &&
                  !(workflow.reviewSnapshotStale === true && workflow.reviewPackage) &&
                  workflow.fixResult === undefined &&
                  !(workflow.phase === "failed" && workflow.consolidatedReport !== undefined);
                const canUnstick =
                  workflow.phase === "reviewing" &&
                  reviewer.status === "running" &&
                  Boolean(reviewer.providerSessionId) &&
                  reviewer.dispatchState === "sent";
                const actionPending = reviewerAction?.reviewerId === reviewer.id;
                const reviewerActionsBlocked =
                  reviewerAction !== null || stoppingReviewerId !== null || pending;
                return (
                  <ContextMenu key={reviewer.id}>
                    <ContextMenuTrigger asChild>
                      <div className="flex items-center rounded-lg border border-border/45 bg-background/40 transition-colors has-[button:enabled:hover]:border-cyan-400/35">
                        <button
                          type="button"
                          disabled={!reviewer.providerSessionId || (!openReviewer && !createTab)}
                          aria-label={reviewerTranscriptLabel(reviewer, index)}
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
                            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
                          ) : (
                            <Circle className="size-4 shrink-0 text-muted-foreground" />
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium">
                              Reviewer {index + 1} · {reviewer.agent}
                            </p>
                            <p className="truncate text-[11px] text-muted-foreground">
                              {reviewer.model}
                              {reviewer.reasoningEffort ? ` · ${reviewer.reasoningEffort}` : ""}
                            </p>
                            {runtimeSummary ? (
                              <p
                                className="mt-0.5 truncate font-mono text-[10px] tabular-nums text-muted-foreground"
                                aria-label={`Reviewer ${index + 1} runtime and token usage`}
                              >
                                {runtimeSummary}
                              </p>
                            ) : null}
                            <WorkflowResultStatus
                              state={reviewer.resultSubmission}
                              kind="review-report"
                              className="mt-0.5 text-[11px]"
                            />
                            {/* The workflow error generalizes a shared cause; this is
                            the only place the reviewer's own outcome is legible. */}
                            {note ? (
                              <p
                                className={`max-h-16 overflow-x-hidden overflow-y-auto overscroll-contain break-words whitespace-normal pr-1 text-[11px] [overflow-wrap:anywhere] ${NOTE_TONE_CLASS[note.tone]}`}
                                data-testid={`multi-reviewer-note-${reviewer.id}`}
                                title={note.text}
                              >
                                {note.text}
                              </p>
                            ) : null}
                          </div>
                          {reviewer.report ? (
                            <div
                              className="ml-auto flex shrink-0 flex-col items-end gap-1 pl-2"
                              aria-hidden="true"
                            >
                              <span
                                className="flex items-center gap-1 text-amber-400"
                                title={findingCountLabel(reviewer.report.issues.length, "issue")}
                              >
                                <CircleAlert className="size-3.5" aria-hidden="true" />
                                <span className="font-mono text-xs tabular-nums">
                                  {reviewer.report.issues.length}
                                </span>
                              </span>
                              <span
                                className="flex items-center gap-1 text-orange-400"
                                title={findingCountLabel(
                                  reviewer.report.testCoverageGaps.length,
                                  "coverage gap",
                                )}
                              >
                                <FileWarning className="size-3.5" aria-hidden="true" />
                                <span className="font-mono text-xs tabular-nums">
                                  {reviewer.report.testCoverageGaps.length}
                                </span>
                              </span>
                            </div>
                          ) : null}
                        </button>
                        {stoppable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="mr-1.5 size-7 shrink-0 text-muted-foreground hover:text-destructive"
                            aria-label={`Stop Reviewer ${index + 1}`}
                            title="Stop this reviewer; the review continues without it"
                            disabled={reviewerActionsBlocked}
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
                    </ContextMenuTrigger>
                    <ContextMenuContent className="w-44">
                      <ContextMenuItem
                        disabled={
                          !canRestart || reviewerActionsBlocked || !commands.restartReviewer
                        }
                        onSelect={() =>
                          void runReviewerAction(reviewer.id, "restart", commands.restartReviewer)
                        }
                      >
                        {actionPending && reviewerAction.kind === "restart" ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <RotateCcw />
                        )}
                        Restart
                      </ContextMenuItem>
                      <ContextMenuItem
                        disabled={
                          !canUnstick || reviewerActionsBlocked || !commands.unstickReviewer
                        }
                        onSelect={() =>
                          void runReviewerAction(reviewer.id, "unstick", commands.unstickReviewer)
                        }
                      >
                        {actionPending && reviewerAction.kind === "unstick" ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Play />
                        )}
                        Unstick
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </div>
          </section>

          <MultiReviewStepSection
            heading="Consolidation"
            name="Consolidation"
            status={consolidationStatus}
            stalled={workflow.phase === "consolidating" && reviewSessionStalled}
            model={reviewSelection}
            runtime={stepRuntime("consolidation", consolidationStatus)}
            runtimeLabel="Consolidation runtime"
            openLabel="Open consolidation session"
            openTitle={stepOpenTitle(
              consolidationStatus,
              hasReviewSession,
              "consolidation",
              "Consolidation starts after the independent reviews finish",
            )}
            canOpen={canOpenReviewStep(consolidationStatus)}
            onOpen={() => presentReviewSession(workflow)}
          />

          <MultiReviewStepSection
            heading="Fix"
            name="Fix"
            status={fixStatus}
            stalled={workflow.phase === "fixing" && fixSessionStalled}
            model={workflow.fixModel}
            runtime={stepRuntime("fix", fixStatus)}
            runtimeLabel="Fix runtime"
            openLabel="Open fix model session"
            openTitle={stepOpenTitle(
              fixStatus,
              hasFixSession,
              "fix",
              "The fix session starts once the consolidated findings are sent to the fix model",
            )}
            canOpen={canOpenFixStep(fixStatus)}
            onOpen={() => presentFixSession(workflow, "manual")}
          />

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

          {workflow.reviewSnapshotStale === true && !workflow.reviewPackage && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-500">
              The repository worktree changed after this Multi Review started. The review continued,
              so reviewer reports may reflect different worktree states.
            </div>
          )}

          {(error || workflow.error) && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {error ?? workflow.error}
            </div>
          )}

          {(presentationNotice || workflow.presentationError) && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-500">
              {presentationNotice ?? workflow.presentationError}
            </div>
          )}

          {workflow.phase === "interactive" &&
            workflow.addressPromptPending !== true &&
            workflow.fixSession?.providerSessionId &&
            !presentationNotice &&
            !workflow.presentationError && (
              <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground">
                The fix request was delivered. The fix session is ready to open.
              </div>
            )}

          {workflow.addressPromptPending === true && !workflow.error && (
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground">
              The fix request was recorded and is being delivered in the background.
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
          <>
            <Button disabled={pending} onClick={() => void addressAll()}>
              <Wrench className="mr-2 size-4" />
              Fix
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                setCustomFixError(null);
                setCustomFixPromptOpen(true);
              }}
              aria-label="Custom fix prompt"
              title="Custom fix prompt"
            >
              ...
            </Button>
          </>
        )}
      </footer>
      <MultiReviewFixPromptDialog
        open={customFixPromptOpen}
        onOpenChange={(open) => {
          setCustomFixPromptOpen(open);
          if (!open) setCustomFixError(null);
        }}
        catalog={modelCatalog}
        defaultSelection={workflow.fixModel}
        error={customFixError}
        busy={customFixPending}
        onSubmit={startCustomFix}
      />
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
