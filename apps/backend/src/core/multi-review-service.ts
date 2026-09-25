import {
  newReviewValidationRun,
  parseReviewValidationPlan,
  type ReviewValidationRun,
} from "@orkestrator/protocol/review-workflow";
import {
  reviewValidationDiscoveryPrompt,
  REVIEW_VALIDATION_PLAN_SCHEMA,
} from "./review-validation-prompts.js";
import { validationPreparation } from "./review-validation-service.js";
import { createHash, randomUUID } from "node:crypto";
import {
  MULTI_REVIEW_REPLACED_FIX_SESSION_NOTICE,
  MULTI_REVIEW_WORKFLOW_VERSION,
  MULTI_REVIEW_UNSTICK_PROMPT,
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  isStartMultiReviewInput,
  type MultiReviewFixSession,
  type MultiReviewPausablePhase,
  type MultiReviewPhase,
  type MultiReviewModelSelection,
  type MultiReviewReviewerTranscript,
  type MultiReviewStepKind,
  type MultiReviewWorkflow,
  type MultiReviewWorktreeSnapshot,
  type StartMultiReviewCustomFixInput,
  type StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import {
  INTERACTIVE_AGENT_INTERACTION_POLICY,
  UNATTENDED_AGENT_INTERACTION_POLICY,
} from "@orkestrator/protocol/agent-interactions";
import { REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS } from "@orkestrator/protocol/review-fanout";
import { multiReviewDuplicateReviewerCount } from "@orkestrator/protocol/multi-review-launch";
import type { AgentModel } from "@orkestrator/protocol/native-agent";
import type { AgentSettingsTier } from "@orkestrator/protocol/agent-settings";
import {
  ReviewContractValidationError,
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  type ReviewContractValidationIssue,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema, StructuredOutputProvider } from "@orkestrator/protocol/structured-output";
import {
  workflowResultInstruction,
  workflowResultToolName,
  type WorkflowResultKind,
} from "@orkestrator/protocol/workflow-results";
import type { AppConfig, Environment } from "./models.js";
import type { StorageService } from "./storage.js";
import type { AgentToolConnection } from "./agent-tools.js";
import type { WorkflowResultService } from "./workflow-result-service.js";
import { WorkflowResultRollout } from "./workflow-result-rollout.js";
import {
  AmbiguousPromptDispatchError,
  ProviderDispatchPreparationError,
  createBuildPipelineProvider,
  readProviderStatus,
  type BridgeConnection,
  type BuildPipelineProvider,
  type ProviderDependencies,
  type ProviderSessionObservation,
  type ProviderStatus,
} from "./build-pipeline-provider.js";
import { addressPrompt, structuredReportRepairPrompt } from "./build-pipeline-prompts.js";
import {
  connectionDefaultsFor,
  createAgentModelCatalogReader,
  resolveFastMode,
  type AgentModelCatalogReader,
} from "./build-pipeline-service-helpers.js";
import {
  parseReviewPreparationResult,
  REVIEW_FIX_RESULT_JSON_SCHEMA,
  parseFixResult,
} from "./looped-review-prompts.js";
import { parseReviewPackageReference } from "./review-package.js";
import { resolveEnvironmentExecutionPolicy } from "./native-agent-execution-policy.js";
import {
  createPackagedMultiReviewerPrompt,
  createMultiReviewConsolidationPrompt,
} from "./multi-review-prompts.js";
import {
  InvalidMultiReviewAddressStateError,
  MissingMultiReviewAddressSessionError,
  MultiReviewAddressDispatchError,
  type MultiReviewAddressDispatchResult,
  type MultiReviewFixSessionReplacement,
} from "./multi-review-address-dispatch.js";
import {
  DEFAULT_PROGRESS_PROBE_INTERVAL_MS,
  DEFAULT_STALL_ABANDON_MS,
  DEFAULT_STALL_WARNING_MS,
  MultiReviewProgressTracker,
  PROGRESS_TRANSCRIPT_TAIL_MESSAGES,
  noProgressElapsedMs,
  stalledMinutes,
} from "./multi-review-progress.js";

import {
  recordEfficiency,
  type EfficiencyPhase,
  type MultiReviewEfficiencyObserver,
} from "./multi-review-efficiency.js";
import {
  ReviewEvidencePermits,
  evidenceGenerationKey,
  type EvidencePermitPhase,
} from "./review-evidence-permits.js";
import type { ReviewFanoutConcurrency } from "./review-fanout-scheduler.js";
import { WorkflowDueScheduler, stableJitterMs } from "./multi-review-scheduler.js";
import {
  readReviewerTranscript,
  type ReviewerTranscriptRead,
} from "./multi-review-reviewer-transcript.js";
import {
  ReviewFanoutRunner,
  ReviewSnapshotChangedError,
  ReviewSnapshotUnverifiableError,
  assertReviewSnapshotCurrent,
  attachAgentBeforeDispatch,
  captureReviewWorktreeSnapshot,
  commitProgressObservation,
  consolidationReports,
  deriveConsolidatedProvenance,
  consolidationResultContext,
  parseStructuredReportResult,
  promptWorktreeSnapshot,
  resolveUnattendedReviewerInteractions,
  type ReviewFanoutHost,
} from "./review-fanout.js";
import { recurringWorkMetrics } from "./recurring-work-metrics.js";

type CommandInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
/** Structured reports need a mutation boundary without provider planning behavior. */
const READ_ONLY_REPORT_TURN = Object.freeze({ mode: "build" as const, readOnly: true });
const DEFAULT_POLL_MS = 1_000;
/** Running provider work is observed every few seconds, with per-workflow jitter. */
const DEFAULT_OBSERVATION_MS = 3_000;
const DEFAULT_RECONCILE_MS = 15_000;
/** Workflows advanced at once; each carries its own bounded reviewer pool. */
const MAX_CONCURRENT_WORKFLOW_PASSES = 8;
const CONTROLLER_LEASE_MS = 15_000;
const CONTROLLER_RENEW_MS = 5_000;
const MAX_IDLE_RESULT_POLLS = 5;
const INTERACTIVE_FIX_INITIAL_IDLE_POLLS = 1;
const MAX_SCHEMA_REPAIR_ATTEMPTS = 3;
const ADDRESS_DISPATCH_RETRY_MS = 5_000;
const MAX_ADDRESS_DISPATCH_ATTEMPTS = 3;
const CANCELLATION_DEADLINE_MS = 10 * 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

function efficiencyPhase(phase: MultiReviewPhase): EfficiencyPhase {
  return phase === "preparing" ||
    phase === "reviewing" ||
    phase === "consolidating" ||
    phase === "fixing"
    ? phase
    : "other";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reviewerSessionKey(workflowId: string, reviewerId: string): string {
  return `multi-review:${workflowId}:reviewer:${reviewerId}`;
}

function fixSessionKey(workflowId: string): string {
  return `multi-review:${workflowId}:fix`;
}

function reviewSessionKey(workflowId: string): string {
  return `multi-review:${workflowId}:review-preparation`;
}

function preparationModel(workflow: MultiReviewWorkflow): MultiReviewModelSelection {
  return workflow.reviewModel ?? workflow.fixModel;
}

function consolidationModel(workflow: MultiReviewWorkflow): MultiReviewModelSelection {
  return workflow.consolidationModel ?? preparationModel(workflow);
}

function sameModelSelection(
  left: MultiReviewModelSelection,
  right: MultiReviewModelSelection,
): boolean {
  return (
    left.agent === right.agent &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.fastMode === right.fastMode
  );
}

function stepModelLabel(kind: MultiReviewStepKind): "preparation" | "consolidation" | "fix" {
  return kind === "prepare" ? "preparation" : kind === "consolidate" ? "consolidation" : "fix";
}

function stepResultLabel(
  kind: MultiReviewStepKind,
): "review package preparation" | "consolidated report" | "fix result" {
  return kind === "prepare"
    ? "review package preparation"
    : kind === "consolidate"
      ? "consolidated report"
      : "fix result";
}

function reviewSession(workflow: MultiReviewWorkflow): MultiReviewFixSession | undefined {
  return (
    workflow.reviewSession ??
    (workflow.reviewModel || workflow.consolidationModel ? undefined : workflow.fixSession)
  );
}

function clearReviewSession(workflow: MultiReviewWorkflow): void {
  if (workflow.reviewModel || workflow.consolidationModel) {
    delete workflow.reviewSession;
    workflow.reviewSessionKey = rotatedSessionKey(reviewSessionKey(workflow.id));
  } else {
    delete workflow.fixSession;
    workflow.fixSessionKey = rotatedSessionKey(fixSessionKey(workflow.id));
  }
}

function rotatedSessionKey(base: string): string {
  return `${base}:restart:${randomUUID()}`;
}

/**
 * Opens a step's durable timing record.
 *
 * The three steps share one provider session, and every dispatch resets that
 * session's clock and adds to its cumulative token counter. Recording the start
 * and the counter's value here is what lets a settled step keep reporting its
 * own runtime and its own consumption after the next step takes the session.
 */
function beginStepRuntime(
  workflow: MultiReviewWorkflow,
  kind: MultiReviewStepKind,
  session: MultiReviewFixSession,
): void {
  const runtimes = (workflow.stepRuntimes ??= {});
  runtimes[kind] = {
    startedAt: session.startedAt,
    ...(session.tokenCount === undefined
      ? kind === "prepare"
        ? { tokenBaseline: 0 }
        : {}
      : { tokenBaseline: session.tokenCount }),
  };
}

/** Adopt the clock of a request that was already running when step records were introduced. */
function backfillActiveStepRuntime(
  workflow: MultiReviewWorkflow,
  session: MultiReviewFixSession,
): boolean {
  const kind = workflow.activeRequest?.kind;
  if (!kind || workflow.stepRuntimes?.[kind]) return false;
  beginStepRuntime(workflow, kind, session);
  return true;
}

/** Stops a step's clock, keeping the first settlement when one is already recorded. */
function settleStepRuntime(workflow: MultiReviewWorkflow, kind: MultiReviewStepKind): void {
  const runtime = workflow.stepRuntimes?.[kind];
  if (!runtime || runtime.completedAt !== undefined) return;
  runtime.completedAt = nowIso();
}

function clearPendingAddressIdentity(workflow: MultiReviewWorkflow): void {
  delete workflow.addressSessionKey;
  delete workflow.addressRequestId;
  delete workflow.addressTabId;
}

function fixStepHasStarted(workflow: MultiReviewWorkflow): boolean {
  return (
    workflow.fixLaunch !== undefined ||
    workflow.stepRuntimes?.fix !== undefined ||
    workflow.fixResult !== undefined ||
    workflow.phase === "fixing" ||
    workflow.phase === "interactive" ||
    workflow.phase === "completed"
  );
}

function queueDefaultFix(workflow: MultiReviewWorkflow): void {
  workflow.phase = "interactive";
  workflow.fixLaunch = { kind: "default" };
  workflow.addressPromptPending = true;
  workflow.addressPromptAttempts = 0;
  workflow.addressSessionKey = `multi-review:${workflow.id}:interactive`;
  workflow.addressRequestId = `multi-review-address:${workflow.id}`;
  workflow.addressTabId = workflow.fixTabId ?? `multi-review-fix:${workflow.id}`;
  delete workflow.customFixInstruction;
  delete workflow.customFixModel;
  delete workflow.presentationError;
  delete workflow.activeRequest;
  delete workflow.error;
}

function queueRestartedFix(workflow: MultiReviewWorkflow): void {
  const launch = workflow.fixLaunch ?? { kind: "default" as const };
  workflow.fixLaunch = launch;
  const launchId = randomUUID();
  workflow.phase = "interactive";
  workflow.addressPromptPending = true;
  workflow.addressPromptAttempts = 0;
  workflow.addressSessionKey = `multi-review:${workflow.id}:interactive:${launchId}`;
  workflow.addressRequestId = `multi-review-address:${workflow.id}:${launchId}`;
  workflow.addressTabId = `multi-review-fix:${workflow.id}:${launchId}`;
  if (launch.kind === "custom") {
    workflow.customFixInstruction = launch.instruction;
    workflow.customFixModel = launch.model;
  } else {
    delete workflow.customFixInstruction;
    delete workflow.customFixModel;
  }
  delete workflow.presentationError;
  delete workflow.activeRequest;
  delete workflow.error;
}

function resetReviewerForRestart(
  workflow: MultiReviewWorkflow,
  reviewer: MultiReviewWorkflow["reviewers"][number],
): void {
  reviewer.status = "pending";
  reviewer.sessionKey = rotatedSessionKey(reviewerSessionKey(workflow.id, reviewer.id));
  delete reviewer.providerSessionId;
  delete reviewer.requestId;
  delete reviewer.dispatchState;
  delete reviewer.resultTransport;
  delete reviewer.resultSubmission;
  delete reviewer.schemaRepairAttempts;
  delete reviewer.schemaRepairPrompt;
  delete reviewer.continuationPrompt;
  delete reviewer.idleResultPolls;
  delete reviewer.progressAt;
  delete reviewer.progressDigest;
  delete reviewer.stalledSince;
  delete reviewer.tokenCount;
  delete reviewer.usageFinalizationPolls;
  delete reviewer.report;
  delete reviewer.error;
  delete reviewer.startedAt;
  delete reviewer.completedAt;
}

class FixResultValidationError extends Error {
  readonly issues: readonly ReviewContractValidationIssue[];

  constructor(message: string, path = "$", details?: Record<string, unknown>) {
    const detailText = details ? ` Provider validation details: ${JSON.stringify(details)}` : "";
    super(`${message}${detailText}`);
    this.name = "FixResultValidationError";
    this.issues = [{ path, code: "invalid_value", message: this.message }];
  }
}

function isSupervisedPhase(phase: MultiReviewPhase): boolean {
  return (
    phase === "preparing" ||
    phase === "reviewing" ||
    phase === "consolidating" ||
    phase === "fixing" ||
    phase === "cancelling"
  );
}

function stepForPausablePhase(phase: MultiReviewPhase): MultiReviewStepKind | null {
  if (phase === "preparing") return "prepare";
  if (phase === "consolidating") return "consolidate";
  if (phase === "fixing") return "fix";
  return null;
}

function hasWorkflowActivity(workflow: MultiReviewWorkflow): boolean {
  return (
    isSupervisedPhase(workflow.phase) ||
    workflow.validationRun?.status === "planned" ||
    workflow.validationRun?.status === "running" ||
    workflow.addressPromptPending === true ||
    workflow.reviewers.some((reviewer) => reviewer.status === "running") ||
    workflow.reviewSession?.status === "running" ||
    workflow.fixSession?.status === "running"
  );
}

function needsPausedStopReconciliation(workflow: MultiReviewWorkflow): boolean {
  if (workflow.phase !== "paused" || !workflow.pausedStep) return false;
  const session = workflow.pausedStep === "fix" ? workflow.fixSession : reviewSession(workflow);
  return (
    (workflow.pausedStep === "prepare" &&
      (workflow.validationRun?.status === "planned" ||
        workflow.validationRun?.status === "running")) ||
    session?.status === "running"
  );
}

/**
 * How soon a workflow needs its next supervision pass.
 *
 * `fast` covers every state that is about to issue a request or is settling a
 * boundary — admission, dispatch journals, result consumption, cancellation.
 * `observe` covers work that is simply running at the provider: reviews last
 * minutes, so reading their status every second bought nothing but load.
 */
function supervisionDemand(
  workflow: MultiReviewWorkflow,
  dispatchesAddressPrompts: boolean,
): "none" | "fast" | "observe" {
  if ((workflow.pendingResultConsumptions?.length ?? 0) > 0) return "fast";
  if (workflow.phase === "cancelling") return "fast";
  if (workflow.phase === "interactive" && workflow.addressPromptPending === true) {
    return dispatchesAddressPrompts ? "fast" : "none";
  }
  if (needsPausedStopReconciliation(workflow)) return "observe";
  if (needsInteractiveFixObservation(workflow)) return "observe";
  if (!isSupervisedPhase(workflow.phase)) return "none";
  if (workflow.phase === "reviewing") {
    return workflow.reviewers.some(
      (reviewer) =>
        reviewer.status === "pending" ||
        (reviewer.status === "running" && reviewer.dispatchState !== "sent"),
    )
      ? "fast"
      : "observe";
  }
  if (workflow.phase === "preparing" && workflow.validationRun) {
    return workflow.validationRun.status === "planned" ? "fast" : "observe";
  }
  return workflow.activeRequest?.state === "sent" ? "observe" : "fast";
}

/** The initial interactive Fix turn is observed until its durable runtime settles. */
function needsInteractiveFixObservation(workflow: MultiReviewWorkflow): boolean {
  return (
    workflow.phase === "interactive" &&
    workflow.addressPromptPending !== true &&
    (workflow.fixSession?.status === "running" || workflow.fixSession?.status === "idle") &&
    workflow.stepRuntimes?.fix?.completedAt === undefined
  );
}

export interface MultiReviewServiceOptions {
  autoAdvance?: boolean;
  pollIntervalMs?: number;
  controllerLeaseMs?: number;
  controllerRenewMs?: number;
  cancellationDeadlineMs?: number;
  progressProbeIntervalMs?: number;
  stallWarningMs?: number;
  stallAbandonMs?: number;
  /**
   * Status-observation cadence for work that is simply running at a provider.
   * Defaults to {@link DEFAULT_OBSERVATION_MS}, or to `pollIntervalMs` when a
   * caller configured that explicitly.
   */
  observationIntervalMs?: number;
  /** Period of the authoritative storage scan that rediscovers workflows. */
  reconcileIntervalMs?: number;
  /**
   * False restores the fixed interval scan with catch-up passes. Kept as a
   * rollback gate while the due-time scheduler soaks.
   */
  adaptiveScheduling?: boolean;
  addressDispatchRetryMs?: number;
  maxAddressDispatchAttempts?: number;
  provider?: (
    workflow: MultiReviewWorkflow,
    selection: MultiReviewModelSelection,
  ) => Promise<BuildPipelineProvider>;
  providerDependencies?: Pick<ProviderDependencies, "openCodeClient" | "monitorRetryMs">;
  workflowResults?: WorkflowResultService;
  workflowResultRollout?: WorkflowResultRollout;
  resolveAgentToolConnection?: (
    environmentId: string,
    projectId: string,
    target: "host" | "container",
    resultKey: string,
    provider?: StructuredOutputProvider,
  ) => AgentToolConnection;
  /**
   * Delivers the durable interactive handoff after {@link address} records it.
   * The supervisor, not a mounted renderer, retries this callback until it
   * succeeds and acknowledges the persisted intent.
   */
  dispatchAddressPrompt?: (
    workflow: MultiReviewWorkflow,
    presentation: { activateTab: boolean },
  ) => Promise<MultiReviewAddressDispatchResult | MultiReviewFixSession | void>;
  /** Rebinds and seeds a renderer-created replacement for a missing Fix session. */
  recoverAddressSession?: (
    workflow: MultiReviewWorkflow,
    replacement: MultiReviewFixSessionReplacement,
  ) => Promise<MultiReviewAddressDispatchResult>;
  /** Removes a failed custom launch from the native-agent identity store. */
  invalidateAddressSession?: (
    workflow: MultiReviewWorkflow,
    session: MultiReviewFixSession,
  ) => Promise<void>;
  /**
   * Reviewer fan-out concurrency. Clamped by the shared runner; set every limit
   * to `1` to restore strictly serial admission and observation.
   */
  reviewFanoutConcurrency?: Partial<ReviewFanoutConcurrency>;
  /**
   * When false, every reviewer admission re-verifies the review package, as
   * before evidence permits existed. Kept as a rollback gate for one release.
   */
  evidencePermits?: boolean;
  /** Content-free efficiency measurements (tests and benchmarks). */
  efficiency?: MultiReviewEfficiencyObserver;
}

/** Durable backend owner for reviewer fan-out, consolidation, and fixes. */
export class MultiReviewService {
  private cachedWorkflowRollout: WorkflowResultRollout | null = null;
  private readonly ownerId = randomUUID();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly scheduledRuns = new Map<string, { pending: boolean; promise: Promise<void> }>();
  private readonly providers = new Map<string, BuildPipelineProvider>();
  private readonly providerCreations = new Map<string, Promise<BuildPipelineProvider>>();
  private readonly providerUsers = new Map<string, Set<string>>();
  private readonly providerReaders = new Map<string, number>();
  private readonly leases = new Map<string, { token: string; expiresAt: string }>();
  private readonly progress: MultiReviewProgressTracker;
  private readonly evidencePermits = new ReviewEvidencePermits();
  /**
   * Per-workflow-object write queue. Reviewers advance concurrently and every
   * save is revision- and fence-checked, so unserialized saves of the same
   * in-memory workflow would reject one another as revision conflicts.
   */
  private readonly saveTails = new WeakMap<MultiReviewWorkflow, Promise<void>>();
  private readonly addressDispatchRetryAt = new Map<string, number>();
  /**
   * Focus is permission from the foreground action, not durable workflow state.
   * It is consumed by the first dispatch attempt and intentionally disappears
   * across retries and backend restarts.
   */
  private readonly foregroundAddressDispatches = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private tickRun: { pending: boolean; promise: Promise<void> } | null = null;
  private readonly scheduler: WorkflowDueScheduler;
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: MultiReviewServiceOptions = {},
  ) {
    this.progress = new MultiReviewProgressTracker(
      options.progressProbeIntervalMs ?? DEFAULT_PROGRESS_PROBE_INTERVAL_MS,
    );
    this.scheduler = new WorkflowDueScheduler({
      run: (workflowId) => this.runScheduled(workflowId),
      nextDueAt: (workflowId) => this.nextDueAt(workflowId),
      discover: () => this.discoverSupervisedWorkflows(),
      reconcileIntervalMs:
        this.options.reconcileIntervalMs ?? this.options.pollIntervalMs ?? DEFAULT_RECONCILE_MS,
      maxConcurrent: MAX_CONCURRENT_WORKFLOW_PASSES,
      onPass: ({ queueDelayMs, durationMs }) =>
        recordEfficiency(this.options.efficiency, {
          owner: "multi-review",
          operation: "scheduler.pass",
          count: queueDelayMs,
          elapsedMs: durationMs,
        }),
    });
  }

  async init(): Promise<void> {
    this.stopped = false;
    if (this.timer) clearInterval(this.timer);
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.timer = null;
    this.renewTimer = null;
    // The workflow store is authoritative across backend restarts. Restore the
    // environment projection before the renderer can mistake an active review
    // for completed work, and retire a stale working source left by a workflow
    // that settled while the previous process was shutting down.
    await this.reconcileEnvironmentActivity();
    if (this.options.autoAdvance !== false) {
      if (this.options.adaptiveScheduling === false) {
        this.timer = setInterval(
          () => void this.requestTick(),
          this.options.pollIntervalMs ?? DEFAULT_POLL_MS,
        );
        this.timer.unref?.();
        void this.requestTick();
      } else {
        // The first reconciliation scan runs immediately and rebuilds every
        // due time from storage; nothing about scheduling survives a restart.
        this.scheduler.start();
      }
      this.renewTimer = setInterval(
        () => void this.renewLeases(),
        this.options.controllerRenewMs ?? CONTROLLER_RENEW_MS,
      );
      this.renewTimer.unref?.();
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.timer = null;
    this.renewTimer = null;
    await this.scheduler.stop();
    await Promise.allSettled([
      ...this.locks.values(),
      ...[...this.scheduledRuns.values()].map((entry) => entry.promise),
      ...(this.tickRun ? [this.tickRun.promise] : []),
    ]);
    await Promise.allSettled([...this.providers.values()].map((provider) => provider.dispose?.()));
    this.providers.clear();
    this.providerCreations.clear();
    this.providerUsers.clear();
    this.providerReaders.clear();
    this.addressDispatchRetryAt.clear();
    this.foregroundAddressDispatches.clear();
    await Promise.allSettled(
      [...this.leases].map(([workflowId, lease]) =>
        this.storage.releaseMultiReviewController(workflowId, this.ownerId, lease.token),
      ),
    );
    this.leases.clear();
    this.progress.clear();
    this.evidencePermits.clear();
  }

  /**
   * Reads a bounded tail of a reviewer's live provider transcript without
   * copying it into the workflow snapshot. The provider remains authoritative
   * while the review is running; callers refetch after a hidden tab becomes
   * active again.
   *
   * A caller that passes the `sourceToken` from its previous response gets an
   * `unchanged` answer with no messages when nothing moved. Status, report,
   * and recovery fields are always current, so the tab's controls stay
   * authoritative even when the transcript itself is unchanged or unreadable.
   */
  async reviewerTranscript(
    workflowId: string,
    reviewerId: string,
    knownSourceToken?: string,
  ): Promise<MultiReviewReviewerTranscript> {
    const loadReviewer = async () => {
      const record = await this.storage.getMultiReviewWorkflow(workflowId);
      if (!record || !isMultiReviewWorkflow(record.snapshot)) {
        throw new Error(`Multi review workflow not found: ${workflowId}`);
      }
      const workflow = record.snapshot;
      const reviewer = workflow.reviewers.find((entry) => entry.id === reviewerId);
      if (!reviewer) throw new Error(`Multi review reviewer not found: ${reviewerId}`);
      return { workflow, reviewer };
    };
    let { workflow, reviewer } = await loadReviewer();

    let transcript: ReviewerTranscriptRead | undefined;
    const readSessionId = reviewer.providerSessionId;
    if (readSessionId) {
      const key = this.providerKey(workflow, reviewer);
      this.providerReaders.set(key, (this.providerReaders.get(key) ?? 0) + 1);
      try {
        const provider = await this.providerInstance(workflow, reviewer);
        provider.registerSession?.(readSessionId, {
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "review",
          workflowId: workflow.id,
          provider: reviewer.agent,
          fence: reviewer.sessionKey,
        });
        const started = Date.now();
        transcript = await readReviewerTranscript(provider, readSessionId, knownSourceToken);
        recordEfficiency(this.options.efficiency, {
          owner: "multi-review",
          operation:
            transcript.kind === "unchanged"
              ? "transcript.ui_unchanged"
              : transcript.fallback
                ? "transcript.ui_fallback"
                : "transcript.ui_read",
          phase: "ui",
          bytes: transcript.kind === "snapshot" ? transcript.bytes : 0,
          elapsedMs: Date.now() - started,
        });
      } finally {
        await this.releaseProviderReaderByKey(key);
      }
      // The reviewer may have been restarted while the read was in flight. A
      // transcript from the replaced session must not reach the new session's
      // view, so answer from the current state with no messages and no token;
      // the next poll reads the new session.
      ({ workflow, reviewer } = await loadReviewer());
      if (reviewer.providerSessionId !== readSessionId) transcript = undefined;
    }

    return {
      workflowId: workflow.id,
      reviewerId: reviewer.id,
      workflowPhase: workflow.phase,
      agent: reviewer.agent,
      model: reviewer.model,
      ...(reviewer.reasoningEffort ? { reasoningEffort: reviewer.reasoningEffort } : {}),
      status: reviewer.status,
      ...(reviewer.dispatchState ? { dispatchState: reviewer.dispatchState } : {}),
      messages: transcript?.kind === "snapshot" ? transcript.messages : [],
      transcript: transcript?.kind === "unchanged" ? "unchanged" : "snapshot",
      ...(transcript?.sourceToken ? { sourceToken: transcript.sourceToken } : {}),
      ...(transcript?.kind === "snapshot" && transcript.truncated ? { truncated: true } : {}),
      ...(reviewer.report ? { report: reviewer.report } : {}),
      ...(reviewer.error ? { error: reviewer.error } : {}),
      ...(reviewer.progressAt ? { progressAt: reviewer.progressAt } : {}),
      ...(reviewer.stalledSince ? { stalledSince: reviewer.stalledSince } : {}),
      ...(reviewer.startedAt ? { startedAt: reviewer.startedAt } : {}),
      ...(reviewer.completedAt ? { completedAt: reviewer.completedAt } : {}),
    };
  }

  async start(
    input: StartMultiReviewInput,
    reservedWorkflowId?: string,
  ): Promise<MultiReviewWorkflow> {
    if (!isStartMultiReviewInput(input)) throw new Error("Invalid multi review start request");
    const environment = await this.storage.getEnvironment(input.environmentId);
    if (
      !environment ||
      environment.projectId !== input.projectId ||
      environment.deletionRequestedAt
    ) {
      throw new Error("The review environment is unavailable");
    }
    const reviewWorktreeSnapshot = await this.captureReviewWorktreeSnapshot(input.environmentId);
    const config = await this.storage.loadConfig();
    const repository = config.repositories[input.projectId] ?? {};
    const readCatalog = this.catalogReaderFor(input.environmentId);
    const withFastMode = (selection: MultiReviewModelSelection) =>
      this.configuredSelection(selection, environment, config, repository, readCatalog);
    const [reviewers, reviewModelSelection, fixModel] = await Promise.all([
      Promise.all(input.reviewers.map(withFastMode)),
      input.reviewModel ? withFastMode(input.reviewModel) : undefined,
      withFastMode(input.fixModel),
    ]);
    // Coordinator and MCP starts bypass the launcher's duplicate warning, so
    // the count is measured here too. It is advisory: duplicates stay valid.
    recordEfficiency(this.options.efficiency, {
      owner: "multi-review",
      operation: "launch.duplicate_reviewers",
      reviewers: reviewers.length,
      count: multiReviewDuplicateReviewerCount(reviewers),
    });
    const timestamp = nowIso();
    const workflow: MultiReviewWorkflow = {
      version: MULTI_REVIEW_WORKFLOW_VERSION,
      controller: "backend",
      // Complete actions reserve this identity durably before any launch I/O.
      id: reservedWorkflowId ?? randomUUID(),
      environmentId: input.environmentId,
      projectId: input.projectId,
      targetBranch: input.targetBranch,
      autoFix: input.autoFix ?? false,
      ...(input.reviewInstruction ? { reviewInstruction: input.reviewInstruction } : {}),
      reviewers: reviewers.map((selection) => ({
        id: randomUUID(),
        ...selection,
        status: "pending" as const,
      })),
      ...(reviewModelSelection ? { reviewModel: reviewModelSelection } : {}),
      fixModel,
      reviewWorktreeSnapshot,
      phase: "preparing",
      createdAt: timestamp,
      updatedAt: timestamp,
      backendRevision: 0,
    };
    const saved = await this.storage.createMultiReviewWorkflowIfNoActive(
      workflow.id,
      workflow.environmentId,
      MULTI_REVIEW_WORKFLOW_VERSION,
      workflow,
    );
    if (!saved) {
      throw new Error(
        "Finish, cancel, or delete the existing Multi Review before starting another",
      );
    }
    workflow.backendRevision = saved.revision;
    await this.syncWorkflowActivity(workflow);
    void this.advanceNow(workflow.id);
    return workflow;
  }

  async address(workflowId: string): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      try {
        // `address_multi_review` also owns the durable native-agent dispatch. If
        // that second half was interrupted, repeating the command must resume it
        // without trying to transition the already-interactive workflow again.
        if (workflow.phase === "interactive" && workflow.addressPromptPending === true) {
          this.addressDispatchRetryAt.delete(workflow.id);
          this.foregroundAddressDispatches.add(workflow.id);
          void this.advanceNow(workflow.id);
          return workflow;
        }
        // The durable handoff already ran. A transport retry must not send a
        // second fix turn or report a successful handoff as a validation error.
        if (workflow.phase === "interactive") return workflow;
        if (workflow.phase !== "ready" || !workflow.consolidatedReport) {
          throw new Error("The consolidated review is not ready to address");
        }
        // Persist the user's intent before any provider I/O. The backend
        // supervisor adopts the idle consolidation session and dispatches the
        // prompt from `advance`; a renderer can disappear immediately after this
        // save without delaying or losing the work.
        queueDefaultFix(workflow);
        const saved = await this.save(workflow, token);
        this.addressDispatchRetryAt.delete(workflow.id);
        this.foregroundAddressDispatches.add(workflow.id);
        void this.advanceNow(workflow.id);
        return saved;
      } finally {
        // This method owns a short-lived transition/dispatch claim. Every exit
        // path must release it, including validation and already-complete errors,
        // or a rejected retry fences out subsequent controllers until expiry.
        await this.release(workflow, token);
      }
    });
  }

  async customFix(input: StartMultiReviewCustomFixInput): Promise<MultiReviewWorkflow> {
    return this.withLock(input.workflowId, async () => {
      const controlled = await this.loadControlled(input.workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${input.workflowId}`);
      const { workflow, token } = controlled;
      try {
        const instruction = input.instruction.trim();
        if (
          workflow.phase === "interactive" &&
          workflow.addressPromptPending === true &&
          workflow.customFixInstruction === instruction &&
          workflow.customFixModel?.agent === input.fixModel.agent &&
          workflow.customFixModel.model === input.fixModel.model &&
          workflow.customFixModel.reasoningEffort === input.fixModel.reasoningEffort
        ) {
          this.addressDispatchRetryAt.delete(workflow.id);
          this.foregroundAddressDispatches.add(workflow.id);
          void this.advanceNow(workflow.id);
          return workflow;
        }
        if (workflow.phase !== "ready" || !workflow.consolidatedReport) {
          throw new Error("The consolidated review is not ready for a custom fix");
        }
        // Persist the complete launch intent before creating a provider session
        // or publishing its tab. The supervisor can resume every later step
        // after a renderer unmount or a backend restart.
        workflow.phase = "interactive";
        const launchId = randomUUID();
        workflow.addressSessionKey = `multi-review:${workflow.id}:interactive:${launchId}`;
        workflow.addressRequestId = `multi-review-address:${workflow.id}:${launchId}`;
        workflow.addressTabId = `multi-review-fix:${workflow.id}:${launchId}`;
        workflow.customFixInstruction = instruction;
        const environment = await this.storage.getEnvironment(workflow.environmentId);
        if (!environment) throw new Error("Review environment no longer exists");
        const config = await this.storage.loadConfig();
        const repository = config.repositories[workflow.projectId] ?? {};
        workflow.customFixModel = await this.configuredSelection(
          input.fixModel,
          environment,
          config,
          repository,
          this.catalogReaderFor(workflow.environmentId),
        );
        workflow.fixLaunch = {
          kind: "custom",
          instruction,
          model: workflow.customFixModel,
        };
        workflow.addressPromptPending = true;
        workflow.addressPromptAttempts = 0;
        delete workflow.presentationError;
        delete workflow.activeRequest;
        delete workflow.error;
        const saved = await this.save(workflow, token);
        this.addressDispatchRetryAt.delete(workflow.id);
        this.foregroundAddressDispatches.add(workflow.id);
        void this.advanceNow(workflow.id);
        return saved;
      } finally {
        await this.release(workflow, token);
      }
    });
  }

  async recoverFixSession(
    environmentId: string,
    replacement: MultiReviewFixSessionReplacement,
  ): Promise<MultiReviewWorkflow> {
    if (!this.options.recoverAddressSession) {
      throw new Error("Multi Review Fix session recovery is unavailable");
    }
    const records = await this.storage.listMultiReviewWorkflows(environmentId);
    const candidate = records
      .map((record) => record.snapshot)
      .find(
        (workflow) =>
          isMultiReviewWorkflow(workflow) &&
          workflow.phase === "interactive" &&
          (workflow.fixSession?.providerSessionId === replacement.expectedProviderSessionId ||
            workflow.fixSession?.providerSessionId === replacement.replacementProviderSessionId) &&
          (workflow.fixTabId ?? workflow.addressTabId ?? `multi-review-fix:${workflow.id}`) ===
            replacement.tabId,
      );
    if (!candidate || !isMultiReviewWorkflow(candidate)) {
      throw new Error("The Multi Review workflow for this Fix tab is no longer available");
    }
    return this.withLock(candidate.id, async () => {
      const controlled = await this.loadControlled(candidate.id);
      if (!controlled) throw new Error(`Multi review workflow not found: ${candidate.id}`);
      const { workflow, token } = controlled;
      try {
        if (workflow.fixSession?.providerSessionId === replacement.replacementProviderSessionId) {
          return workflow;
        }
        const recovered = await this.options.recoverAddressSession!(workflow, replacement);
        await this.assertFence(workflow.id, token);
        workflow.fixSession = recovered.fixSession;
        workflow.fixSession.status = "running";
        workflow.fixSession.startedAt = nowIso();
        delete workflow.fixSession.tokenCount;
        delete workflow.fixSession.completedAt;
        delete workflow.fixSession.idleResultPolls;
        delete workflow.fixSession.observedRunning;
        delete workflow.fixSession.usageFinalizationPolls;
        workflow.fixSessionKey = recovered.fixSession.sessionKey;
        beginStepRuntime(workflow, "fix", workflow.fixSession);
        if (workflow.stepRuntimes?.fix) {
          workflow.stepRuntimes.fix.tokenBaseline = 0;
        }
        workflow.fixTabId = recovered.tabId;
        workflow.presentationError = MULTI_REVIEW_REPLACED_FIX_SESSION_NOTICE;
        delete workflow.error;
        this.progress.forget(replacement.expectedProviderSessionId);
        return await this.save(workflow, token);
      } finally {
        await this.release(workflow, token);
      }
    });
  }

  async retry(workflowId: string): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      // An explicit restart starts a new admission generation.
      this.evidencePermits.invalidate(workflowId);
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      if (workflow.phase !== "failed") return workflow;
      // A stale immutable package is unusable and requires a full preparation
      // reset. Live-worktree drift on a legacy/no-package review is advisory:
      // completed reports remain useful (with the drift limitation attached),
      // so an unrelated later failure must take the targeted retry path below.
      if (workflow.reviewSnapshotStale === true && workflow.reviewPackage) {
        for (const reviewer of workflow.reviewers) {
          await this.abandonSession(workflow, reviewer, reviewer.providerSessionId);
          if (reviewer.providerSessionId) this.progress.forget(reviewer.providerSessionId);
          reviewer.status = "pending";
          delete reviewer.error;
          delete reviewer.report;
          delete reviewer.providerSessionId;
          reviewer.sessionKey = rotatedSessionKey(reviewerSessionKey(workflow.id, reviewer.id));
          delete reviewer.requestId;
          delete reviewer.dispatchState;
          delete reviewer.schemaRepairAttempts;
          delete reviewer.schemaRepairPrompt;
          delete reviewer.idleResultPolls;
          delete reviewer.progressAt;
          delete reviewer.progressDigest;
          delete reviewer.stalledSince;
          delete reviewer.tokenCount;
          delete reviewer.usageFinalizationPolls;
          delete reviewer.startedAt;
          delete reviewer.completedAt;
        }
        const staleReviewSession = reviewSession(workflow);
        await this.abandonSession(
          workflow,
          staleReviewSession ?? preparationModel(workflow),
          staleReviewSession?.providerSessionId,
        );
        if (staleReviewSession) this.progress.forget(staleReviewSession.providerSessionId);
        if (workflow.reviewModel && workflow.fixSession) {
          await this.abandonSession(
            workflow,
            workflow.fixModel,
            workflow.fixSession.providerSessionId,
          );
          this.progress.forget(workflow.fixSession.providerSessionId);
          delete workflow.fixSession;
          workflow.fixSessionKey = rotatedSessionKey(fixSessionKey(workflow.id));
        }
        workflow.phase = "preparing";
        delete workflow.reviewPackage;
        delete workflow.validationRun;
        delete workflow.validationStopRequested;
        delete workflow.stepRuntimes;
        delete workflow.reviewSnapshotStale;
        clearReviewSession(workflow);
        delete workflow.activeRequest;
        delete workflow.consolidatedReport;
        delete workflow.fixResult;
        delete workflow.addressPromptPending;
        delete workflow.addressPromptAttempts;
        clearPendingAddressIdentity(workflow);
        delete workflow.customFixInstruction;
        delete workflow.customFixModel;
        delete workflow.presentationError;
      } else if (
        workflow.activeRequest?.kind === "prepare" ||
        (!workflow.reviewPackage &&
          workflow.reviewers.every((reviewer) => reviewer.status === "pending"))
      ) {
        await this.abandonSession(
          workflow,
          reviewSession(workflow) ?? preparationModel(workflow),
          reviewSession(workflow)?.providerSessionId,
        );
        if (workflow.validationRun) {
          await this.invoke("cancel_review_validation", {
            environmentId: workflow.environmentId,
            run: workflow.validationRun,
          });
          delete workflow.validationRun;
        }
        delete workflow.validationStopRequested;
        workflow.phase = "preparing";
        delete workflow.stepRuntimes;
        clearReviewSession(workflow);
        delete workflow.activeRequest;
      } else {
        // Reviewer failures are independent, so a single pass can fail several of
        // them at once. Restoring only the first would consolidate from fewer
        // reviewers than the user asked for, without saying so.
        const failedReviewers = workflow.reviewers.filter(
          (reviewer) => reviewer.status === "failed",
        );
        const hasReport = workflow.reviewers.some(
          (reviewer) => reviewer.status === "completed" && reviewer.report !== undefined,
        );
        // With no surviving report there is nothing to consolidate, so retry
        // every failed or stopped reviewer. If a report did survive, preserve
        // the user's stop choices and retry only failures from the requested panel.
        const restartable = hasReport
          ? failedReviewers
          : workflow.reviewers.filter(
              (reviewer) => reviewer.status === "failed" || reviewer.status === "cancelled",
            );
        if (restartable.length > 0) {
          for (const reviewer of restartable) {
            // Retrying allocates a fresh session, so the abandoned one must be
            // aborted while its id is still known. Clearing the id first would
            // leave a provider turn running that nothing can ever reach again.
            await this.abandonSession(workflow, reviewer, reviewer.providerSessionId);
            if (reviewer.providerSessionId) this.progress.forget(reviewer.providerSessionId);
            reviewer.status = "pending";
            delete reviewer.error;
            delete reviewer.providerSessionId;
            reviewer.sessionKey = rotatedSessionKey(reviewerSessionKey(workflow.id, reviewer.id));
            delete reviewer.requestId;
            delete reviewer.dispatchState;
            delete reviewer.schemaRepairAttempts;
            delete reviewer.schemaRepairPrompt;
            delete reviewer.idleResultPolls;
            delete reviewer.progressAt;
            delete reviewer.progressDigest;
            delete reviewer.stalledSince;
            delete reviewer.tokenCount;
            delete reviewer.usageFinalizationPolls;
            delete reviewer.completedAt;
          }
          workflow.phase = "reviewing";
        } else if (workflow.consolidatedReport && reviewSession(workflow)) {
          workflow.phase = "ready";
          reviewSession(workflow)!.status = "idle";
          delete workflow.addressPromptPending;
          delete workflow.addressPromptAttempts;
          clearPendingAddressIdentity(workflow);
          delete workflow.presentationError;
          delete workflow.activeRequest;
        } else {
          await this.abandonSession(
            workflow,
            reviewSession(workflow) ?? consolidationModel(workflow),
            reviewSession(workflow)?.providerSessionId,
          );
          workflow.phase = "consolidating";
          // The retry runs on a fresh session, so consolidation's numbers start
          // again. Preparation already finished and keeps its own.
          delete workflow.stepRuntimes?.consolidate;
          delete workflow.stepRuntimes?.fix;
          clearReviewSession(workflow);
          delete workflow.activeRequest;
        }
      }
      delete workflow.error;
      const saved = await this.save(workflow, token);
      void this.advanceNow(workflowId);
      return saved;
    });
  }

  /**
   * Stop one reviewer without stopping the review.
   *
   * A single wedged reviewer otherwise holds the whole workflow in `reviewing`,
   * because the pass will not consolidate while any reviewer is still pending or
   * running. Stopping retires that reviewer as `cancelled`: the pass skips it,
   * consolidation runs from whatever the remaining reviewers produced, and the
   * fix stage follows as usual.
   *
   * The abort is best-effort by design. The reason to stop a reviewer is that it
   * is unresponsive, so waiting for the provider to confirm the abort would
   * reproduce the stall this control exists to escape. Cancelling the whole
   * workflow keeps the strict path, where an unsettled session blocks the
   * transition.
   */
  async stopReviewer(workflowId: string, reviewerId: string): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      let handedToSupervisor = false;
      try {
        const reviewer = workflow.reviewers.find((entry) => entry.id === reviewerId);
        if (!reviewer) throw new Error(`Multi review reviewer not found: ${reviewerId}`);
        // Idempotent: a double click, or a reviewer that settled between the
        // render and the command, must not rewrite a finished result.
        if (reviewer.status !== "pending" && reviewer.status !== "running") return workflow;
        if (workflow.phase !== "reviewing") {
          throw new Error("A reviewer can only be stopped while review is running");
        }
        await this.abandonSession(workflow, reviewer, reviewer.providerSessionId);
        if (reviewer.providerSessionId) this.progress.forget(reviewer.providerSessionId);
        reviewer.status = "cancelled";
        reviewer.completedAt = nowIso();
        // The session id is kept so the read-only transcript stays reachable.
        delete reviewer.idleResultPolls;
        delete reviewer.stalledSince;
        delete reviewer.progressDigest;
        delete reviewer.schemaRepairPrompt;
        delete reviewer.dispatchState;
        const saved = await this.save(workflow, token);
        if (isSupervisedPhase(saved.phase)) {
          handedToSupervisor = true;
          // Re-enter immediately rather than waiting for the next tick: with this
          // reviewer out of the way the pass may already be able to consolidate.
          void this.advanceNow(workflowId);
        }
        return saved;
      } finally {
        // A stale/no-op command against a settled workflow is a short-lived
        // claim: a stop that arrives after `ready` must not resurrect a
        // renewable lease on a workflow the background supervisor no longer
        // visits. A supervised workflow keeps its claim, because `release` also
        // forgets every live progress clock and drops the workflow's provider
        // users — the reviewers still running are using both.
        if (!handedToSupervisor && !isSupervisedPhase(workflow.phase)) {
          await this.release(workflow, token);
        }
      }
    });
  }

  /** Stop the environment-owned validation process and continue with its partial evidence. */
  async stopValidation(workflowId: string): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      let handedToSupervisor = false;
      try {
        if (
          workflow.phase !== "preparing" ||
          !workflow.validationRun ||
          (workflow.validationRun.status !== "planned" &&
            workflow.validationRun.status !== "running")
        ) {
          throw new Error("Validation can only be stopped while tests are running");
        }
        if (workflow.validationStopRequested === true) {
          handedToSupervisor = true;
          void this.advanceNow(workflowId);
          return workflow;
        }
        // Persist intent before touching the worker. If the backend restarts after
        // cancellation, the supervisor still knows that a cancelled run should be
        // packaged as partial evidence rather than failed or restarted.
        workflow.validationStopRequested = true;
        const saved = await this.save(workflow, token);
        handedToSupervisor = true;
        void this.advanceNow(workflowId);
        return saved;
      } finally {
        // Guard failures and failed saves do not have a supervisor continuation
        // that can retire this claim. Do not leave their lease renewable forever.
        if (!handedToSupervisor) await this.release(workflow, token);
      }
    });
  }

  /** Discard one reviewer's session and run that reviewer again from its original prompt. */
  async restartReviewer(workflowId: string, reviewerId: string): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      // An explicit restart starts a new admission generation.
      this.evidencePermits.invalidate(workflowId);
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      const phaseAtClaim = workflow.phase;
      let handedToSupervisor = false;
      try {
        const reviewer = workflow.reviewers.find((entry) => entry.id === reviewerId);
        if (!reviewer) throw new Error(`Multi review reviewer not found: ${reviewerId}`);
        if (workflow.activeRequest?.kind === "prepare") {
          throw new Error(
            "Retry Multi Review to finish preparing the review package before restarting reviewers",
          );
        }
        if (
          workflow.phase === "preparing" ||
          workflow.phase === "cancelling" ||
          workflow.phase === "cancelled"
        ) {
          throw new Error("This reviewer is not available to restart yet");
        }
        if (workflow.reviewSnapshotStale === true && workflow.reviewPackage) {
          throw new Error("Restart the full Multi Review to review the updated worktree snapshot");
        }
        const restartFixAfterConsolidation = fixStepHasStarted(workflow);

        await this.supersedeRestartedResults(workflow, [reviewer]);

        await this.abandonSession(workflow, reviewer, reviewer.providerSessionId);
        if (reviewer.providerSessionId) this.progress.forget(reviewer.providerSessionId);
        // Consolidation is derived from the reviewer reports. Once any input is
        // restarted, its session/result can no longer remain authoritative.
        const activeReviewSession = reviewSession(workflow);
        await this.abandonSession(
          workflow,
          activeReviewSession ?? consolidationModel(workflow),
          activeReviewSession?.providerSessionId,
        );
        if (activeReviewSession) this.progress.forget(activeReviewSession.providerSessionId);
        if (workflow.fixSession && workflow.fixSession !== activeReviewSession) {
          await this.abandonSession(
            workflow,
            workflow.fixSession,
            workflow.fixSession.providerSessionId,
          );
          this.progress.forget(workflow.fixSession.providerSessionId);
          delete workflow.fixSession;
          workflow.fixSessionKey = rotatedSessionKey(fixSessionKey(workflow.id));
        }
        resetReviewerForRestart(workflow, reviewer);
        workflow.phase = "reviewing";
        clearReviewSession(workflow);
        delete workflow.activeRequest;
        delete workflow.consolidatedReport;
        delete workflow.fixResult;
        delete workflow.stepRuntimes?.consolidate;
        delete workflow.stepRuntimes?.fix;
        delete workflow.addressPromptPending;
        delete workflow.addressPromptAttempts;
        clearPendingAddressIdentity(workflow);
        delete workflow.customFixInstruction;
        delete workflow.customFixModel;
        delete workflow.presentationError;
        workflow.restartFixAfterConsolidation = restartFixAfterConsolidation || undefined;
        delete workflow.error;
        const saved = await this.save(workflow, token);
        handedToSupervisor = true;
        void this.advanceNow(workflowId);
        return saved;
      } finally {
        if (!handedToSupervisor && !isSupervisedPhase(phaseAtClaim)) {
          await this.release(workflow, token);
        }
      }
    });
  }

  /** Restart a preparation, consolidation, or fix tile and every dependent step. */
  async restartStep(
    workflowId: string,
    kind: MultiReviewStepKind,
    model?: MultiReviewModelSelection,
  ): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      // An explicit restart starts a new admission generation.
      this.evidencePermits.invalidate(workflowId);
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      const phaseAtClaim = workflow.phase;
      let handedToSupervisor = false;
      try {
        if (workflow.phase === "cancelling" || workflow.phase === "cancelled") {
          throw new Error("A cancelled Multi Review cannot restart a step");
        }
        const packageStarted =
          workflow.stepRuntimes?.prepare !== undefined ||
          workflow.reviewPackage !== undefined ||
          workflow.validationRun !== undefined ||
          workflow.activeRequest?.kind === "prepare" ||
          workflow.phase === "preparing" ||
          workflow.reviewers.some(
            (reviewer) => reviewer.providerSessionId !== undefined || reviewer.report !== undefined,
          );
        const consolidationStarted =
          workflow.stepRuntimes?.consolidate !== undefined ||
          workflow.consolidatedReport !== undefined ||
          workflow.activeRequest?.kind === "consolidate" ||
          workflow.phase === "consolidating";
        if (kind === "prepare" && !packageStarted) {
          throw new Error("Review package preparation has not started");
        }
        if (kind === "consolidate" && !consolidationStarted) {
          throw new Error("Consolidation has not started");
        }
        if (kind === "fix" && !fixStepHasStarted(workflow)) {
          throw new Error("Fix has not started");
        }
        if (
          kind === "consolidate" &&
          !workflow.reviewers.some((reviewer) => reviewer.report !== undefined)
        ) {
          throw new Error("Consolidation cannot restart without a reviewer report");
        }
        if (kind === "fix" && !workflow.consolidatedReport) {
          throw new Error("Fix cannot restart without a consolidated report");
        }

        // Snapshot capture can reject (unknown worktree, missing fingerprint,
        // or too many changed paths). Resolve it before closing result slots or
        // aborting provider sessions so a rejected command is a true no-op.
        const restartedReviewWorktreeSnapshot =
          kind === "prepare"
            ? await this.captureReviewWorktreeSnapshot(workflow.environmentId)
            : undefined;

        // Resolve provider-owned settings before abandoning any session. A
        // rejected model override must leave the current run untouched.
        let restartedModel: MultiReviewModelSelection | undefined;
        if (model) {
          const environment = await this.storage.getEnvironment(workflow.environmentId);
          if (!environment) throw new Error("Review environment no longer exists");
          const config = await this.storage.loadConfig();
          const repository = config.repositories[workflow.projectId] ?? {};
          restartedModel = await this.configuredSelection(
            model,
            environment,
            config,
            repository,
            this.catalogReaderFor(workflow.environmentId),
          );
        }

        const shouldReplayFix = kind !== "fix" && fixStepHasStarted(workflow);
        const preserveSharedFixSession =
          kind === "fix" &&
          restartedModel === undefined &&
          !workflow.reviewModel &&
          workflow.fixLaunch?.kind !== "custom";
        await this.supersedeRestartedResults(
          workflow,
          kind === "prepare" ? workflow.reviewers : [],
        );
        const activeReviewSession = reviewSession(workflow);
        const abandonActiveReviewSession =
          kind !== "fix" || (!workflow.reviewModel && !preserveSharedFixSession);
        if (abandonActiveReviewSession) {
          await this.abandonSession(
            workflow,
            activeReviewSession ??
              (kind === "prepare" ? preparationModel(workflow) : consolidationModel(workflow)),
            activeReviewSession?.providerSessionId,
          );
          if (activeReviewSession) this.progress.forget(activeReviewSession.providerSessionId);
        }
        if (workflow.fixSession && workflow.fixSession !== activeReviewSession) {
          await this.abandonSession(
            workflow,
            workflow.fixSession,
            workflow.fixSession.providerSessionId,
          );
          this.progress.forget(workflow.fixSession.providerSessionId);
        }

        if (kind === "prepare") {
          if (
            workflow.validationRun &&
            (workflow.validationRun.status === "planned" ||
              workflow.validationRun.status === "running")
          ) {
            await this.invoke("cancel_review_validation", {
              environmentId: workflow.environmentId,
              run: workflow.validationRun,
            }).catch(() => undefined);
          }
          for (const reviewer of workflow.reviewers) {
            await this.abandonSession(workflow, reviewer, reviewer.providerSessionId);
            if (reviewer.providerSessionId) this.progress.forget(reviewer.providerSessionId);
            resetReviewerForRestart(workflow, reviewer);
          }
          workflow.reviewWorktreeSnapshot = restartedReviewWorktreeSnapshot!;
          workflow.phase = "preparing";
          delete workflow.reviewPackage;
          delete workflow.validationRun;
          delete workflow.validationStopRequested;
          delete workflow.stepRuntimes;
          delete workflow.reviewSnapshotStale;
          clearReviewSession(workflow);
        } else if (kind === "consolidate") {
          workflow.phase = "consolidating";
          delete workflow.stepRuntimes?.consolidate;
          delete workflow.stepRuntimes?.fix;
          clearReviewSession(workflow);
        } else {
          if (!preserveSharedFixSession) {
            delete workflow.fixSession;
            workflow.fixSessionKey = rotatedSessionKey(fixSessionKey(workflow.id));
          }
          delete workflow.stepRuntimes?.fix;
          if (restartedModel) {
            workflow.fixModel = restartedModel;
            if (workflow.fixLaunch?.kind === "custom") {
              workflow.fixLaunch = { ...workflow.fixLaunch, model: restartedModel };
            }
          }
          queueRestartedFix(workflow);
        }

        if (kind === "prepare" && restartedModel) {
          workflow.reviewModel = restartedModel;
          delete workflow.consolidationModel;
        } else if (kind === "consolidate" && restartedModel) {
          workflow.consolidationModel = restartedModel;
        }

        if (kind !== "fix") {
          if (workflow.reviewModel || workflow.consolidationModel) {
            delete workflow.fixSession;
            workflow.fixSessionKey = rotatedSessionKey(fixSessionKey(workflow.id));
          }
          workflow.restartFixAfterConsolidation = shouldReplayFix || undefined;
          delete workflow.consolidatedReport;
        } else {
          delete workflow.restartFixAfterConsolidation;
        }
        delete workflow.fixResult;
        delete workflow.activeRequest;
        delete workflow.pausedFromPhase;
        delete workflow.pausedStep;
        if (kind !== "fix") {
          delete workflow.addressPromptPending;
          delete workflow.addressPromptAttempts;
          clearPendingAddressIdentity(workflow);
          delete workflow.customFixInstruction;
          delete workflow.customFixModel;
          delete workflow.presentationError;
        }
        delete workflow.error;
        const saved = await this.save(workflow, token);
        if (!isSupervisedPhase(saved.phase)) await this.release(workflow, token);
        handedToSupervisor = true;
        void this.advanceNow(workflowId);
        return saved;
      } finally {
        if (!handedToSupervisor && !isSupervisedPhase(phaseAtClaim)) {
          await this.release(workflow, token);
        }
      }
    });
  }

  /** Stop one active backend-owned step without discarding its provider conversation. */
  async pauseStep(workflowId: string, kind: MultiReviewStepKind): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      try {
        const activeStep =
          workflow.phase === "paused" ? workflow.pausedStep : stepForPausablePhase(workflow.phase);
        if (activeStep !== kind) {
          throw new Error(`The ${stepModelLabel(kind)} step is not running`);
        }
        if (workflow.phase !== "paused") {
          workflow.pausedFromPhase = workflow.phase as MultiReviewPausablePhase;
          workflow.pausedStep = kind;
          workflow.phase = "paused";
        }
        const errors = await this.stopStepForPause(workflow, token, kind);
        if (errors.length > 0) {
          workflow.error =
            `Multi Review paused, but stopping the active work could not be confirmed: ${errors.join("; ")}`.slice(
              0,
              4_096,
            );
        } else {
          delete workflow.error;
        }
        return await this.save(workflow, token);
      } finally {
        await this.release(workflow, token);
      }
    });
  }

  /** Resume a paused step by dispatching a fresh request in its retained session. */
  async resumeStep(workflowId: string, kind: MultiReviewStepKind): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      let handedToSupervisor = false;
      try {
        if (
          workflow.phase !== "paused" ||
          workflow.pausedStep !== kind ||
          !workflow.pausedFromPhase
        ) {
          throw new Error(`The ${stepModelLabel(kind)} step is not paused`);
        }
        const errors = await this.stopStepForPause(workflow, token, kind);
        if (errors.length > 0) {
          workflow.error =
            `Multi Review remains paused because active work could not be stopped: ${errors.join("; ")}`.slice(
              0,
              4_096,
            );
          const saved = await this.save(workflow, token);
          return saved;
        }
        workflow.phase = workflow.pausedFromPhase;
        delete workflow.pausedFromPhase;
        delete workflow.pausedStep;
        delete workflow.error;
        const saved = await this.save(workflow, token);
        handedToSupervisor = true;
        void this.advanceNow(workflowId);
        return saved;
      } finally {
        if (!handedToSupervisor) await this.release(workflow, token);
      }
    });
  }

  /** Abort a wedged turn, then continue in the same reviewer session. */
  async unstickReviewer(workflowId: string, reviewerId: string): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      const phaseAtClaim = workflow.phase;
      let handedToSupervisor = false;
      try {
        const reviewer = workflow.reviewers.find((entry) => entry.id === reviewerId);
        if (!reviewer) throw new Error(`Multi review reviewer not found: ${reviewerId}`);
        if (workflow.phase !== "reviewing") {
          throw new Error("A reviewer can only be unstuck while review is running");
        }
        if (
          reviewer.status !== "running" ||
          !reviewer.providerSessionId ||
          reviewer.dispatchState !== "sent"
        ) {
          throw new Error("This reviewer does not have a running turn to unstick");
        }

        const stopped = await this.abortSession(
          workflow,
          token,
          reviewer.providerSessionId,
          reviewer,
        );
        if (!stopped.settled) {
          throw new Error(`The reviewer could not be stopped: ${stopped.error}`);
        }
        if (stopped.status !== "idle") {
          throw new Error(
            "The reviewer session is no longer reusable; restart this reviewer instead",
          );
        }
        this.progress.forget(reviewer.providerSessionId);
        reviewer.requestId = randomUUID();
        reviewer.dispatchState = "prepared";
        reviewer.continuationPrompt = MULTI_REVIEW_UNSTICK_PROMPT;
        delete reviewer.schemaRepairPrompt;
        delete reviewer.idleResultPolls;
        delete reviewer.progressAt;
        delete reviewer.progressDigest;
        delete reviewer.stalledSince;
        delete reviewer.error;
        delete reviewer.completedAt;
        const saved = await this.save(workflow, token);
        handedToSupervisor = true;
        void this.advanceNow(workflowId);
        return saved;
      } finally {
        if (!handedToSupervisor && !isSupervisedPhase(phaseAtClaim)) {
          await this.release(workflow, token);
        }
      }
    });
  }

  async cancel(workflowId: string): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      if (isMultiReviewTerminalPhase(workflow.phase)) return workflow;
      if (workflow.phase === "cancelling") {
        void this.advanceNow(workflowId);
        return workflow;
      }
      workflow.phase = "cancelling";
      workflow.cancellingSince = nowIso();
      delete workflow.pausedFromPhase;
      delete workflow.pausedStep;
      delete workflow.error;
      const saved = await this.save(workflow, token);
      void this.advanceNow(workflowId);
      return saved;
    });
  }

  /**
   * Tear down an entire workflow from one parent-tab close intent.
   *
   * This is intentionally stronger than cancel: every reviewer and fix session
   * is closed, every pane tab owned by the workflow is removed authoritatively,
   * and the durable workflow is deleted so a replacement can start immediately.
   */
  async close(workflowId: string): Promise<void> {
    const closeRequestedAt = nowIso();
    return this.withLock(workflowId, async () => {
      const existing = await this.storage.getMultiReviewWorkflow(workflowId);
      if (!existing) return;
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error("The Multi Review controller is busy");
      const { workflow, token } = controlled;
      try {
        if (!isMultiReviewTerminalPhase(workflow.phase)) {
          throw new Error("Cancel or finish the running Multi Review before deleting it");
        }
        const targets = [
          ...workflow.reviewers.flatMap((reviewer) =>
            reviewer.providerSessionId
              ? [
                  {
                    selection: reviewer as MultiReviewModelSelection,
                    sessionId: reviewer.providerSessionId,
                  },
                ]
              : [],
          ),
          ...(workflow.fixSession?.providerSessionId
            ? [
                {
                  selection: workflow.fixModel,
                  sessionId: workflow.fixSession.providerSessionId,
                },
              ]
            : []),
          ...(workflow.reviewSession?.providerSessionId
            ? [
                {
                  selection: workflow.reviewSession,
                  sessionId: workflow.reviewSession.providerSessionId,
                },
              ]
            : []),
        ];
        const uniqueTargets = [
          ...new Map(
            targets.map((target) => [`${target.selection.agent}:${target.sessionId}`, target]),
          ).values(),
        ];
        if (
          workflow.validationRun &&
          ["planned", "running"].includes(workflow.validationRun.status)
        ) {
          workflow.validationRun = await this.invoke("cancel_review_validation", {
            environmentId: workflow.environmentId,
            run: workflow.validationRun,
          });
        }
        const shutdowns = await Promise.allSettled(
          uniqueTargets.map(async ({ selection, sessionId }) => {
            const provider = await this.provider(workflow, selection);
            const confirmStopped = async (): Promise<void> => {
              const observed = await readProviderStatus(provider, sessionId);
              if (observed.status === "running" || observed.status === "blocked") {
                throw new Error(`session remained ${observed.status} after abort`);
              }
            };
            if (!provider.closeSession) {
              await provider.abort(sessionId);
              await confirmStopped();
              return;
            }
            try {
              await provider.closeSession(sessionId);
            } catch (closeError) {
              try {
                await provider.abort(sessionId);
                await confirmStopped();
              } catch (abortError) {
                throw new Error(
                  `Could not stop ${selection.agent} session ${sessionId}: ` +
                    `${errorMessage(closeError)}; abort also failed: ${errorMessage(abortError)}`,
                );
              }
            }
          }),
        );
        const failures = shutdowns.flatMap((result) =>
          result.status === "rejected" ? [errorMessage(result.reason)] : [],
        );
        if (failures.length > 0) {
          throw new Error(`Could not close Multi Review sessions: ${failures.join("; ")}`);
        }

        // Delete the durable recovery record before its tabs. If the pane write
        // fails, stale tabs can still reconcile against a missing workflow; the
        // inverse would strand a live record with every recovery surface gone.
        await this.storage.deleteMultiReviewWorkflow(workflow.id);
        this.addressDispatchRetryAt.delete(workflow.id);
        const cleanup = await Promise.allSettled([
          this.storage.removeMultiReviewTabs(workflow.environmentId, workflow.id),
          this.syncEnvironmentActivity(workflow.environmentId, closeRequestedAt),
        ]);
        for (const result of cleanup) {
          if (result.status === "rejected") {
            // The destructive commit already succeeded. Returning an error now
            // would make the renderer retain a tab for a workflow that no
            // longer exists; stale durable tabs reconcile away on hydration.
            console.warn("[multi-review] Post-delete cleanup failed:", result.reason);
          }
        }
      } finally {
        // Closing owns only a short-lived destructive claim. Failed provider
        // creation or shutdown must not leave the workflow fenced forever.
        await this.release(workflow, token);
      }
    });
  }

  /**
   * Runs a pass now. Used by user actions and state transitions; a request
   * that arrives while a pass is running reruns it once afterwards. The next
   * periodic pass is scheduled from this one's completion.
   */
  advanceNow(workflowId: string): Promise<void> {
    recordEfficiency(this.options.efficiency, {
      owner: "multi-review",
      operation: "scheduler.wake",
    });
    const run = this.runLocked(workflowId);
    // Same promise for every caller that joins this pass; scheduling the next
    // one is a side effect of completion, not part of what callers await.
    const reschedule = () => void this.scheduler.reschedule(workflowId);
    void run.then(reschedule, reschedule);
    return run;
  }

  /**
   * A timer-driven pass. Unlike {@link advanceNow} it joins a pass already in
   * progress instead of requesting another: a timer that fires during a slow
   * pass is not evidence that anything changed.
   */
  /**
   * Under the adaptive scheduler one `multi-review-tick` attempt is either a
   * reconciliation scan or one workflow's due pass; both are observed so the
   * cost stays comparable with the legacy whole-service tick.
   */
  private runScheduled(workflowId: string): Promise<void> {
    recurringWorkMetrics.requested("multi-review-tick");
    const existing = this.scheduledRuns.get(workflowId);
    if (existing) {
      recurringWorkMetrics.coalesced("multi-review-tick");
      return existing.promise;
    }
    return recurringWorkMetrics.observe("multi-review-tick", (span) => {
      span.work("record-selected");
      return this.runLocked(workflowId);
    });
  }

  /** Workflow IDs storage says need supervision; the scheduler's ground truth. */
  private discoverSupervisedWorkflows(): Promise<string[]> {
    if (this.stopped) return Promise.resolve([]);
    recurringWorkMetrics.requested("multi-review-tick");
    return recurringWorkMetrics.observe("multi-review-tick", async (span) => {
      const records = await this.storage.listAllMultiReviewWorkflows();
      span.work("record-scanned", records.length);
      return records.flatMap((record) =>
        isMultiReviewWorkflow(record.snapshot) &&
        supervisionDemand(record.snapshot, this.options.dispatchAddressPrompt !== undefined) !==
          "none"
          ? [record.id]
          : [],
      );
    });
  }

  /** Next pass for one workflow, computed from the state its last pass left. */
  private async nextDueAt(workflowId: string): Promise<number | undefined> {
    if (this.stopped) return undefined;
    const record = await this.storage.getMultiReviewWorkflow(workflowId);
    if (!record || !isMultiReviewWorkflow(record.snapshot)) return undefined;
    const workflow = record.snapshot;
    const demand = supervisionDemand(workflow, this.options.dispatchAddressPrompt !== undefined);
    if (demand === "none") return undefined;
    const now = Date.now();
    const fastMs = this.options.pollIntervalMs ?? DEFAULT_POLL_MS;
    if (demand === "fast") {
      const retryAt = this.addressDispatchRetryAt.get(workflowId);
      return retryAt !== undefined && retryAt > now ? retryAt : now + fastMs;
    }
    const observeMs =
      this.options.observationIntervalMs ?? this.options.pollIntervalMs ?? DEFAULT_OBSERVATION_MS;
    // Spread workflows restored together across a third of the interval.
    return now + observeMs + stableJitterMs(workflowId, observeMs >= 1_000 ? observeMs / 3 : 0);
  }

  private requestTick(): Promise<void> {
    recurringWorkMetrics.requested("multi-review-tick");
    if (this.tickRun) {
      recurringWorkMetrics.coalesced("multi-review-tick");
      this.tickRun.pending = true;
      return this.tickRun.promise;
    }
    const run = { pending: false, promise: Promise.resolve() };
    run.promise = (async () => {
      do {
        run.pending = false;
        await recurringWorkMetrics.observe("multi-review-tick", () => this.tick());
      } while (run.pending && !this.stopped);
    })().finally(() => {
      if (this.tickRun === run) this.tickRun = null;
    });
    this.tickRun = run;
    return run.promise;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const records = await this.storage.listAllMultiReviewWorkflows();
    recurringWorkMetrics.work("record-scanned", records.length);
    await Promise.all(
      records.flatMap((record) => {
        if (!isMultiReviewWorkflow(record.snapshot)) return [];
        const workflow = record.snapshot;
        if (
          !(
            isSupervisedPhase(workflow.phase) ||
            needsPausedStopReconciliation(workflow) ||
            needsInteractiveFixObservation(workflow) ||
            (workflow.pendingResultConsumptions?.length ?? 0) > 0 ||
            (workflow.addressPromptPending === true && this.options.dispatchAddressPrompt)
          )
        ) {
          return [];
        }
        recurringWorkMetrics.work("record-selected");
        return [this.runLocked(record.id)];
      }),
    );
  }

  private runLocked(workflowId: string): Promise<void> {
    const existing = this.scheduledRuns.get(workflowId);
    if (existing) {
      existing.pending = true;
      return existing.promise;
    }
    const run = { pending: false, promise: Promise.resolve() };
    run.promise = (async () => {
      do {
        run.pending = false;
        await this.withLock(workflowId, async () => {
          try {
            await this.advance(workflowId);
          } catch (error) {
            if (!(error instanceof ControllerFenceError)) {
              await this.fail(workflowId, error);
            }
          }
        });
      } while (run.pending && !this.stopped);
    })().finally(() => {
      if (this.scheduledRuns.get(workflowId) === run) this.scheduledRuns.delete(workflowId);
    });
    this.scheduledRuns.set(workflowId, run);
    return run.promise;
  }

  private withLock<T>(workflowId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(workflowId) ?? Promise.resolve();
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const run = previous.then(operation, operation);
    run.then(resolveResult, rejectResult);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(workflowId, settled);
    void settled.finally(() => {
      if (this.locks.get(workflowId) === settled) this.locks.delete(workflowId);
    });
    return result;
  }

  private async loadControlled(
    workflowId: string,
  ): Promise<{ workflow: MultiReviewWorkflow; token: string } | null> {
    const claimed = await this.storage.claimMultiReviewController(
      workflowId,
      this.ownerId,
      this.controllerLeaseMs(),
    );
    if (!claimed.granted) return null;
    const record = await this.storage.getMultiReviewWorkflow(workflowId);
    if (!record || !isMultiReviewWorkflow(record.snapshot)) return null;
    this.leases.set(workflowId, { token: claimed.token, expiresAt: claimed.expiresAt });
    return {
      workflow: {
        ...record.snapshot,
        controllerFence: claimed.token,
        backendRevision: record.revision,
      },
      token: claimed.token,
    };
  }

  private save(workflow: MultiReviewWorkflow, token: string): Promise<MultiReviewWorkflow> {
    const run = (this.saveTails.get(workflow) ?? Promise.resolve()).then(() =>
      this.saveNow(workflow, token),
    );
    this.saveTails.set(
      workflow,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async saveNow(
    workflow: MultiReviewWorkflow,
    token: string,
  ): Promise<MultiReviewWorkflow> {
    recordEfficiency(this.options.efficiency, {
      owner: "multi-review",
      operation: "workflow.save",
      phase: efficiencyPhase(workflow.phase),
    });
    workflow.updatedAt = nowIso();
    workflow.controllerFence = token;
    const saved = await this.storage.saveMultiReviewWorkflow(
      workflow.id,
      workflow.environmentId,
      MULTI_REVIEW_WORKFLOW_VERSION,
      workflow,
      workflow.backendRevision,
      { ownerId: this.ownerId, token },
    );
    workflow.backendRevision = saved.revision;
    await this.syncWorkflowActivity(workflow);
    return workflow;
  }

  /** Project durable workflow activity into the environment badge source. */
  private async syncWorkflowActivity(workflow: MultiReviewWorkflow): Promise<void> {
    const desired = hasWorkflowActivity(workflow) ? "working" : "idle";
    const environment = await this.storage.getEnvironment(workflow.environmentId);
    if (!environment || environment.agentActivitySources?.["multi-review"]?.state === desired) {
      return;
    }
    await this.storage.setEnvironmentAgentActivity(
      workflow.environmentId,
      desired,
      nowIso(),
      "multi-review",
    );
  }

  /** Recompute the shared activity source after deleting one of several workflows. */
  private async syncEnvironmentActivity(
    environmentId: string,
    occurredAt = nowIso(),
  ): Promise<void> {
    const records = await this.storage.listMultiReviewWorkflows(environmentId);
    const desired = records.some(
      (record) => isMultiReviewWorkflow(record.snapshot) && hasWorkflowActivity(record.snapshot),
    )
      ? "working"
      : "idle";
    const environment = await this.storage.getEnvironment(environmentId);
    if (!environment || environment.agentActivitySources?.["multi-review"]?.state === desired) {
      return;
    }
    await this.storage.setEnvironmentAgentActivity(
      environmentId,
      desired,
      occurredAt,
      "multi-review",
    );
  }

  /** Rehydrate active reviews and clear stale review activity on service boot. */
  private async reconcileEnvironmentActivity(): Promise<void> {
    const [records, environments] = await Promise.all([
      this.storage.listAllMultiReviewWorkflows(),
      this.storage.loadEnvironments(),
    ]);
    const activeEnvironmentIds = new Set(
      records.flatMap((record) =>
        isMultiReviewWorkflow(record.snapshot) && hasWorkflowActivity(record.snapshot)
          ? [record.snapshot.environmentId]
          : [],
      ),
    );
    await Promise.all(
      environments.flatMap((environment) => {
        const desired = activeEnvironmentIds.has(environment.id) ? "working" : "idle";
        if (
          !activeEnvironmentIds.has(environment.id) &&
          !environment.agentActivitySources?.["multi-review"]
        )
          return [];
        if (environment.agentActivitySources?.["multi-review"]?.state === desired) return [];
        return [
          this.storage.setEnvironmentAgentActivity(
            environment.id,
            desired,
            nowIso(),
            "multi-review",
          ),
        ];
      }),
    );
  }

  private async advance(workflowId: string): Promise<void> {
    const existing = await this.storage.getMultiReviewWorkflow(workflowId);
    if (!existing || !isMultiReviewWorkflow(existing.snapshot)) return;
    const existingPhase = existing.snapshot.phase;
    const pendingAddress =
      existingPhase === "interactive" &&
      existing.snapshot.addressPromptPending === true &&
      this.options.dispatchAddressPrompt !== undefined;
    const observingInteractiveFix = needsInteractiveFixObservation(existing.snapshot);
    const reconcilingPausedStop = needsPausedStopReconciliation(existing.snapshot);
    if (
      !pendingAddress &&
      !observingInteractiveFix &&
      !reconcilingPausedStop &&
      !isSupervisedPhase(existingPhase) &&
      !existing.snapshot.pendingResultConsumptions?.length
    )
      return;
    if (pendingAddress && (this.addressDispatchRetryAt.get(workflowId) ?? 0) > Date.now()) return;
    const controlled = await this.loadControlled(workflowId);
    if (!controlled) return;
    const { workflow, token } = controlled;
    if (workflow.pendingResultConsumptions?.length) {
      await this.consumePendingResults(workflow, token);
      return;
    }
    if (needsPausedStopReconciliation(workflow)) {
      await this.advancePausedStop(workflow, token);
    } else if (
      workflow.phase === "interactive" &&
      workflow.addressPromptPending === true &&
      this.options.dispatchAddressPrompt
    ) {
      await this.advanceAddressPrompt(workflow, token);
    } else if (needsInteractiveFixObservation(workflow)) {
      await this.advanceInteractiveFix(workflow, token);
    } else if (workflow.phase === "cancelling") {
      await this.advanceCancellation(workflow, token);
    } else if (workflow.phase === "reviewing") {
      await this.advanceReviewers(workflow, token);
    } else if (
      workflow.phase === "preparing" ||
      workflow.phase === "consolidating" ||
      workflow.phase === "fixing"
    ) {
      await this.advanceFixModel(workflow, token);
    }
  }

  /** Retry a pause whose validation process or provider session did not confirm its stop. */
  private async advancePausedStop(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    const errors = await this.stopStepForPause(workflow, token, workflow.pausedStep!);
    if (errors.length > 0) {
      workflow.error =
        `Multi Review remains paused because active work could not be stopped: ${errors.join("; ")}`.slice(
          0,
          4_096,
        );
    } else {
      delete workflow.error;
    }
    await this.save(workflow, token);
  }

  /** Complete an interactive handoff without relying on a mounted review tab. */
  private async advanceAddressPrompt(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    try {
      const previousFixSession = workflow.fixSession;
      const activateTab = this.foregroundAddressDispatches.delete(workflow.id);
      const dispatched = await this.options.dispatchAddressPrompt!(workflow, { activateTab });
      const result: MultiReviewAddressDispatchResult | undefined =
        dispatched && "fixSession" in dispatched
          ? dispatched
          : dispatched
            ? {
                fixSession: dispatched,
                tabId: workflow.addressTabId ?? `multi-review-fix:${workflow.id}`,
              }
            : undefined;
      const fixSession = result?.fixSession;
      await this.assertFence(workflow.id, token);
      if (fixSession) {
        workflow.fixSession = fixSession;
        if (workflow.customFixModel) {
          workflow.fixModel = workflow.customFixModel;
          workflow.fixSessionKey = fixSession.sessionKey;
        }
      }
      const dispatchedSession = workflow.fixSession;
      if (dispatchedSession) {
        dispatchedSession.status = "running";
        dispatchedSession.startedAt = nowIso();
        delete dispatchedSession.completedAt;
        delete dispatchedSession.idleResultPolls;
        delete dispatchedSession.observedRunning;
        delete dispatchedSession.usageFinalizationPolls;
        beginStepRuntime(workflow, "fix", dispatchedSession);
        if (
          workflow.stepRuntimes?.fix &&
          dispatchedSession.tokenCount === undefined &&
          (!previousFixSession ||
            previousFixSession.providerSessionId !== dispatchedSession.providerSessionId)
        ) {
          workflow.stepRuntimes.fix.tokenBaseline = 0;
        }
      }
      workflow.fixTabId = result?.tabId ?? workflow.addressTabId ?? workflow.fixTabId;
      if (result?.presentationError) workflow.presentationError = result.presentationError;
      else delete workflow.presentationError;
      delete workflow.addressPromptPending;
      delete workflow.addressPromptAttempts;
      clearPendingAddressIdentity(workflow);
      delete workflow.customFixInstruction;
      delete workflow.customFixModel;
      delete workflow.error;
      this.addressDispatchRetryAt.delete(workflow.id);
      await this.save(workflow, token);
      if (
        fixSession &&
        previousFixSession &&
        previousFixSession.providerSessionId !== fixSession.providerSessionId
      ) {
        await this.abandonSession(
          workflow,
          previousFixSession,
          previousFixSession.providerSessionId,
        );
        this.progress.forget(previousFixSession.providerSessionId);
      }
    } catch (error) {
      if (error instanceof ControllerFenceError) throw error;
      const nextError = errorMessage(error).slice(0, 4_096);
      const attempts = (workflow.addressPromptAttempts ?? 0) + 1;
      const missingSession = error instanceof MissingMultiReviewAddressSessionError;
      const invalidState = error instanceof InvalidMultiReviewAddressStateError;
      if (missingSession || invalidState || attempts >= this.maxAddressDispatchAttempts()) {
        // A definitive miss cannot recover under the old provider id. Other
        // persistent failures stop after a bounded budget so activity and user
        // controls cannot remain wedged forever.
        const failedPreparedSession =
          error instanceof MultiReviewAddressDispatchError ? error.preparedSession : undefined;
        if (failedPreparedSession) {
          await this.abandonSession(
            workflow,
            workflow.customFixModel ?? workflow.fixModel,
            failedPreparedSession.providerSessionId,
          );
          this.progress.forget(failedPreparedSession.providerSessionId);
          await this.options
            .invalidateAddressSession?.(workflow, failedPreparedSession)
            .catch(() => undefined);
        }
        workflow.phase = "failed";
        delete workflow.addressPromptPending;
        delete workflow.addressPromptAttempts;
        clearPendingAddressIdentity(workflow);
        delete workflow.customFixInstruction;
        delete workflow.customFixModel;
        delete workflow.activeRequest;
        if (missingSession) {
          if (workflow.fixSession?.providerSessionId) {
            this.progress.forget(workflow.fixSession.providerSessionId);
          }
          workflow.fixSessionKey = rotatedSessionKey(fixSessionKey(workflow.id));
          delete workflow.fixSession;
        }
        workflow.error = nextError;
        this.addressDispatchRetryAt.delete(workflow.id);
        await this.save(workflow, token);
      } else {
        // Keep the exact same durable request pending. The native-agent layer
        // deduplicates it by request id, so retrying after a lost acknowledgement
        // cannot create a second turn. Persist the attempt count so restarts do
        // not reset a permanently failing dispatch to an infinite retry loop.
        workflow.addressPromptAttempts = attempts;
        workflow.error = nextError;
        this.addressDispatchRetryAt.set(workflow.id, Date.now() + this.addressDispatchRetryMs());
        await this.save(workflow, token);
      }
    } finally {
      await this.release(workflow, token);
    }
  }

  /**
   * Reconcile the initial interactive Fix turn after ownership moves to its
   * ordinary native-agent tab. The provider remains authoritative; this copy
   * only keeps the Multi Review card, timing, usage, and activity badge honest.
   */
  private async advanceInteractiveFix(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    const session = workflow.fixSession!;
    try {
      if (!workflow.stepRuntimes?.fix) beginStepRuntime(workflow, "fix", session);
      const provider = await this.provider(workflow, session);
      provider.registerSession?.(session.providerSessionId, {
        origin: "interactive-native",
        interactionPolicy: INTERACTIVE_AGENT_INTERACTION_POLICY,
        phase: "fix",
        workflowId: workflow.id,
        provider: session.agent,
        fence: session.sessionKey,
      });
      const activity = provider.observeActivity
        ? (await provider.observeActivity(session.providerSessionId)).state
        : provider.activity
          ? await provider.activity(session.providerSessionId)
          : undefined;
      let observation: (ProviderSessionObservation & { error?: string }) | undefined;
      if (activity === undefined) {
        observation = await readProviderStatus(provider, session.providerSessionId);
      }
      await this.assertFence(workflow.id, token);
      const activityState =
        activity ??
        (observation?.status === "running"
          ? "working"
          : observation?.status === "blocked"
            ? "waiting"
            : observation?.status === "missing"
              ? "missing"
              : "idle");

      if (activityState === "working" || activityState === "waiting") {
        const hadTerminalPolls =
          session.idleResultPolls !== undefined || session.usageFinalizationPolls !== undefined;
        const activityChanged = session.observedRunning !== true || session.status !== "running";
        delete session.idleResultPolls;
        delete session.usageFinalizationPolls;
        session.observedRunning = true;
        session.status = "running";
        delete session.completedAt;
        delete session.error;
        const refreshedUsage =
          observation?.contextUsage ?? (await provider.refreshUsage?.(session.providerSessionId));
        const usageChanged = await this.refreshFixSessionUsage(
          workflow,
          token,
          provider,
          session,
          refreshedUsage,
          undefined,
          "fix",
        );
        if (activityChanged || hadTerminalPolls || usageChanged) await this.save(workflow, token);
        await this.unclaim(workflow, token);
        return;
      }

      if (
        activityState === "idle" &&
        observation?.status !== "error" &&
        observation?.status !== "missing"
      ) {
        if (session.observedRunning !== true) {
          session.idleResultPolls = (session.idleResultPolls ?? 0) + 1;
          if (session.idleResultPolls <= INTERACTIVE_FIX_INITIAL_IDLE_POLLS) {
            await this.save(workflow, token);
            await this.unclaim(workflow, token);
            return;
          }
        }
        if (observation === undefined) {
          observation = await readProviderStatus(provider, session.providerSessionId);
          await this.assertFence(workflow.id, token);
        }
        if (observation.status === "running" || observation.status === "blocked") {
          delete session.idleResultPolls;
          delete session.usageFinalizationPolls;
          session.observedRunning = true;
          session.status = "running";
          await this.refreshFixSessionUsage(
            workflow,
            token,
            provider,
            session,
            observation.contextUsage,
            undefined,
            "fix",
          );
          await this.save(workflow, token);
          await this.unclaim(workflow, token);
          return;
        }
      }

      observation ??= { status: activityState === "missing" ? "missing" : "idle" };
      const terminalMessages =
        observation.status !== "running" &&
        observation.status !== "blocked" &&
        this.validSessionTokens(observation.contextUsage) === undefined &&
        provider.usageFromMessages
          ? this.readFixSessionMessages(provider, session)
          : undefined;
      await this.refreshFixSessionUsage(
        workflow,
        token,
        provider,
        session,
        observation.contextUsage,
        terminalMessages,
        "fix",
      );

      if (observation.status === "running" || observation.status === "blocked") {
        delete session.idleResultPolls;
        delete session.usageFinalizationPolls;
        session.observedRunning = true;
        session.status = "running";
        await this.save(workflow, token);
        await this.unclaim(workflow, token);
        return;
      }
      if (
        observation.status === "idle" &&
        observation.usagePending === true &&
        (session.usageFinalizationPolls ?? 0) < REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS
      ) {
        session.usageFinalizationPolls = (session.usageFinalizationPolls ?? 0) + 1;
        await this.save(workflow, token);
        await this.unclaim(workflow, token);
        return;
      }

      delete session.idleResultPolls;
      delete session.usageFinalizationPolls;
      session.completedAt = nowIso();
      settleStepRuntime(workflow, "fix");
      if (observation.status === "idle") {
        session.status = "idle";
        delete session.error;
      } else {
        session.status = "failed";
        session.error =
          observation.status === "missing"
            ? "The interactive fix session no longer exists"
            : observation.error
              ? `The interactive fix session failed: ${observation.error}`
              : "The interactive fix session failed";
      }
      await this.save(workflow, token);
      await this.release(workflow, token);
    } catch (error) {
      if (error instanceof ControllerFenceError) throw error;
      console.warn(
        "[multi-review] Reading interactive fix session state failed:",
        errorMessage(error),
      );
      await this.unclaim(workflow, token);
    }
  }

  private async advanceCancellation(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    const waiting: string[] = [];
    if (workflow.validationRun && ["planned", "running"].includes(workflow.validationRun.status)) {
      try {
        workflow.validationRun = await this.invoke<ReviewValidationRun>(
          "cancel_review_validation",
          {
            environmentId: workflow.environmentId,
            run: workflow.validationRun,
          },
        );
      } catch {
        waiting.push("validation commands have not stopped");
      }
    }

    for (const reviewer of workflow.reviewers) {
      if (reviewer.status !== "running" || !reviewer.providerSessionId) continue;
      const result = await this.abortSession(workflow, token, reviewer.providerSessionId, reviewer);
      if (!result.settled) waiting.push(`reviewer ${reviewer.id}: ${result.error}`);
    }
    if (workflow.fixSession?.status === "running") {
      const result = await this.abortSession(
        workflow,
        token,
        workflow.fixSession.providerSessionId,
        workflow.fixModel,
      );
      if (!result.settled) waiting.push(`fix model: ${result.error}`);
    }
    if (workflow.reviewSession?.status === "running") {
      const result = await this.abortSession(
        workflow,
        token,
        workflow.reviewSession.providerSessionId,
        workflow.reviewSession,
      );
      if (!result.settled) waiting.push(`review preparation model: ${result.error}`);
    }
    const started = workflow.cancellingSince ? Date.parse(workflow.cancellingSince) : Number.NaN;
    const timedOut =
      Number.isFinite(started) &&
      Date.now() - started >= (this.options.cancellationDeadlineMs ?? CANCELLATION_DEADLINE_MS);
    if (waiting.length > 0 && !timedOut) {
      workflow.error =
        `Cancellation is waiting for provider sessions to stop: ${waiting.join("; ")}`.slice(
          0,
          4_096,
        );
      await this.save(workflow, token);
      return;
    }
    for (const reviewer of workflow.reviewers) {
      if (reviewer.status === "pending" || reviewer.status === "running") {
        reviewer.status = "cancelled";
      }
    }
    if (workflow.fixSession?.status === "running") workflow.fixSession.status = "cancelled";
    if (workflow.reviewSession?.status === "running") workflow.reviewSession.status = "cancelled";
    if (workflow.activeRequest) settleStepRuntime(workflow, workflow.activeRequest.kind);
    const cancelledResultKeys = [
      ...(workflow.activeRequest?.resultTransport === "tool-v1"
        ? [workflow.activeRequest.requestId]
        : []),
      ...workflow.reviewers.flatMap((reviewer) =>
        reviewer.resultTransport === "tool-v1" && reviewer.requestId ? [reviewer.requestId] : [],
      ),
    ];
    workflow.phase = "cancelled";
    if (timedOut && waiting.length > 0) {
      workflow.error =
        `Cancellation timed out while provider sessions were still active: ${waiting.join("; ")}`.slice(
          0,
          4_096,
        );
    } else {
      delete workflow.error;
    }
    await Promise.all(
      cancelledResultKeys.map((resultKey) =>
        this.options.workflowResults?.close(resultKey, "cancelled"),
      ),
    );
    delete workflow.cancellingSince;
    delete workflow.activeRequest;
    await this.save(workflow, token);
    await this.release(workflow, token);
  }

  private async abortSession(
    workflow: MultiReviewWorkflow,
    token: string,
    providerSessionId: string,
    selection: MultiReviewModelSelection,
  ): Promise<{ settled: boolean; error: string; status?: ProviderStatus }> {
    try {
      const provider = await this.provider(workflow, selection);
      await this.assertFence(workflow.id, token);
      let abortError: unknown;
      try {
        await provider.abort(providerSessionId);
        await this.assertFence(workflow.id, token);
      } catch (error) {
        if (error instanceof ControllerFenceError) throw error;
        abortError = error;
      }
      try {
        // Read as data: a session whose turn ended terminally is stopped, which
        // is what settles the abort. Letting that throw reported a successful
        // abort as unsettled whenever the provider explained why it failed.
        const { status } = await readProviderStatus(provider, providerSessionId);
        await this.assertFence(workflow.id, token);
        if (status === "idle" || status === "missing" || status === "error") {
          return { settled: true, error: "", status };
        }
        return {
          settled: false,
          error: abortError ? errorMessage(abortError) : `provider still reports ${status}`,
          status,
        };
      } catch (statusError) {
        if (statusError instanceof ControllerFenceError) throw statusError;
        return {
          settled: false,
          error: abortError
            ? `${errorMessage(abortError)}; status check failed: ${errorMessage(statusError)}`
            : `status check failed: ${errorMessage(statusError)}`,
        };
      }
    } catch (error) {
      if (error instanceof ControllerFenceError) throw error;
      return { settled: false, error: errorMessage(error) };
    }
  }

  /** Finish the destructive half of pause; safe to repeat before resume. */
  private async stopStepForPause(
    workflow: MultiReviewWorkflow,
    token: string,
    kind: MultiReviewStepKind,
  ): Promise<string[]> {
    const errors: string[] = [];
    if (
      kind === "prepare" &&
      workflow.validationRun &&
      (workflow.validationRun.status === "planned" || workflow.validationRun.status === "running")
    ) {
      try {
        const cancelled = await this.invoke<ReviewValidationRun>("cancel_review_validation", {
          environmentId: workflow.environmentId,
          run: workflow.validationRun,
        });
        await this.assertFence(workflow.id, token);
        if (cancelled.status === "planned" || cancelled.status === "running") {
          workflow.validationRun = cancelled;
          errors.push(`validation: provider still reports ${cancelled.status}`);
        } else {
          delete workflow.validationRun;
        }
      } catch (error) {
        if (error instanceof ControllerFenceError) throw error;
        errors.push(`validation: ${errorMessage(error)}`);
      }
    }

    const session = kind === "fix" ? workflow.fixSession : reviewSession(workflow);
    const selection =
      session ??
      (kind === "fix"
        ? workflow.fixModel
        : kind === "prepare"
          ? preparationModel(workflow)
          : consolidationModel(workflow));
    if (session?.status === "running") {
      const stopped = await this.abortSession(
        workflow,
        token,
        session.providerSessionId,
        selection,
      );
      if (!stopped.settled) {
        errors.push(`${stepModelLabel(kind)} session: ${stopped.error}`);
      } else {
        session.status = "idle";
        session.completedAt = nowIso();
        delete session.idleResultPolls;
        delete session.usageFinalizationPolls;
        delete session.observedRunning;
        delete session.progressAt;
        delete session.progressDigest;
        delete session.stalledSince;
        this.progress.forget(session.providerSessionId);
      }
    }

    if (errors.length === 0) {
      await this.supersedeRestartedResults(workflow, []);
      delete workflow.activeRequest;
      settleStepRuntime(workflow, kind);
    }
    return errors;
  }

  /**
   * Best-effort abort of a session this workflow is about to stop tracking.
   * Failure is tolerated: the retry must still proceed, and a provider that
   * cannot confirm the abort is no worse than the session being dropped.
   */
  private async abandonSession(
    workflow: MultiReviewWorkflow,
    selection: MultiReviewModelSelection,
    providerSessionId: string | undefined,
  ): Promise<void> {
    if (!providerSessionId) return;
    const key = this.providerKey(workflow, selection);
    try {
      // One-shot cleanup must not register the workflow as a long-lived user of
      // a provider it is about to stop tracking.
      const provider = await this.providerInstance(workflow, selection);
      await provider.abort(providerSessionId);
    } catch {
      // Intentionally ignored; the caller is discarding this session either way.
    } finally {
      await this.disposeProviderIfUnused(key);
    }
  }

  /** Deny late tool submissions owned by a generation being replaced. */
  private async supersedeRestartedResults(
    workflow: MultiReviewWorkflow,
    reviewers: MultiReviewWorkflow["reviewers"],
  ): Promise<void> {
    const keys = new Set<string>();
    const alreadyApplied = new Set(workflow.pendingResultConsumptions ?? []);
    if (workflow.activeRequest?.resultTransport === "tool-v1") {
      keys.add(workflow.activeRequest.requestId);
    }
    for (const reviewer of reviewers) {
      if (reviewer.resultTransport === "tool-v1" && reviewer.requestId) {
        keys.add(reviewer.requestId);
      }
    }
    for (const resultKey of alreadyApplied) keys.delete(resultKey);
    await Promise.all(
      Array.from(keys, (resultKey) => this.options.workflowResults?.close(resultKey, "superseded")),
    );
  }

  /**
   * The reviewer fan-out, as this workflow's owner sees it.
   *
   * Everything inside one reviewer's turn is the shared runner's business.
   * What stays here is what only Multi Review knows: where the state is
   * persisted, which lease fences it, and what the phase becomes once every
   * reviewer has settled.
   */
  private reviewFanoutHost(workflow: MultiReviewWorkflow, token: string): ReviewFanoutHost {
    return {
      workflowId: workflow.id,
      targetBranch: workflow.targetBranch,
      reviewInstruction: workflow.reviewInstruction,
      label: "Multi Review",
      sessionKeyFor: (reviewer) =>
        reviewer.sessionKey ?? reviewerSessionKey(workflow.id, reviewer.id),
      sessionLabelFor: (_reviewer, index) => `Multi Review · Reviewer ${index + 1}`,
      provider: (selection) => this.provider(workflow, selection),
      executionPolicy: () => this.executionPolicy(workflow),
      agentMcp: (selection, resultKey) =>
        this.workflowAgentMcp(workflow, resultKey, selection.agent),
      ...(this.options.workflowResults
        ? {
            supportsToolResult: (selection: MultiReviewModelSelection) =>
              this.workflowToolEnabled(selection.agent, "review-report"),
            prepareResult: async (
              selection: MultiReviewModelSelection,
              requestId: string,
              schema: JsonSchema,
            ) =>
              this.options.workflowResults!.prepare({
                resultKey: requestId,
                kind: "review-report",
                environmentId: workflow.environmentId,
                projectId: workflow.projectId,
                provider: selection.agent,
                schema,
              }),
            projectResult: (requestId: string) =>
              this.options.workflowResults!.projection(requestId),
            readResult: <T>(requestId: string) =>
              this.options.workflowResults!.structured<T>(requestId),
            consumeResult: (requestId: string) => this.options.workflowResults!.consume(requestId),
            stageResultConsumption: (requestId: string) => {
              workflow.pendingResultConsumptions = Array.from(
                new Set([...(workflow.pendingResultConsumptions ?? []), requestId]),
              );
            },
            finishResultConsumption: (requestId: string) => {
              const pending = (workflow.pendingResultConsumptions ?? []).filter(
                (candidate) => candidate !== requestId,
              );
              if (pending.length > 0) workflow.pendingResultConsumptions = pending;
              else delete workflow.pendingResultConsumptions;
            },
            closeResult: (requestId: string) =>
              this.options.workflowResults!.close(requestId, "superseded"),
          }
        : {}),
      save: async () => {
        await this.save(workflow, token);
      },
      assertFence: () => this.assertFence(workflow.id, token),
      reviewerMode: workflow.reviewPackage ? "plan" : "build",
      ...(workflow.reviewPackage
        ? {
            beforeAdmission: () => this.verifyReviewEvidence(workflow, token, "fanout"),
            reviewerPrompt: async (index: number, count: number) => {
              if (this.options.evidencePermits === false) {
                await this.assertReviewPackageIntegrity(workflow, token);
              }
              return createPackagedMultiReviewerPrompt({
                reviewPackage: workflow.reviewPackage!,
                reviewInstruction: workflow.reviewInstruction,
                reviewerNumber: index + 1,
                reviewerCount: count,
              });
            },
          }
        : {}),
      reviewSnapshot: async () =>
        promptWorktreeSnapshot(await this.reviewSnapshotForDispatch(workflow, token)),
      worktreeChangedDuringReview: () =>
        !workflow.reviewPackage && workflow.reviewSnapshotStale === true,
      resolveUnattendedInteractions: (provider, providerSessionId) =>
        this.resolveUnattendedInteractions(workflow, token, provider, providerSessionId),
      abandonSession: (selection, providerSessionId) =>
        this.abandonSession(workflow, selection, providerSessionId),
      captureReviewerUsage: true,
      progress: this.progress,
      stallWarningMs: this.stallWarningMs(),
      stallAbandonMs: this.stallAbandonMs(),
      concurrency: this.options.reviewFanoutConcurrency,
      efficiency: this.options.efficiency,
      efficiencyOwner: "multi-review",
    };
  }

  private async advanceReviewers(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    // Reviewer admission decides a transport, so the rollout snapshot has to be
    // current before the runner asks whether tool mode is allowed.
    await this.workflowRollout.refresh();
    const runner = new ReviewFanoutRunner(this.reviewFanoutHost(workflow, token));
    const outcome = await runner.advanceReviewers(workflow.reviewers);
    if (outcome.kind === "working") return;
    if (outcome.kind === "ready") {
      workflow.phase = "consolidating";
      delete workflow.error;
      await this.save(workflow, token);
      return;
    }
    workflow.phase = "failed";
    workflow.error = outcome.error;
    await this.save(workflow, token);
    await this.release(workflow, token);
  }

  /**
   * The preparation, consolidation, and fix session carries the same hazard as a reviewer: it
   * can report `running` forever while a sub-agent it is waiting on has stopped
   * producing anything. Abandoning it fails the workflow, which is recoverable
   * through Retry, rather than leaving it supervised indefinitely.
   */
  private async observeFixSessionProgress(
    workflow: MultiReviewWorkflow,
    token: string,
    provider: BuildPipelineProvider,
    session: NonNullable<MultiReviewWorkflow["fixSession"]>,
    observedUsage: { sessionTokens?: number } | undefined,
    kind: MultiReviewStepKind,
  ): Promise<void> {
    const previousDigest = session.progressDigest;
    let usageChanged = await this.refreshFixSessionUsage(
      workflow,
      token,
      provider,
      session,
      observedUsage,
      undefined,
    );
    const needsTranscriptUsage =
      this.validSessionTokens(observedUsage) === undefined &&
      provider.usageFromMessages !== undefined;
    let messages: Promise<unknown[]> | undefined;
    const observation = await this.progress.observe(
      session.providerSessionId,
      async () => {
        messages = needsTranscriptUsage
          ? this.readFixSessionMessages(provider, session)
          : provider.messages(session.providerSessionId, {
              limit: PROGRESS_TRANSCRIPT_TAIL_MESSAGES,
            });
        return (await messages).slice(-PROGRESS_TRANSCRIPT_TAIL_MESSAGES);
      },
      session.progressDigest,
    );
    if (needsTranscriptUsage && messages) {
      const transcriptUsageChanged = await this.refreshFixSessionUsage(
        workflow,
        token,
        provider,
        session,
        undefined,
        messages,
      );
      usageChanged = usageChanged || transcriptUsageChanged;
    }
    await this.assertFence(workflow.id, token);
    const decision = commitProgressObservation(session, observation);
    if (decision === "reset" || decision === "hold") {
      await this.save(workflow, token);
      return;
    }
    const changed = usageChanged || session.progressDigest !== previousDigest;
    const elapsedMs = noProgressElapsedMs(session.progressAt, session.startedAt);
    if (elapsedMs === null) {
      if (changed) await this.save(workflow, token);
      return;
    }
    if (elapsedMs >= this.stallAbandonMs()) {
      await this.abandonSession(workflow, session, session.providerSessionId);
      this.progress.forget(session.providerSessionId);
      throw new Error(
        `The ${stepModelLabel(kind)} session produced no activity for ${stalledMinutes(elapsedMs)} minutes`,
      );
    }
    if (elapsedMs >= this.stallWarningMs() && session.stalledSince === undefined) {
      session.stalledSince = nowIso();
      await this.save(workflow, token);
      return;
    }
    if (changed) await this.save(workflow, token);
  }

  /**
   * Reads the transcript tail once for the providers that meter usage from it.
   *
   * The promise deliberately remains rejectable. The progress tracker treats a
   * failed read as "nothing learned", while usage metering catches and logs the
   * same rejection without failing the supervised turn.
   */
  private readFixSessionMessages(
    provider: BuildPipelineProvider,
    session: NonNullable<MultiReviewWorkflow["fixSession"]>,
  ): Promise<unknown[]> {
    const limit = provider.usageMessageLimit;
    return provider.messages(session.providerSessionId, limit === undefined ? {} : { limit });
  }

  private validSessionTokens(usage: { sessionTokens?: number } | undefined): number | undefined {
    const reported = usage?.sessionTokens;
    return typeof reported === "number" && Number.isSafeInteger(reported) && reported >= 0
      ? reported
      : undefined;
  }

  /**
   * Copies the session's cumulative token counter into the workflow and
   * attributes the growth since dispatch to the step that is running.
   *
   * One session serves all three steps, so its counter alone cannot say what
   * preparation cost as distinct from consolidation. The dispatch baseline is
   * the difference, and the step keeps the delta after the session moves on.
   */
  private async refreshFixSessionUsage(
    workflow: MultiReviewWorkflow,
    token: string,
    provider: BuildPipelineProvider,
    session: NonNullable<MultiReviewWorkflow["fixSession"]>,
    observedUsage: { sessionTokens?: number } | undefined,
    messages: Promise<unknown[]> | undefined,
    runtimeKind?: MultiReviewStepKind,
  ): Promise<boolean> {
    try {
      const observed = this.validSessionTokens(observedUsage);
      const usage =
        observed === undefined && provider.usageFromMessages && messages
          ? provider.usageFromMessages(await messages)
          : undefined;
      const reported = observed ?? this.validSessionTokens(usage);
      if (reported === undefined) return false;
      await this.assertFence(workflow.id, token);
      const tokenCount = Math.max(session.tokenCount ?? 0, reported);
      const kind = runtimeKind ?? workflow.activeRequest?.kind;
      const runtime = kind ? workflow.stepRuntimes?.[kind] : undefined;
      const stepTokens =
        runtime?.tokenBaseline === undefined
          ? undefined
          : Math.max(0, tokenCount - runtime.tokenBaseline);
      if (
        session.tokenCount === tokenCount &&
        (runtime === undefined || runtime.tokenCount === stepTokens)
      ) {
        return false;
      }
      session.tokenCount = tokenCount;
      if (runtime) runtime.tokenCount = stepTokens;
      return true;
    } catch (error) {
      if (error instanceof ControllerFenceError) throw error;
      console.warn("[multi-review] Reading fix session token usage failed:", errorMessage(error));
      return false;
    }
  }

  private stallWarningMs(): number {
    return this.options.stallWarningMs ?? DEFAULT_STALL_WARNING_MS;
  }

  private stallAbandonMs(): number {
    return this.options.stallAbandonMs ?? DEFAULT_STALL_ABANDON_MS;
  }

  private async advanceValidation(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    let run = workflow.validationRun!;
    if (run.status === "planned" || run.status === "running") {
      run = await this.invoke<ReviewValidationRun>(
        workflow.validationStopRequested === true
          ? "cancel_review_validation"
          : run.status === "planned"
            ? "start_review_validation"
            : "status_review_validation",
        {
          environmentId: workflow.environmentId,
          run,
        },
      );
      await this.assertFence(workflow.id, token);
      workflow.validationRun = run;
      await this.save(workflow, token);
      if (run.status === "planned" || run.status === "running") return;
    }
    const preparation = validationPreparation(run, {
      allowCancelled: workflow.validationStopRequested === true,
    });
    const sealingStarted = Date.now();
    const generated = await this.invoke<unknown>("generate_looped_review_package", {
      environmentId: workflow.environmentId,
      packageId: run.id,
      round: 1,
      targetBranch: workflow.targetBranch,
      preparation,
      expectedHead: run.plan.headRef,
      validationPlan: run.plan,
    });
    await this.assertFence(workflow.id, token);
    run.sealingDurationMs = Date.now() - sealingStarted;
    workflow.reviewPackage = parseReviewPackageReference(generated, {
      id: run.id,
      round: 1,
      targetBranch: workflow.targetBranch,
    });
    workflow.phase = "reviewing";
    delete workflow.validationStopRequested;
    settleStepRuntime(workflow, "prepare");
    delete workflow.activeRequest;
    delete workflow.reviewSnapshotStale;
    await this.save(workflow, token);
  }

  private async advanceFixModel(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    if (workflow.phase === "preparing" && workflow.validationRun) {
      await this.advanceValidation(workflow, token);
      return;
    }
    const preparing = workflow.phase === "preparing";
    const coordinating = preparing || workflow.phase === "consolidating";
    const separateReviewSession =
      coordinating &&
      (workflow.reviewModel !== undefined || workflow.consolidationModel !== undefined);
    const selection = preparing
      ? preparationModel(workflow)
      : workflow.phase === "consolidating"
        ? consolidationModel(workflow)
        : workflow.fixModel;
    const provider = await this.provider(workflow, selection);
    await this.assertFence(workflow.id, token);
    let session = coordinating ? reviewSession(workflow) : workflow.fixSession;
    if (session && coordinating && !sameModelSelection(session, selection)) {
      await this.abandonSession(workflow, session, session.providerSessionId);
      this.progress.forget(session.providerSessionId);
      clearReviewSession(workflow);
      session = undefined;
      await this.save(workflow, token);
    }
    if (!session) {
      const sessionKey = separateReviewSession
        ? (workflow.reviewSessionKey ?? reviewSessionKey(workflow.id))
        : (workflow.fixSessionKey ?? fixSessionKey(workflow.id));
      const providerSessionId = await provider.createSession(
        "review",
        preparing ? "Multi Review · Prepare review package" : "Multi Review · Consolidation",
        {
          clientSessionKey: sessionKey,
          ...(preparing ? { mode: "build" as const, readOnly: false } : READ_ONLY_REPORT_TURN),
          model: selection.model === "default" ? undefined : selection.model,
          effort: selection.reasoningEffort,
          ...(typeof selection.fastMode === "boolean" ? { fastMode: selection.fastMode } : {}),
          policy: await this.executionPolicy(workflow),
          interaction: {
            origin: "looped-review",
            interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
            phase: "review",
            workflowId: workflow.id,
            provider: selection.agent,
            fence: sessionKey,
          },
        },
      );
      await this.assertFence(workflow.id, token);
      session = {
        ...selection,
        sessionKey,
        providerSessionId,
        requestIds: [],
        status: "running",
        startedAt: nowIso(),
      };
      if (separateReviewSession) {
        workflow.reviewSession = session;
        workflow.reviewSessionKey = sessionKey;
      } else {
        workflow.fixSession = session;
        workflow.fixSessionKey = sessionKey;
      }
      await this.save(workflow, token);
    }
    provider.registerSession?.(session.providerSessionId, {
      origin: "looped-review",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: workflow.phase === "fixing" ? "fix" : "review",
      workflowId: workflow.id,
      provider: selection.agent,
      fence: session.sessionKey,
    });
    let runtimeBackfilled = backfillActiveStepRuntime(workflow, session);
    if (
      !workflow.stepRuntimes &&
      !workflow.activeRequest &&
      workflow.phase === "consolidating" &&
      session.completedAt
    ) {
      workflow.stepRuntimes = {
        prepare: {
          startedAt: session.startedAt,
          completedAt: session.completedAt,
          ...(session.tokenCount === undefined ? {} : { tokenCount: session.tokenCount }),
          tokenBaseline: 0,
        },
      };
      runtimeBackfilled = true;
    }
    if (runtimeBackfilled) await this.save(workflow, token);
    if (!workflow.activeRequest) {
      const requestId = randomUUID();
      const kind = preparing ? "prepare" : workflow.phase === "fixing" ? "fix" : "consolidate";
      await this.workflowRollout.refresh();
      workflow.activeRequest = {
        kind,
        requestId,
        state: "prepared",
        resultTransport: this.workflowToolEnabled(selection.agent, this.stepResultKind(kind))
          ? "tool-v1"
          : "structured-output-v1",
        ...(this.workflowToolEnabled(selection.agent, this.stepResultKind(kind))
          ? { resultSubmission: "preparing" as const }
          : {}),
        createdAt: nowIso(),
      };
      session.requestIds.push(requestId);
      session.status = "running";
      session.startedAt = nowIso();
      delete session.completedAt;
      delete session.progressAt;
      delete session.progressDigest;
      delete session.stalledSince;
      beginStepRuntime(workflow, kind, session);
      await this.save(workflow, token);
    }
    const request = workflow.activeRequest;
    const modelLabel = stepModelLabel(request.kind);
    const resultLabel = stepResultLabel(request.kind);
    if (request.state === "prepared") {
      // Built while the dispatch is still unjournaled, for the same reason the
      // reviewer prompt is: the worktree probe must not widen the window in
      // which a crash leaves the turn ambiguous. A schema repair re-sends an
      // already-answered prompt and is not re-gated.
      let prompt = request.schemaRepairPrompt;
      if (!prompt) {
        if (request.kind === "prepare") {
          prompt = reviewValidationDiscoveryPrompt(workflow.targetBranch);
        } else if (request.kind === "consolidate") {
          const reviewSnapshot = workflow.reviewPackage
            ? undefined
            : await this.reviewSnapshotForDispatch(workflow, token);
          if (workflow.reviewPackage) {
            await this.verifyReviewEvidence(workflow, token, "consolidation");
          }
          prompt = createMultiReviewConsolidationPrompt({
            targetBranch: workflow.targetBranch,
            worktree: reviewSnapshot ? promptWorktreeSnapshot(reviewSnapshot) : undefined,
            worktreeChangedDuringReview:
              !workflow.reviewPackage && workflow.reviewSnapshotStale === true,
            reviewPackage: workflow.reviewPackage,
            reports: consolidationReports(workflow.reviewers),
            onEvidenceStats: (stats) =>
              recordEfficiency(this.options.efficiency, {
                owner: "multi-review",
                operation: "consolidation.input",
                phase: "consolidating",
                reviewers: stats.reviewers,
                count: stats.sourceFindings,
                bytes: stats.compactBytes,
              }),
          });
        } else {
          prompt = addressPrompt(workflow.consolidatedReport!);
        }
      }
      await this.assertFence(workflow.id, token);
      const schema =
        request.kind === "prepare"
          ? REVIEW_VALIDATION_PLAN_SCHEMA
          : request.kind === "consolidate"
            ? (STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema)
            : REVIEW_FIX_RESULT_JSON_SCHEMA;
      const resultKind: WorkflowResultKind =
        request.kind === "prepare"
          ? "validation-plan"
          : request.kind === "consolidate"
            ? "consolidated-review"
            : "fix-result";
      const agentMcp =
        request.resultTransport === "tool-v1"
          ? await this.workflowAgentMcp(workflow, request.requestId, selection.agent)
          : undefined;
      if (request.resultTransport === "tool-v1" && this.options.workflowResults) {
        await this.options.workflowResults.prepare({
          resultKey: request.requestId,
          kind: resultKind,
          environmentId: workflow.environmentId,
          projectId: workflow.projectId,
          provider: selection.agent,
          schema,
          ...(request.kind === "consolidate"
            ? { context: consolidationResultContext(workflow.reviewers) }
            : {}),
        });
      }
      // Same reason as the reviewer dispatch: pay the cold start before the
      // at-most-once window rather than inside it.
      await attachAgentBeforeDispatch(
        provider,
        session.providerSessionId,
        agentMcp
          ? {
              agentMcp,
              workflowResultTool: workflowResultToolName(resultKind),
            }
          : undefined,
      );
      request.state = "dispatching";
      await this.save(workflow, token);
      try {
        await provider.send(
          session.providerSessionId,
          request.resultTransport === "tool-v1"
            ? `${prompt}\n\n${workflowResultInstruction(resultKind, request.requestId, {
                capability: agentMcp?.workflowResultCapability,
              })}`
            : prompt,
          {
            requestId: request.requestId,
            schema: request.resultTransport === "tool-v1" ? undefined : schema,
            ...(request.kind === "consolidate"
              ? READ_ONLY_REPORT_TURN
              : { mode: "build" as const, readOnly: false }),
            model: selection.model === "default" ? undefined : selection.model,
            effort: selection.reasoningEffort,
            ...(typeof selection.fastMode === "boolean" ? { fastMode: selection.fastMode } : {}),
            ...(agentMcp ? { agentMcp } : {}),
            ...(agentMcp ? { workflowResultTool: workflowResultToolName(resultKind) } : {}),
          },
        );
      } catch (error) {
        if (error instanceof AmbiguousPromptDispatchError) return;
        request.state = "prepared";
        await this.save(workflow, token);
        if (error instanceof ProviderDispatchPreparationError) return;
        throw error;
      }
      await this.assertFence(workflow.id, token);
      request.state = "sent";
      await this.save(workflow, token);
    }
    if (request.state === "dispatching") {
      request.state = "sent";
      await this.save(workflow, token);
    }
    await this.resolveUnattendedInteractions(workflow, token, provider, session.providerSessionId);
    // Read as data so the terminal-failure branch below fires whether or not
    // the provider explained itself, and can report the explanation when it did.
    const observation = await readProviderStatus(
      provider,
      session.providerSessionId,
      request.requestId,
    );
    const { status, error: statusDetail } = observation;
    await this.assertFence(workflow.id, token);
    if (status === "idle" && observation.turnSettled === false) return;
    if (status === "running") {
      if (request.idleResultPolls !== undefined || request.usageFinalizationPolls !== undefined) {
        delete request.idleResultPolls;
        delete request.usageFinalizationPolls;
        await this.save(workflow, token);
      }
      await this.observeFixSessionProgress(
        workflow,
        token,
        provider,
        session,
        observation.contextUsage,
        request.kind,
      );
      return;
    }
    const terminalMessages =
      this.validSessionTokens(observation.contextUsage) === undefined && provider.usageFromMessages
        ? this.readFixSessionMessages(provider, session)
        : undefined;
    const usageChanged = await this.refreshFixSessionUsage(
      workflow,
      token,
      provider,
      session,
      observation.contextUsage,
      terminalMessages,
    );
    if (usageChanged) await this.save(workflow, token);
    if (status === "blocked") {
      // Unattended interactions were already resolved above; a provider still
      // reporting blocked cannot be waited on indefinitely.
      request.idleResultPolls = (request.idleResultPolls ?? 0) + 1;
      await this.save(workflow, token);
      if (request.idleResultPolls >= MAX_IDLE_RESULT_POLLS) {
        throw new Error(`The ${modelLabel} model stayed blocked without a resolvable interaction`);
      }
      return;
    }
    if (status === "error" || status === "missing") {
      throw new Error(
        status === "missing"
          ? `The ${modelLabel} session no longer exists`
          : statusDetail
            ? `The ${modelLabel} session failed: ${statusDetail}`
            : `The ${modelLabel} session failed`,
      );
    }
    if (request.resultTransport === "tool-v1") {
      request.resultSubmission = await this.options.workflowResults?.projection(request.requestId);
    }
    const result =
      request.resultTransport === "tool-v1"
        ? ((await this.options.workflowResults?.structured<unknown>(request.requestId)) ?? null)
        : await provider.structured<unknown>(session.providerSessionId, request.requestId);
    await this.assertFence(workflow.id, token);
    if (!result) {
      if (observation.backgroundWorkLive) {
        // Waiting on background agents it launched is progress, not idleness;
        // the transcript stall clock still bounds it.
        if (request.idleResultPolls !== undefined) {
          delete request.idleResultPolls;
          await this.save(workflow, token);
        }
        await this.observeFixSessionProgress(
          workflow,
          token,
          provider,
          session,
          observation.contextUsage,
          request.kind,
        );
        return;
      }
      request.idleResultPolls = (request.idleResultPolls ?? 0) + 1;
      await this.save(workflow, token);
      if (request.idleResultPolls >= MAX_IDLE_RESULT_POLLS) {
        throw new Error(`The ${modelLabel} model became idle without returning its ${resultLabel}`);
      }
      return;
    }
    if (
      observation.usagePending === true &&
      (request.usageFinalizationPolls ?? 0) < REVIEW_FANOUT_MAX_FINAL_USAGE_POLLS
    ) {
      request.usageFinalizationPolls = (request.usageFinalizationPolls ?? 0) + 1;
      await this.save(workflow, token);
      return;
    }
    delete request.usageFinalizationPolls;
    if (request.kind === "prepare") {
      if (
        !result.ok &&
        result.error.code !== "schema_retry_exhausted" &&
        result.error.code !== "malformed_output"
      )
        throw new Error(result.error.message);
      if (
        result.ok &&
        result.value &&
        typeof result.value === "object" &&
        "commands" in result.value
      ) {
        let plan;
        try {
          plan = parseReviewValidationPlan(result.value);
        } catch (error) {
          await this.prepareFixSessionSchemaRepair(
            workflow,
            token,
            request,
            session,
            new FixResultValidationError(errorMessage(error)),
          );
          return;
        }
        workflow.validationRun = newReviewValidationRun(`review-validation-${randomUUID()}`, plan);
        workflow.validationRun.discoveryDurationMs = Math.max(
          0,
          Date.now() - Date.parse(session.startedAt),
        );
        session.status = "idle";
        session.completedAt = nowIso();
        delete session.stalledSince;
        this.stageWorkflowResultConsumption(workflow, request);
        await this.save(workflow, token);
        await this.consumePendingResults(workflow, token);
        return;
      }
      let preparation: ReturnType<typeof parseReviewPreparationResult>;
      try {
        if (!result.ok) throw new Error(result.error.message);
        preparation = parseReviewPreparationResult(result.value);
      } catch (error) {
        await this.prepareFixSessionSchemaRepair(
          workflow,
          token,
          request,
          session,
          new FixResultValidationError(errorMessage(error)),
        );
        return;
      }
      const packageId = this.reviewPackageId(workflow);
      const generated = await this.invoke<unknown>("generate_looped_review_package", {
        environmentId: workflow.environmentId,
        packageId,
        round: 1,
        targetBranch: workflow.targetBranch,
        preparation,
      });
      await this.assertFence(workflow.id, token);
      workflow.reviewPackage = parseReviewPackageReference(generated, {
        id: packageId,
        round: 1,
        targetBranch: workflow.targetBranch,
      });
      workflow.phase = "reviewing";
      session.status = "idle";
      session.completedAt = nowIso();
      settleStepRuntime(workflow, "prepare");
      delete workflow.activeRequest;
      delete workflow.reviewSnapshotStale;
      this.stageWorkflowResultConsumption(workflow, request);
      await this.save(workflow, token);
      await this.consumePendingResults(workflow, token);
      return;
    }
    if (request.kind === "consolidate") {
      const parsed = parseStructuredReportResult(result, workflow.reviewers);
      if (!parsed.success) {
        await this.prepareFixSessionSchemaRepair(workflow, token, request, session, parsed.error);
        return;
      }
      const provenance = deriveConsolidatedProvenance(parsed.data, workflow.reviewers);
      if (provenance.issues.length > 0) {
        await this.prepareFixSessionSchemaRepair(
          workflow,
          token,
          request,
          session,
          new ReviewContractValidationError("structured-review-report", provenance.issues),
        );
        return;
      }
      workflow.consolidatedReport = provenance.report;
      if (workflow.restartFixAfterConsolidation) {
        delete workflow.restartFixAfterConsolidation;
        queueRestartedFix(workflow);
      } else if (
        workflow.autoFix &&
        (workflow.consolidatedReport.issues.length > 0 ||
          workflow.consolidatedReport.testCoverageGaps.length > 0)
      ) {
        // Save the report and fix intent atomically, so a restart cannot lose
        // the handoff or send it twice. The supervisor owns delivery.
        queueDefaultFix(workflow);
      } else {
        workflow.phase = "ready";
      }
      session.status = "idle";
      session.completedAt = nowIso();
      settleStepRuntime(workflow, "consolidate");
      delete workflow.activeRequest;
      this.stageWorkflowResultConsumption(workflow, request);
      await this.save(workflow, token);
      await this.consumePendingResults(workflow, token);
      await this.release(workflow, token);
      return;
    }
    let fixed: ReturnType<typeof parseFixResult>;
    if (
      !result.ok &&
      result.error.code !== "schema_retry_exhausted" &&
      result.error.code !== "malformed_output"
    ) {
      throw new Error(result.error.message);
    }
    try {
      if (!result.ok) {
        const path =
          typeof result.error.details?.path === "string" ? result.error.details.path : "$";
        throw new FixResultValidationError(result.error.message, path, result.error.details);
      }
      fixed = parseFixResult(result.value);
    } catch (error) {
      const diagnostic =
        error instanceof FixResultValidationError
          ? error
          : new FixResultValidationError(errorMessage(error));
      await this.prepareFixSessionSchemaRepair(workflow, token, request, session, diagnostic);
      return;
    }
    workflow.fixResult = fixed;
    session.completedAt = nowIso();
    settleStepRuntime(workflow, "fix");
    delete workflow.activeRequest;
    if (!fixed.complete) {
      session.status = "failed";
      workflow.phase = "failed";
      workflow.error = `The fix model could not address every finding: ${fixed.summary}`;
    } else {
      session.status = "idle";
      workflow.phase = "completed";
    }
    this.stageWorkflowResultConsumption(workflow, request);
    await this.save(workflow, token);
    await this.consumePendingResults(workflow, token);
    await this.release(workflow, token);
  }

  private async prepareFixSessionSchemaRepair(
    workflow: MultiReviewWorkflow,
    token: string,
    request: NonNullable<MultiReviewWorkflow["activeRequest"]>,
    session: NonNullable<MultiReviewWorkflow["fixSession"]>,
    error: Pick<ReviewContractValidationError, "message" | "issues">,
  ): Promise<void> {
    const attempt = (request.schemaRepairAttempts ?? 0) + 1;
    if (attempt > MAX_SCHEMA_REPAIR_ATTEMPTS) {
      throw new Error(
        `${error.message} The ${stepModelLabel(request.kind)} model could not produce a valid ${stepResultLabel(request.kind)} in ${MAX_SCHEMA_REPAIR_ATTEMPTS} repair attempts.`,
      );
    }
    const previousRequestId = request.requestId;
    const previousTransport = request.resultTransport;
    const requestId = randomUUID();
    request.requestId = requestId;
    request.state = "prepared";
    await this.workflowRollout.refresh();
    request.resultTransport = this.workflowToolEnabled(
      session.agent,
      this.stepResultKind(request.kind),
    )
      ? "tool-v1"
      : "structured-output-v1";
    request.resultSubmission = request.resultTransport === "tool-v1" ? "preparing" : undefined;
    request.createdAt = nowIso();
    request.schemaRepairAttempts = attempt;
    request.schemaRepairPrompt = structuredReportRepairPrompt(
      error.issues,
      attempt,
      MAX_SCHEMA_REPAIR_ATTEMPTS,
      request.kind === "prepare"
        ? {
            schema: REVIEW_VALIDATION_PLAN_SCHEMA,
            resultLabel: "validation discovery plan",
            workLabel: "discovery work",
            stageLabel: "discovery stage",
            preserveInstruction:
              "Do not run validation, create another commit, or modify artifacts. Correct only the command plan using the current repository requirements already discovered. The backend executes the commands.",
          }
        : request.kind === "fix"
          ? {
              schema: REVIEW_FIX_RESULT_JSON_SCHEMA,
              resultLabel: "fix result",
              workLabel: "fix work",
              stageLabel: "fix stage",
              preserveInstruction:
                "Do not repeat the fix, re-run validation, or edit any file. Keep the files changed, commands run, notes, and limitations you already established, and change only what the errors above require.",
            }
          : undefined,
    );
    delete request.idleResultPolls;
    session.requestIds.push(requestId);
    if (previousTransport === "tool-v1") {
      await this.options.workflowResults?.close(previousRequestId, "superseded");
    }
    await this.save(workflow, token);
  }

  private stageWorkflowResultConsumption(
    workflow: MultiReviewWorkflow,
    request: NonNullable<MultiReviewWorkflow["activeRequest"]>,
  ): void {
    if (request.resultTransport === "tool-v1") {
      workflow.pendingResultConsumptions = Array.from(
        new Set([...(workflow.pendingResultConsumptions ?? []), request.requestId]),
      );
    }
  }

  private async consumePendingResults(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    const pending = workflow.pendingResultConsumptions ?? [];
    if (pending.length === 0) return;
    try {
      for (const resultKey of pending) await this.options.workflowResults?.consume(resultKey);
      delete workflow.pendingResultConsumptions;
      await this.save(workflow, token);
    } catch (error) {
      console.warn(
        `[multi-review] Deferred result consumption for ${workflow.id}:`,
        errorMessage(error),
      );
    }
  }

  private resolveUnattendedInteractions(
    workflow: MultiReviewWorkflow,
    token: string,
    provider: BuildPipelineProvider,
    providerSessionId: string,
  ): Promise<void> {
    return resolveUnattendedReviewerInteractions(provider, providerSessionId, () =>
      this.assertFence(workflow.id, token),
    );
  }

  private async fail(workflowId: string, error: unknown): Promise<void> {
    if (error instanceof ControllerFenceError) return;
    const controlled = await this.loadControlled(workflowId).catch(() => null);
    if (!controlled) return;
    const { workflow, token } = controlled;
    if (isMultiReviewTerminalPhase(workflow.phase)) return;
    if (
      workflow.validationRun &&
      (workflow.validationRun.status === "planned" || workflow.validationRun.status === "running")
    ) {
      try {
        workflow.validationRun = await this.invoke("cancel_review_validation", {
          environmentId: workflow.environmentId,
          run: workflow.validationRun,
        });
      } catch {
        // The workflow failure that brought us here remains authoritative. The
        // cancellation request is best-effort cleanup for an environment-owned
        // worker and must never replace or hide that original error.
      }
    }
    const failedDuringReview = workflow.phase === "reviewing";
    workflow.phase = "failed";
    delete workflow.pausedFromPhase;
    delete workflow.pausedStep;
    workflow.error = errorMessage(error).slice(0, 4_096);
    delete workflow.validationStopRequested;
    if (error instanceof ReviewSnapshotChangedError) {
      workflow.reviewSnapshotStale = true;
    }
    if (failedDuringReview) {
      // This failure abandons every live reviewer session, so none of them may
      // stay `running` on a settled workflow: `hasWorkflowActivity` reads that
      // status, and a survivor would pin the environment badge to "working"
      // for good, including across the boot-time reconcile.
      const running = workflow.reviewers.filter((entry) => entry.status === "running");
      const abandoned =
        running.length > 0
          ? running
          : workflow.reviewers.filter((entry) => entry.status === "pending").slice(0, 1);
      for (const reviewer of abandoned) {
        reviewer.status = "failed";
        reviewer.error = workflow.error;
      }
    }
    if (workflow.fixSession?.status === "running") {
      workflow.fixSession.status = "failed";
      workflow.fixSession.error = workflow.error;
    }
    if (workflow.reviewSession?.status === "running") {
      workflow.reviewSession.status = "failed";
      workflow.reviewSession.error = workflow.error;
    }
    // The turn that was in flight is over, whatever it was: stop its clock so
    // the failed card still reports how long it ran.
    if (workflow.activeRequest) settleStepRuntime(workflow, workflow.activeRequest.kind);
    await this.save(workflow, token).catch(() => undefined);
    await this.release(workflow, token);
  }

  private async release(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    await this.unclaim(workflow, token);
    // A released workflow is settling; its next admission, if any, follows an
    // explicit user action and must re-verify the evidence it dispatches.
    this.evidencePermits.invalidate(workflow.id);
    // Every caller of `release` is settling the workflow, so no progress clock
    // it owns can be read again. Dropping them here keeps the tracker bounded by
    // live sessions rather than by how many reviews the process has supervised.
    for (const reviewer of workflow.reviewers) {
      if (reviewer.providerSessionId) this.progress.forget(reviewer.providerSessionId);
    }
    if (workflow.fixSession) this.progress.forget(workflow.fixSession.providerSessionId);
    if (workflow.reviewSession) this.progress.forget(workflow.reviewSession.providerSessionId);
    const keys = Array.from(this.providerUsers, ([key, users]) =>
      users.has(workflow.id) ? key : undefined,
    ).filter((key): key is string => key !== undefined);
    await Promise.allSettled(keys.map((key) => this.releaseProviderUserByKey(workflow.id, key)));
  }

  /** Drop only the short controller claim while preserving observation resources. */
  private async unclaim(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    await this.storage
      .releaseMultiReviewController(workflow.id, this.ownerId, token)
      .catch(() => undefined);
    this.leases.delete(workflow.id);
  }

  private async releaseProviderUserByKey(workflowId: string, key: string): Promise<void> {
    const users = this.providerUsers.get(key);
    users?.delete(workflowId);
    if (users?.size === 0) this.providerUsers.delete(key);
    await this.disposeProviderIfUnused(key);
  }

  private async releaseProviderReaderByKey(key: string): Promise<void> {
    const readers = this.providerReaders.get(key) ?? 0;
    if (readers <= 1) this.providerReaders.delete(key);
    else this.providerReaders.set(key, readers - 1);
    await this.disposeProviderIfUnused(key);
  }

  private async disposeProviderIfUnused(key: string): Promise<void> {
    if ((this.providerUsers.get(key)?.size ?? 0) > 0 || (this.providerReaders.get(key) ?? 0) > 0)
      return;
    const provider = this.providers.get(key);
    this.providers.delete(key);
    await provider?.dispose?.();
  }

  private async assertFence(workflowId: string, token: string): Promise<void> {
    recordEfficiency(this.options.efficiency, { owner: "multi-review", operation: "fence.check" });
    if (!(await this.storage.validateMultiReviewController(workflowId, this.ownerId, token))) {
      this.leases.delete(workflowId);
      throw new ControllerFenceError();
    }
  }

  private renewLeases(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    recurringWorkMetrics.requested("multi-review-lease-renewal");
    return recurringWorkMetrics.observe("multi-review-lease-renewal", () => this.renewLeasesOnce());
  }

  private async renewLeasesOnce(): Promise<void> {
    for (const [workflowId, lease] of this.leases) {
      const claimed = await this.storage
        .claimMultiReviewController(workflowId, this.ownerId, this.controllerLeaseMs())
        .catch(() => null);
      if (!claimed?.granted || claimed.token !== lease.token) this.leases.delete(workflowId);
      else this.leases.set(workflowId, { token: claimed.token, expiresAt: claimed.expiresAt });
    }
  }

  private controllerLeaseMs(): number {
    return this.options.controllerLeaseMs ?? CONTROLLER_LEASE_MS;
  }

  private addressDispatchRetryMs(): number {
    return Math.max(0, this.options.addressDispatchRetryMs ?? ADDRESS_DISPATCH_RETRY_MS);
  }

  private maxAddressDispatchAttempts(): number {
    return Math.max(1, this.options.maxAddressDispatchAttempts ?? MAX_ADDRESS_DISPATCH_ATTEMPTS);
  }

  /** Captures the one durable source identity every review turn must share. */
  private captureReviewWorktreeSnapshot(
    environmentId: string,
  ): Promise<MultiReviewWorktreeSnapshot> {
    return captureReviewWorktreeSnapshot(
      (command, args) => this.invoke(command, args),
      environmentId,
      "Multi Review",
    );
  }

  /**
   * Observes live-worktree drift before dispatch without stopping Multi Review.
   *
   * The first mismatch becomes a durable warning. Later reviewers and
   * consolidation continue from the original prompt evidence, while their own
   * repository inspection and the consolidation limitation make the mixed
   * observation explicit. Immutable package verification remains fail-closed
   * in `assertReviewPackageIntegrity`.
   */
  private async reviewSnapshotForDispatch(
    workflow: MultiReviewWorkflow,
    token: string,
  ): Promise<MultiReviewWorktreeSnapshot> {
    const baseline = workflow.reviewWorktreeSnapshot;
    // A workflow persisted before snapshots existed has no baseline to drift
    // from. Adopting one is strictly better than failing every in-flight review
    // on upgrade: nothing is lost, because there was never a pinned state.
    if (!baseline) {
      const adopted = await this.captureReviewSnapshotOrFail(workflow.environmentId);
      workflow.reviewWorktreeSnapshot = adopted;
      await this.save(workflow, token);
      return adopted;
    }
    if (workflow.reviewSnapshotStale === true) return baseline;
    try {
      await assertReviewSnapshotCurrent(
        (command, args) => this.invoke(command, args),
        workflow.environmentId,
        baseline,
        "Multi Review",
      );
    } catch (error) {
      if (!(error instanceof ReviewSnapshotChangedError)) throw error;
      workflow.reviewSnapshotStale = true;
      await this.save(workflow, token);
    }
    return baseline;
  }

  /** Capture failures during a live review are unverifiable, never drift. */
  private async captureReviewSnapshotOrFail(
    environmentId: string,
  ): Promise<MultiReviewWorktreeSnapshot> {
    try {
      return await this.captureReviewWorktreeSnapshot(environmentId);
    } catch (error) {
      throw new ReviewSnapshotUnverifiableError(
        `Multi Review cannot establish its worktree snapshot: ${errorMessage(error)}`,
      );
    }
  }

  private reviewPackageId(workflow: MultiReviewWorkflow): string {
    const digest = createHash("sha256")
      .update(
        workflow.reviewModel
          ? (workflow.reviewSessionKey ?? reviewSessionKey(workflow.id))
          : (workflow.fixSessionKey ?? fixSessionKey(workflow.id)),
      )
      .digest("hex")
      .slice(0, 32);
    return `review-package-multi-${digest}`;
  }

  /**
   * Verifies the sealed evidence generation once per phase. Every reviewer in
   * a fan-out admission generation shares one check, and consolidation checks
   * again, independently, after the long reviewer phase. See
   * {@link ReviewEvidencePermits} for what a permit does and does not trust.
   */
  private async verifyReviewEvidence(
    workflow: MultiReviewWorkflow,
    token: string,
    phase: EvidencePermitPhase,
  ): Promise<void> {
    const reviewPackage = workflow.reviewPackage;
    if (!reviewPackage) return;
    if (this.options.evidencePermits === false) {
      // Rollback gate: the legacy path verifies inside every reviewer prompt,
      // so fan-out admission itself has nothing to add.
      if (phase === "consolidation") await this.assertReviewPackageIntegrity(workflow, token);
      return;
    }
    try {
      const outcome = await this.evidencePermits.ensure(
        workflow.id,
        phase,
        {
          generationKey: evidenceGenerationKey({
            environmentId: workflow.environmentId,
            package: reviewPackage,
            snapshotFingerprint: workflow.reviewWorktreeSnapshot?.fingerprint,
          }),
          controllerToken: token,
        },
        () => this.assertReviewPackageIntegrity(workflow, token),
      );
      if (outcome.reused) {
        recordEfficiency(this.options.efficiency, {
          owner: "multi-review",
          operation: "evidence.permit_reuse",
          phase: phase === "fanout" ? "reviewing" : "consolidating",
        });
      }
    } catch (error) {
      this.evidencePermits.invalidate(workflow.id);
      throw error;
    }
  }

  private async assertReviewPackageIntegrity(
    workflow: MultiReviewWorkflow,
    token: string,
  ): Promise<void> {
    const verifyStarted = Date.now();
    const verification = await this.invoke<{ valid: boolean; reason?: string }>(
      "verify_looped_review_package",
      {
        environmentId: workflow.environmentId,
        reviewPackage: workflow.reviewPackage,
      },
    );
    recordEfficiency(this.options.efficiency, {
      owner: "multi-review",
      operation: "evidence.verify",
      phase: efficiencyPhase(workflow.phase),
      outcome: verification.valid ? "success" : "failed",
      bytes: workflow.reviewPackage?.bytes,
      elapsedMs: Date.now() - verifyStarted,
    });
    await this.assertFence(workflow.id, token);
    if (!verification.valid)
      throw new ReviewSnapshotChangedError(
        `Multi Review package integrity verification failed: ${verification.reason ?? "unknown reason"}. Retry to prepare a new package.`,
      );
  }

  private providerKey(workflow: MultiReviewWorkflow, selection: MultiReviewModelSelection): string {
    return `${workflow.environmentId}:${selection.agent}`;
  }

  /**
   * A catalogue reader scoped to one environment, shared by every selection.
   *
   * The read is lazy because most workflows configure no speed at all, and the
   * command behind it can wait on live bridge catalogue fetches. Nothing on
   * this path should pay for it unless a Fast choice actually needs narrowing.
   */
  private catalogReaderFor(environmentId: string): AgentModelCatalogReader {
    return createAgentModelCatalogReader(() =>
      this.invoke<AgentModel[]>("get_native_agent_model_catalog", { environmentId }),
    );
  }

  private async configuredSelection(
    selection: MultiReviewModelSelection,
    environment: Environment,
    config: AppConfig,
    repository: { agentSettings?: AgentSettingsTier },
    readCatalog: AgentModelCatalogReader,
  ): Promise<MultiReviewModelSelection> {
    const defaults = connectionDefaultsFor(selection.agent, config, repository, environment);
    const fastMode = await resolveFastMode(
      selection.agent,
      selection.fastMode ?? defaults.fastMode,
      selection.model === "default" ? undefined : selection.model,
      readCatalog,
    );
    const { fastMode: _requestedFastMode, ...rest } = selection;
    return {
      ...rest,
      ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    };
  }

  private async executionPolicy(workflow: MultiReviewWorkflow) {
    const environment = await this.storage.getEnvironment(workflow.environmentId);
    if (!environment) throw new Error("Review environment no longer exists");
    return resolveEnvironmentExecutionPolicy(environment, "looped-review");
  }

  private async provider(
    workflow: MultiReviewWorkflow,
    selection: MultiReviewModelSelection,
  ): Promise<BuildPipelineProvider> {
    const key = this.providerKey(workflow, selection);
    const users = this.providerUsers.get(key) ?? new Set<string>();
    users.add(workflow.id);
    this.providerUsers.set(key, users);
    return this.providerInstance(workflow, selection);
  }

  private async providerInstance(
    workflow: MultiReviewWorkflow,
    selection: MultiReviewModelSelection,
  ): Promise<BuildPipelineProvider> {
    const key = this.providerKey(workflow, selection);
    const cached = this.providers.get(key);
    if (cached) return cached;
    const pending = this.providerCreations.get(key);
    if (pending) return pending;
    const creation = (async () => {
      const provider = this.options.provider
        ? await this.options.provider(workflow, selection)
        : await (async () => {
            const environment = await this.storage.getEnvironment(workflow.environmentId);
            if (!environment) throw new Error("Review environment no longer exists");
            const connection = await this.bridgeConnection(selection.agent, environment);
            return createBuildPipelineProvider(connection, {
              ...this.options.providerDependencies,
              workflowResults: this.options.workflowResults,
              autoAnswerRequests: false,
            });
          })();
      this.providers.set(key, provider);
      return provider;
    })();
    this.providerCreations.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.providerCreations.get(key) === creation) this.providerCreations.delete(key);
    }
  }

  private async workflowAgentMcp(
    workflow: MultiReviewWorkflow,
    resultKey: string,
    provider?: StructuredOutputProvider,
  ): Promise<AgentToolConnection | undefined> {
    if (!this.options.resolveAgentToolConnection) return undefined;
    const environment = await this.storage.getEnvironment(workflow.environmentId);
    if (!environment) return undefined;
    return this.options.resolveAgentToolConnection(
      workflow.environmentId,
      workflow.projectId,
      environment.environmentType === "local" ? "host" : "container",
      resultKey,
      provider,
    );
  }

  private get workflowRollout(): WorkflowResultRollout {
    this.cachedWorkflowRollout ??=
      this.options.workflowResultRollout ?? new WorkflowResultRollout(async () => undefined);
    return this.cachedWorkflowRollout;
  }

  private workflowToolEnabled(
    agent: MultiReviewModelSelection["agent"],
    kind: WorkflowResultKind,
  ): boolean {
    return (
      this.options.workflowResults !== undefined &&
      this.options.resolveAgentToolConnection !== undefined &&
      this.workflowRollout.allows(agent, kind)
    );
  }

  /** Result kind produced by one multi-review step. */
  private stepResultKind(kind: MultiReviewStepKind): WorkflowResultKind {
    if (kind === "prepare") return "validation-plan";
    if (kind === "consolidate") return "consolidated-review";
    return "fix-result";
  }

  private async bridgeConnection(
    agent: MultiReviewModelSelection["agent"],
    environment: Environment,
  ): Promise<BridgeConnection> {
    const suffix = agent === "opencode" ? "opencode" : agent;
    if (environment.environmentType === "local") {
      const result = await this.invoke<{ port: number; authToken?: string }>(
        `start_local_${suffix}_server_cmd`,
        { environmentId: environment.id },
      );
      if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
      return {
        agent,
        baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken,
        directory: environment.worktreePath,
      };
    }
    if (!environment.containerId) throw new Error("Review container is unavailable");
    const result = await this.invoke<{ hostPort: number; authToken?: string }>(
      `start_${suffix}_server`,
      { containerId: environment.containerId },
    );
    if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
    return {
      agent,
      baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
    };
  }
}

class ControllerFenceError extends Error {
  constructor() {
    super("Multi review controller lease was lost");
    this.name = "ControllerFenceError";
  }
}
