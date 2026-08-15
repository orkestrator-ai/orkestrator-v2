import { randomUUID } from "node:crypto";
import {
  MULTI_REVIEW_WORKFLOW_VERSION,
  isMultiReviewTerminalPhase,
  isMultiReviewWorkflow,
  isStartMultiReviewInput,
  type MultiReviewPhase,
  type MultiReviewModelSelection,
  type MultiReviewReviewerTranscript,
  type MultiReviewWorkflow,
  type StartMultiReviewInput,
} from "@orkestrator/protocol/multi-review";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import {
  ReviewContractValidationError,
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  safeParseStructuredReviewReport,
  type ReviewContractValidationIssue,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema, StructuredOutputResult } from "@orkestrator/protocol/structured-output";
import type { Environment } from "./models.js";
import type { StorageService } from "./storage.js";
import {
  AmbiguousPromptDispatchError,
  createBuildPipelineProvider,
  readProviderStatus,
  type BridgeConnection,
  type BuildPipelineProvider,
  type ProviderDependencies,
} from "./build-pipeline-provider.js";
import { addressPrompt, structuredReportRepairPrompt } from "./build-pipeline-prompts.js";
import {
  REVIEW_FIX_RESULT_JSON_SCHEMA,
  parseFixResult,
} from "./looped-review-prompts.js";
import {
  createMultiReviewConsolidationPrompt,
  createMultiReviewerPrompt,
} from "./multi-review-prompts.js";

type CommandInvoker = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
const DEFAULT_POLL_MS = 1_000;
const CONTROLLER_LEASE_MS = 15_000;
const CONTROLLER_RENEW_MS = 5_000;
const MAX_IDLE_RESULT_POLLS = 5;
const MAX_SCHEMA_REPAIR_ATTEMPTS = 3;
/**
 * Caps one transcript response. The reviewer tab polls this read model while a
 * review runs, and the bridge transcript itself is unbounded, so without a cap
 * every poll would carry the whole history. The viewer renders the tail.
 */
const MAX_REVIEWER_TRANSCRIPT_MESSAGES = 500;
const CANCELLATION_DEADLINE_MS = 10 * 60_000;

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class FixResultValidationError extends Error {
  readonly issues: readonly ReviewContractValidationIssue[];

  constructor(
    message: string,
    path = "$",
    details?: Record<string, unknown>,
  ) {
    const detailText = details
      ? ` Provider validation details: ${JSON.stringify(details)}`
      : "";
    super(`${message}${detailText}`);
    this.name = "FixResultValidationError";
    this.issues = [{ path, code: "invalid_value", message: this.message }];
  }
}

function isSupervisedPhase(phase: MultiReviewPhase): boolean {
  return phase === "reviewing"
    || phase === "consolidating"
    || phase === "fixing"
    || phase === "cancelling";
}

function hasWorkflowActivity(workflow: MultiReviewWorkflow): boolean {
  return isSupervisedPhase(workflow.phase)
    || workflow.reviewers.some((reviewer) => reviewer.status === "running")
    || workflow.fixSession?.status === "running";
}

const NO_VALID_REPORT_ERROR = "No reviewer produced a valid report";

/** Summarises why every reviewer failed, deduplicating a shared root cause. */
function multiReviewFailureSummary(
  reviewers: readonly MultiReviewWorkflow["reviewers"][number][],
): string {
  const reasons = [...new Set(reviewers.flatMap((reviewer) =>
    reviewer.error ? [reviewer.error] : []))];
  if (reasons.length === 0) return NO_VALID_REPORT_ERROR;
  return `${NO_VALID_REPORT_ERROR}: ${reasons.join("; ")}`.slice(0, 4_096);
}

export interface MultiReviewServiceOptions {
  autoAdvance?: boolean;
  pollIntervalMs?: number;
  controllerLeaseMs?: number;
  controllerRenewMs?: number;
  cancellationDeadlineMs?: number;
  provider?: (
    workflow: MultiReviewWorkflow,
    selection: MultiReviewModelSelection,
  ) => Promise<BuildPipelineProvider>;
  providerDependencies?: Pick<ProviderDependencies, "openCodeClient" | "monitorRetryMs">;
}

