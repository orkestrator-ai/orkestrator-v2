import { ReviewValidationStatus } from "./ReviewValidationStatus";
import { WorkflowResultStatus } from "./WorkflowResultStatus";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  AlertTriangle,
  ExternalLink,
  Loader2,
  Pause,
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
import { ContextMenuItem } from "@/components/ui/context-menu";
import { StructuredReviewReportView } from "./StructuredReviewReportView";
import { StackedEyes } from "./MultiReviewLaunchDialog";
import { useMultiReviewStore } from "@/stores/multiReviewStore";
import { hydrateMultiReviewWorkflow } from "@/lib/multi-review-persistence";
import { useOptionalTerminalContext, type CreateTabOptions } from "@/contexts/TerminalContext";
import { MultiReviewReviewerTab } from "./MultiReviewReviewerTab";
import * as backend from "@/lib/backend";
import { MultiReviewFixPromptDialog } from "./MultiReviewFixPromptDialog";
import { MultiReviewRestartDialog } from "./MultiReviewRestartDialog";
import { useReviewModelCatalog } from "@/hooks/useBuildLaunchOptions";
import { formatElapsed, formatElapsedWithHours } from "@/lib/format-elapsed";
import { formatTokenCount } from "@/lib/context-usage";
import {
  formatRuntimeParts,
  runtimeParts,
  runtimeSummary,
  type RuntimeParts,
} from "@/lib/review/runtime-summary";
import {
  flowNodeElementId,
  MultiReviewFlowGraph,
  type MultiReviewFlowNodeModel,
} from "./MultiReviewFlowGraph";
import {
  MultiReviewFindingsPane,
  MultiReviewInspectorHeader,
  ReviewerTranscriptTail,
} from "./MultiReviewInspector";
import {
  defaultFlowSelection,
  flowPendingLabel,
  latestActivityAt,
  mergeReviewerFindings,
  multiReviewElapsedSeconds,
  multiReviewFlowEdges,
  multiReviewTotalTokens,
  reviewerFlowState,
  severityCounts,
  type MultiReviewFlowState,
} from "./multi-review-flow";

interface MultiReviewCommands {
  address: (workflowId: string) => Promise<MultiReviewWorkflow>;
  customFix?: (
    workflowId: string,
    fixModel: MultiReviewWorkflow["fixModel"],
    instruction: string,
  ) => Promise<MultiReviewWorkflow>;
  retry: (workflowId: string) => Promise<MultiReviewWorkflow>;
  cancel: (workflowId: string) => Promise<MultiReviewWorkflow>;
  stopValidation?: (workflowId: string) => Promise<MultiReviewWorkflow>;
  stopReviewer: (workflowId: string, reviewerId: string) => Promise<MultiReviewWorkflow>;
  restartReviewer?: (workflowId: string, reviewerId: string) => Promise<MultiReviewWorkflow>;
  restartStep?: (
    workflowId: string,
    kind: MultiReviewStepKind,
    model?: MultiReviewWorkflow["fixModel"],
  ) => Promise<MultiReviewWorkflow>;
  pauseStep?: (workflowId: string, kind: MultiReviewStepKind) => Promise<MultiReviewWorkflow>;
  resumeStep?: (workflowId: string, kind: MultiReviewStepKind) => Promise<MultiReviewWorkflow>;
  unstickReviewer?: (workflowId: string, reviewerId: string) => Promise<MultiReviewWorkflow>;
}

const defaultCommands: MultiReviewCommands = {
  address: backend.addressMultiReview,
  customFix: (workflowId, fixModel, instruction) =>
    backend.startMultiReviewCustomFix({ workflowId, fixModel, instruction }),
  retry: backend.retryMultiReview,
  cancel: backend.cancelMultiReview,
  stopValidation: backend.stopMultiReviewValidation,
  stopReviewer: backend.stopMultiReviewReviewer,
  restartReviewer: backend.restartMultiReviewReviewer,
  restartStep: backend.restartMultiReviewStep,
  pauseStep: backend.pauseMultiReviewStep,
  resumeStep: backend.resumeMultiReviewStep,
  unstickReviewer: backend.unstickMultiReviewReviewer,
};

interface MultiReviewTabProps {
  data: MultiReviewTabData;
  isActive: boolean;
  hydrateWorkflow?: typeof hydrateMultiReviewWorkflow;
  commands?: MultiReviewCommands;
  openReviewer?: (reviewerId: string, index: number) => void;
  /** Reads the selected reviewer's transcript tail for the inspector. */
  loadReviewerTranscript?: typeof backend.getMultiReviewReviewerTranscript;
}

function phaseCopy(workflow: MultiReviewWorkflow): string {
  const labels = {
    preparing: "Discovering validation, running checks, and preparing shared evidence",
    reviewing: "Independent read-only reviews are running",
    consolidating: "The review preparation model is consolidating findings",
    ready: "Consolidated report ready",
    fixing: "The fix model is addressing every finding",
    interactive: "The fix model is working interactively",
    paused: "Multi Review paused",
    completed: "All findings were addressed",
    cancelling: "Cancelling Multi Review",
    cancelled: "Multi Review cancelled",
    failed: "Multi Review needs attention",
  } as const;
  if (
    workflow.phase === "interactive" &&
    workflow.addressPromptPending !== true &&
    workflow.fixSession?.status === "idle" &&
    workflow.stepRuntimes?.fix?.completedAt !== undefined
  ) {
    return "The fix session finished and is ready for follow-up";
  }
  if (
    workflow.phase === "interactive" &&
    workflow.addressPromptPending !== true &&
    workflow.fixSession?.status === "failed"
  ) {
    return workflow.fixSession.error ?? "The fix session stopped with an error";
  }
  return labels[workflow.phase];
}

