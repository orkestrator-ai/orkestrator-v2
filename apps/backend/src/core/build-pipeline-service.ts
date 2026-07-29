import { randomUUID } from "node:crypto";
import type {
  BuildPhase,
  BuildPipeline,
  BuildPipelineAgent,
  PipelineSession,
  PipelineSessionPhase,
  ResumableBuildPhase,
  StartBuildPipelineInput,
} from "@orkestrator/protocol/build-pipeline";
import {
  BUILD_PIPELINE_VERSION,
  isActiveBuildPhase,
  isStartBuildPipelineInput,
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

function isPipeline(value: unknown): value is BuildPipeline {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<BuildPipeline>;
  return typeof candidate.id === "string"
    && typeof candidate.taskId === "string"
    && typeof candidate.projectId === "string"
    && typeof candidate.environmentId === "string"
    && Array.isArray(candidate.sessions)
    && typeof candidate.phase === "string"
    && typeof candidate.backendRevision === "number";
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

export class BuildPipelineService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly locks = new Map<string, Promise<void>>();
  private readonly providers = new Map<string, BuildPipelineProvider>();
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly invoke: CommandInvoker,
    private readonly options: {
      autoAdvance?: boolean;
      provider?: (pipeline: BuildPipeline) => Promise<BuildPipelineProvider>;
    } = {},
  ) {}

  async init(): Promise<void> {
    this.stopped = false;
    for (const record of await this.storage.listAllBuildPipelines()) {
      if (!isPipeline(record.snapshot)) continue;
      const pipeline = record.snapshot;
      if (pipeline.controller !== "backend") {
        pipeline.controller = "backend";
        pipeline.backendRevision = record.revision;
        await this.save(pipeline, record.revision);
      }
    }
    if (this.options.autoAdvance !== false) {
      this.timer ??= setInterval(() => {
        void this.tick();
      }, 1_500);
      this.timer.unref?.();
      void this.tick();
    }
  }

  shutdown(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.providers.clear();
  }

  async start(input: StartBuildPipelineInput): Promise<BuildPipeline> {
    if (!isStartBuildPipelineInput(input)) {
      throw new Error("Invalid build pipeline start request");
    }
    const pipeline: BuildPipeline = {
      id: randomUUID(),
      taskId: input.taskId,
      projectId: input.projectId,
      environmentId: input.existingEnvironmentId?.trim() ?? "",
      environmentType: input.environmentType,
      agentType: input.agentType,
      phase: input.existingEnvironmentId
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
      backendRevision: 0,
      controller: "backend",
    };
    await this.save(pipeline, 0);
    if (!pipeline.environmentId) {
      const environment = await this.findLinkedEnvironment(pipeline)
        ?? await this.invoke<Environment>("create_environment", {
          projectId: pipeline.projectId,
          networkAccessMode: pipeline.environmentType === "containerized"
            ? "restricted"
            : "full",
          environmentType: pipeline.environmentType,
          buildPipelineId: pipeline.id,
          namingPrompt: input.namingPrompt ?? pipeline.taskTitle,
        });
      pipeline.environmentId = environment.id;
      pipeline.environmentType = environment.environmentType;
      pipeline.phase = "starting-environment";
      // Persist the association before configuration. If the backend exits
      // here, the next supervisor pass resumes this environment instead of
      // creating a second one.
      await this.save(pipeline, pipeline.backendRevision);
    } else {
      const environment = await this.storage.getEnvironment(pipeline.environmentId);
      if (!environment || environment.projectId !== pipeline.projectId) {
        throw new Error("The selected build environment does not belong to this project");
      }
      pipeline.environmentType = environment.environmentType;
      await this.save(pipeline, pipeline.backendRevision);
    }
    await this.ensureSourceLink(pipeline);
    if (this.options.autoAdvance !== false) void this.runLocked(pipeline.id);
    return pipeline;
  }

  /** Immediate supervisor pass, also useful for deterministic backend tests. */
  advanceNow(pipelineId: string): Promise<void> {
    return this.runLocked(pipelineId);
  }

  async pause(pipelineId: string): Promise<BuildPipeline> {
    return this.mutate(pipelineId, async (pipeline) => {
      const previous = resumablePhase(pipeline.phase);
      if (!previous) return;
      pipeline.pausedFromPhase = previous;
      pipeline.phase = "paused";
      const session = sessionForCurrentPhase(pipeline);
      if (session?.status === "running") {
        const provider = await this.provider(pipeline);
        await provider.abort(session.sdkSessionId);
        session.status = "idle";
      }
    });
  }

  async resume(pipelineId: string): Promise<BuildPipeline> {
    const pipeline = await this.mutate(pipelineId, (candidate) => {
      if (candidate.phase !== "paused") return;
      candidate.phase = candidate.pausedFromPhase ?? "building";
      delete candidate.pausedFromPhase;
      delete candidate.error;
    });
    void this.runLocked(pipelineId);
    return pipeline;
  }

  async cancel(pipelineId: string): Promise<BuildPipeline> {
    return this.mutate(pipelineId, async (pipeline) => {
      const session = sessionForCurrentPhase(pipeline);
      if (session?.status === "running" && pipeline.environmentId) {
        await (await this.provider(pipeline)).abort(session.sdkSessionId);
      }
      if (session) session.status = "idle";
      pipeline.phase = "failed";
      pipeline.error = "Build cancelled";
      delete pipeline.pendingPromptAttempt;
      delete pipeline.activePromptContext;
    });
  }

  async remove(pipelineId: string): Promise<void> {
    const record = await this.storage.getBuildPipeline(pipelineId);
    if (
      record
      && isPipeline(record.snapshot)
      && isActiveBuildPhase(record.snapshot.phase)
    ) {
      await this.cancel(pipelineId);
    }
    await this.storage.deleteBuildPipeline(pipelineId);
  }

  async retryCompletionComment(pipelineId: string): Promise<BuildPipeline> {
    const pipeline = await this.mutate(pipelineId, (candidate) => {
      delete candidate.completionCommentStatus;
      delete candidate.completionCommentError;
    });
    await this.postCompletionComment(pipeline);
    return pipeline;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const records = await this.storage.listAllBuildPipelines();
    await Promise.all(records.flatMap((record) => {
      if (!isPipeline(record.snapshot) || !isActiveBuildPhase(record.snapshot.phase)) {
        return [];
      }
      return [this.runLocked(record.id)];
    }));
  }

  private runLocked(pipelineId: string): Promise<void> {
    const previous = this.locks.get(pipelineId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.advance(pipelineId))
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

  private async advance(pipelineId: string): Promise<void> {
    const record = await this.requireRecord(pipelineId);
    const pipeline = record.snapshot as BuildPipeline;
    pipeline.backendRevision = record.revision;
    if (!isActiveBuildPhase(pipeline.phase)) return;

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
          namingPrompt: pipeline.taskTitle,
        });
      pipeline.environmentId = environment.id;
      pipeline.environmentType = environment.environmentType;
      pipeline.phase = "starting-environment";
      await this.save(pipeline, record.revision);
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
      if (session.status !== "running" || transcriptChanged) {
        session.status = "running";
        await this.save(pipeline, record.revision);
      }
      return;
    }

    session.status = "idle";
    await this.refreshTranscript(session, provider);
    delete pipeline.pendingPromptAttempt;
    delete pipeline.activePromptContext;

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
    if (JSON.stringify(messages) === JSON.stringify(session.messages ?? [])) {
      return false;
    }
    session.messages = messages;
    session.messageRevision = (session.messageRevision ?? 0) + 1;
    return true;
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
    const provider = await this.provider(pipeline);
    const label = SESSION_LABELS[sessionPhase];
    const sessionId = await provider.createSession(sessionPhase, label);
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
    if (!result) return;
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
      await provider.send(session.sdkSessionId, prompt, { requestId: request });
      session.status = "running";
      delete pipeline.pendingPromptAttempt;
      await this.save(pipeline, pipeline.backendRevision);
      return;
    }
    await this.startStage(pipeline, "verify", "verifying");
  }

  private async finishVerification(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
    session: PipelineSession,
  ): Promise<void> {
    const requestId = session.structuredRequestId
      ?? pipeline.pendingPromptAttempt?.requestId
      ?? pipeline.activePromptContext?.requestId;
    // The prompt attempt is cleared after a confirmed dispatch, so the stable
    // request key is also retained in the user message/session metadata by all
    // providers. Prefer the last structured user request when necessary.
    const resolvedRequestId = requestId ?? this.structuredRequestId(session.messages);
    if (!resolvedRequestId) throw new Error("Verification result key is missing");
    const result = await provider.structured<{
      complete: boolean;
      rationale: string;
    }>(session.sdkSessionId, resolvedRequestId);
    if (!result) return;
    if (!result.ok) throw new Error(result.error.message);
    const complete = result.value?.complete === true;
    const rationale = typeof result.value?.rationale === "string"
      ? result.value.rationale
      : "Verification returned no rationale.";
    pipeline.verificationResult = complete ? "pass" : "fail";
    pipeline.verificationFeedback = rationale;
    if (complete) {
      await this.startStage(pipeline, "pr", "creating-pr");
      return;
    }
    if (pipeline.iteration >= pipeline.maxIterations) {
      throw new Error(`Verification failed after ${pipeline.maxIterations} iterations: ${rationale}`);
    }
    pipeline.iteration += 1;
    await this.startStage(pipeline, "fix", "fixing");
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
    const conflicts = await this.hasMergeConflicts(pipeline);
    if (conflicts) {
      await this.startStage(pipeline, "resolve-conflicts", "resolving-conflicts");
      return;
    }
    await this.complete(pipeline);
  }

  private async finishConflictResolution(pipeline: BuildPipeline): Promise<void> {
    if (await this.hasMergeConflicts(pipeline)) {
      throw new Error("Merge conflicts could not be fully resolved automatically");
    }
    await this.complete(pipeline);
  }

  private async hasMergeConflicts(pipeline: BuildPipeline): Promise<boolean> {
    const environment = await this.storage.getEnvironment(pipeline.environmentId);
    if (!environment) return false;
    const result = environment.environmentType === "local"
      ? await this.invoke<{ hasMergeConflicts: boolean } | null>("detect_pr_local", {
          environmentId: environment.id,
          branch: environment.branch,
        })
      : environment.containerId
        ? await this.invoke<{ hasMergeConflicts: boolean } | null>("detect_pr", {
            containerId: environment.containerId,
            branch: environment.branch,
          })
        : null;
    return result?.hasMergeConflicts === true;
  }

  private async complete(pipeline: BuildPipeline): Promise<void> {
    pipeline.phase = "complete";
    delete pipeline.error;
    await this.save(pipeline, pipeline.backendRevision);
    await this.postCompletionComment(pipeline).catch(async (error) => {
      pipeline.completionCommentStatus = "failed";
      pipeline.completionCommentError = errorMessage(error);
      await this.save(pipeline, pipeline.backendRevision);
    });
  }

  private async postCompletionComment(pipeline: BuildPipeline): Promise<void> {
    const source = pipeline.source;
    if (!source || source.type === "kanban") return;
    pipeline.completionCommentStatus = "posting";
    await this.save(pipeline, pipeline.backendRevision);
    const body = `✅ Orkestrator build completed for **${pipeline.taskTitle}**.`;
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
    if (this.options.provider) return this.options.provider(pipeline);
    const providerKey = `${pipeline.environmentId}:${pipeline.agentType}`;
    const cached = this.providers.get(providerKey);
    if (cached) return cached;
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
    });
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
    if (!record || !isPipeline(record.snapshot)) return;
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
    await this.save(pipeline, record.revision);
  }

  private async recordReconnect(
    pipelineId: string,
    error: ProviderUnavailableError,
  ): Promise<void> {
    const record = await this.storage.getBuildPipeline(pipelineId);
    if (!record || !isPipeline(record.snapshot)) return;
    const pipeline = record.snapshot;
    const phase = resumablePhase(pipeline.phase);
    if (!phase) return;
    this.providers.delete(`${pipeline.environmentId}:${pipeline.agentType}`);
    pipeline.backendRevision = record.revision;
    pipeline.reconnectAttempt = {
      id: pipeline.reconnectAttempt?.id ?? randomUUID(),
      phase,
      kind: "stage-transition",
      sessionId: sessionForCurrentPhase(pipeline)?.sdkSessionId,
      startedAt: pipeline.reconnectAttempt?.startedAt
        ?? new Date().toISOString(),
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
    if (!record || !isPipeline(record.snapshot)) {
      throw new Error(`Build pipeline not found: ${pipelineId}`);
    }
    return record;
  }

  private async save(pipeline: BuildPipeline, expectedRevision: number): Promise<void> {
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
  }
}