/** Durable backend owner for reviewer fan-out, consolidation, and fixes. */
export class MultiReviewService {
  private readonly ownerId = randomUUID();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly scheduledRuns = new Map<string, { pending: boolean; promise: Promise<void> }>();
  private readonly providers = new Map<string, BuildPipelineProvider>();
  private readonly providerCreations = new Map<string, Promise<BuildPipelineProvider>>();
  private readonly providerUsers = new Map<string, Set<string>>();
  private readonly providerReaders = new Map<string, number>();
  private readonly leases = new Map<string, { token: string; expiresAt: string }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private renewTimer: ReturnType<typeof setInterval> | null = null;
  private tickRun: { pending: boolean; promise: Promise<void> } | null = null;
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: MultiReviewServiceOptions = {},
  ) {}

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
      this.timer = setInterval(() => void this.requestTick(), this.options.pollIntervalMs ?? DEFAULT_POLL_MS);
      this.timer.unref?.();
      this.renewTimer = setInterval(
        () => void this.renewLeases(),
        this.options.controllerRenewMs ?? CONTROLLER_RENEW_MS,
      );
      this.renewTimer.unref?.();
      void this.requestTick();
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.timer = null;
    this.renewTimer = null;
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
    await Promise.allSettled([...this.leases].map(([workflowId, lease]) =>
      this.storage.releaseMultiReviewController(workflowId, this.ownerId, lease.token)));
    this.leases.clear();
  }

  /**
   * Reads a reviewer's live provider transcript without copying it into the
   * workflow snapshot. The provider remains authoritative while the review is
   * running; callers can refetch after a hidden tab becomes active again.
   */
  async reviewerTranscript(
    workflowId: string,
    reviewerId: string,
  ): Promise<MultiReviewReviewerTranscript> {
    const record = await this.storage.getMultiReviewWorkflow(workflowId);
    if (!record || !isMultiReviewWorkflow(record.snapshot)) {
      throw new Error(`Multi review workflow not found: ${workflowId}`);
    }
    const workflow = record.snapshot;
    const reviewer = workflow.reviewers.find((entry) => entry.id === reviewerId);
    if (!reviewer) throw new Error(`Multi review reviewer not found: ${reviewerId}`);

    let messages: unknown[] = [];
    if (reviewer.providerSessionId) {
      const key = this.providerKey(workflow, reviewer);
      this.providerReaders.set(key, (this.providerReaders.get(key) ?? 0) + 1);
      try {
        const provider = await this.providerInstance(workflow, reviewer);
        provider.registerSession?.(reviewer.providerSessionId, {
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "review",
          workflowId: workflow.id,
          provider: reviewer.agent,
          fence: reviewer.sessionKey,
        });
        const transcript = await provider.messages(reviewer.providerSessionId);
        messages = transcript.length > MAX_REVIEWER_TRANSCRIPT_MESSAGES
          ? transcript.slice(-MAX_REVIEWER_TRANSCRIPT_MESSAGES)
          : transcript;
      } finally {
        await this.releaseProviderReaderByKey(key);
      }
    }

    return {
      workflowId: workflow.id,
      reviewerId: reviewer.id,
      agent: reviewer.agent,
      model: reviewer.model,
      ...(reviewer.reasoningEffort ? { reasoningEffort: reviewer.reasoningEffort } : {}),
      status: reviewer.status,
      messages,
      ...(reviewer.report ? { report: reviewer.report } : {}),
      ...(reviewer.error ? { error: reviewer.error } : {}),
      ...(reviewer.startedAt ? { startedAt: reviewer.startedAt } : {}),
      ...(reviewer.completedAt ? { completedAt: reviewer.completedAt } : {}),
    };
  }

  async start(input: StartMultiReviewInput): Promise<MultiReviewWorkflow> {
    if (!isStartMultiReviewInput(input)) throw new Error("Invalid multi review start request");
    const environment = await this.storage.getEnvironment(input.environmentId);
    if (!environment || environment.projectId !== input.projectId || environment.deletionRequestedAt) {
      throw new Error("The review environment is unavailable");
    }
    const timestamp = nowIso();
    const workflow: MultiReviewWorkflow = {
      version: MULTI_REVIEW_WORKFLOW_VERSION,
      controller: "backend",
      id: randomUUID(),
      environmentId: input.environmentId,
      projectId: input.projectId,
      targetBranch: input.targetBranch,
      ...(input.reviewInstruction ? { reviewInstruction: input.reviewInstruction } : {}),
      reviewers: input.reviewers.map((selection) => ({
        id: randomUUID(), ...selection, status: "pending" as const,
      })),
      fixModel: input.fixModel,
      phase: "reviewing",
      createdAt: timestamp,
      updatedAt: timestamp,
      backendRevision: 0,
    };
    const saved = await this.storage.createMultiReviewWorkflowIfNoActive(
      workflow.id, workflow.environmentId, MULTI_REVIEW_WORKFLOW_VERSION, workflow,
    );
    if (!saved) {
      throw new Error("Finish, cancel, or delete the existing Multi Review before starting another");
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
          return workflow;
        }
        if (workflow.phase !== "ready" || !workflow.consolidatedReport || !workflow.fixSession) {
          throw new Error("The consolidated review is not ready to address");
        }
        // The whole point of the handoff is that the adopted session already
        // holds the consolidated report. A renderer that resumes a rollout the
        // provider has forgotten silently falls back to creating an empty
        // session, which would then receive "address every finding" with no
        // findings in context. Prove liveness here, before anything is dispatched.
        //
        // Reading status does not register the session, so this cannot pull the
        // conversation back into the unattended policy the renderer is about to
        // replace. A failed last turn is not a missing session, and a transport
        // failure is not evidence of deletion: only `missing` blocks the handoff.
        const provider = await this.provider(workflow, workflow.fixModel);
        await this.assertFence(workflow.id, token);
        const { status } = await readProviderStatus(
          provider, workflow.fixSession.providerSessionId,
        );
        await this.assertFence(workflow.id, token);
        if (status === "missing") {
          throw new Error("The consolidation session is no longer available");
        }
        // The renderer adopts this idle consolidation session as an interactive
        // native tab and sends the address prompt there. Supervising a structured
        // fix turn would steal the same provider session back into unattended mode.
        workflow.phase = "interactive";
        workflow.fixSession.status = "idle";
        workflow.addressPromptPending = true;
        delete workflow.activeRequest;
        delete workflow.error;
        return await this.save(workflow, token);
      } finally {
        // This method owns a short-lived transition/dispatch claim. Every exit
        // path must release it, including validation and already-complete errors,
        // or a rejected retry fences out subsequent controllers until expiry.
        await this.release(workflow, token);
      }
    });
  }

  async acknowledgeAddressPrompt(workflowId: string): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      try {
        if (workflow.phase !== "interactive") {
          throw new Error("The Multi Review address prompt is not awaiting dispatch");
        }
        if (workflow.addressPromptPending !== true) return workflow;
        delete workflow.addressPromptPending;
        return await this.save(workflow, token);
      } finally {
        // Interactive workflows are terminal and must never retain a renewed
        // controller/provider lease just because dispatch acknowledgement ran.
        await this.release(workflow, token);
      }
    });
  }

  async retry(workflowId: string): Promise<MultiReviewWorkflow> {
    return this.withLock(workflowId, async () => {
      const controlled = await this.loadControlled(workflowId);
      if (!controlled) throw new Error(`Multi review workflow not found: ${workflowId}`);
      const { workflow, token } = controlled;
      if (workflow.phase !== "failed") return workflow;
      // Reviewer failures are independent, so a single pass can fail several of
      // them at once. Restoring only the first would consolidate from fewer
      // reviewers than the user asked for, without saying so.
      const failedReviewers = workflow.reviewers.filter((reviewer) => reviewer.status === "failed");
      if (failedReviewers.length > 0) {
        for (const failedReviewer of failedReviewers) {
          // Retrying allocates a fresh session, so the abandoned one must be
          // aborted while its id is still known. Clearing the id first would
          // leave a provider turn running that nothing can ever reach again.
          await this.abandonSession(workflow, failedReviewer, failedReviewer.providerSessionId);
          failedReviewer.status = "pending";
          delete failedReviewer.error;
          delete failedReviewer.providerSessionId;
          delete failedReviewer.sessionKey;
          delete failedReviewer.requestId;
          delete failedReviewer.dispatchState;
          delete failedReviewer.schemaRepairAttempts;
          delete failedReviewer.schemaRepairPrompt;
          delete failedReviewer.idleResultPolls;
        }
        workflow.phase = "reviewing";
      } else if (workflow.consolidatedReport && workflow.fixSession) {
        workflow.phase = "ready";
        workflow.fixSession.status = "idle";
        delete workflow.addressPromptPending;
        delete workflow.activeRequest;
      } else {
        await this.abandonSession(
          workflow, workflow.fixModel, workflow.fixSession?.providerSessionId,
        );
        workflow.phase = "consolidating";
        delete workflow.fixSession;
        delete workflow.activeRequest;
      }
      delete workflow.error;
      const saved = await this.save(workflow, token);
      void this.advanceNow(workflowId);
      return saved;
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
      delete workflow.error;
      const saved = await this.save(workflow, token);
      void this.advanceNow(workflowId);
      return saved;
    });
  }

  advanceNow(workflowId: string): Promise<void> {
    return this.runLocked(workflowId);
  }

  private requestTick(): Promise<void> {
    if (this.tickRun) {
      this.tickRun.pending = true;
      return this.tickRun.promise;
    }
    const run = { pending: false, promise: Promise.resolve() };
    run.promise = (async () => {
      do {
        run.pending = false;
        await this.tick();
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
    await Promise.all(records.flatMap((record) => {
      if (!isMultiReviewWorkflow(record.snapshot)) return [];
      const phase = record.snapshot.phase;
      return isSupervisedPhase(phase) ? [this.runLocked(record.id)] : [];
    }));
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
    const settled = run.then(() => undefined, () => undefined);
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
      workflowId, this.ownerId, this.controllerLeaseMs(),
    );
    if (!claimed.granted) return null;
    const record = await this.storage.getMultiReviewWorkflow(workflowId);
    if (!record || !isMultiReviewWorkflow(record.snapshot)) return null;
    this.leases.set(workflowId, { token: claimed.token, expiresAt: claimed.expiresAt });
    return {
      workflow: { ...record.snapshot, controllerFence: claimed.token, backendRevision: record.revision },
      token: claimed.token,
    };
  }

  private async save(workflow: MultiReviewWorkflow, token: string): Promise<MultiReviewWorkflow> {
    workflow.updatedAt = nowIso();
    workflow.controllerFence = token;
    const saved = await this.storage.saveMultiReviewWorkflow(
      workflow.id, workflow.environmentId, MULTI_REVIEW_WORKFLOW_VERSION,
      workflow, workflow.backendRevision, { ownerId: this.ownerId, token },
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
          : []),
    );
    await Promise.all(environments.flatMap((environment) => {
      const desired = activeEnvironmentIds.has(environment.id) ? "working" : "idle";
      if (!activeEnvironmentIds.has(environment.id)
        && !environment.agentActivitySources?.["multi-review"]) return [];
      if (environment.agentActivitySources?.["multi-review"]?.state === desired) return [];
      return [this.storage.setEnvironmentAgentActivity(
        environment.id,
        desired,
        nowIso(),
        "multi-review",
      )];
    }));
  }

  private async advance(workflowId: string): Promise<void> {
    const existing = await this.storage.getMultiReviewWorkflow(workflowId);
    if (!existing || !isMultiReviewWorkflow(existing.snapshot)) return;
    const existingPhase = existing.snapshot.phase;
    if (existingPhase !== "reviewing" && existingPhase !== "consolidating"
      && existingPhase !== "fixing" && existingPhase !== "cancelling") return;
    const controlled = await this.loadControlled(workflowId);
    if (!controlled) return;
    const { workflow, token } = controlled;
    if (workflow.phase === "cancelling") {
      await this.advanceCancellation(workflow, token);
    } else if (workflow.phase === "reviewing") {
      await this.advanceReviewers(workflow, token);
    } else if (workflow.phase === "consolidating" || workflow.phase === "fixing") {
      await this.advanceFixModel(workflow, token);
    }
  }

  private async advanceCancellation(
    workflow: MultiReviewWorkflow,
    token: string,
  ): Promise<void> {
    const waiting: string[] = [];
    for (const reviewer of workflow.reviewers) {
      if (reviewer.status !== "running" || !reviewer.providerSessionId) continue;
      const result = await this.abortSession(
        workflow, token, reviewer.providerSessionId, reviewer,
      );
      if (!result.settled) waiting.push(`reviewer ${reviewer.id}: ${result.error}`);
    }
    if (workflow.fixSession?.status === "running") {
      const result = await this.abortSession(
        workflow, token, workflow.fixSession.providerSessionId, workflow.fixModel,
      );
      if (!result.settled) waiting.push(`fix model: ${result.error}`);
    }
    const started = workflow.cancellingSince ? Date.parse(workflow.cancellingSince) : Number.NaN;
    const timedOut = Number.isFinite(started)
      && Date.now() - started >= (this.options.cancellationDeadlineMs ?? CANCELLATION_DEADLINE_MS);
    if (waiting.length > 0 && !timedOut) {
      workflow.error = `Cancellation is waiting for provider sessions to stop: ${waiting.join("; ")}`
        .slice(0, 4_096);
      await this.save(workflow, token);
      return;
    }
    for (const reviewer of workflow.reviewers) {
      if (reviewer.status === "pending" || reviewer.status === "running") {
        reviewer.status = "cancelled";
      }
    }
    if (workflow.fixSession?.status === "running") workflow.fixSession.status = "cancelled";
    workflow.phase = "cancelled";
    if (timedOut && waiting.length > 0) {
      workflow.error = `Cancellation timed out while provider sessions were still active: ${waiting.join("; ")}`
        .slice(0, 4_096);
    } else {
      delete workflow.error;
    }
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
  ): Promise<{ settled: boolean; error: string }> {
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
          return { settled: true, error: "" };
        }
        return {
          settled: false,
          error: abortError ? errorMessage(abortError) : `provider still reports ${status}`,
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
    try {
      const provider = await this.provider(workflow, selection);
      await provider.abort(providerSessionId);
    } catch {
      // Intentionally ignored; the caller is discarding this session either way.
    }
  }

  private async advanceReviewers(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    for (let index = 0; index < workflow.reviewers.length; index++) {
      const reviewer = workflow.reviewers[index]!;
      if (reviewer.status === "completed" || reviewer.status === "failed"
        || reviewer.status === "cancelled") continue;
      let done: "continue" | "stop";
      try {
        done = await this.advanceReviewer(workflow, token, reviewer, index);
      } catch (error) {
        if (error instanceof ControllerFenceError) throw error;
        // A reviewer is one independent input to the consolidated result. Keep
        // its failure local so the remaining reviewers can still produce a
        // valid report for the workflow.
        // The failure may have been raised while the provider turn was still
        // executing. Abort the session best-effort so that turn cannot keep
        // running through consolidation and the fix stage; the session id is
        // kept so the read-only transcript stays reachable and a later retry
        // can abort again without harm.
        if (reviewer.providerSessionId) {
          await this.abandonSession(workflow, reviewer, reviewer.providerSessionId);
        }
        reviewer.status = "failed";
        reviewer.error = errorMessage(error).slice(0, 4_096);
        delete reviewer.idleResultPolls;
        await this.save(workflow, token);
        done = "continue";
      }
      if (done === "stop") return;
    }

    if (workflow.reviewers.some((reviewer) =>
      reviewer.status === "pending" || reviewer.status === "running")) return;

    const completedReviewers = workflow.reviewers.filter((reviewer) =>
      reviewer.status === "completed" && reviewer.report !== undefined);
    if (completedReviewers.length > 0) {
      workflow.phase = "consolidating";
      delete workflow.error;
      await this.save(workflow, token);
      return;
    }

    workflow.phase = "failed";
    // Reviewers fail locally, so an environment-wide cause (an unreachable
    // bridge, a deleted worktree) reaches here as the same message on every
    // reviewer. Carry the distinct causes up rather than reporting a bare
    // "no valid report", which reads as a model-quality problem instead.
    workflow.error = multiReviewFailureSummary(workflow.reviewers);
    await this.save(workflow, token);
    await this.release(workflow, token);
  }

  /** Advances one reviewer. `stop` ends the pass without touching the rest. */
  private async advanceReviewer(
    workflow: MultiReviewWorkflow,
    token: string,
    reviewer: MultiReviewWorkflow["reviewers"][number],
    index: number,
  ): Promise<"continue" | "stop"> {
    const provider = await this.provider(workflow, reviewer);
    await this.assertFence(workflow.id, token);
    if (reviewer.status === "pending") {
      const sessionKey = `multi-review:${workflow.id}:reviewer:${reviewer.id}`;
      const providerSessionId = await provider.createSession("review", `Multi Review · Reviewer ${index + 1}`, {
        clientSessionKey: sessionKey,
        mode: "build",
        model: reviewer.model === "default" ? undefined : reviewer.model,
        effort: reviewer.reasoningEffort,
        interaction: {
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "review",
          workflowId: workflow.id,
          provider: reviewer.agent,
          fence: sessionKey,
        },
      });
      await this.assertFence(workflow.id, token);
      reviewer.sessionKey = sessionKey;
      reviewer.providerSessionId = providerSessionId;
      reviewer.requestId = randomUUID();
      reviewer.dispatchState = "prepared";
      reviewer.status = "running";
      reviewer.startedAt = nowIso();
      await this.save(workflow, token);
    }
    if (!reviewer.providerSessionId || !reviewer.requestId) return "continue";
    provider.registerSession?.(reviewer.providerSessionId, {
      origin: "looped-review",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: "review",
      workflowId: workflow.id,
      provider: reviewer.agent,
      fence: reviewer.sessionKey,
    });
    if (reviewer.dispatchState === "prepared") {
      reviewer.dispatchState = "dispatching";
      await this.save(workflow, token);
      try {
        await provider.send(
          reviewer.providerSessionId,
          reviewer.schemaRepairPrompt ?? createMultiReviewerPrompt({
              targetBranch: workflow.targetBranch,
              reviewInstruction: workflow.reviewInstruction,
              reviewerNumber: index + 1,
              reviewerCount: workflow.reviewers.length,
            }),
          {
            requestId: reviewer.requestId,
            schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema,
            mode: "build",
            model: reviewer.model === "default" ? undefined : reviewer.model,
            effort: reviewer.reasoningEffort,
          },
        );
      } catch (error) {
        if (error instanceof AmbiguousPromptDispatchError) return "stop";
        throw error;
      }
      await this.assertFence(workflow.id, token);
      reviewer.dispatchState = "sent";
      await this.save(workflow, token);
    }
    if (reviewer.dispatchState === "dispatching") {
      // Dispatch acceptance is ambiguous after a crash. The stable request id
      // makes provider reconciliation authoritative; never send it twice.
      reviewer.dispatchState = "sent";
      await this.save(workflow, token);
    }
    if (reviewer.status !== "running") return "continue";
    await this.resolveUnattendedInteractions(workflow, token, provider, reviewer.providerSessionId);
    // Read as data so the terminal-failure branch below fires whether or not
    // the provider explained itself, and can report the explanation when it did.
    const { status, error: statusDetail } = await readProviderStatus(
      provider,
      reviewer.providerSessionId,
    );
    await this.assertFence(workflow.id, token);
    if (status === "running") return this.clearStall(workflow, token, reviewer);
    if (status === "blocked") {
      // Every unattended interaction was already resolved above, and a provider
      // without an interaction surface can never be unblocked from here. Bound
      // the wait the same way the idle path is bounded rather than polling a
      // stalled reviewer forever.
      return this.recordStall(
        workflow, token, reviewer,
        "The reviewer stayed blocked without a resolvable interaction",
      );
    }
    if (status === "error" || status === "missing") {
      reviewer.status = "failed";
      reviewer.error = status === "missing"
        ? "The reviewer session no longer exists"
        : statusDetail
          ? `The reviewer session failed: ${statusDetail}`
          : "The reviewer session failed";
      await this.save(workflow, token);
      return "continue";
    }
    const result = await provider.structured<unknown>(reviewer.providerSessionId, reviewer.requestId);
    await this.assertFence(workflow.id, token);
    if (!result) {
      return this.recordStall(
        workflow, token, reviewer,
        "The reviewer became idle without returning its structured report",
      );
    }
    const parsed = this.parseReportResult(result);
    if (!parsed.success) {
      return this.prepareReviewerReportRepair(
        workflow,
        token,
        reviewer,
        parsed.error,
      );
    }
    reviewer.report = parsed.data;
    reviewer.status = "completed";
    reviewer.completedAt = nowIso();
    delete reviewer.schemaRepairPrompt;
    delete reviewer.idleResultPolls;
    await this.save(workflow, token);
    return "continue";
  }

  private async prepareReviewerReportRepair(
    workflow: MultiReviewWorkflow,
    token: string,
    reviewer: MultiReviewWorkflow["reviewers"][number],
    error: ReviewContractValidationError,
  ): Promise<"stop"> {
    const attempt = (reviewer.schemaRepairAttempts ?? 0) + 1;
    if (attempt > MAX_SCHEMA_REPAIR_ATTEMPTS) {
      throw new Error(
        `${error.message} The reviewer could not produce a valid report in ${MAX_SCHEMA_REPAIR_ATTEMPTS} repair attempts.`,
      );
    }
    reviewer.schemaRepairAttempts = attempt;
    reviewer.schemaRepairPrompt = structuredReportRepairPrompt(
      error.issues,
      attempt,
      MAX_SCHEMA_REPAIR_ATTEMPTS,
    );
    reviewer.requestId = randomUUID();
    reviewer.dispatchState = "prepared";
    delete reviewer.idleResultPolls;
    await this.save(workflow, token);
    return "stop";
  }

  /** Counts one stalled poll, failing the reviewer once the bound is reached. */
  private async recordStall(
    workflow: MultiReviewWorkflow,
    token: string,
    reviewer: MultiReviewWorkflow["reviewers"][number],
    error: string,
  ): Promise<"continue" | "stop"> {
    reviewer.idleResultPolls = (reviewer.idleResultPolls ?? 0) + 1;
    if (reviewer.idleResultPolls >= MAX_IDLE_RESULT_POLLS) {
      reviewer.status = "failed";
      reviewer.error = error;
    }
    await this.save(workflow, token);
    return "continue";
  }

  /** Observed progress retires the stall count so it cannot accumulate. */
  private async clearStall(
    workflow: MultiReviewWorkflow,
    token: string,
    reviewer: MultiReviewWorkflow["reviewers"][number],
  ): Promise<"continue"> {
    if (reviewer.idleResultPolls === undefined) return "continue";
    delete reviewer.idleResultPolls;
    await this.save(workflow, token);
    return "continue";
  }

  private async advanceFixModel(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    const provider = await this.provider(workflow, workflow.fixModel);
    await this.assertFence(workflow.id, token);
    if (!workflow.fixSession) {
      const sessionKey = `multi-review:${workflow.id}:fix`;
      const providerSessionId = await provider.createSession("review", "Multi Review · Consolidation", {
        clientSessionKey: sessionKey,
        mode: "plan",
        model: workflow.fixModel.model === "default" ? undefined : workflow.fixModel.model,
        effort: workflow.fixModel.reasoningEffort,
        interaction: {
          origin: "looped-review",
          interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: "review",
          workflowId: workflow.id,
          provider: workflow.fixModel.agent,
          fence: sessionKey,
        },
      });
      await this.assertFence(workflow.id, token);
      workflow.fixSession = {
        ...workflow.fixModel,
        sessionKey,
        providerSessionId,
        requestIds: [],
        status: "running",
        startedAt: nowIso(),
      };
      await this.save(workflow, token);
    }
    const session = workflow.fixSession;
    provider.registerSession?.(session.providerSessionId, {
      origin: "looped-review",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: workflow.phase === "fixing" ? "fix" : "review",
      workflowId: workflow.id,
      provider: workflow.fixModel.agent,
      fence: session.sessionKey,
    });
    if (!workflow.activeRequest) {
      const requestId = randomUUID();
      workflow.activeRequest = {
        kind: "consolidate", requestId, state: "prepared", createdAt: nowIso(),
      };
      session.requestIds.push(requestId);
      await this.save(workflow, token);
    }
    const request = workflow.activeRequest;
    if (request.state === "prepared") {
      request.state = "dispatching";
      await this.save(workflow, token);
      const prompt = request.schemaRepairPrompt ?? (request.kind === "consolidate"
        ? createMultiReviewConsolidationPrompt({
            targetBranch: workflow.targetBranch,
            reports: workflow.reviewers.flatMap((reviewer) =>
              reviewer.status === "completed" && reviewer.report
                ? [{
                    reviewerId: reviewer.id,
                    agent: reviewer.agent,
                    model: reviewer.model,
                    report: reviewer.report,
                  }]
                : []),
          })
        : addressPrompt(workflow.consolidatedReport!));
      try {
        await provider.send(session.providerSessionId, prompt, {
          requestId: request.requestId,
          schema: request.kind === "consolidate"
            ? STRUCTURED_REVIEW_REPORT_JSON_SCHEMA as JsonSchema
            : REVIEW_FIX_RESULT_JSON_SCHEMA,
          mode: request.kind === "consolidate" ? "plan" : "build",
          model: workflow.fixModel.model === "default" ? undefined : workflow.fixModel.model,
          effort: workflow.fixModel.reasoningEffort,
        });
      } catch (error) {
        if (error instanceof AmbiguousPromptDispatchError) return;
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
    const { status, error: statusDetail } = await readProviderStatus(
      provider,
      session.providerSessionId,
    );
    await this.assertFence(workflow.id, token);
    if (status === "running") {
      if (request.idleResultPolls !== undefined) {
        delete request.idleResultPolls;
        await this.save(workflow, token);
      }
      return;
    }
    if (status === "blocked") {
      // Unattended interactions were already resolved above; a provider still
      // reporting blocked cannot be waited on indefinitely.
      request.idleResultPolls = (request.idleResultPolls ?? 0) + 1;
      await this.save(workflow, token);
      if (request.idleResultPolls >= MAX_IDLE_RESULT_POLLS) {
        throw new Error("The fix model stayed blocked without a resolvable interaction");
      }
      return;
    }
    if (status === "error" || status === "missing") {
      throw new Error(status === "missing"
        ? "The consolidation session no longer exists"
        : statusDetail
          ? `The consolidation session failed: ${statusDetail}`
          : "The consolidation session failed");
    }
    const result = await provider.structured<unknown>(session.providerSessionId, request.requestId);
    await this.assertFence(workflow.id, token);
    if (!result) {
      request.idleResultPolls = (request.idleResultPolls ?? 0) + 1;
      await this.save(workflow, token);
      if (request.idleResultPolls >= MAX_IDLE_RESULT_POLLS) {
        throw new Error(`The fix model became idle without returning its ${request.kind === "fix" ? "fix result" : "consolidated report"}`);
      }
      return;
    }
    if (request.kind === "consolidate") {
      const parsed = this.parseReportResult(result);
      if (!parsed.success) {
        await this.prepareFixSessionSchemaRepair(
          workflow,
          token,
          request,
          session,
          parsed.error,
        );
        return;
      }
      workflow.consolidatedReport = parsed.data;
      workflow.phase = "ready";
      session.status = "idle";
      session.completedAt = nowIso();
      delete workflow.activeRequest;
      await this.save(workflow, token);
      await this.release(workflow, token);
      return;
    }
    let fixed: ReturnType<typeof parseFixResult>;
    if (!result.ok && result.error.code !== "schema_retry_exhausted"
      && result.error.code !== "malformed_output") {
      throw new Error(result.error.message);
    }
    try {
      if (!result.ok) {
        const path = typeof result.error.details?.path === "string"
          ? result.error.details.path
          : "$";
        throw new FixResultValidationError(result.error.message, path, result.error.details);
      }
      fixed = parseFixResult(result.value);
    } catch (error) {
      const diagnostic = error instanceof FixResultValidationError
        ? error
        : new FixResultValidationError(errorMessage(error));
      await this.prepareFixSessionSchemaRepair(
        workflow,
        token,
        request,
        session,
        diagnostic,
      );
      return;
    }
    workflow.fixResult = fixed;
    session.completedAt = nowIso();
    delete workflow.activeRequest;
    if (!fixed.complete) {
      session.status = "failed";
      workflow.phase = "failed";
      workflow.error = `The fix model could not address every finding: ${fixed.summary}`;
    } else {
      session.status = "idle";
      workflow.phase = "completed";
    }
    await this.save(workflow, token);
    await this.release(workflow, token);
  }

  private parseReportResult(result: StructuredOutputResult<unknown>) {
    if (!result.ok) {
      if (result.error.code === "schema_retry_exhausted"
        || result.error.code === "malformed_output") {
        const detailPath = typeof result.error.details?.path === "string"
          ? result.error.details.path
          : "$";
        const detailText = result.error.details
          ? ` Provider validation details: ${JSON.stringify(result.error.details)}`
          : "";
        return {
          success: false as const,
          error: new ReviewContractValidationError("structured-review-report", [{
            path: detailPath,
            code: "invalid_value",
            message: `${result.error.message}${detailText}`,
          }]),
        };
      }
      throw new Error(result.error.message);
    }
    return safeParseStructuredReviewReport(result.value);
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
        `${error.message} The fix model could not produce a valid ${request.kind === "fix" ? "fix result" : "consolidated report"} in ${MAX_SCHEMA_REPAIR_ATTEMPTS} repair attempts.`,
      );
    }
    const requestId = randomUUID();
    request.requestId = requestId;
    request.state = "prepared";
    request.createdAt = nowIso();
    request.schemaRepairAttempts = attempt;
    request.schemaRepairPrompt = structuredReportRepairPrompt(
      error.issues,
      attempt,
      MAX_SCHEMA_REPAIR_ATTEMPTS,
      request.kind === "fix" ? {
        schema: REVIEW_FIX_RESULT_JSON_SCHEMA,
        resultLabel: "fix result",
        workLabel: "fix work",
        stageLabel: "fix stage",
        preserveInstruction: "Do not repeat the fix, re-run validation, or edit any file. Keep the files changed, commands run, notes, and limitations you already established, and change only what the errors above require.",
      } : undefined,
    );
    delete request.idleResultPolls;
    session.requestIds.push(requestId);
    await this.save(workflow, token);
  }

  private async resolveUnattendedInteractions(
    workflow: MultiReviewWorkflow,
    token: string,
    provider: BuildPipelineProvider,
    providerSessionId: string,
  ): Promise<void> {
    if (!provider.interactions) return;
    const snapshot = await provider.interactions.listPendingInteractions(providerSessionId);
    await this.assertFence(workflow.id, token);
    for (const request of snapshot.requests) {
      const action = request.kind === "question" || request.kind === "mcp-form"
        || request.kind === "elicitation" || request.kind === "terminal-selection"
        ? "decline" as const
        : "deny" as const;
      await provider.interactions.resolveInteraction(providerSessionId, request.id, {
        version: 1,
        interactionId: request.id,
        sessionId: providerSessionId,
        action,
        resolvedAt: Date.now(),
      });
      await this.assertFence(workflow.id, token);
    }
  }

  private async fail(workflowId: string, error: unknown): Promise<void> {
    if (error instanceof ControllerFenceError) return;
    const controlled = await this.loadControlled(workflowId).catch(() => null);
    if (!controlled) return;
    const { workflow, token } = controlled;
    if (isMultiReviewTerminalPhase(workflow.phase)) return;
    const failedDuringReview = workflow.phase === "reviewing";
    workflow.phase = "failed";
    workflow.error = errorMessage(error).slice(0, 4_096);
    if (failedDuringReview) {
      // This failure abandons every live reviewer session, so none of them may
      // stay `running` on a settled workflow: `hasWorkflowActivity` reads that
      // status, and a survivor would pin the environment badge to "working"
      // for good, including across the boot-time reconcile.
      const running = workflow.reviewers.filter((entry) => entry.status === "running");
      const abandoned = running.length > 0
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
    await this.save(workflow, token).catch(() => undefined);
    await this.release(workflow, token);
  }

  private async release(workflow: MultiReviewWorkflow, token: string): Promise<void> {
    await this.storage.releaseMultiReviewController(workflow.id, this.ownerId, token)
      .catch(() => undefined);
    this.leases.delete(workflow.id);
    const keys = new Set([
      ...workflow.reviewers.map((reviewer) => this.providerKey(workflow, reviewer)),
      this.providerKey(workflow, workflow.fixModel),
    ]);
    await Promise.allSettled([...keys].map((key) => this.releaseProviderUserByKey(workflow.id, key)));
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
    if ((this.providerUsers.get(key)?.size ?? 0) > 0
      || (this.providerReaders.get(key) ?? 0) > 0) return;
    const provider = this.providers.get(key);
    this.providers.delete(key);
    await provider?.dispose?.();
  }

  private async assertFence(workflowId: string, token: string): Promise<void> {
    if (!await this.storage.validateMultiReviewController(workflowId, this.ownerId, token)) {
      this.leases.delete(workflowId);
      throw new ControllerFenceError();
    }
  }

  private async renewLeases(): Promise<void> {
    if (this.stopped) return;
    for (const [workflowId, lease] of this.leases) {
      const claimed = await this.storage.claimMultiReviewController(
        workflowId, this.ownerId, this.controllerLeaseMs(),
      ).catch(() => null);
      if (!claimed?.granted || claimed.token !== lease.token) this.leases.delete(workflowId);
      else this.leases.set(workflowId, { token: claimed.token, expiresAt: claimed.expiresAt });
    }
  }

  private controllerLeaseMs(): number {
    return this.options.controllerLeaseMs ?? CONTROLLER_LEASE_MS;
  }

  private providerKey(
    workflow: MultiReviewWorkflow,
    selection: MultiReviewModelSelection,
  ): string {
    return `${workflow.environmentId}:${selection.agent}`;
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

  private async bridgeConnection(
    agent: MultiReviewModelSelection["agent"],
    environment: Environment,
  ): Promise<BridgeConnection> {
    const suffix = agent === "opencode" ? "opencode" : agent;
    if (environment.environmentType === "local") {
      const result = await this.invoke<{ port: number; authToken?: string }>(
        `start_local_${suffix}_server_cmd`, { environmentId: environment.id },
      );
      if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
      return {
        agent, baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken, directory: environment.worktreePath,
      };
    }
    if (!environment.containerId) throw new Error("Review container is unavailable");
    const result = await this.invoke<{ hostPort: number; authToken?: string }>(
      `start_${suffix}_server`, { containerId: environment.containerId },
    );
    if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
    return {
      agent, baseUrl: `http://127.0.0.1:${result.hostPort}`,
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