/** Phases in which the backend is doing work rather than waiting for the user. */
function isBusyPhase(phase: MultiReviewPhase): boolean {
  return (
    phase === "preparing" ||
    phase === "reviewing" ||
    phase === "consolidating" ||
    phase === "fixing" ||
    phase === "cancelling"
  );
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

/**
 * The preparation/consolidation session, which records its own provider.
 * Consolidation moves to a session of its own, so the preparation step reads
 * the session the backend kept for it once that has happened.
 */
export function multiReviewReviewSession(
  workflow: MultiReviewWorkflow,
  step: "prepare" | "consolidate" = "consolidate",
): MultiReviewWorkflow["reviewSession"] {
  return (
    (step === "prepare" ? workflow.preparationSession : undefined) ??
    workflow.reviewSession ??
    (workflow.reviewModel || workflow.consolidationModel ? undefined : workflow.fixSession)
  );
}

/** Opens a preparation or consolidation conversation, never the Fix tab. */
export function multiReviewReviewSessionTabOptions(
  workflow: MultiReviewWorkflow,
  step: "prepare" | "consolidate" = "consolidate",
): CreateTabOptions | null {
  const session = multiReviewReviewSession(workflow, step);
  if (!session?.providerSessionId) return null;
  return {
    // A restarted step (possibly on another provider) gets a new provider
    // session, so the tab identity follows it instead of refocusing a tab that
    // is still attached to the abandoned session.
    tabId: `multi-review-review:${workflow.id}:${session.providerSessionId}`,
    activateExistingTab: true,
    agentLaunchMode: "native",
    resumeSessionId: session.providerSessionId,
    displayTitle: MULTI_REVIEW_REVIEW_TAB_TITLE,
    isReviewTab: true,
    hideStructuredOutput: true,
    initialAgentModel: session.model === "default" ? undefined : session.model,
    initialReasoningEffort: session.reasoningEffort,
    initialConversationMode: "plan",
    ...(session.status === "running" ? { requireExistingResumeSession: true } : {}),
  };
}

/**
 * The supervisor drives preparation and consolidation in one coordinator
 * session, then performs fixing in a separate session. Each node needs both a
 * label and the state that decides its look and whether its session can open.
 * Steps share the graph's state vocabulary, so a step and a reviewer in the
 * same state look the same.
 */
export type MultiReviewStepState = MultiReviewFlowState;

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
  if (workflow.phase === "paused" && workflow.pausedStep === "prepare") {
    return step("Paused", "paused");
  }
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
  if (workflow.phase === "paused" && workflow.pausedStep === "consolidate") {
    return step("Paused", "paused");
  }
  if (workflow.phase === "paused" && workflow.pausedStep === "prepare") {
    return step("Waiting for review package", "not-started");
  }
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
  if (workflow.phase === "paused" && workflow.pausedStep === "fix") {
    return step("Paused", "paused");
  }
  if (workflow.phase === "paused" && workflow.pausedStep === "prepare") {
    return step("Waiting for review package", "not-started");
  }
  if (workflow.phase === "paused" && workflow.pausedStep === "consolidate") {
    return step("Waiting for consolidation", "not-started");
  }
  if (workflow.phase === "interactive") {
    if (workflow.addressPromptPending === true) return step("Starting fix session", "running");
    if (
      workflow.fixSession?.status === "idle" &&
      workflow.stepRuntimes?.fix?.completedAt !== undefined
    )
      return step("Complete", "complete");
    if (workflow.fixSession?.status === "failed") return step("Failed", "failed");
    if (workflow.fixSession?.status === "cancelled") return step("Cancelled", "cancelled");
    return step("Interactive fix session", "running");
  }
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
    case "paused":
      return workflow.pausedStep === "prepare"
        ? "package"
        : workflow.pausedStep === "consolidate"
          ? "consolidation"
          : workflow.pausedStep === "fix"
            ? "fix"
            : null;
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

/** Status copy for the backend-owned PR launch that follows a successful Fix. */
export function autoPrLaunchNotice(launch: NonNullable<MultiReviewWorkflow["autoPrLaunch"]>): {
  text: string;
  tone: "muted" | "success" | "warning";
} {
  if (launch.state === "launched") {
    return {
      text: "The fix completed, so a PR tab was launched to commit, push, and open the pull request.",
      tone: "success",
    };
  }
  if (launch.state === "skipped") {
    return { text: launch.message ?? "The automatic pull request was skipped.", tone: "muted" };
  }
  if (launch.state === "failed") {
    return {
      text: `The pull request could not be started automatically${launch.message ? `: ${launch.message}` : "."} Use the PR button to create it.`,
      tone: "warning",
    };
  }
  return {
    text: "The fix completed. The pull request agent is being launched in the background.",
    tone: "muted",
  };
}

const AUTO_PR_NOTICE_TONE_CLASS = {
  muted: "border-border/60 bg-muted/30 text-muted-foreground",
  success: "border-emerald-500/25 bg-emerald-500/5 text-foreground/85",
  warning: "border-amber-500/30 bg-amber-500/8 text-amber-500",
} as const;

function AutoPrLaunchNotice({
  launch,
}: {
  launch: NonNullable<MultiReviewWorkflow["autoPrLaunch"]>;
}) {
  const notice = autoPrLaunchNotice(launch);
  return (
    <div
      data-testid="multi-review-auto-pr-notice"
      className={`rounded-lg border p-3 text-sm ${AUTO_PR_NOTICE_TONE_CLASS[notice.tone]}`}
    >
      {notice.text}
    </div>
  );
}

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
export function multiReviewStepRuntimeParts(
  workflow: MultiReviewWorkflow,
  step: MultiReviewStepKey,
  running: boolean,
  now = Date.now(),
): RuntimeParts | null {
  if (workflow.stepRuntimes) {
    // A step this workflow has records for but no record of has not run yet,
    // and must not borrow the shared session's clock from the step that has.
    const runtime = workflow.stepRuntimes[STEP_REQUEST_KIND[step]];
    return runtime ? runtimeParts(runtime, running, now) : null;
  }
  if (fixSessionRuntimeStep(workflow) !== step) return null;
  const session =
    step === "fix"
      ? workflow.fixSession
      : (workflow.reviewSession ??
        (workflow.reviewModel || workflow.consolidationModel ? undefined : workflow.fixSession));
  if (!session) return null;
  const elapsed = fixSessionRuntimeSummary(session, now);
  return elapsed
    ? { elapsed, tokens: null, tokensPending: false, live: session.status === "running" }
    : null;
}

export function multiReviewStepRuntimeSummary(
  workflow: MultiReviewWorkflow,
  step: MultiReviewStepKey,
  running: boolean,
  now = Date.now(),
): string | null {
  const parts = multiReviewStepRuntimeParts(workflow, step, running, now);
  return parts ? formatRuntimeParts(parts) : null;
}

/** Column heading for the reviewer panel: finished over the reviewers still counted. */
export function reviewerColumnLabel(reviewers: MultiReviewWorkflow["reviewers"]): string {
  const completed = reviewers.filter((reviewer) => reviewer.status === "completed").length;
  const stopped = reviewers.filter((reviewer) => reviewer.status === "cancelled").length;
  const activePanelSize = reviewers.length - stopped;
  const progress = activePanelSize === 0 ? `${completed}` : `${completed}/${activePanelSize}`;
  return stopped === 0 ? `Review · ${progress}` : `Review · ${progress} · ${stopped} stopped`;
}

/** The pill text for a reviewer, matching the step labels' register. */
export function reviewerStatusLabel(reviewer: MultiReviewWorkflow["reviewers"][number]): string {
  switch (reviewer.status) {
    case "pending":
      return "Queued";
    case "running":
      return reviewer.stalledSince ? "Stalled" : "Reviewing";
    case "completed":
      return "Complete";
    case "failed":
      return "Failed";
    default:
      return "Stopped";
  }
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

function modelDetail(model: MultiReviewWorkflow["fixModel"], withAgent: boolean): string {
  return [withAgent ? model.agent : null, model.model, model.reasoningEffort]
    .filter(Boolean)
    .join(" · ");
}

/** The second-row word for a step that is doing, or did, something notable. */
function stepStatusWord(
  status: MultiReviewStepStatus,
  stalled: boolean,
): MultiReviewFlowNodeModel["statusWord"] {
  if (stalled && status.state === "running") return { text: "stalled", tone: "warning" };
  switch (status.state) {
    case "running":
      return { text: status.label.toLowerCase(), tone: "running" };
    case "paused":
      return { text: "paused", tone: "warning" };
    case "failed":
      return { text: "failed", tone: "destructive" };
    case "cancelling":
    case "cancelled":
      return { text: status.label.toLowerCase(), tone: "muted" };
    default:
      return undefined;
  }
}

function reviewerStatusWord(
  reviewer: MultiReviewWorkflow["reviewers"][number],
): MultiReviewFlowNodeModel["statusWord"] {
  switch (reviewer.status) {
    case "running":
      if (reviewer.stalledSince) return { text: "stalled", tone: "warning" };
      if (reviewer.resultSubmission === "needs-attention") {
        return { text: "report needs attention", tone: "warning" };
      }
      if (reviewer.resultSubmission === "correcting") {
        return { text: "correcting report", tone: "running" };
      }
      if (reviewer.resultSubmission === "received") {
        return { text: "report received", tone: "running" };
      }
      return { text: "reviewing", tone: "running" };
    case "failed":
      return { text: "failed", tone: "destructive" };
    case "cancelled":
      return { text: "stopped", tone: "muted" };
    default:
      return undefined;
  }
}

function validationChips(
  run: MultiReviewWorkflow["validationRun"],
): MultiReviewFlowNodeModel["validation"] {
  if (!run?.results.length) return undefined;
  return run.results.map((result) => ({ id: result.id, label: result.id, status: result.status }));
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

type ReviewTileActivation = { kind: "pointer"; pointerId: number } | { kind: "keyboard" } | null;

/**
 * Keep the browser-only trusted-click exception independently testable: DOM
 * test environments cannot manufacture events whose `isTrusted` flag is true.
 */
export function allowsReviewTileActivation(
  requireDirectActivation: boolean,
  hasDirectActivation: boolean,
  clickDetail: number,
  isTrusted: boolean,
): boolean {
  return !requireDirectActivation || hasDirectActivation || (clickDetail === 0 && isTrusted);
}

const INSPECTOR_BUTTON_CLASS = "h-7 gap-1.5 px-2.5 text-xs";

/**
 * Open session for the selected node.
 *
 * Preparation and consolidation are backend-owned sessions: with
 * `requireDirectActivation` their tab opens only for a pointer or keyboard
 * input that began on this button, so a gesture that mounted the review (and
 * whose click lands here) cannot pull the session into the pane layout.
 */
function SessionOpenButton({
  label,
  title,
  enabled,
  onOpen,
  requireDirectActivation = false,
}: {
  label: string;
  title?: string;
  enabled: boolean;
  onOpen: () => void;
  requireDirectActivation?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const directActivationRef = useRef<ReviewTileActivation>(null);

  useEffect(() => {
    if (!requireDirectActivation) return;

    const clearFinishedPointerOutsideButton = (event: PointerEvent) => {
      const activation = directActivationRef.current;
      if (activation?.kind !== "pointer" || activation.pointerId !== event.pointerId) return;

      const target = event.target;
      if (!(target instanceof Node) || !buttonRef.current?.contains(target)) {
        directActivationRef.current = null;
      }
    };
    const clearCancelledPointer = (event: PointerEvent) => {
      const activation = directActivationRef.current;
      if (activation?.kind === "pointer" && activation.pointerId === event.pointerId) {
        directActivationRef.current = null;
      }
    };

    window.addEventListener("pointerup", clearFinishedPointerOutsideButton);
    window.addEventListener("pointercancel", clearCancelledPointer);
    return () => {
      window.removeEventListener("pointerup", clearFinishedPointerOutsideButton);
      window.removeEventListener("pointercancel", clearCancelledPointer);
    };
  }, [requireDirectActivation]);

  return (
    <Button
      ref={buttonRef}
      type="button"
      variant="outline"
      size="sm"
      className={INSPECTOR_BUTTON_CLASS}
      disabled={!enabled}
      aria-label={label}
      title={title}
      onPointerDown={(event) => {
        if (event.isPrimary === false || event.button !== 0) return;
        directActivationRef.current = { kind: "pointer", pointerId: event.pointerId };
      }}
      onPointerCancel={(event) => {
        const activation = directActivationRef.current;
        if (activation?.kind === "pointer" && activation.pointerId === event.pointerId) {
          directActivationRef.current = null;
        }
      }}
      onBlur={() => {
        if (directActivationRef.current?.kind === "keyboard") directActivationRef.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          directActivationRef.current = { kind: "keyboard" };
        }
      }}
      onClick={(event) => {
        const hasDirectActivation = directActivationRef.current !== null;
        directActivationRef.current = null;
        // A trusted detail-zero click is an assistive-technology activation.
        // Pointer and keyboard activation are armed above; synthetic and
        // carry-over clicks are deliberately ignored.
        if (
          !allowsReviewTileActivation(
            requireDirectActivation,
            hasDirectActivation,
            event.detail,
            event.nativeEvent.isTrusted,
          )
        ) {
          return;
        }
        onOpen();
      }}
    >
      <ExternalLink className="size-3.5" />
      Open session
    </Button>
  );
}

/** A node in the graph, plus what the inspector shows when it is selected. */
interface MultiReviewFlowNodeView {
  node: MultiReviewFlowNodeModel;
  actions: ReactNode;
  body: ReactNode;
  activityAt?: number;
}

function StepFacts({
  model,
  runtime,
  status,
}: {
  model: MultiReviewWorkflow["fixModel"];
  runtime: RuntimeParts | null;
  status: MultiReviewStepStatus;
}) {
  return (
    <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-xs">
      <dt className="text-muted-foreground">Model</dt>
      <dd className="truncate">{modelDetail(model, true)}</dd>
      <dt className="text-muted-foreground">Runtime</dt>
      <dd className="font-mono tabular-nums">
        {runtime
          ? formatRuntimeParts(runtime)
          : status.state === "not-started"
            ? "Not started yet"
            : "Not recorded"}
      </dd>
    </dl>
  );
}

function MultiReviewOverviewTab({
  data,
  isActive,
  hydrateWorkflow = hydrateMultiReviewWorkflow,
  commands = defaultCommands,
  openReviewer,
  loadReviewerTranscript,
}: MultiReviewTabProps) {
  const createTab = useOptionalTerminalContext()?.createTab;
  const workflow = useMultiReviewStore((state) => state.workflows.get(data.workflowId));
  const replaceWorkflow = useMultiReviewStore((state) => state.replaceWorkflow);
  const [error, setError] = useState<string | null>(null);
  const [presentationNotice, setPresentationNotice] = useState<string | null>(null);
  const [openAfterDelivery, setOpenAfterDelivery] = useState(false);
  const [pending, setPending] = useState(false);
  const [stoppingReviewerId, setStoppingReviewerId] = useState<string | null>(null);
  const [stoppingValidation, setStoppingValidation] = useState(false);
  const [reviewerAction, setReviewerAction] = useState<{
    reviewerId: string;
    kind: "restart" | "unstick";
  } | null>(null);
  const [restartingStep, setRestartingStep] = useState<MultiReviewStepKind | null>(null);
  const [stepLifecycleAction, setStepLifecycleAction] = useState<{
    kind: MultiReviewStepKind;
    action: "pause" | "resume";
  } | null>(null);
  const [restartDialogStep, setRestartDialogStep] = useState<MultiReviewStepKind | null>(null);
  const [restartDialogError, setRestartDialogError] = useState<string | null>(null);
  const [customFixPromptOpen, setCustomFixPromptOpen] = useState(false);
  const [customFixPending, setCustomFixPending] = useState(false);
  const [customFixError, setCustomFixError] = useState<string | null>(null);
  const modelCatalog = useReviewModelCatalog(
    workflow?.projectId ?? "",
    customFixPromptOpen || restartDialogStep !== null,
  );
  const [reviewPanelNow, setReviewPanelNow] = useState(() => Date.now());
  /** The node the user picked; null follows the running node. */
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const panelId = useId();
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
  // The header's workflow clock counts while any stage is at work.
  const hasLiveClock = Boolean(
    hasRunningReviewer ||
    hasRunningFixSession ||
    hasRunningValidation ||
    (workflow && isBusyPhase(workflow.phase)),
  );

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
    (target: MultiReviewWorkflow | undefined, step: "prepare" | "consolidate") => {
      setPresentationNotice(null);
      if (!target) {
        setError("The review preparation session is no longer available");
        return;
      }
      const session = multiReviewReviewSession(target, step);
      const options = multiReviewReviewSessionTabOptions(target, step);
      if (!session || !options) {
        setError("The review preparation session is no longer available");
        return;
      }
      if (!createTab) {
        setError("The environment is not ready to open the review preparation session.");
        return;
      }
      // Consolidation may run on its own provider (Restart in…), so open the
      // tab with the agent that owns the session rather than the prepare model.
      if (!createTab(session.agent, options)) {
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

  const stopValidation = async () => {
    if (stoppingValidation || pending || !workflow || !commands.stopValidation) return;
    setStoppingValidation(true);
    setError(null);
    try {
      replaceWorkflow(await commands.stopValidation(workflow.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStoppingValidation(false);
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

  const restartStep = async (
    kind: MultiReviewStepKind,
    model?: MultiReviewWorkflow["fixModel"],
  ) => {
    if (
      !workflow ||
      !commands.restartStep ||
      restartingStep !== null ||
      stepLifecycleAction !== null ||
      pending
    )
      return;
    setRestartingStep(kind);
    setError(null);
    setRestartDialogError(null);
    try {
      replaceWorkflow(
        await (model
          ? commands.restartStep(workflow.id, kind, model)
          : commands.restartStep(workflow.id, kind)),
      );
      if (model) setRestartDialogStep(null);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      setError(message);
      if (model) setRestartDialogError(message);
    } finally {
      setRestartingStep(null);
    }
  };

  const runStepLifecycle = async (
    kind: MultiReviewStepKind,
    action: "pause" | "resume",
    command: MultiReviewCommands["pauseStep"] | MultiReviewCommands["resumeStep"],
  ) => {
    if (!workflow || !command || stepLifecycleAction !== null || restartingStep !== null || pending)
      return;
    setStepLifecycleAction({ kind, action });
    setError(null);
    try {
      replaceWorkflow(await command(workflow.id, kind));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setStepLifecycleAction(null);
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

  const busy = isBusyPhase(workflow.phase);
  const reviewSessionStalled =
    (workflow.phase === "preparing" || workflow.phase === "consolidating") &&
    (
      workflow.reviewSession ??
      (workflow.reviewModel || workflow.consolidationModel ? undefined : workflow.fixSession)
    )?.stalledSince !== undefined;
  const fixSessionStalled =
    workflow.phase === "fixing" && workflow.fixSession?.stalledSince !== undefined;
  const packageStatus = reviewPackageGenerationStep(workflow);
  const consolidationStatus = consolidationStep(workflow);
  const fixStatus = fixStep(workflow);
  const reviewSelection = workflow.reviewModel ?? workflow.fixModel;
  const consolidationSelection = workflow.consolidationModel ?? reviewSelection;
  const hasReviewSession = Boolean(multiReviewReviewSession(workflow)?.providerSessionId);
  const hasPreparationSession = Boolean(
    multiReviewReviewSession(workflow, "prepare")?.providerSessionId,
  );
  const hasFixSession = Boolean(workflow.fixSession?.providerSessionId);
  const canCancel =
    workflow.phase !== "completed" &&
    workflow.phase !== "cancelled" &&
    workflow.phase !== "cancelling" &&
    workflow.phase !== "interactive";
  const lifecyclePending = stepLifecycleAction !== null;

  const stepView = ({
    key,
    kind,
    title,
    status,
    stalled,
    model,
    runtimeLabel,
    openLabel,
    openTitle,
    canOpen,
    onOpen,
    requireDirectActivation = false,
    canPause,
    canResume,
    showPauseAction = true,
    activityAt,
    details,
  }: {
    key: MultiReviewStepKey;
    kind: MultiReviewStepKind;
    title: string;
    status: MultiReviewStepStatus;
    stalled: boolean;
    model: MultiReviewWorkflow["fixModel"];
    runtimeLabel: string;
    openLabel: string;
    openTitle: string;
    canOpen: boolean;
    onOpen: () => void;
    requireDirectActivation?: boolean;
    canPause: boolean;
    canResume: boolean;
    showPauseAction?: boolean;
    activityAt?: number;
    details?: ReactNode;
  }): MultiReviewFlowNodeView => {
    const runtime = multiReviewStepRuntimeParts(
      workflow,
      key,
      status.state === "running",
      reviewPanelNow,
    );
    const canRestart = status.state !== "not-started" && Boolean(commands.restartStep);
    const restarting = restartingStep === kind;
    const restart = () => void restartStep(kind);
    const restartIn = () => {
      setRestartDialogError(null);
      setRestartDialogStep(kind);
    };
    const pause = () => void runStepLifecycle(kind, "pause", commands.pauseStep);
    const resume = () => void runStepLifecycle(kind, "resume", commands.resumeStep);
    return {
      node: {
        id: key,
        kind: key,
        title,
        state: status.state,
        stalled,
        statusLabel: status.label,
        detail: modelDetail(model, true),
        runtime,
        runtimeLabel,
        pendingLabel:
          status.state === "not-started" ? flowPendingLabel("step", status.label) : undefined,
        statusWord: stepStatusWord(status, stalled),
        validation: key === "package" ? validationChips(workflow.validationRun) : undefined,
        canOpen,
        onOpen,
        contextMenu: (
          <>
            <ContextMenuItem
              disabled={!canRestart || restarting || lifecyclePending}
              onSelect={restart}
            >
              {restarting ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              Restart
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canRestart || restarting || lifecyclePending}
              onSelect={restartIn}
            >
              <RotateCcw />
              Restart in…
            </ContextMenuItem>
            {canResume ? (
              <ContextMenuItem disabled={lifecyclePending || restarting} onSelect={resume}>
                {lifecyclePending ? <Loader2 className="animate-spin" /> : <Play />}
                Resume
              </ContextMenuItem>
            ) : showPauseAction ? (
              <ContextMenuItem
                disabled={!canPause || lifecyclePending || restarting}
                onSelect={pause}
              >
                {lifecyclePending ? <Loader2 className="animate-spin" /> : <Pause />}
                Pause
              </ContextMenuItem>
            ) : null}
          </>
        ),
      },
      actions: (
        <>
          <SessionOpenButton
            label={openLabel}
            title={openTitle}
            enabled={canOpen}
            onOpen={onOpen}
            requireDirectActivation={requireDirectActivation}
          />
          {canRestart ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className={INSPECTOR_BUTTON_CLASS}
                disabled={restarting || lifecyclePending}
                onClick={restart}
              >
                {restarting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <RotateCcw className="size-3.5" />
                )}
                Restart
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={INSPECTOR_BUTTON_CLASS}
                disabled={restarting || lifecyclePending}
                onClick={restartIn}
              >
                Restart in…
              </Button>
            </>
          ) : null}
          {canResume ? (
            <Button
              variant="outline"
              size="sm"
              className={INSPECTOR_BUTTON_CLASS}
              disabled={lifecyclePending || restarting}
              onClick={resume}
            >
              <Play className="size-3.5" />
              Resume
            </Button>
          ) : showPauseAction && canPause ? (
            <Button
              variant="outline"
              size="sm"
              className={INSPECTOR_BUTTON_CLASS}
              disabled={lifecyclePending || restarting}
              onClick={pause}
            >
              <Pause className="size-3.5" />
              Pause
            </Button>
          ) : null}
        </>
      ),
      body: (
        <div className="space-y-4">
          <StepFacts model={model} runtime={runtime} status={status} />
          {details}
          <p className="text-xs text-muted-foreground">
            This step runs in a backend-owned session. Open session to read its transcript.
          </p>
        </div>
      ),
      activityAt,
    };
  };

  const packageView = stepView({
    key: "package",
    kind: "prepare",
    title: "Review package",
    status: packageStatus,
    stalled: workflow.phase === "preparing" && reviewSessionStalled,
    model: reviewSelection,
    runtimeLabel: "Review package generation runtime",
    openLabel: "Open review package generation session",
    openTitle: stepOpenTitle(
      packageStatus,
      hasPreparationSession,
      "review package generation",
      "Review package generation has not started yet",
    ),
    canOpen: packageStatus.state !== "not-started" && hasPreparationSession && Boolean(createTab),
    onOpen: () => presentReviewSession(workflow, "prepare"),
    requireDirectActivation: true,
    canPause: workflow.phase === "preparing" && Boolean(commands.pauseStep),
    canResume:
      workflow.phase === "paused" &&
      workflow.pausedStep === "prepare" &&
      Boolean(commands.resumeStep),
    activityAt: latestActivityAt(workflow.stepRuntimes?.prepare, workflow.validationRun),
    details: workflow.validationRun ? (
      <ReviewValidationStatus
        environmentId={data.environmentId}
        run={workflow.validationRun}
        now={reviewPanelNow}
        onStop={
          commands.stopValidation &&
          workflow.phase === "preparing" &&
          (workflow.validationRun.status === "planned" ||
            workflow.validationRun.status === "running")
            ? () => void stopValidation()
            : undefined
        }
        stopping={
          stoppingValidation ||
          (workflow.phase === "preparing" &&
            (workflow.validationRun.status === "planned" ||
              workflow.validationRun.status === "running") &&
            workflow.validationStopRequested === true)
        }
      />
    ) : null,
  });

  const consolidationView = stepView({
    key: "consolidation",
    kind: "consolidate",
    title: "Consolidation",
    status: consolidationStatus,
    stalled: workflow.phase === "consolidating" && reviewSessionStalled,
    model: consolidationSelection,
    runtimeLabel: "Consolidation runtime",
    openLabel: "Open consolidation session",
    openTitle: stepOpenTitle(
      consolidationStatus,
      hasReviewSession,
      "consolidation",
      "Consolidation starts after the independent reviews finish",
    ),
    canOpen: consolidationStatus.state !== "not-started" && hasReviewSession && Boolean(createTab),
    onOpen: () => presentReviewSession(workflow, "consolidate"),
    requireDirectActivation: true,
    canPause: workflow.phase === "consolidating" && Boolean(commands.pauseStep),
    canResume:
      workflow.phase === "paused" &&
      workflow.pausedStep === "consolidate" &&
      Boolean(commands.resumeStep),
    activityAt: latestActivityAt(workflow.stepRuntimes?.consolidate),
    details: workflow.consolidatedReport ? (
      <p className="text-xs text-foreground/85">
        {findingCountLabel(workflow.consolidatedReport.issues.length, "issue")} ·{" "}
        {findingCountLabel(workflow.consolidatedReport.testCoverageGaps.length, "coverage gap")}.
        The consolidated report is below.
      </p>
    ) : null,
  });

  const fixView = stepView({
    key: "fix",
    kind: "fix",
    title: "Fix",
    status: fixStatus,
    stalled: workflow.phase === "fixing" && fixSessionStalled,
    model: workflow.fixModel,
    runtimeLabel: "Fix runtime",
    openLabel: "Open fix model session",
    openTitle: stepOpenTitle(
      fixStatus,
      hasFixSession,
      "fix",
      "The fix session starts once the consolidated findings are sent to the fix model",
    ),
    canOpen: fixStatus.state !== "not-started" && hasFixSession && Boolean(createTab),
    onOpen: () => presentFixSession(workflow, "manual"),
    canPause: workflow.phase === "fixing" && Boolean(commands.pauseStep),
    canResume:
      workflow.phase === "paused" && workflow.pausedStep === "fix" && Boolean(commands.resumeStep),
    showPauseAction: false,
    activityAt: latestActivityAt(workflow.stepRuntimes?.fix),
    details: workflow.fixResult ? (
      <p className="text-xs text-foreground/85">{workflow.fixResult.summary}</p>
    ) : null,
  });

  const reviewerRestartable =
    (workflow.phase === "reviewing" ||
      workflow.phase === "consolidating" ||
      workflow.phase === "ready" ||
      workflow.phase === "fixing" ||
      workflow.phase === "interactive" ||
      workflow.phase === "completed" ||
      workflow.phase === "failed") &&
    workflow.activeRequest?.kind !== "prepare" &&
    !(workflow.reviewSnapshotStale === true && workflow.reviewPackage);
  const reviewerActionsBlocked = reviewerAction !== null || stoppingReviewerId !== null || pending;

  const reviewerViews = workflow.reviewers.map((reviewer, index): MultiReviewFlowNodeView => {
    const name = `Reviewer ${index + 1}`;
    const note = reviewerStatusNote(reviewer);
    const stalled = reviewer.status === "running" && Boolean(reviewer.stalledSince);
    const runtime = runtimeParts(reviewer, reviewer.status === "running", reviewPanelNow);
    const stoppable =
      workflow.phase === "reviewing" &&
      (reviewer.status === "pending" || reviewer.status === "running");
    const canUnstick =
      workflow.phase === "reviewing" &&
      reviewer.status === "running" &&
      Boolean(reviewer.providerSessionId) &&
      reviewer.dispatchState === "sent";
    const pendingAction = reviewerAction?.reviewerId === reviewer.id ? reviewerAction.kind : null;
    const canOpen = Boolean(reviewer.providerSessionId) && Boolean(openReviewer || createTab);
    const open = () => {
      if (openReviewer) {
        openReviewer(reviewer.id, index);
        return;
      }
      createTab?.("multi-review", {
        multiReviewId: workflow.id,
        multiReviewReviewerId: reviewer.id,
        displayTitle: name,
      });
    };
    const restart = () => void runReviewerAction(reviewer.id, "restart", commands.restartReviewer);
    const unstick = () => void runReviewerAction(reviewer.id, "unstick", commands.unstickReviewer);
    const stop = () => void stopReviewer(reviewer.id);
    const findings = reviewer.report
      ? `${findingCountLabel(reviewer.report.issues.length, "issue")}, ${findingCountLabel(reviewer.report.testCoverageGaps.length, "coverage gap")}`
      : undefined;
    return {
      node: {
        id: `reviewer:${reviewer.id}`,
        kind: "reviewer",
        title: `${name} · ${reviewer.agent}`,
        state: reviewerFlowState(reviewer.status),
        stalled,
        statusLabel: reviewerStatusLabel(reviewer),
        detail: modelDetail(reviewer, false),
        runtime,
        runtimeLabel: `${name} runtime and token usage`,
        pendingLabel:
          reviewer.status === "pending" ? flowPendingLabel("reviewer", "Queued") : undefined,
        statusWord: reviewerStatusWord(reviewer),
        // A failed or stopped reviewer can still have filed a partial report.
        severity: reviewer.report ? severityCounts(reviewer.report.issues) : undefined,
        findingsLabel: findings,
        canOpen,
        onOpen: open,
        contextMenu: (
          <>
            <ContextMenuItem
              disabled={!reviewerRestartable || reviewerActionsBlocked || !commands.restartReviewer}
              onSelect={restart}
            >
              {pendingAction === "restart" ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              Restart
            </ContextMenuItem>
            <ContextMenuItem
              disabled={!canUnstick || reviewerActionsBlocked || !commands.unstickReviewer}
              onSelect={unstick}
            >
              {pendingAction === "unstick" ? <Loader2 className="animate-spin" /> : <Play />}
              Unstick
            </ContextMenuItem>
            <ContextMenuItem disabled={!stoppable || reviewerActionsBlocked} onSelect={stop}>
              {stoppingReviewerId === reviewer.id ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Square />
              )}
              Stop
            </ContextMenuItem>
          </>
        ),
      },
      actions: (
        <>
          <SessionOpenButton
            label={reviewerTranscriptLabel(reviewer, index)}
            title={canOpen ? "Open this reviewer's read-only transcript in a new tab" : undefined}
            enabled={canOpen}
            onOpen={open}
          />
          {reviewerRestartable && commands.restartReviewer ? (
            <Button
              variant="outline"
              size="sm"
              className={INSPECTOR_BUTTON_CLASS}
              aria-label={`Restart ${name}`}
              title="Restart this reviewer from the beginning in a fresh session"
              disabled={reviewerActionsBlocked}
              onClick={restart}
            >
              {pendingAction === "restart" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw className="size-3.5" />
              )}
              Restart
            </Button>
          ) : null}
          {canUnstick && commands.unstickReviewer ? (
            <Button
              variant="outline"
              size="sm"
              className={INSPECTOR_BUTTON_CLASS}
              aria-label={`Unstick ${name}`}
              title='Stop the current turn, then send "Please continue"'
              disabled={reviewerActionsBlocked}
              onClick={unstick}
            >
              {pendingAction === "unstick" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
              Unstick
            </Button>
          ) : null}
          {stoppable ? (
            <Button
              variant="outline"
              size="sm"
              className={`${INSPECTOR_BUTTON_CLASS} hover:text-destructive`}
              aria-label={`Stop ${name}`}
              title="Stop this reviewer; the review continues without it"
              disabled={reviewerActionsBlocked}
              onClick={stop}
            >
              {stoppingReviewerId === reviewer.id ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Square className="size-3.5" />
              )}
              Stop
            </Button>
          ) : null}
        </>
      ),
      body: (
        <div className="space-y-3">
          <p className="truncate text-xs text-muted-foreground">
            {modelDetail(reviewer, true)} · Read only
            {runtime ? ` · ${formatRuntimeParts(runtime)}` : ""}
          </p>
          {reviewer.resultSubmission && reviewer.resultSubmission !== "preparing" ? (
            <WorkflowResultStatus state={reviewer.resultSubmission} kind="review-report" />
          ) : null}
          {/* The workflow error generalizes a shared cause; this is the only
          place the reviewer's own outcome is legible. */}
          {note ? (
            <p
              className={`max-h-16 overflow-x-hidden overflow-y-auto overscroll-contain break-words whitespace-normal pr-1 text-xs [overflow-wrap:anywhere] ${NOTE_TONE_CLASS[note.tone]}`}
              data-testid={`multi-reviewer-note-${reviewer.id}`}
              title={note.text}
            >
              {note.text}
            </p>
          ) : null}
          <ReviewerTranscriptTail
            key={reviewer.id}
            workflowId={workflow.id}
            reviewerId={reviewer.id}
            hasSession={Boolean(reviewer.providerSessionId)}
            live={reviewer.status === "running" || reviewer.status === "pending"}
            isActive={isActive}
            loadTranscript={loadReviewerTranscript}
          />
          {findings ? <p className="text-xs text-muted-foreground">{findings}</p> : null}
        </div>
      ),
      activityAt: latestActivityAt(reviewer),
    };
  });

  const views = [packageView, ...reviewerViews, consolidationView, fixView];
  const stage = { package: 0, reviewer: 1, consolidation: 2, fix: 3 } as const;
  const defaultSelectionId = defaultFlowSelection(
    views.map((view) => ({
      id: view.node.id,
      state: view.node.state,
      stage: stage[view.node.kind],
      activityAt: view.activityAt,
    })),
  );
  // A reviewer that left the panel (or a stale pick) falls back to the default.
  const selected =
    views.find((view) => view.node.id === selectedNodeId) ??
    views.find((view) => view.node.id === defaultSelectionId) ??
    packageView;
  const edges = multiReviewFlowEdges({
    package: packageView.node.state,
    reviewers: reviewerViews.map((view) => view.node.state),
    consolidation: consolidationView.node.state,
    fix: fixView.node.state,
  });
  const { findings, reviewerCount } = mergeReviewerFindings(workflow.reviewers);
  const elapsedSeconds = multiReviewElapsedSeconds(
    workflow,
    busy || views.some((view) => view.node.state === "running"),
    reviewPanelNow,
  );
  const totalTokens = multiReviewTotalTokens(workflow);
  const headerStalled = reviewSessionStalled || fixSessionStalled;

  const notices: ReactNode[] = [];
  if (headerStalled) {
    notices.push(
      <section
        key="stalled"
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
            No new activity has arrived. Cancel now, or wait for the workflow to stop automatically
            and then retry.
          </p>
        </div>
      </section>,
    );
  }
  if (workflow.reviewSnapshotStale === true && !workflow.reviewPackage) {
    notices.push(
      <div
        key="snapshot-stale"
        className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-500"
      >
        The repository worktree changed after this Multi Review started. The review continued, so
        reviewer reports may reflect different worktree states.
      </div>,
    );
  }
  if (error || workflow.error) {
    notices.push(
      <div
        key="error"
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
      >
        {error ?? workflow.error}
      </div>,
    );
  }
  if (presentationNotice || workflow.presentationError) {
    notices.push(
      <div
        key="presentation"
        className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-sm text-amber-500"
      >
        {presentationNotice ?? workflow.presentationError}
      </div>,
    );
  }
  if (
    workflow.phase === "interactive" &&
    workflow.addressPromptPending !== true &&
    workflow.fixSession?.providerSessionId &&
    !presentationNotice &&
    !workflow.presentationError
  ) {
    notices.push(
      <div
        key="fix-ready"
        className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground"
      >
        The fix request was delivered. The fix session is ready to open.
      </div>,
    );
  }
  if (workflow.addressPromptPending === true && !workflow.error) {
    notices.push(
      <div
        key="address-pending"
        className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-muted-foreground"
      >
        The fix request was recorded and is being delivered in the background.
      </div>,
    );
  }
  if (workflow.autoPrLaunch) {
    notices.push(<AutoPrLaunchNotice key="auto-pr" launch={workflow.autoPrLaunch} />);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-divider px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-cyan-400/25 bg-cyan-500/10 text-cyan-300">
            <StackedEyes className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold">Multi Review</h1>
            <p
              className={`truncate text-xs ${headerStalled ? "text-amber-500" : "text-muted-foreground"}`}
            >
              <span>
                {reviewSessionStalled
                  ? "No activity from the review preparation model"
                  : fixSessionStalled
                    ? "No activity from the fix model"
                    : phaseCopy(workflow)}
              </span>
              {elapsedSeconds !== null ? (
                <span data-testid="multi-review-elapsed">
                  {" · "}
                  <span className="font-mono tabular-nums">
                    {formatElapsedWithHours(elapsedSeconds)}
                  </span>
                </span>
              ) : null}
              {totalTokens !== null ? (
                <span data-testid="multi-review-total-tokens">
                  {" · "}
                  <span className="font-mono tabular-nums">
                    {formatTokenCount(totalTokens)}
                  </span>{" "}
                  tokens
                </span>
              ) : null}
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

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="@container flex min-h-full flex-col">
          {notices.length > 0 ? (
            <div className="space-y-2 border-b border-divider px-4 py-3 sm:px-6">{notices}</div>
          ) : null}
          <MultiReviewFlowGraph
            packageNode={packageView.node}
            reviewerNodes={reviewerViews.map((view) => view.node)}
            consolidationNode={consolidationView.node}
            fixNode={fixView.node}
            edges={edges}
            reviewLabel={reviewerColumnLabel(workflow.reviewers)}
            reviewTitle={reviewerProgressSummary(workflow.reviewers)}
            selectedId={selected.node.id}
            onSelect={setSelectedNodeId}
            panelId={panelId}
          />
          <div className="grid min-h-80 flex-1 grid-cols-1 @min-[900px]:grid-cols-[1.3fr_1fr]">
            <section
              role="tabpanel"
              id={panelId}
              aria-labelledby={flowNodeElementId(panelId, selected.node.id)}
              data-testid="multi-review-inspector"
              className="min-w-0 px-4 py-4 sm:px-6"
            >
              <MultiReviewInspectorHeader node={selected.node} actions={selected.actions} />
              {selected.body}
            </section>
            <div className="min-w-0 border-t border-divider px-4 py-4 sm:px-6 @min-[900px]:border-t-0 @min-[900px]:border-l">
              <MultiReviewFindingsPane findings={findings} reviewerCount={reviewerCount} />
            </div>
          </div>
          {workflow.consolidatedReport || workflow.fixResult ? (
            <div className="space-y-4 border-t border-divider px-4 py-4 sm:px-6">
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
            </div>
          ) : null}
        </div>
      </div>

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
      {restartDialogStep ? (
        <MultiReviewRestartDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRestartDialogStep(null);
              setRestartDialogError(null);
            }
          }}
          kind={restartDialogStep}
          catalog={modelCatalog}
          defaultSelection={
            restartDialogStep === "fix"
              ? workflow.fixModel
              : restartDialogStep === "consolidate"
                ? consolidationSelection
                : reviewSelection
          }
          error={restartDialogError}
          busy={restartingStep === restartDialogStep}
          onSubmit={(selection) => void restartStep(restartDialogStep, selection)}
        />
      ) : null}
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
