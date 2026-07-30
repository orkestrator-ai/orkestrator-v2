import { createHash, randomUUID } from "node:crypto";
import type {
  BuildPhase,
  BuildPipeline,
  BuildPipelineAgent,
  BuildPipelineSource,
  PipelineSession,
  PipelineSessionPhase,
  ResumableBuildPhase,
  StartBuildPipelineInput,
} from "@orkestrator/protocol/build-pipeline";
import {
  BUILD_PIPELINE_VERSION,
  isBuildPipeline,
  isActiveBuildPhase,
  isStartBuildPipelineInput,
  MAX_PIPELINE_USER_MESSAGES,
  MAX_PIPELINE_USER_MESSAGE_LENGTH,
} from "@orkestrator/protocol/build-pipeline";
import {
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  parseStructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import type { Environment, PersistedBuildPipeline } from "./models.js";
import type { StorageService } from "./storage.js";
import {
  createBuildPipelineProvider,
  PromptRejectedError,
  ProviderUnavailableError,
  type BridgeConnection,
  type BuildPipelineProvider,
} from "./build-pipeline-provider.js";
import { stagePromptImages } from "./prompt-attachments.js";
import {
  addressPrompt,
  buildPrompt,
  fixPrompt,
  prPrompt,
  resolveConflictsPrompt,
  reviewPrompt,
  verificationPrompt,
} from "./build-pipeline-prompts.js";

type CommandInvoker = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;

const VERIFICATION_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["complete", "rationale"],
  properties: {
    complete: { type: "boolean" },
    rationale: { type: "string" },
  },
};

