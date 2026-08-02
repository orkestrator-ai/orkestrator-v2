import { createHash, randomUUID } from "node:crypto";
import type {
  BuildPhase,
  BuildPipeline,
  BuildPipelineAgent,
  BuildPipelineSource,
  BuildStepConfigs,
  PipelineSession,
  PipelineSessionPhase,
  ResumableBuildPhase,
  StartBuildPipelineInput,
} from "@orkestrator/protocol/build-pipeline";
import {
  BUILD_PIPELINE_VERSION,
  BUILD_STEP_KEYS,
  executionModeForSessionPhase,
  isBuildPipeline,
  isActiveBuildPhase,
  isStartBuildPipelineInput,
  stepKeyForSessionPhase,
  isVerificationVerdict,
  MAX_PIPELINE_USER_MESSAGES,
  MAX_PIPELINE_USER_MESSAGE_LENGTH,
  VERIFICATION_VERDICT_SCHEMA,
  type VerificationVerdict,
} from "@orkestrator/protocol/build-pipeline";
import {
  STRUCTURED_REVIEW_REPORT_JSON_SCHEMA,
  parseStructuredReviewReport,
} from "@orkestrator/protocol/structured-review";
import type { JsonSchema } from "@orkestrator/protocol/structured-output";
import { UNATTENDED_AGENT_INTERACTION_POLICY } from "@orkestrator/protocol/agent-interactions";
import type { AppConfig, Environment, PersistedBuildPipeline } from "./models.js";
import type { StorageService } from "./storage.js";
import {
  AmbiguousPromptDispatchError,
  createBuildPipelineProvider,
  ProviderUnavailableError,
  type BridgeConnection,
  type BuildPipelineProvider,
  type ProviderDependencies,
  type ProviderInteractionObservationEvent,
  type ProviderExecutionMode,
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

// The transcript renderer recognizes a verification answer by the same contract
// the turn is constrained to, and the protocol package derives both that schema
// and its type guard from one field list, so neither can drift from the other.
const VERIFICATION_SCHEMA: JsonSchema = VERIFICATION_VERDICT_SCHEMA;

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

/**
 * The agent a repository's `defaultModel` and `defaultEffort` were chosen for.
 *
 * Both are stored as a single value per repository rather than one per agent, so
 * they only describe the repository's own default agent. Since steps may now run
 * a harness the repository was never configured for, every read of them has to
 * be gated on this.
 */
function repositoryAgent(
  global: { defaultAgent?: BuildPipelineAgent },
  repository: { defaultAgent?: BuildPipelineAgent },
): BuildPipelineAgent {
  return repository.defaultAgent ?? global.defaultAgent ?? "claude";
}

/**
 * The default model for one harness.
 *
 * `repositoryDefault` is only passed when the caller has established that
 * `agent` is the repository's default agent; handing a Codex model id to the
 * Claude bridge is what happens otherwise.
 */
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

/**
 * The connection-level model and reasoning effort for one harness.
 *
 * The repository defaults apply only to the repository's own default agent. A
 * step that pinned a different harness falls back to that harness's global
 * default instead, which is exactly what the launcher displayed for it.
 */
function connectionDefaultsFor(
  agent: BuildPipelineAgent,
  config: Pick<AppConfig, "global">,
  repository: {
    defaultAgent?: BuildPipelineAgent;
    defaultModel?: string;
    defaultEffort?: string;
  },
): { model?: string; effort?: string } {
  const owns = agent === repositoryAgent(config.global, repository);
  return {
    model: modelFor(
      agent,
      config.global,
      owns ? repository.defaultModel : undefined,
    ),
    effort: (owns ? repository.defaultEffort : undefined)
      ?? (agent === "codex" ? config.global.codexReasoningEffort : undefined),
  };
}

/**
 * The harness a session runs on.
 *
 * Falls back to the pipeline agent for sessions recorded before steps could
 * choose their own, which all ran on that one agent.
 */
function sessionAgent(
  pipeline: BuildPipeline,
  session: PipelineSession,
): BuildPipelineAgent {
  return session.agent ?? pipeline.agentType;
}

/** Every harness a pipeline may hold a provider for. */
function pipelineAgents(pipeline: BuildPipeline): Set<BuildPipelineAgent> {
  const agents = new Set<BuildPipelineAgent>([pipeline.agentType]);
  for (const key of BUILD_STEP_KEYS) {
    const agent = pipeline.steps?.[key]?.agent;
    if (agent) agents.add(agent);
  }
  for (const session of pipeline.sessions) {
    agents.add(sessionAgent(pipeline, session));
  }
  return agents;
}

/**
 * The model a step actually pinned, or `undefined` for "no selection".
 *
 * `"default"` is a **real Claude catalog id** — the bridge resolves it to Opus
 * with a 1M context — so discarding it there silently downgrades the run to the
 * global default and contradicts the model the launcher displayed. For Codex and
 * OpenCode the same string is only ever the placeholder the launcher shows when
 * that harness has no catalog yet, and no server would recognise it, so there it
 * does mean "unset". The same asymmetry is documented at the other consumer,
 * `CreateEnvironmentDialog`.
 */
function stepModel(
  agent: BuildPipelineAgent,
  model: string | undefined,
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "default" && agent !== "claude") return undefined;
  return trimmed;
}

