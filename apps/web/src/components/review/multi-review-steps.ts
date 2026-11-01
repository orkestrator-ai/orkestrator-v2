/**
 * What the Multi Review tab shows for each pipeline step and reviewer: step
 * states, runtimes, labels and the tab options that open a step's session.
 * Everything here is a pure reading of the workflow snapshot, so it can be
 * tested phase by phase without rendering the tab.
 */

import type {
  MultiReviewPhase,
  MultiReviewStepKind,
  MultiReviewWorkflow,
} from "@orkestrator/protocol/multi-review";
import {
  MULTI_REVIEW_FIX_TAB_TITLE,
  MULTI_REVIEW_REVIEW_TAB_TITLE,
  multiReviewSharedSessionStep,
} from "@orkestrator/protocol/multi-review";
import type { NativeAgentTurnPhase } from "@orkestrator/protocol/native-agent";
import { AGENT_PLATFORM_LABELS, isAgentPlatform } from "@orkestrator/protocol/agent-platforms";
import { reviewerCouldNotStart } from "@orkestrator/protocol/review-fanout";
import type { CreateTabOptions } from "@/contexts/TerminalContext";
import type { PrState } from "@/types";
import { formatElapsed } from "@/lib/format-elapsed";
import {
  formatRuntimeParts,
  runtimeParts,
  runtimeSummary,
  type RuntimeParts,
} from "@/lib/review/runtime-summary";
import type { MultiReviewFlowNodeModel } from "./MultiReviewFlowGraph";
import type { MultiReviewFlowState } from "./multi-review-flow";

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
  // A graph-engine review keeps no request once its run ended (item 301): its
  // consolidation session says whether that step is the one that failed.
  if (
    workflow.phase === "failed" &&
    workflow.engine === "graph" &&
    workflow.reviewSession?.status === "failed"
  ) {
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
    workflow.addressPromptPending === true ||
    // A graph-engine Fix that started (item 301), whose run then ended.
    (workflow.engine === "graph" && workflow.stepRuntimes?.fix !== undefined) ||
    (workflow.engine === "graph" && workflow.fixSession?.status === "failed");
  if (workflow.phase === "failed" && dispatched) return step("Failed", "failed");
  if (workflow.phase === "ready") return step("Ready to start", "not-started");
  return step("Not started", "not-started");
}

export type MultiReviewStepKey = "package" | "consolidation" | "fix";

/**
 * Why a failed step failed, for its node. A step is only shown failed when the
 * workflow's failure belongs to it, so the workflow error is that step's; an
 * interactive Fix session that stopped records its own.
 */
export function multiReviewStepError(
  workflow: MultiReviewWorkflow,
  key: MultiReviewStepKey,
  status: MultiReviewStepStatus,
): string | undefined {
  if (status.state !== "failed") return undefined;
  if (key === "fix" && workflow.phase === "interactive") {
    return workflow.fixSession?.error ?? workflow.error;
  }
  return workflow.error;
}

const STEP_KEY: Record<MultiReviewStepKind, MultiReviewStepKey> = {
  prepare: "package",
  consolidate: "consolidation",
  fix: "fix",
};

/**
 * Which step owns the fix session's clock. The three steps share one provider
 * session and every dispatch resets `startedAt`, so a runtime shown against the
 * wrong card would be the next step's elapsed time under a settled step's name.
 */