const SESSION_LABELS: Record<PipelineSessionPhase, string> = {
  build: "Build Session",
  review: "Review Session",
  verify: "Verification Session",
  fix: "Fix Session",
  pr: "PR Creation Session",
  "resolve-conflicts": "Conflict Resolution Session",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalAdmissionSource(
  source: BuildPipelineSource | undefined,
): Record<string, unknown> | null {
  if (!source) return null;
  if (source.type === "kanban") {
    return {
      type: source.type,
      taskId: source.taskId.trim(),
    };
  }
  if (source.type === "linear") {
    return {
      type: source.type,
      issueId: source.issueId.trim(),
    };
  }
  return {
    type: source.type,
    repositoryOwner: source.repositoryOwner.trim().toLowerCase(),
    repositoryName: source.repositoryName.trim().toLowerCase(),
    issueNumber: source.issueNumber,
  };
}

function buildAdmissionKey(input: StartBuildPipelineInput): string {
  return createHash("sha256")
    .update(JSON.stringify({
      projectId: input.projectId.trim(),
      taskId: input.taskId.trim(),
      source: canonicalAdmissionSource(input.source),
      existingEnvironmentId: input.existingEnvironmentId?.trim() || null,
      featurePlanId: input.featurePlanId?.trim() || null,
    }))
    .digest("hex");
}

function sessionForCurrentPhase(pipeline: BuildPipeline): PipelineSession | undefined {
  return pipeline.sessions[pipeline.currentSessionIndex];
}

function resumablePhase(phase: BuildPhase): ResumableBuildPhase | null {
  return isActiveBuildPhase(phase) ? phase as ResumableBuildPhase : null;
}

function modelFor(
  agent: BuildPipelineAgent,
  global: {
    claudeModel?: string;
    codexModel: string;
    opencodeModel: string;
  },
  repositoryDefault?: string,
): string | undefined {
  if (repositoryDefault && repositoryDefault !== "default") return repositoryDefault;
  const model = agent === "claude"
    ? global.claudeModel
    : agent === "codex"
      ? global.codexModel
      : global.opencodeModel;
  return model && model !== "default" ? model : undefined;
}

function sessionPhaseFor(
  phase: ResumableBuildPhase,
): PipelineSessionPhase | null {
  switch (phase) {
    case "building":
      return "build";
    case "reviewing":
    case "addressing":
      return "review";
    case "verifying":
      return "verify";
    case "fixing":
      return "fix";
    case "creating-pr":
      return "pr";
    case "resolving-conflicts":
      return "resolve-conflicts";
    case "creating-environment":
    case "starting-environment":
    case "waiting-for-setup":
      return null;
  }
}

function resumePromptFor(phase: ResumableBuildPhase): string | null {
  switch (phase) {
    case "building":
      return "Resume the build pipeline from where you left off. Continue implementing the original ticket, incorporate any messages sent while the pipeline was paused, validate the work as appropriate, and stop when the implementation is ready for review. Do not ask questions; make sensible assumptions.";
    case "reviewing":
      return "Resume the build pipeline review from where you left off. Continue reviewing the current changes against the original ticket and target branch, incorporate any messages sent while the pipeline was paused, and finish with the required structured review result. Do not ask questions; make sensible assumptions.";
    case "addressing":
      return "Resume addressing the review findings from where you left off. Incorporate any messages sent while the pipeline was paused, make the required code and test changes, and validate the result as appropriate. Do not ask questions; make sensible assumptions.";
    case "verifying":
      return "Resume verification from where you left off. Re-check the current codebase against the original ticket, incorporate any messages sent while the pipeline was paused, and respond with only the JSON object required by the verification instructions.";
    case "fixing":
      return "Resume fixing the verification failures from where you left off. Incorporate any messages sent while the pipeline was paused, finish the requested fixes, and validate the result as appropriate. Do not ask questions; make sensible assumptions.";
    case "creating-pr":
      return "Resume creating the pull request from where you left off. Incorporate any messages sent while the pipeline was paused, push or prepare the branch as needed, and create the PR against the target branch if it is not already created. Do not ask questions; make sensible assumptions.";
    case "resolving-conflicts":
      return "Resume resolving PR merge conflicts from where you left off. Incorporate any messages sent while the pipeline was paused, finish the conflict resolution, and validate the result as appropriate. Do not ask questions; make sensible assumptions.";
    case "creating-environment":
    case "starting-environment":
    case "waiting-for-setup":
      return null;
  }
}

type PullRequestDetection = {
  url: string;
  state: "open" | "merged" | "closed";
  hasMergeConflicts: boolean;
};

/**
 * How long a pipeline may stay in reconnect before it is failed.
 *
 * Without a bound, a bridge that starts but never answers keeps the pipeline in
 * "Reconnecting…" for the life of the process: every tick evicts the provider,
 * rebuilds it, fails again, and nothing ever escalates to the user.
 */
const DEFAULT_RECONNECT_DEADLINE_MS = 5 * 60_000;

/**
 * How long a finished turn may withhold its structured result before the
 * pipeline fails.
 *
 * `provider.structured()` returning null means "not available yet", which is
 * normal for a tick or two. It is also what a bridge returns after it has
 * forgotten an in-memory result (a restart mid-turn), and there the session is
 * idle forever — so polling it without a deadline is a silent livelock.
 */
const DEFAULT_STRUCTURED_RESULT_DEADLINE_MS = 2 * 60_000;

/**
 * Minimum spacing between transcript-only snapshot writes for a running turn.
 *
 * Persisting the pipeline rewrites the whole build-pipelines file, so following
 * a streaming transcript at the tick rate turns every active build into a
 * continuous full-file rewrite. Status changes and phase transitions still
 * persist immediately; only a pure transcript delta is throttled.
 */
const DEFAULT_TRANSCRIPT_PERSIST_INTERVAL_MS = 5_000;

/**
 * Change detector for a transcript snapshot.
 *
 * Serializing both sides in full on every tick costs O(transcript) twice per
 * pass, per pipeline, and transcripts reach megabytes. Provider transcripts
 * grow by appending and by rewriting the entry currently streaming, so the
 * length plus the tail entry captures every change they actually make.
 */
function transcriptFingerprint(messages: unknown[]): string {
  if (messages.length === 0) return "0:";
  let tail: string;
  try {
    tail = JSON.stringify(messages[messages.length - 1]) ?? "";
  } catch {
    // A transcript that cannot be serialized cannot be persisted either; treat
    // every observation as a change so the save path reports the real error.
    tail = String(Date.now());
  }
  return `${messages.length}:${tail}`;
}

function elapsedSince(timestamp: string | undefined): number | null {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Date.now() - parsed : null;
}

export class BuildPipelineService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly providers = new Map<string, BuildPipelineProvider>();
  private readonly provisioningPrompts = new Map<string, string | undefined>();
  private tickPromise: Promise<void> | null = null;
  private tickRequested = false;
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: {
      autoAdvance?: boolean;
      provider?: (pipeline: BuildPipeline) => Promise<BuildPipelineProvider>;
      reconnectDeadlineMs?: number;
      structuredResultDeadlineMs?: number;
      transcriptPersistIntervalMs?: number;
    } = {},
  ) {}

  private get reconnectDeadlineMs(): number {
    return this.options.reconnectDeadlineMs ?? DEFAULT_RECONNECT_DEADLINE_MS;
  }

  private get structuredResultDeadlineMs(): number {
    return this.options.structuredResultDeadlineMs
      ?? DEFAULT_STRUCTURED_RESULT_DEADLINE_MS;
  }

  private get transcriptPersistIntervalMs(): number {
    return this.options.transcriptPersistIntervalMs
      ?? DEFAULT_TRANSCRIPT_PERSIST_INTERVAL_MS;
  }

  async init(): Promise<void> {
    this.stopped = false;
    const terminalReconciliations: Promise<void>[] = [];
    for (const record of await this.storage.listAllBuildPipelines()) {
      if (!record.snapshot || typeof record.snapshot !== "object") continue;
      const normalized = {
        ...record.snapshot,
        controller: "backend" as const,
        backendRevision: record.revision,
      };
      if (!isBuildPipeline(normalized)) continue;
      const pipeline = normalized;
      if (
        (record.snapshot as { controller?: unknown }).controller !== "backend"
        || (record.snapshot as { backendRevision?: unknown }).backendRevision
          !== record.revision
      ) {
        // One unsaveable record must not take the whole backend down with it.
        // The realistic case is a pipeline whose environment carries a deletion
        // tombstone because the app died part-way through deleting it: the save
        // is rejected on purpose, and re-arming the rest of the pipelines still
        // matters far more than adopting this one.
        try {
          await this.save(pipeline, record.revision);
        } catch (error) {
          console.warn(
            `[build-pipeline] Skipped restoring pipeline ${pipeline.id}:`,
            errorMessage(error),
          );
          continue;
        }
      }
      if (this.needsTerminalReconciliation(pipeline)) {
        terminalReconciliations.push(this.runLocked(pipeline.id));
      }
    }
    if (this.options.autoAdvance !== false) {
      this.timer ??= setInterval(() => {
        void this.requestTick();
      }, 1_500);
      this.timer.unref?.();
      void this.requestTick();
    }
    await Promise.all(terminalReconciliations);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.tickRequested = false;
    if (this.tickPromise) {
      await this.tickPromise;
    }
    while (this.locks.size > 0) {
      await Promise.allSettled([...this.locks.values()]);
    }
    await Promise.allSettled([...this.providers.values()].map(async (provider) => {
      const disposable = provider as BuildPipelineProvider & {
        dispose?: () => void | Promise<void>;
      };
      await disposable.dispose?.();
    }));
    this.providers.clear();
    this.provisioningPrompts.clear();
  }

  async start(input: StartBuildPipelineInput): Promise<BuildPipeline> {
    if (!isStartBuildPipelineInput(input)) {
      throw new Error("Invalid build pipeline start request");
    }
    let existingEnvironment: Environment | null = null;
    const existingEnvironmentId = input.existingEnvironmentId?.trim() ?? "";
    if (existingEnvironmentId) {
      existingEnvironment = await this.storage.getEnvironment(existingEnvironmentId);
      if (
        !existingEnvironment
        || existingEnvironment.projectId !== input.projectId
        || existingEnvironment.deletionRequestedAt
      ) {
        throw new Error("The selected build environment does not belong to this project");
      }
    }
    const pipeline: BuildPipeline = {
      id: randomUUID(),
      taskId: input.taskId,
      projectId: input.projectId,
      environmentId: existingEnvironmentId,
      environmentType: existingEnvironment?.environmentType ?? input.environmentType,
      agentType: input.agentType,
      phase: existingEnvironment
        ? "starting-environment"
        : "creating-environment",
      sessions: [],
      currentSessionIndex: -1,
      iteration: 0,
      maxIterations: input.maxIterations ?? 3,
      createdAt: new Date().toISOString(),
      taskTitle: input.taskTitle,
      taskSnapshot: input.taskSnapshot,
      source: input.source,
      featurePlanId: input.featurePlanId?.trim() || undefined,
      admissionKey: buildAdmissionKey(input),
      backendRevision: 0,
      controller: "backend",
    };
    if (!existingEnvironment) {
      // Installed before the reservation becomes visible to timer ticks.
      this.provisioningPrompts.set(pipeline.id, input.namingPrompt);
    }
    try {
      const admitted = await this.save(pipeline, 0);
      if (admitted.id !== pipeline.id) {
        this.provisioningPrompts.delete(pipeline.id);
        const existing = admitted.snapshot;
        if (!isBuildPipeline(existing)) {
          throw new Error("Existing build pipeline admission is invalid");
        }
        return existing;
      }
    } catch (error) {
      this.provisioningPrompts.delete(pipeline.id);
      throw error;
    }
    // Provisioning is performed by the same per-pipeline supervisor lock used
    // by timer ticks. A tick that observes the just-persisted reservation joins
    // this pass instead of racing a second create_environment call.
    // For an existing environment the first pass only commits source linkage;
    // for a new environment it provisions exactly once. In both cases a timer
    // tick joins this same lock, so it cannot race the start response's write.
    await this.runLocked(pipeline.id, input.namingPrompt);
    let startedRecord = await this.requireRecord(pipeline.id);
    let started = startedRecord.snapshot as BuildPipeline;
    if (started.phase === "failed") {
      throw new Error(started.error ?? "Failed to start build pipeline");
    }
    if (!started.sourceLinkedAt) {
      // A newly provisioned environment is associated in the first pass and
      // source-linked in this second pass. It must also use runLocked: a timer
      // can observe the association save before start() resumes, and both
      // callers must join one CAS write rather than racing ensureSourceLink.
      await this.runLocked(pipeline.id);
      startedRecord = await this.requireRecord(pipeline.id);
      started = startedRecord.snapshot as BuildPipeline;
      if (started.phase === "failed") {
        throw new Error(started.error ?? "Failed to link build pipeline source");
      }
    }
    if (this.options.autoAdvance !== false) void this.runLocked(pipeline.id);
    return started;
  }

  async importLegacy(
    projectId: string,
    snapshots: unknown[],
  ): Promise<{ importedIds: string[]; skipped: number }> {
    const importedIds: string[] = [];
    let skipped = 0;
    if (!projectId.trim() || !Array.isArray(snapshots)) {
      return { importedIds, skipped: Array.isArray(snapshots) ? snapshots.length : 0 };
    }
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
        skipped += 1;
        continue;
      }
      const normalized = {
        ...snapshot,
        controller: "backend",
        backendRevision: 0,
      };
      if (!isBuildPipeline(normalized) || normalized.projectId !== projectId) {
        skipped += 1;
        continue;
      }
      if (await this.storage.getBuildPipeline(normalized.id)) {
        skipped += 1;
        continue;
      }
      if (normalized.environmentId) {
        const environment = await this.storage.getEnvironment(normalized.environmentId);
        if (
          !environment
          || environment.projectId !== projectId
          || environment.deletionRequestedAt
          || (
            environment.buildPipelineId !== undefined
            && environment.buildPipelineId !== normalized.id
          )
        ) {
          skipped += 1;
          continue;
        }
      }
      // save() short-circuits when an active pipeline already holds this
      // admission key and returns that record instead. Treating the returned id
      // as imported would report a pipeline that was never persisted and then
      // schedule a supervisor pass for it.
      const admitted = await this.save(normalized, 0);
      if (admitted.id !== normalized.id) {
        skipped += 1;
        continue;
      }
      importedIds.push(normalized.id);
      if (isActiveBuildPhase(normalized.phase) && this.options.autoAdvance !== false) {
        void this.runLocked(normalized.id);
      }
    }
    return { importedIds, skipped };
  }

  /** Immediate supervisor pass, also useful for deterministic backend tests. */
  advanceNow(pipelineId: string): Promise<void> {
    return this.runLocked(pipelineId);
  }

  async pause(pipelineId: string): Promise<BuildPipeline> {
    let abortError: unknown;
    const pipeline = await this.mutate(pipelineId, async (pipeline) => {
      const previous = resumablePhase(pipeline.phase);
      if (!previous) return;
      pipeline.pausedFromPhase = previous;
      pipeline.phase = "paused";
      const session = sessionForCurrentPhase(pipeline);
      if (session?.status === "running") {
        try {
          const provider = await this.provider(pipeline);
          await provider.abort(session.sdkSessionId);
          session.status = "idle";
        } catch (error) {
          abortError = error;
          pipeline.error = `Build paused, but stopping the agent could not be confirmed: ${errorMessage(error)}`;
        }
      }
    });
    if (abortError) throw abortError;
    return pipeline;
  }

  async resume(pipelineId: string): Promise<BuildPipeline> {
    const pipeline = await this.mutate(pipelineId, (candidate) => {
      if (candidate.phase !== "paused") return;
      const phase = candidate.pausedFromPhase ?? "building";
      candidate.phase = phase;
      delete candidate.pausedFromPhase;
      delete candidate.error;
      const session = sessionForCurrentPhase(candidate);
      const prompt = resumePromptFor(phase);
      if (
        prompt
        && session?.status === "idle"
        && session.phase === sessionPhaseFor(phase)
      ) {
        const requestId = randomUUID();
        const structuredReview = phase === "reviewing" || phase === "verifying";
        candidate.pendingPromptAttempt = {
          id: randomUUID(),
          sessionId: session.sdkSessionId,
          requestId,
          phase,
          prompt,
          useTaskImages: false,
          structuredReview,
          startedAt: new Date().toISOString(),
        };
        candidate.activePromptContext = {
          phase,
          kind: "prompt-dispatch",
          sessionId: session.sdkSessionId,
          requestId,
          prompt,
          useTaskImages: false,
          structuredReview,
        };
        session.structuredRequestId = structuredReview ? requestId : undefined;
        if (phase === "reviewing") {
          candidate.structuredReviewRequestId = requestId;
          delete candidate.structuredReview;
        }
      }
    });
    void this.runLocked(pipelineId);
    return pipeline;
  }

  /**
   * Queues a user message for the pipeline's current agent session.
   *
   * The message is durable rather than sent straight through: the agent is
   * usually mid-turn, the tab that composed it may be unmounted before the turn
   * ends, and a pause can sit between composing and dispatch. The supervisor
   * delivers it on the next idle tick, one at a time, through the same
   * at-most-once attempt record every other prompt uses.
   */
  async sendMessage(pipelineId: string, text: string): Promise<BuildPipeline> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Message must not be blank");
    if (trimmed.length > MAX_PIPELINE_USER_MESSAGE_LENGTH) {
      throw new Error(
        `Message exceeds the ${MAX_PIPELINE_USER_MESSAGE_LENGTH} character limit`,
      );
    }
    let rejection: Error | undefined;
    const pipeline = await this.mutate(pipelineId, (candidate) => {
      if (candidate.phase === "complete" || candidate.phase === "failed") {
        rejection = new Error("This build has finished");
        return;
      }
      const queue = candidate.pendingUserMessages ?? [];
      if (queue.length >= MAX_PIPELINE_USER_MESSAGES) {
        rejection = new Error(
          `Only ${MAX_PIPELINE_USER_MESSAGES} queued messages are allowed`,
        );
        return;
      }
      candidate.pendingUserMessages = [...queue, {
        id: randomUUID(),
        text: trimmed,
        createdAt: new Date().toISOString(),
      }];
    });
    if (rejection) throw rejection;
    void this.runLocked(pipelineId);
    return pipeline;
  }

  /**
   * Re-runs the review stage against the current working tree.
   *
   * Recorded as a request rather than performed here so the new session is
   * created inside the same per-pipeline lock every other transition uses; a
   * direct startStage would race a tick that is already advancing this pipeline.
   */
  async retryReview(pipelineId: string): Promise<BuildPipeline> {
    let rejection: Error | undefined;
    await this.mutate(pipelineId, (candidate) => {
      if (candidate.phase === "complete") {
        rejection = new Error("This build has already completed");
        return;
      }
      if (!candidate.environmentId || candidate.sessions.length === 0) {
        rejection = new Error("This build has not reached its review stage yet");
        return;
      }
      candidate.reviewRetryRequested = true;
      if (candidate.phase === "failed" || candidate.phase === "paused") {
        // A retry is an explicit instruction to keep going, so revive the
        // pipeline; the requested review starts on the next supervisor pass.
        candidate.phase = candidate.pausedFromPhase ?? "reviewing";
        delete candidate.pausedFromPhase;
        delete candidate.error;
        delete candidate.failureContext;
        // The terminal comment for the abandoned outcome has already been
        // posted. Clearing the bookkeeping lets the eventual new outcome
        // reconcile again; the post commands dedupe by pipeline id, so this
        // cannot produce a second comment on the issue.
        delete candidate.completionCommentStatus;
        delete candidate.completionCommentError;
      }
    });
    if (rejection) throw rejection;
    await this.runLocked(pipelineId);
    return (await this.requireRecord(pipelineId)).snapshot as BuildPipeline;
  }

  async cancel(pipelineId: string): Promise<BuildPipeline> {
    let abortError: unknown;
    const pipeline = await this.mutate(pipelineId, async (pipeline) => {
      const session = sessionForCurrentPhase(pipeline);
      if (session?.status === "running" && pipeline.environmentId) {
        try {
          await (await this.provider(pipeline)).abort(session.sdkSessionId);
          session.status = "idle";
        } catch (error) {
          abortError = error;
        }
      }
      pipeline.phase = "failed";
      pipeline.error = abortError
        ? `Build cancelled, but stopping the agent could not be confirmed: ${errorMessage(abortError)}`
        : "Build cancelled";
      delete pipeline.pendingPromptAttempt;
      delete pipeline.activePromptContext;
      delete pipeline.pendingUserMessages;
      delete pipeline.reviewRetryRequested;
    });
    await this.reconcileTerminalState(pipeline);
    if (abortError) throw abortError;
    return pipeline;
  }

  async remove(pipelineId: string): Promise<void> {
    const record = await this.storage.getBuildPipeline(pipelineId);
    if (
      record
      && isBuildPipeline(record.snapshot)
      && isActiveBuildPhase(record.snapshot.phase)
    ) {
      await this.cancel(pipelineId);
    }
    await this.storage.deleteBuildPipeline(pipelineId);
    if (!record || !isBuildPipeline(record.snapshot)) return;
    const providerKey = `${record.snapshot.environmentId}:${record.snapshot.agentType}`;
    // Providers are keyed by environment and agent, so a sibling pipeline in
    // the same environment shares this one. Disposing it there would tear down
    // the OpenCode request monitor out from under a build that is still running.
    const stillInUse = (await this.storage.listAllBuildPipelines()).some(
      (candidate) =>
        candidate.id !== pipelineId
        && isBuildPipeline(candidate.snapshot)
        && `${candidate.snapshot.environmentId}:${candidate.snapshot.agentType}`
          === providerKey,
    );
    if (stillInUse) return;
    const provider = this.providers.get(providerKey);
    this.providers.delete(providerKey);
    await provider?.dispose?.();
  }

  async retryCompletionComment(pipelineId: string): Promise<BuildPipeline> {
    await this.mutate(pipelineId, (candidate) => {
      delete candidate.completionCommentStatus;
      delete candidate.completionCommentError;
    });
    await this.runLocked(pipelineId);
    const record = await this.requireRecord(pipelineId);
    const pipeline = record.snapshot as BuildPipeline;
    if (pipeline.completionCommentStatus === "failed") {
      throw new Error(pipeline.completionCommentError ?? "Failed to post completion comment");
    }
    return pipeline;
  }

  private requestTick(): Promise<void> {
    if (this.tickPromise) {
      this.tickRequested = true;
      return this.tickPromise;
    }
    const operation = (async () => {
      do {
        this.tickRequested = false;
        await this.tickPass();
      } while (!this.stopped && this.tickRequested);
    })().finally(() => {
      if (this.tickPromise === operation) this.tickPromise = null;
    });
    this.tickPromise = operation;
    return operation;
  }

  private async tickPass(): Promise<void> {
    if (this.stopped) return;
    const records = await this.storage.listAllBuildPipelines();
    await Promise.all(records.flatMap((record) => {
      if (
        !isBuildPipeline(record.snapshot)
        || (
          !isActiveBuildPhase(record.snapshot.phase)
          && !this.needsTerminalReconciliation(record.snapshot)
        )
      ) {
        return [];
      }
      return [this.runLocked(record.id)];
    }));
  }

  private runLocked(
    pipelineId: string,
    namingPrompt?: string,
  ): Promise<void> {
    // Timer ticks are level-triggered. If a pass is already running, joining
    // it is sufficient; appending another promise every 1.5 seconds lets a
    // stalled provider call grow an unbounded queue.
    const existing = this.locks.get(pipelineId);
    if (existing) return existing;
    const next = this.advance(pipelineId, namingPrompt)
      .catch(async (error) => {
        if (error instanceof ProviderUnavailableError) {
          await this.recordReconnect(pipelineId, error).catch(() => undefined);
        } else {
          await this.fail(pipelineId, error).catch(() => undefined);
        }
      })
      .finally(() => {
        if (this.locks.get(pipelineId) === next) this.locks.delete(pipelineId);
      });
    this.locks.set(pipelineId, next);
    return next;
  }

  private async advance(
    pipelineId: string,
    namingPrompt?: string,
  ): Promise<void> {
    const record = await this.requireRecord(pipelineId);
    const pipeline = record.snapshot as BuildPipeline;
    pipeline.backendRevision = record.revision;
    if (!isActiveBuildPhase(pipeline.phase)) {
      await this.reconcileTerminalState(pipeline);
      return;
    }

    if (pipeline.environmentId && !pipeline.sourceLinkedAt) {
      await this.ensureSourceLink(pipeline);
      return;
    }

    if (pipeline.phase === "creating-environment") {
      const environment = await this.findLinkedEnvironment(pipeline)
        ?? await this.invoke<Environment>("create_environment", {
          projectId: pipeline.projectId,
          networkAccessMode: pipeline.environmentType === "containerized"
            ? "restricted"
            : "full",
          environmentType: pipeline.environmentType,
          buildPipelineId: pipeline.id,
          namingPrompt: namingPrompt
            ?? this.provisioningPrompts.get(pipeline.id)
            ?? pipeline.taskTitle,
        });
      pipeline.environmentId = environment.id;
      pipeline.environmentType = environment.environmentType;
      pipeline.phase = "starting-environment";
      await this.save(pipeline, record.revision);
      this.provisioningPrompts.delete(pipeline.id);
      return;
    }

    if (!pipeline.environmentId) {
      throw new Error("Build pipeline has no environment");
    }

    if (pipeline.phase === "starting-environment") {
      await this.configureEnvironment(pipeline);
      const environment = await this.storage.getEnvironment(pipeline.environmentId);
      if (!environment) throw new Error("Build environment no longer exists");
      if (environment.status !== "running") {
        await this.invoke("start_environment", {
          environmentId: pipeline.environmentId,
        });
      }
      pipeline.phase = "waiting-for-setup";
      await this.save(pipeline, record.revision);
      return;
    }

    if (pipeline.phase === "waiting-for-setup") {
      await this.invoke("run_environment_setup", {
        environmentId: pipeline.environmentId,
      });
      await this.startStage(pipeline, "build", "building");
      return;
    }

    const session = sessionForCurrentPhase(pipeline);
    if (!session) {
      await this.restartMissingStage(pipeline);
      return;
    }
    const provider = await this.provider(pipeline);
    const status = await provider.status(session.sdkSessionId);
    if (pipeline.reconnectAttempt) {
      delete pipeline.reconnectAttempt;
      delete pipeline.error;
      await this.save(pipeline, record.revision);
      return;
    }
    if (status === "missing") {
      throw new Error(`The ${session.label.toLowerCase()} is no longer available`);
    }
    if (status === "error") {
      throw new Error(`The ${session.label.toLowerCase()} failed`);
    }
    if (
      pipeline.pendingPromptAttempt
      && pipeline.pendingPromptAttempt.sessionId === session.sdkSessionId
    ) {
      if (status === "running") {
        delete pipeline.pendingPromptAttempt;
        await this.save(pipeline, record.revision);
        return;
      }
      await this.dispatchPending(pipeline, provider);
      return;
    }
    if (status === "running") {
      const transcriptChanged = await this.refreshTranscript(session, provider);
      const statusChanged = session.status !== "running";
      session.status = "running";
      // A status change is a state transition and always persists. A pure
      // transcript delta is throttled: it arrives on every tick of a streaming
      // turn, and each save rewrites the entire build-pipelines file.
      if (statusChanged || (transcriptChanged && this.shouldPersistTranscript(session))) {
        session.messagesPersistedAt = new Date().toISOString();
        await this.save(pipeline, record.revision);
      }
      return;
    }

    const wasRunning = session.status === "running";
    session.status = "idle";
    const transcriptChanged = await this.refreshTranscript(session, provider);
    delete pipeline.pendingPromptAttempt;
    delete pipeline.activePromptContext;
    if (wasRunning || transcriptChanged) {
      // The turn is over, so this is the final transcript. Persist it now
      // rather than leaving the throttled tail to whichever branch runs next —
      // several of them return without saving.
      session.messagesPersistedAt = new Date().toISOString();
      await this.save(pipeline, pipeline.backendRevision);
    }

    if (pipeline.reviewRetryRequested) {
      delete pipeline.reviewRetryRequested;
      delete pipeline.structuredReview;
      delete pipeline.verificationResult;
      delete pipeline.verificationFeedback;
      await this.startStage(pipeline, "review", "reviewing");
      return;
    }

    if (pipeline.pendingUserMessages?.length) {
      await this.dispatchUserMessage(pipeline, provider, session);
      return;
    }

    switch (pipeline.phase) {
      case "building":
      case "fixing":
        await this.startStage(pipeline, "review", "reviewing");
        return;
      case "reviewing":
        await this.finishReview(pipeline, provider, session);
        return;
      case "addressing":
        await this.startStage(pipeline, "verify", "verifying");
        return;
      case "verifying":
        await this.finishVerification(pipeline, provider, session);
        return;
      case "creating-pr":
        await this.finishPullRequest(pipeline);
        return;
      case "resolving-conflicts":
        await this.finishConflictResolution(pipeline);
        return;
      default:
        return;
    }
  }

  private async findLinkedEnvironment(
    pipeline: Pick<BuildPipeline, "id" | "projectId">,
  ): Promise<Environment | undefined> {
    return (await this.storage.getEnvironmentsByProject(pipeline.projectId))
      .find((environment) =>
        environment.buildPipelineId === pipeline.id
        && !environment.deletionRequestedAt
      );
  }

  private async refreshTranscript(
    session: PipelineSession,
    provider: BuildPipelineProvider,
  ): Promise<boolean> {
    const messages = await provider.messages(session.sdkSessionId);
    const fingerprint = transcriptFingerprint(messages);
    // A snapshot restored before fingerprints existed has none, so fall back to
    // recomputing it from the stored transcript exactly once.
    const previous = session.messagesFingerprint
      ?? (session.messages === undefined
        ? undefined
        : transcriptFingerprint(session.messages));
    if (previous === fingerprint) return false;
    session.messages = messages;
    session.messagesFingerprint = fingerprint;
    session.messageRevision = (session.messageRevision ?? 0) + 1;
    return true;
  }

  private shouldPersistTranscript(session: PipelineSession): boolean {
    const elapsed = elapsedSince(session.messagesPersistedAt);
    return elapsed === null || elapsed >= this.transcriptPersistIntervalMs;
  }

  /**
   * Dispatches the oldest queued user message into the current session.
   *
   * The message moves out of the queue and into the durable prompt attempt
   * before anything is sent, so a dispatch whose response is lost is retried by
   * the normal pending-attempt path under the same request id rather than being
   * either dropped or delivered twice.
   */
  private async dispatchUserMessage(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void> {
    const [next, ...rest] = pipeline.pendingUserMessages ?? [];
    if (!next) return;
    const phase = resumablePhase(pipeline.phase);
    if (!phase) return;
    if (rest.length) {
      pipeline.pendingUserMessages = rest;
    } else {
      delete pipeline.pendingUserMessages;
    }
    const requestId = randomUUID();
    pipeline.pendingPromptAttempt = {
      id: next.id,
      sessionId: session.sdkSessionId,
      requestId,
      phase,
      prompt: next.text,
      useTaskImages: false,
      startedAt: new Date().toISOString(),
    };
    await this.save(pipeline, pipeline.backendRevision);
    await this.dispatchPending(pipeline, provider);
  }

  private async ensureSourceLink(pipeline: BuildPipeline): Promise<void> {
    if (!pipeline.environmentId || pipeline.sourceLinkedAt) return;
    if (pipeline.source?.type === "kanban") {
      await this.invoke("update_kanban_task", {
        taskId: pipeline.source.taskId,
        environmentId: pipeline.environmentId,
        buildPipelineId: pipeline.id,
      });
    }
    if (pipeline.featurePlanId) {
      await this.invoke("update_feature_plan", {
        featureId: pipeline.featurePlanId,
        updates: {
          status: "building",
          buildTaskId: pipeline.taskId,
          buildPipelineId: pipeline.id,
          codexEnvironmentId: pipeline.environmentId,
        },
      });
    }
    pipeline.sourceLinkedAt = new Date().toISOString();
    await this.save(pipeline, pipeline.backendRevision);
  }

  private async restartMissingStage(pipeline: BuildPipeline): Promise<void> {
    const stage = pipeline.phase === "building"
      ? "build"
      : pipeline.phase === "reviewing"
        ? "review"
        : pipeline.phase === "verifying"
          ? "verify"
          : pipeline.phase === "fixing"
            ? "fix"
            : pipeline.phase === "creating-pr"
              ? "pr"
              : pipeline.phase === "resolving-conflicts"
                ? "resolve-conflicts"
                : null;
    if (!stage) throw new Error(`Cannot recover pipeline phase ${pipeline.phase}`);
    await this.startStage(
      pipeline,
      stage,
      pipeline.phase as ResumableBuildPhase,
    );
  }

  private async startStage(
    pipeline: BuildPipeline,
    sessionPhase: PipelineSessionPhase,
    phase: ResumableBuildPhase,
  ): Promise<void> {
    if (sessionPhase === "build") {
      await this.updateKanbanLifecycle(pipeline, {
        status: "in-progress",
        comment: "🔨 Build started",
      });
    }
    const provider = await this.provider(pipeline);
    const label = SESSION_LABELS[sessionPhase];
    const sessionId = await provider.createSession(sessionPhase, label);
    provider.registerSession?.(sessionId);
    const { prompt, schema, images } = await this.promptFor(pipeline, sessionPhase);
    const requestId = randomUUID();
    const session: PipelineSession = {
      phase: sessionPhase,
      iteration: pipeline.iteration,
      sessionKey: `${pipeline.id}:${sessionPhase}:${pipeline.iteration}:${randomUUID()}`,
      sdkSessionId: sessionId,
      status: "running",
      startedAt: new Date().toISOString(),
      label,
      messages: [],
      messageRevision: 0,
      structuredRequestId: schema !== undefined ? requestId : undefined,
    };
    pipeline.sessions.push(session);
    pipeline.currentSessionIndex = pipeline.sessions.length - 1;
    pipeline.phase = phase;
    delete pipeline.error;
    delete pipeline.failureContext;

    pipeline.pendingPromptAttempt = {
      id: randomUUID(),
      sessionId,
      requestId,
      phase,
      prompt,
      useTaskImages: images.length > 0,
      structuredReview: schema !== undefined,
      startedAt: new Date().toISOString(),
    };
    pipeline.activePromptContext = {
      phase,
      kind: "prompt-dispatch",
      sessionId,
      prompt,
      useTaskImages: images.length > 0,
      requestId,
      structuredReview: schema !== undefined,
    };
    if (sessionPhase === "review") {
      pipeline.structuredReviewRequestId = requestId;
      delete pipeline.structuredReview;
    }
    await this.save(pipeline, pipeline.backendRevision);
    try {
      await provider.send(sessionId, prompt, { requestId, images, schema });
      delete pipeline.pendingPromptAttempt;
      await this.save(pipeline, pipeline.backendRevision);
    } catch (error) {
      if (error instanceof PromptRejectedError) throw error;
      // The bridge may have accepted the stable request before the response was
      // lost. Keep the durable attempt; the next tick reconciles status and, if
      // still idle, retries this exact request ID through bridge deduplication.
    }
  }

  private async dispatchPending(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
  ): Promise<void> {
    const attempt = pipeline.pendingPromptAttempt;
    if (!attempt) return;
    const schema = attempt.structuredReview
      ? attempt.phase === "reviewing"
        ? STRUCTURED_REVIEW_REPORT_JSON_SCHEMA
        : attempt.phase === "verifying"
          ? VERIFICATION_SCHEMA
          : undefined
      : undefined;
    try {
      await provider.send(attempt.sessionId, attempt.prompt, {
        requestId: attempt.requestId,
        images: attempt.useTaskImages
          ? pipeline.taskSnapshot.images
          : [],
        schema,
      });
      const session = pipeline.sessions.find((candidate) =>
        candidate.sdkSessionId === attempt.sessionId);
      if (session) session.status = "running";
      delete pipeline.pendingPromptAttempt;
      await this.save(pipeline, pipeline.backendRevision);
    } catch (error) {
      if (error instanceof PromptRejectedError) throw error;
    }
  }

  private async promptFor(
    pipeline: BuildPipeline,
    phase: PipelineSessionPhase,
  ): Promise<{ prompt: string; schema?: JsonSchema; images: BuildPipeline["taskSnapshot"]["images"] }> {
    const notes = (await this.storage.getProjectNotes(pipeline.projectId)).content;
    const config = await this.storage.loadConfig();
    const repository = await this.storage.getRepositoryConfig(pipeline.projectId);
    const target = repository.prBaseBranch || "main";
    if (phase === "build") {
      return { prompt: buildPrompt(pipeline, notes), images: pipeline.taskSnapshot.images };
    }
    if (phase === "review") {
      return {
        prompt: reviewPrompt(
          pipeline,
          notes,
          target,
          config.global.reviewInstruction,
        ),
        schema: STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
        images: pipeline.taskSnapshot.images,
      };
    }
    if (phase === "verify") {
      return {
        prompt: verificationPrompt(pipeline, notes, target),
        schema: VERIFICATION_SCHEMA,
        images: pipeline.taskSnapshot.images,
      };
    }
    if (phase === "fix") {
      return {
        prompt: fixPrompt(
          pipeline,
          notes,
          pipeline.verificationFeedback ?? "The verification did not pass.",
        ),
        images: pipeline.taskSnapshot.images,
      };
    }
    if (phase === "pr") {
      return { prompt: prPrompt(target), images: [] };
    }
    return { prompt: resolveConflictsPrompt(target), images: [] };
  }

  private async finishReview(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void> {
    const requestId = pipeline.structuredReviewRequestId;
    if (!requestId) throw new Error("Review result key is missing");
    const result = await provider.structured<unknown>(session.sdkSessionId, requestId);
    if (!result) {
      await this.awaitStructuredResult(pipeline, session, "review");
      return;
    }
    delete session.structuredWaitStartedAt;
    if (!result.ok) throw new Error(result.error.message);
    const report = parseStructuredReviewReport(result.value, {
      allowLegacyTestResults: true,
    });
    pipeline.structuredReview = report;
    if (report.issues.length || report.testCoverageGaps.length) {
      pipeline.phase = "addressing";
      const prompt = addressPrompt(report);
      const request = randomUUID();
      pipeline.pendingPromptAttempt = {
        id: randomUUID(),
        sessionId: session.sdkSessionId,
        requestId: request,
        phase: "addressing",
        prompt,
        useTaskImages: false,
        startedAt: new Date().toISOString(),
      };
      await this.save(pipeline, pipeline.backendRevision);
      // Routed through dispatchPending so a lost response keeps the durable
      // attempt and retries under the same request id, exactly as every other
      // dispatch does, instead of failing a review that has already succeeded.
      await this.dispatchPending(pipeline, provider);
      return;
    }
    await this.startStage(pipeline, "verify", "verifying");
  }

  private async finishVerification(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void> {
    // advance() clears pendingPromptAttempt and activePromptContext before it
    // reaches this branch, so the session's own key is the only durable copy.
    // A snapshot written before that field existed has none, and there the
    // providers' own transcript metadata carries the last structured request.
    const resolvedRequestId = session.structuredRequestId
      ?? this.structuredRequestId(session.messages);
    if (!resolvedRequestId) throw new Error("Verification result key is missing");
    const result = await provider.structured<{
      complete: boolean;
      rationale: string;
    }>(session.sdkSessionId, resolvedRequestId);
    if (!result) {
      await this.awaitStructuredResult(pipeline, session, "verification");
      return;
    }
    delete session.structuredWaitStartedAt;
    if (!result.ok) throw new Error(result.error.message);
    const complete = result.value?.complete === true;
    const rationale = typeof result.value?.rationale === "string"
      ? result.value.rationale
      : "Verification returned no rationale.";
    pipeline.verificationResult = complete ? "pass" : "fail";
    pipeline.verificationFeedback = rationale;
    if (complete) {
      await this.updateKanbanLifecycle(pipeline, {
        comment: "✅ Validation complete",
      });
      await this.startStage(pipeline, "pr", "creating-pr");
      return;
    }
    if (pipeline.iteration >= pipeline.maxIterations) {
      throw new Error(`Verification failed after ${pipeline.maxIterations} iterations: ${rationale}`);
    }
    pipeline.iteration += 1;
    await this.startStage(pipeline, "fix", "fixing");
  }

  /**
   * Records that a finished turn has not produced its structured result yet,
   * and fails the pipeline once that has gone on too long.
   *
   * A null result is normal for a tick or two while the provider finalizes the
   * turn. It is also what a bridge returns for a result it no longer holds —
   * after a restart mid-turn, say — and in that case the session stays idle and
   * the answer never arrives. Without this the supervisor would re-poll an
   * unchanged snapshot every 1.5 seconds forever, showing the user a stage that
   * looks live and will never move.
   */
  private async awaitStructuredResult(
    pipeline: BuildPipeline,
    session: PipelineSession,
    label: string,
  ): Promise<void> {
    const elapsed = elapsedSince(session.structuredWaitStartedAt);
    if (elapsed === null) {
      session.structuredWaitStartedAt = new Date().toISOString();
      await this.save(pipeline, pipeline.backendRevision);
      return;
    }
    if (elapsed >= this.structuredResultDeadlineMs) {
      throw new Error(
        `The ${label} finished without returning its required structured result`,
      );
    }
  }

  private structuredRequestId(messages: unknown[] | undefined): string | undefined {
    if (!messages) return undefined;
    for (const entry of [...messages].reverse()) {
      if (!entry || typeof entry !== "object") continue;
      const record = entry as Record<string, unknown>;
      const info = record.info && typeof record.info === "object"
        ? record.info as Record<string, unknown>
        : record;
      if (info.role === "user" && typeof info.id === "string") return info.id;
      if (typeof record.requestId === "string") return record.requestId;
      if (typeof record.id === "string" && record.role === "user") return record.id;
    }
    return undefined;
  }

  private async finishPullRequest(pipeline: BuildPipeline): Promise<void> {
    const detection = await this.detectPullRequest(pipeline);
    if (!detection) {
      // PR creation and GitHub indexing are not atomic. Keep the pipeline in
      // creating-pr and let the durable monitor plus the next supervisor pass
      // observe it; absence is not evidence that creation succeeded.
      await this.invoke("pr_monitor_watch", {
        environmentId: pipeline.environmentId,
        mode: "create-pending",
      });
      return;
    }
    await this.persistPullRequest(pipeline, detection);
    if (detection.hasMergeConflicts) {
      await this.startStage(pipeline, "resolve-conflicts", "resolving-conflicts");
      return;
    }
    await this.complete(pipeline);
  }

  private async finishConflictResolution(pipeline: BuildPipeline): Promise<void> {
    const detection = await this.detectPullRequest(pipeline);
    if (!detection) {
      throw new Error("The pull request could not be found after conflict resolution");
    }
    await this.persistPullRequest(pipeline, detection);
    if (detection.hasMergeConflicts) {
      throw new Error("Merge conflicts could not be fully resolved automatically");
    }
    await this.complete(pipeline);
  }

  private async detectPullRequest(
    pipeline: BuildPipeline,
  ): Promise<PullRequestDetection | null> {
    const environment = await this.storage.getEnvironment(pipeline.environmentId);
    if (!environment) throw new Error("Build environment no longer exists");
    const result = environment.environmentType === "local"
      ? await this.invoke<PullRequestDetection | null>("detect_pr_local", {
          environmentId: environment.id,
          branch: environment.branch,
        })
      : environment.containerId
        ? await this.invoke<PullRequestDetection | null>("detect_pr", {
            containerId: environment.containerId,
            branch: environment.branch,
          })
        : (() => {
            throw new Error("Build container is unavailable");
          })();
    if (!result) return null;
    if (
      typeof result.url !== "string"
      || !result.url
      || !["open", "merged", "closed"].includes(result.state)
      || typeof result.hasMergeConflicts !== "boolean"
    ) {
      throw new Error("Pull request detection returned an invalid result");
    }
    return result;
  }

  private async persistPullRequest(
    pipeline: BuildPipeline,
    detection: PullRequestDetection,
  ): Promise<void> {
    await this.storage.updateEnvironment(pipeline.environmentId, {
      prUrl: detection.url,
      prState: detection.state,
      hasMergeConflicts: detection.hasMergeConflicts,
    });
    await this.updateKanbanLifecycle(pipeline, {
      status: "review",
      prUrl: detection.url,
      prState: detection.state,
      comment: `🔗 PR raised: ${detection.url}`,
    });
    await this.invoke("pr_monitor_watch", {
      environmentId: pipeline.environmentId,
      mode: "normal",
    });
  }

  private async complete(pipeline: BuildPipeline): Promise<void> {
    pipeline.phase = "complete";
    delete pipeline.error;
    await this.save(pipeline, pipeline.backendRevision);
    await this.reconcileTerminalState(pipeline);
  }

  private async postCompletionComment(pipeline: BuildPipeline): Promise<void> {
    const source = pipeline.source;
    if (!source || source.type === "kanban") return;
    if (pipeline.completionCommentStatus === "posted") return;
    pipeline.completionCommentStatus = "posting";
    await this.save(pipeline, pipeline.backendRevision);
    const body = pipeline.phase === "complete"
      ? `✅ Orkestrator build completed for **${pipeline.taskTitle}**.`
      : `❌ Orkestrator build failed for **${pipeline.taskTitle}**: ${pipeline.error ?? "Unknown error"}`;
    const result = source.type === "linear"
      ? await this.invoke<{ commentId?: string; postedAt?: string }>(
          "post_linear_completion_comment",
          {
            pipelineId: pipeline.id,
            issueId: source.issueId,
            body,
          },
        )
      : await this.invoke<{ commentId?: string; postedAt?: string }>(
          "post_github_completion_comment",
          {
            pipelineId: pipeline.id,
            projectId: pipeline.projectId,
            repositoryOwner: source.repositoryOwner,
            repositoryName: source.repositoryName,
            issueNumber: source.issueNumber,
            body,
          },
        );
    pipeline.completionCommentStatus = "posted";
    pipeline.completionCommentId = result.commentId;
    pipeline.completionCommentPostedAt = result.postedAt ?? new Date().toISOString();
    delete pipeline.completionCommentError;
    await this.save(pipeline, pipeline.backendRevision);
  }

  private needsTerminalReconciliation(pipeline: BuildPipeline): boolean {
    if (pipeline.phase !== "complete" && pipeline.phase !== "failed") return false;
    return Boolean(
      pipeline.source
      && pipeline.completionCommentStatus !== "posted"
      && pipeline.completionCommentStatus !== "failed",
    );
  }

  private async reconcileTerminalState(pipeline: BuildPipeline): Promise<void> {
    if (pipeline.phase !== "complete" && pipeline.phase !== "failed") return;
    if (!pipeline.source) return;
    if (pipeline.source.type === "kanban") {
      if (pipeline.completionCommentStatus === "posted") return;
      try {
        pipeline.completionCommentStatus = "posting";
        await this.save(pipeline, pipeline.backendRevision);
        await this.updateKanbanLifecycle(pipeline, {
          status: pipeline.phase === "complete" ? "review" : "backlog",
        });
        pipeline.completionCommentStatus = "posted";
        pipeline.completionCommentPostedAt = new Date().toISOString();
        delete pipeline.completionCommentError;
        await this.save(pipeline, pipeline.backendRevision);
      } catch (error) {
        pipeline.completionCommentStatus = "failed";
        pipeline.completionCommentError = errorMessage(error);
        await this.save(pipeline, pipeline.backendRevision);
      }
      return;
    }
    try {
      await this.postCompletionComment(pipeline);
    } catch (error) {
      pipeline.completionCommentStatus = "failed";
      pipeline.completionCommentError = errorMessage(error);
      await this.save(pipeline, pipeline.backendRevision);
    }
  }

  private async updateKanbanLifecycle(
    pipeline: BuildPipeline,
    updates: {
      status?: "backlog" | "in-progress" | "review";
      comment?: string;
      prUrl?: string;
      prState?: "open" | "merged" | "closed";
    },
  ): Promise<void> {
    const source = pipeline.source;
    if (source?.type !== "kanban") return;
    const tasks = await this.invoke<Array<{
      id: string;
      status: string;
      prUrl?: string;
      prState?: string;
      comments: Array<{ text: string }>;
    }>>("get_kanban_tasks", { projectId: pipeline.projectId });
    const task = tasks
      .find((candidate) => candidate.id === source.taskId);
    if (!task) throw new Error(`Kanban task not found: ${source.taskId}`);
    if (
      (updates.status && task.status !== updates.status)
      || (updates.prUrl && task.prUrl !== updates.prUrl)
      || (updates.prState && task.prState !== updates.prState)
    ) {
      await this.invoke("update_kanban_task", {
        taskId: task.id,
        ...(updates.status ? { status: updates.status } : {}),
        ...(updates.prUrl ? { prUrl: updates.prUrl } : {}),
        ...(updates.prState ? { prState: updates.prState } : {}),
      });
    }
    if (
      updates.comment
      && !task.comments.some((comment) => comment.text === updates.comment)
    ) {
      await this.invoke("add_kanban_comment", {
        taskId: task.id,
        text: updates.comment,
      });
    }
  }

  private async configureEnvironment(pipeline: BuildPipeline): Promise<void> {
    await this.invoke("update_environment_agent_settings", {
      environmentId: pipeline.environmentId,
      defaultAgent: pipeline.agentType,
      claudeMode: "native",
      claudeNativeBackend: null,
      opencodeMode: "native",
      codexMode: "native",
      pendingAgentLaunch: false,
    });
  }

  private async provider(pipeline: BuildPipeline): Promise<BuildPipelineProvider> {
    if (this.options.provider) {
      const provider = await this.options.provider(pipeline);
      for (const session of pipeline.sessions) {
        provider.registerSession?.(session.sdkSessionId);
      }
      return provider;
    }
    const providerKey = `${pipeline.environmentId}:${pipeline.agentType}`;
    const cached = this.providers.get(providerKey);
    if (cached) {
      for (const session of pipeline.sessions) {
        cached.registerSession?.(session.sdkSessionId);
      }
      return cached;
    }
    const environment = await this.storage.getEnvironment(pipeline.environmentId);
    if (!environment) throw new Error("Build environment no longer exists");
    const config = await this.storage.loadConfig();
    const repository = await this.storage.getRepositoryConfig(pipeline.projectId);
    const connection = await this.bridgeConnection(pipeline.agentType, environment);
    const provider = createBuildPipelineProvider({
      ...connection,
      model: modelFor(
        pipeline.agentType,
        config.global,
        repository.defaultModel,
      ),
      effort: repository.defaultEffort
        ?? (pipeline.agentType === "codex"
          ? config.global.codexReasoningEffort
          : undefined),
    }, {
      // Task-snapshot images arrive as base64. Both bridges require a workspace
      // path, so they have to be written into the environment before they can be
      // attached to a prompt.
      stageImages: (images) =>
        stagePromptImages(this.invoke, environment, images),
    });
    for (const session of pipeline.sessions) {
      provider.registerSession?.(session.sdkSessionId);
    }
    this.providers.set(providerKey, provider);
    return provider;
  }

  private async bridgeConnection(
    agent: BuildPipelineAgent,
    environment: Environment,
  ): Promise<BridgeConnection> {
    const suffix = agent === "opencode"
      ? "opencode"
      : agent;
    if (environment.environmentType === "local") {
      const result = await this.invoke<{
        port: number;
        authToken?: string;
      }>(`start_local_${suffix}_server_cmd`, {
        environmentId: environment.id,
      });
      if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
      return {
        agent,
        baseUrl: `http://127.0.0.1:${result.port}`,
        authToken: result.authToken,
        directory: environment.worktreePath,
      };
    }
    if (!environment.containerId) throw new Error("Build container is unavailable");
    const result = await this.invoke<{
      hostPort: number;
      authToken?: string;
    }>(`start_${suffix}_server`, {
      containerId: environment.containerId,
    });
    if (!result.authToken) throw new Error(`${agent} bridge authentication is unavailable`);
    return {
      agent,
      baseUrl: `http://127.0.0.1:${result.hostPort}`,
      authToken: result.authToken,
    };
  }

  private async fail(pipelineId: string, error: unknown): Promise<void> {
    const record = await this.storage.getBuildPipeline(pipelineId);
    if (!record || !isBuildPipeline(record.snapshot)) return;
    const pipeline = record.snapshot;
    if (!isActiveBuildPhase(pipeline.phase)) return;
    pipeline.backendRevision = record.revision;
    pipeline.error = errorMessage(error);
    pipeline.failureContext = {
      phase: pipeline.phase as ResumableBuildPhase,
      kind: "stage-transition",
      sessionId: sessionForCurrentPhase(pipeline)?.sdkSessionId,
    };
    pipeline.phase = "failed";
    delete pipeline.pendingPromptAttempt;
    this.provisioningPrompts.delete(pipeline.id);
    await this.save(pipeline, record.revision);
    await this.reconcileTerminalState(pipeline);
  }

  private async recordReconnect(
    pipelineId: string,
    error: ProviderUnavailableError,
  ): Promise<void> {
    const record = await this.storage.getBuildPipeline(pipelineId);
    if (!record || !isBuildPipeline(record.snapshot)) return;
    const pipeline = record.snapshot;
    const phase = resumablePhase(pipeline.phase);
    if (!phase) return;
    const providerKey = `${pipeline.environmentId}:${pipeline.agentType}`;
    const provider = this.providers.get(providerKey);
    this.providers.delete(providerKey);
    await provider?.dispose?.();
    const startedAt = pipeline.reconnectAttempt?.startedAt
      ?? new Date().toISOString();
    const elapsed = elapsedSince(startedAt);
    if (elapsed !== null && elapsed >= this.reconnectDeadlineMs) {
      // Retrying forever is indistinguishable from working, from the outside.
      // Once the bridge has stayed unreachable past the deadline, say so rather
      // than leaving the user watching a stage that will never advance.
      await this.fail(
        pipelineId,
        new Error(
          `${pipeline.agentType} stayed unreachable for ${Math.round(elapsed / 1000)}s: ${error.message}`,
        ),
      );
      return;
    }
    pipeline.backendRevision = record.revision;
    pipeline.reconnectAttempt = {
      id: pipeline.reconnectAttempt?.id ?? randomUUID(),
      phase,
      kind: "stage-transition",
      sessionId: sessionForCurrentPhase(pipeline)?.sdkSessionId,
      startedAt,
    };
    pipeline.error = `Reconnecting to ${pipeline.agentType}: ${error.message}`;
    await this.save(pipeline, record.revision);
  }

  private async mutate(
    pipelineId: string,
    mutation: (pipeline: BuildPipeline) => void | Promise<void>,
  ): Promise<BuildPipeline> {
    const previous = this.locks.get(pipelineId) ?? Promise.resolve();
    let result: BuildPipeline | undefined;
    const next = previous.catch(() => undefined).then(async () => {
      const record = await this.requireRecord(pipelineId);
      const pipeline = record.snapshot as BuildPipeline;
      pipeline.backendRevision = record.revision;
      await mutation(pipeline);
      await this.save(pipeline, record.revision);
      result = pipeline;
    }).finally(() => {
      if (this.locks.get(pipelineId) === next) this.locks.delete(pipelineId);
    });
    this.locks.set(pipelineId, next);
    await next;
    return result!;
  }

  private async requireRecord(pipelineId: string): Promise<PersistedBuildPipeline> {
    const record = await this.storage.getBuildPipeline(pipelineId);
    if (!record || !isBuildPipeline(record.snapshot)) {
      throw new Error(`Build pipeline not found: ${pipelineId}`);
    }
    return record;
  }

  private async save(
    pipeline: BuildPipeline,
    expectedRevision: number,
  ): Promise<PersistedBuildPipeline> {
    pipeline.controller = "backend";
    pipeline.backendRevision = expectedRevision + 1;
    const saved = await this.storage.saveBuildPipeline(
      pipeline.id,
      pipeline.projectId,
      pipeline.environmentId,
      BUILD_PIPELINE_VERSION,
      pipeline,
      expectedRevision,
    );
    pipeline.backendRevision = saved.revision;
    return saved;
  }
}