/**
 * Drops empty selections so a step that only pinned a harness does not also pin
 * a placeholder as a model id or the string "default" as a reasoning effort.
 */
function normalizeSteps(
  steps: BuildStepConfigs | undefined,
): BuildStepConfigs | undefined {
  if (!steps) return undefined;
  const normalized: BuildStepConfigs = {};
  for (const key of BUILD_STEP_KEYS) {
    const step = steps[key];
    if (!step) continue;
    const model = stepModel(step.agent, step.model);
    const reasoningEffort = step.reasoningEffort?.trim();
    normalized[key] = {
      agent: step.agent,
      ...(model ? { model } : {}),
      ...(reasoningEffort && reasoningEffort !== "default"
        ? { reasoningEffort }
        : {}),
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
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

function executionModeOverrideForPhase(
  phase: ResumableBuildPhase,
): ProviderExecutionMode | undefined {
  return phase === "addressing" ? "build" : undefined;
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
  hasMergeConflicts: boolean | null;
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
  /**
   * The harness whose provider each pipeline last resolved.
   *
   * A stage transition resolves and caches the *next* step's provider before it
   * records that step's session, so a failure there cannot be attributed by
   * reading the stored snapshot — it still describes the previous stage. Passes
   * are serialised per pipeline by {@link runLocked}, so the last agent handed
   * to {@link provider} is the one that failed.
   */
  private readonly lastProviderAgent = new Map<string, BuildPipelineAgent>();
  private readonly provisioningPrompts = new Map<string, string | undefined>();
  private tickPromise: Promise<void> | null = null;
  private tickRequested = false;
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: {
      autoAdvance?: boolean;
      provider?: (
        pipeline: BuildPipeline,
        agent: BuildPipelineAgent,
      ) => Promise<BuildPipelineProvider>;
      reconnectDeadlineMs?: number;
      structuredResultDeadlineMs?: number;
      transcriptPersistIntervalMs?: number;
      onInteractionObservation?: (
        event: ProviderInteractionObservationEvent & {
          environmentId: string;
          provider: BuildPipelineAgent;
        },
      ) => void | Promise<void>;
      /** Narrow production-provider seam used by deterministic backend tests. */
      providerDependencies?: Pick<
        ProviderDependencies,
        "openCodeClient" | "monitorRetryMs"
      >;
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
    this.lastProviderAgent.clear();
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
    const steps = normalizeSteps(input.steps);
    const pipeline: BuildPipeline = {
      id: randomUUID(),
      taskId: input.taskId,
      projectId: input.projectId,
      environmentId: existingEnvironmentId,
      environmentType: existingEnvironment?.environmentType ?? input.environmentType,
      // The build step's harness is the pipeline's agent: it is what the
      // environment default is configured for and what every stage without its
      // own configuration falls back to.
      agentType: steps?.build?.agent ?? input.agentType,
      ...(steps ? { steps } : {}),
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
          const provider = await this.provider(
            pipeline,
            sessionAgent(pipeline, session),
          );
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
          await (await this.provider(pipeline, sessionAgent(pipeline, session)))
            .abort(session.sdkSessionId);
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
    // `provider()` records attribution for reconnect handling while a pipeline
    // is active. Cancellation is a terminal transition, so retaining the id
    // here would grow the map for every cancelled build until shutdown.
    this.lastProviderAgent.delete(pipelineId);
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
    this.lastProviderAgent.delete(pipelineId);
    if (!record || !isBuildPipeline(record.snapshot)) return;
    const removed = record.snapshot;
    // Providers are keyed by environment and agent, so a sibling pipeline in
    // the same environment shares this one. Disposing it there would tear down
    // the OpenCode request monitor out from under a build that is still running.
    // A pipeline whose steps chose different harnesses holds one provider per
    // harness, so every one of them has to be checked, not just its build agent.
    const providerKeys = new Set(
      [...pipelineAgents(removed)].map(
        (agent) => `${removed.environmentId}:${agent}`,
      ),
    );
    for (const candidate of await this.storage.listAllBuildPipelines()) {
      if (candidate.id === pipelineId || !isBuildPipeline(candidate.snapshot)) {
        continue;
      }
      for (const agent of pipelineAgents(candidate.snapshot)) {
        providerKeys.delete(`${candidate.snapshot.environmentId}:${agent}`);
      }
    }
    for (const providerKey of providerKeys) {
      const provider = this.providers.get(providerKey);
      this.providers.delete(providerKey);
      await provider?.dispose?.();
    }
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
    const currentAgent = sessionAgent(pipeline, session);
    const provider = await this.provider(pipeline, currentAgent);
    const status = await provider.status(session.sdkSessionId);
    // Only the harness that was recorded as unreachable can clear its own
    // reconnect attempt. A stage transition resolves the *next* step's provider
    // before it records that step's session, so a failure there belongs to a
    // harness this session does not name — and clearing it on this session's
    // evidence would reset `startedAt` on every retry, so the reconnect deadline
    // would never elapse and the pipeline would retry a dead bridge forever.
    // An attempt written before the agent was recorded has no harness to
    // disagree with, so it keeps the original behaviour.
    if (
      pipeline.reconnectAttempt
      && !pipeline.pendingPromptAttempt
      && (pipeline.reconnectAttempt.agent === undefined
        || pipeline.reconnectAttempt.agent === currentAgent)
    ) {
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
    if (status === "blocked") {
      // Observe-only Milestone 3 must not advance or fail a phase. The parked
      // request remains provider-owned until Milestone 4 applies its policy.
      session.status = "running";
      return;
    }
    if (
      pipeline.pendingPromptAttempt
      && pipeline.pendingPromptAttempt.sessionId === session.sdkSessionId
    ) {
      if (status === "running") {
        delete pipeline.pendingPromptAttempt;
        delete pipeline.reconnectAttempt;
        delete pipeline.error;
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
    const { agent, model, effort } = await this.stepSettings(pipeline, sessionPhase);
    const provider = await this.provider(pipeline, agent);
    const label = SESSION_LABELS[sessionPhase];
    // Stated rather than left to each provider's own default, so the sandbox a
    // stage runs under is one decision in one place and does not move when a
    // step pins a different harness.
    const mode = executionModeForSessionPhase(sessionPhase, agent);
    // Codex binds model and effort at session creation, Claude and OpenCode at
    // prompt dispatch, so a per-step selection has to be supplied at both.
    const sessionId = await provider.createSession(sessionPhase, label, {
      model,
      effort,
      mode,
      interaction: {
        origin: "build-pipeline",
        interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
        phase: sessionPhase,
      },
    });
    provider.registerSession?.(sessionId, {
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
      phase: sessionPhase,
    });
    const { prompt, schema, images } = await this.promptFor(pipeline, sessionPhase);
    const requestId = randomUUID();
    const session: PipelineSession = {
      phase: sessionPhase,
      agent,
      origin: "build-pipeline",
      interactionPolicy: UNATTENDED_AGENT_INTERACTION_POLICY,
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
      await provider.send(sessionId, prompt, {
        requestId,
        images,
        schema,
        model,
        effort,
        mode,
      });
      delete pipeline.pendingPromptAttempt;
      await this.save(pipeline, pipeline.backendRevision);
    } catch (error) {
      if (error instanceof AmbiguousPromptDispatchError) {
        // The bridge may have accepted the stable request before the response
        // was lost. Keep the durable attempt; the next tick reconciles status
        // and, if still idle, retries this exact request ID through bridge
        // deduplication.
        return;
      }
      throw error;
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
    // Redispatch has to carry the same step selection the session was opened
    // with: Claude and OpenCode take the model per prompt, so omitting it here
    // would quietly retry the turn on the connection default instead.
    const sessionPhase = sessionPhaseFor(attempt.phase);
    const step = sessionPhase
      ? await this.stepSettings(pipeline, sessionPhase)
      : undefined;
    // `addressing` re-uses the review session to write code, so its override
    // wins over the phase's own read-only mode. Everything else re-states the
    // mode the session was opened with, so a redispatch cannot land a turn in a
    // different sandbox than the one that was interrupted.
    const mode = executionModeOverrideForPhase(attempt.phase)
      ?? (sessionPhase && step
        ? executionModeForSessionPhase(sessionPhase, step.agent)
        : undefined);
    try {
      await provider.send(attempt.sessionId, attempt.prompt, {
        requestId: attempt.requestId,
        images: attempt.useTaskImages
          ? pipeline.taskSnapshot.images
          : [],
        schema,
        mode,
        model: step?.model,
        effort: step?.effort,
      });
      const session = pipeline.sessions.find((candidate) =>
        candidate.sdkSessionId === attempt.sessionId);
      if (session) session.status = "running";
      delete pipeline.pendingPromptAttempt;
      delete pipeline.reconnectAttempt;
      delete pipeline.error;
      await this.save(pipeline, pipeline.backendRevision);
    } catch (error) {
      if (error instanceof AmbiguousPromptDispatchError) return;
      throw error;
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
    const result = await provider.structured<VerificationVerdict>(
      session.sdkSessionId,
      resolvedRequestId,
    );
    if (!result) {
      await this.awaitStructuredResult(pipeline, session, "verification");
      return;
    }
    delete session.structuredWaitStartedAt;
    if (!result.ok) throw new Error(result.error.message);
    if (!isVerificationVerdict(result.value)) {
      throw new Error(
        "Verification returned malformed structured output: expected exactly a boolean complete field and a string rationale field",
      );
    }
    const { complete, rationale } = result.value;
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
    if (detection.hasMergeConflicts === true) {
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
    if (detection.hasMergeConflicts === true) {
      throw new Error("Merge conflicts could not be fully resolved automatically");
    }
    if (detection.hasMergeConflicts === null) {
      // GitHub computes mergeability asynchronously. Keep the durable phase in
      // place until a later supervisor pass has evidence that the conflict is
      // actually gone; an indeterminate answer is not successful resolution.
      return;
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
      || (
        result.hasMergeConflicts !== null
        && typeof result.hasMergeConflicts !== "boolean"
      )
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
    this.provisioningPrompts.delete(pipeline.id);
    this.lastProviderAgent.delete(pipeline.id);
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

  /**
   * The harness, model and reasoning a step runs under.
   *
   * A step's own selections win. A field it left unset resolves to that
   * harness's default — the same value the launcher displayed for it — which
   * `connectionDefaultsFor` supplies one layer down when these are `undefined`.
   * The repository defaults never cross to a harness they were not chosen for.
   */
  private async stepSettings(
    pipeline: BuildPipeline,
    sessionPhase: PipelineSessionPhase,
  ): Promise<{
    agent: BuildPipelineAgent;
    model?: string;
    effort?: string;
  }> {
    const step = pipeline.steps?.[stepKeyForSessionPhase(sessionPhase)];
    if (step) {
      const effort = step.reasoningEffort?.trim();
      return {
        agent: step.agent,
        // Normalised on read as well as on write: `start()` is not the only way
        // a snapshot gets here — `importLegacy` accepts one straight from disk,
        // where a placeholder could otherwise be sent as a real model id.
        model: stepModel(step.agent, step.model),
        effort: effort && effort !== "default" ? effort : undefined,
      };
    }
    const config = await this.storage.loadConfig();
    const repository = await this.storage.getRepositoryConfig(pipeline.projectId);
    return {
      agent: pipeline.agentType,
      ...connectionDefaultsFor(pipeline.agentType, config, repository),
    };
  }

  private async provider(
    pipeline: BuildPipeline,
    agent: BuildPipelineAgent = pipeline.agentType,
  ): Promise<BuildPipelineProvider> {
    // Recorded before anything that can throw, so a bridge that is unreachable
    // during connection setup is still attributed to the right harness.
    this.lastProviderAgent.set(pipeline.id, agent);
    const providerKey = `${pipeline.environmentId}:${agent}`;
    // Only this harness's own sessions. Registering a sibling step's session id
    // would put a foreign session into an environment-wide monitor that is
    // supposed to ignore everything it does not own.
    const ownSessions = pipeline.sessions.filter(
      (session) => sessionAgent(pipeline, session) === agent,
    );
    const cached = this.providers.get(providerKey);
    if (cached) {
      for (const session of ownSessions) {
        cached.registerSession?.(session.sdkSessionId, {
          origin: session.origin ?? "build-pipeline",
          interactionPolicy: session.interactionPolicy
            ?? UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: session.phase,
        });
      }
      return cached;
    }
    if (this.options.provider) {
      const provider = await this.options.provider(pipeline, agent);
      for (const session of ownSessions) {
        provider.registerSession?.(session.sdkSessionId, {
          origin: session.origin ?? "build-pipeline",
          interactionPolicy: session.interactionPolicy
            ?? UNATTENDED_AGENT_INTERACTION_POLICY,
          phase: session.phase,
        });
      }
      this.providers.set(providerKey, provider);
      return provider;
    }
    const environment = await this.storage.getEnvironment(pipeline.environmentId);
    if (!environment) throw new Error("Build environment no longer exists");
    const config = await this.storage.loadConfig();
    const repository = await this.storage.getRepositoryConfig(pipeline.projectId);
    const connection = await this.bridgeConnection(agent, environment);
    const provider = createBuildPipelineProvider({
      ...connection,
      // Connection-level defaults only, and only this harness's own. Every
      // pipeline turn passes the step's model and effort per call, which take
      // precedence; these fill in whatever the step left unset.
      ...connectionDefaultsFor(agent, config, repository),
    }, {
      ...this.options.providerDependencies,
      // Task-snapshot images arrive as base64. Both bridges require a workspace
      // path, so they have to be written into the environment before they can be
      // attached to a prompt.
      stageImages: (images) =>
        stagePromptImages(this.invoke, environment, images),
      onInteractionObservation: async (event) => {
        const enriched = {
          ...event,
          environmentId: pipeline.environmentId,
          provider: agent,
        };
        try {
          await this.options.onInteractionObservation?.(enriched);
        } catch {
          // Passive diagnostics never control workflow behavior.
        }
        if (
          event.state === "detected"
          && event.kind === "question"
          && event.registration.interactionPolicy.mode === "unattended"
        ) {
          await this.persistUnattendedQuestionFailure(enriched);
        }
      },
    });
    for (const session of ownSessions) {
      provider.registerSession?.(session.sdkSessionId, {
        origin: session.origin ?? "build-pipeline",
        interactionPolicy: session.interactionPolicy
          ?? UNATTENDED_AGENT_INTERACTION_POLICY,
        phase: session.phase,
      });
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
    this.lastProviderAgent.delete(pipeline.id);
    await this.save(pipeline, record.revision);
    await this.reconcileTerminalState(pipeline);
  }

  private async persistUnattendedQuestionFailure(
    event: ProviderInteractionObservationEvent & {
      environmentId: string;
      provider: BuildPipelineAgent;
    },
  ): Promise<void> {
    const records = await this.storage.listAllBuildPipelines();
    const record = records.find((candidate) => {
      if (!isBuildPipeline(candidate.snapshot)) return false;
      const session = sessionForCurrentPhase(candidate.snapshot);
      return candidate.snapshot.environmentId === event.environmentId
        && session?.sdkSessionId === event.sessionId
        && sessionAgent(candidate.snapshot, session) === event.provider;
    });
    // A shared environment provider can retain an older registered session
    // after its pipeline has already terminated or been removed. There is no
    // live workflow left to advance, so that orphan request is safe to reject.
    // Actual storage failures still throw from listAllBuildPipelines above.
    if (!record || !isBuildPipeline(record.snapshot)) return;
    if (!isActiveBuildPhase(record.snapshot.phase)) return;
    const failed = await this.mutate(record.id, (pipeline) => {
      if (!isActiveBuildPhase(pipeline.phase)) return;
      const session = sessionForCurrentPhase(pipeline);
      if (
        session?.sdkSessionId !== event.sessionId
        || sessionAgent(pipeline, session) !== event.provider
      ) return;
      pipeline.error = `The ${session.label.toLowerCase()} requested user input`;
      pipeline.failureContext = {
        phase: pipeline.phase as ResumableBuildPhase,
        kind: "interactive-request",
        sessionId: session.sdkSessionId,
      };
      pipeline.phase = "failed";
      delete pipeline.pendingPromptAttempt;
      this.provisioningPrompts.delete(pipeline.id);
      this.lastProviderAgent.delete(pipeline.id);
    });
    // The provider only needs the terminal failure to be durable before it can
    // reject the upstream question. Completion comments and board updates are
    // unrelated external I/O, so let the normal locked supervisor perform them
    // without stalling OpenCode's shared event loop.
    if (this.needsTerminalReconciliation(failed)) {
      void this.runLocked(failed.id);
    }
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
    // Evict the harness that actually failed. The stored snapshot cannot answer
    // that on its own: a stage transition resolves the next step's provider
    // before it records that step's session, so a `createSession` failure on the
    // review harness would look like a failure on the build harness here — and
    // dropping the healthy one would leave the unreachable one cached forever.
    const session = sessionForCurrentPhase(pipeline);
    const agent = this.lastProviderAgent.get(pipelineId)
      ?? (session ? sessionAgent(pipeline, session) : pipeline.agentType);
    const providerKey = `${pipeline.environmentId}:${agent}`;
    const provider = this.providers.get(providerKey);
    this.providers.delete(providerKey);
    await provider?.dispose?.();
    // Only an attempt for this same harness carries its start time forward. A
    // different harness failing is a new outage and gets its own deadline,
    // rather than inheriting an elapsed time it did not accumulate.
    const previous = pipeline.reconnectAttempt;
    const continues = previous !== undefined
      && (previous.agent === undefined || previous.agent === agent);
    const startedAt = (continues ? previous.startedAt : undefined)
      ?? new Date().toISOString();
    const elapsed = elapsedSince(startedAt);
    if (elapsed !== null && elapsed >= this.reconnectDeadlineMs) {
      // Retrying forever is indistinguishable from working, from the outside.
      // Once the bridge has stayed unreachable past the deadline, say so rather
      // than leaving the user watching a stage that will never advance.
      await this.fail(
        pipelineId,
        new Error(
          `${agent} stayed unreachable for ${Math.round(elapsed / 1000)}s: ${error.message}`,
        ),
      );
      return;
    }
    pipeline.backendRevision = record.revision;
    pipeline.reconnectAttempt = {
      id: (continues ? previous.id : undefined) ?? randomUUID(),
      phase,
      kind: "stage-transition",
      // Only when this harness owns the current session. A stage transition
      // fails before its own session exists, and naming the previous stage's
      // session there would point recovery at a session on a healthy bridge.
      sessionId: session && sessionAgent(pipeline, session) === agent
        ? session.sdkSessionId
        : undefined,
      startedAt,
      agent,
    };
    pipeline.error = `Reconnecting to ${agent}: ${error.message}`;
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