export function fixSessionRuntimeStep(workflow: MultiReviewWorkflow): MultiReviewStepKey | null {
  const kind = multiReviewSharedSessionStep(workflow);
  return kind ? STEP_KEY[kind] : null;
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

export type FixSessionOpenOutcome =
  "opened" | "no-session" | "environment-unavailable" | "tab-rejected";

/** Status copy for the backend-owned PR launch that follows a successful Fix or a clean report. */
export function autoPrLaunchNotice(
  launch: NonNullable<MultiReviewWorkflow["autoPrLaunch"]>,
  /** A graph-engine review (item 301): a system step, not an agent tab, opens it. */
  graphEngine = false,
): {
  text: string;
  tone: "muted" | "success" | "warning";
} {
  const reason =
    launch.basis === "clean-review" ? "The review found nothing to fix" : "The fix completed";
  if (launch.state === "launched") {
    return {
      text: graphEngine
        ? `${reason}, so the graph run's pull request step pushed the branch and opened the pull request.`
        : `${reason}, so a PR tab was launched to commit, push, and open the pull request.`,
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
    text: graphEngine
      ? `${reason}. The graph run is writing the description and opening the pull request.`
      : `${reason}. The pull request agent is being launched in the background.`,
    tone: "muted",
  };
}

/** What the PR node shows: the automatic launch, its agent, and the environment's pull request. */
export interface PullRequestStepStatus {
  state: MultiReviewFlowState;
  label: string;
  pendingLabel?: string;
  statusWord?: MultiReviewFlowNodeModel["statusWord"];
  error?: string;
}

const ACTIVE_AGENT_PHASES: ReadonlySet<NativeAgentTurnPhase> = new Set<NativeAgentTurnPhase>([
  "running",
  "blocked",
  "cancelling",
  "recovering",
]);

/**
 * The PR stage. A pull request counts as this review's outcome once the PR
 * agent was launched for it or the step before it finished, so one that was
 * already open does not complete the pipeline before it has run.
 *
 * `agentPhase` is read from the backend while the overview is active. While
 * it works the node runs; once it settles without a pull request having been
 * detected the node says so rather than claiming one.
 */
export function pullRequestStep({
  autoPr,
  launch,
  prUrl,
  prState,
  agentPhase,
  upstreamComplete,
  graphEngine = false,
}: {
  autoPr: boolean;
  launch: MultiReviewWorkflow["autoPrLaunch"];
  prUrl: string | null;
  prState: PrState | null;
  agentPhase: NativeAgentTurnPhase | undefined;
  /** The Fix, or the clean report that stood in for it, finished. */
  upstreamComplete: boolean;
  /**
   * A graph-engine review (item 301): the graph run's `open-pull-request`
   * system step opens it, so `launched` means it exists and no agent runs.
   */
  graphEngine?: boolean;
}): PullRequestStepStatus {
  const launched = launch?.state === "launched";
  if (prUrl && (launched || upstreamComplete)) {
    const state = prState ?? "open";
    return {
      state: "complete",
      label: `Pull request ${state}`,
      statusWord: { text: state, tone: state === "closed" ? "warning" : "muted" },
    };
  }
  if (graphEngine && launched) {
    return { state: "complete", label: "Pull request opened by the graph run" };
  }
  if (graphEngine && launch?.state === "pending") {
    return {
      state: "running",
      label: "The graph run is writing the description and opening the pull request",
      statusWord: { text: "opening", tone: "running" },
    };
  }
  if (launched && agentPhase && ACTIVE_AGENT_PHASES.has(agentPhase)) {
    if (agentPhase === "blocked") {
      return {
        state: "running",
        label: "The PR agent is waiting for input",
        statusWord: { text: "needs input", tone: "warning" },
      };
    }
    return {
      state: "running",
      label: "The PR agent is committing, pushing, and opening the pull request",
      statusWord: { text: "working", tone: "running" },
    };
  }
  switch (launch?.state) {
    case "pending":
      return {
        state: "running",
        label: "The PR agent is being launched",
        statusWord: { text: "launching", tone: "running" },
      };
    case "launched":
      if (agentPhase === "error") {
        return {
          state: "failed",
          label: "The PR agent stopped with an error",
          error: "The PR agent stopped with an error. Open its session to see why.",
        };
      }
      if (agentPhase === "idle") {
        return {
          state: "complete",
          label: "The PR agent finished, but no pull request has been detected yet",
          statusWord: { text: "no PR yet", tone: "warning" },
        };
      }
      return {
        state: "paused",
        label: "The PR agent was launched; its current status is unavailable",
        statusWord: { text: "status unknown", tone: "warning" },
      };
    case "skipped":
      return {
        state: "not-started",
        label: launch.message ?? "The automatic pull request was skipped",
        pendingLabel: "skipped",
      };
    case "failed":
      return {
        state: "failed",
        label: "The pull request could not be started automatically",
        error: autoPrLaunchNotice(launch).text,
      };
    default:
      return autoPr
        ? {
            state: "not-started",
            label: "The PR agent starts once the Fix completes",
            pendingLabel: "waiting",
          }
        : {
            state: "not-started",
            label: "Automatic PR is off. Use the PR button to create one",
            pendingLabel: "manual",
          };
  }
}

/** `#123 · into main`, or just the target branch before a pull request exists. */
export function pullRequestDetail(prUrl: string | null, targetBranch: string): string {
  const number = prUrl?.match(/\/pull\/(\d+)/)?.[1];
  return number ? `#${number} · into ${targetBranch}` : `into ${targetBranch}`;
}

export function openFixSessionError(
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

/** A reviewer whose agent could not start, as a panel's notice names it. */
export interface ReviewerStartFailure {
  /** "Reviewer 3". */
  name: string;
  agent: string;
  error?: string;
}

/**
 * The panel-level notice for reviewers whose agent could not start, so a
 * smaller panel never passes for a whole one. Null when every reviewer started.
 */
export function reviewerStartFailureNotice(
  failures: readonly ReviewerStartFailure[],
  panelSize: number,
): { headline: string; reasons: string[] } | null {
  if (failures.length === 0) return null;
  const agentName = (agent: string) =>
    isAgentPlatform(agent) ? AGENT_PLATFORM_LABELS[agent] : agent;
  const [first] = failures;
  const headline =
    failures.length >= panelSize
      ? panelSize === 1
        ? `The reviewer (${agentName(first!.agent)}) could not start, so this review has no reviewer report.`
        : `No reviewer could start, so this review has no reviewer reports.`
      : failures.length === 1
        ? `${first!.name} (${agentName(first!.agent)}) could not start, so this review is missing its findings. The other reviewers carried on.`
        : `${failures.length} of ${panelSize} reviewers could not start, so this review is missing their findings. The other reviewers carried on.`;
  return {
    headline,
    reasons: failures.map(
      (failure) =>
        `${failure.name} · ${agentName(failure.agent)}: ${failure.error?.trim() || "no reason was recorded"}`,
    ),
  };
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

/**
 * A queued reviewer's place in the admission queue, as the scheduler numbered
 * it. Null for a backend that predates the queue fields, and outside a pass.
 */
export function reviewerQueuePlace(
  reviewer: MultiReviewWorkflow["reviewers"][number],
  reviewers: MultiReviewWorkflow["reviewers"],
): { position: number; of: number } | null {
  if (
    reviewer.status !== "pending" ||
    reviewer.admissionState !== "queued" ||
    reviewer.queuePosition === undefined
  ) {
    return null;
  }
  const queued = reviewers.filter(
    (entry) => entry.status === "pending" && entry.admissionState === "queued",
  ).length;
  return { position: reviewer.queuePosition, of: Math.max(queued, reviewer.queuePosition) };
}

/**
 * Where a pending reviewer's runtime would be: its place in the queue
 * ("queued · #3 of 7"), "starting" once its session is being set up, or a
 * bare "queued" when the backend did not say. Position only: there is no
 * measured duration to estimate a start time from.
 */
export function reviewerPendingLabel(
  reviewer: MultiReviewWorkflow["reviewers"][number],
  reviewers: MultiReviewWorkflow["reviewers"],
): string {
  if (reviewer.status === "pending" && reviewer.admissionState === "admitting") return "starting";
  const place = reviewerQueuePlace(reviewer, reviewers);
  return place ? `queued · #${place.position} of ${place.of}` : "queued";
}

/** The pill text for a reviewer, matching the step labels' register. */
export function reviewerStatusLabel(
  reviewer: MultiReviewWorkflow["reviewers"][number],
  reviewers: MultiReviewWorkflow["reviewers"] = [reviewer],
): string {
  switch (reviewer.status) {
    case "pending": {
      if (reviewer.admissionState === "admitting") return "Starting";
      const place = reviewerQueuePlace(reviewer, reviewers);
      return place ? `Queued · #${place.position} of ${place.of}` : "Queued";
    }
    case "running":
      return reviewer.stalledSince ? "Stalled" : "Reviewing";
    case "completed":
      return "Complete";
    case "failed":
      return reviewerCouldNotStart(reviewer) ? "Could not start" : "Failed";
    default:
      return "Stopped";
  }
}

/**
 * What a reviewer has reported through `report_finding`, for its inspector.
 * Null once its report is accepted, which replaces them.
 */
export function reviewerProvisionalSummary(
  reviewer: MultiReviewWorkflow["reviewers"][number],
): string | null {
  const count = reviewer.provisionalFindings?.length ?? 0;
  if (count === 0) return null;
  const findings = `${count} ${count === 1 ? "finding" : "findings"}`;
  if (reviewer.status === "running") {
    return `${findings} reported so far, provisional until the report is accepted`;
  }
  if (reviewer.status === "failed") return `${findings} reported before it failed, unconfirmed`;
  if (reviewer.status === "cancelled") {
    return `${findings} reported before it was stopped, unconfirmed`;
  }
  return null;
}

export function findingCountLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`} found`;
}

export function reviewerTranscriptLabel(
  reviewer: MultiReviewWorkflow["reviewers"][number],
  index: number,
): string {
  const action = `Open Reviewer ${index + 1} transcript`;
  if (!reviewer.report) return action;
  return `${action}, ${findingCountLabel(reviewer.report.issues.length, "issue")}, ${findingCountLabel(reviewer.report.testCoverageGaps.length, "coverage gap")}`;
}

export function modelDetail(model: MultiReviewWorkflow["fixModel"], withAgent: boolean): string {
  return [withAgent ? model.agent : null, model.model, model.reasoningEffort]
    .filter(Boolean)
    .join(" · ");
}

/** The second-row word for a step that is doing, or did, something notable. */
export function stepStatusWord(
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

export function reviewerStatusWord(
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
      return reviewerCouldNotStart(reviewer)
        ? { text: "could not start", tone: "destructive" }
        : { text: "failed", tone: "destructive" };
    case "cancelled":
      return { text: "stopped", tone: "muted" };
    default:
      return undefined;
  }
}

export function validationChips(
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
export function stepOpenTitle(
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
