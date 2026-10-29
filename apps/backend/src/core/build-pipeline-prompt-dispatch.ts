/**
 * Sending a build pipeline stage's pending prompt to its provider.
 *
 * Every prompt the supervisor, recovery and lifecycle journal as
 * `pendingPromptAttempt` goes out through {@link BuildPipelinePromptDispatch.dispatchPending}:
 * it re-states the session's selection, mode and result slot, opens the
 * at-most-once dispatch window just before the send, and resends an attempt
 * that may already have arrived only on the provider's proof that it did not.
 */
import { recoveredDispatchAcceptance } from "./provider-dispatch-recovery.js";
import { buildPipelineSessionStage } from "./build-pipeline-stages.js";
import {
  type BuildPipeline,
  type BuildPipelineAgent,
  type PipelineSessionPhase,
  executionModeForSessionPhase,
} from "@orkestrator/protocol/build-pipeline";
import { STRUCTURED_REVIEW_REPORT_JSON_SCHEMA } from "@orkestrator/protocol/structured-review";
import type { NativeAgentExecutionPolicy } from "@orkestrator/protocol/native-agent";
import {
  workflowResultInstruction,
  workflowResultToolName,
} from "@orkestrator/protocol/workflow-results";
import {
  type BuildPipelineProvider,
  AmbiguousPromptDispatchError,
} from "./build-pipeline-provider.js";
import {
  sessionAgent,
  sessionPhaseFor,
  VERIFICATION_SCHEMA,
  executionModeOverrideForPhase,
  attachBeforeDispatch,
} from "./build-pipeline-service-helpers.js";
import { REVIEW_VALIDATION_PLAN_SCHEMA } from "./review-validation-prompts.js";
import {
  REVIEW_FIX_RESULT_JSON_SCHEMA,
  REVIEW_PREPARATION_RESULT_JSON_SCHEMA,
} from "./review-prompts.js";
import type { BuildPipelineContext } from "./build-pipeline-context.js";
import type { BuildPipelineAgents } from "./build-pipeline-service-agents.js";

export class BuildPipelinePromptDispatch {
  constructor(
    private readonly ctx: BuildPipelineContext,
    private readonly agents: BuildPipelineAgents,
  ) {}

  async dispatchPending(pipeline: BuildPipeline, provider: BuildPipelineProvider): Promise<void> {
    const attempt = pipeline.pendingPromptAttempt;
    if (!attempt) return;
    if (
      (attempt.dispatchVersion !== 1 || attempt.dispatchingAt !== undefined) &&
      !(await this.resendProvenSafe(pipeline, provider))
    ) {
      return;
    }
    const schema = attempt.structuredReview
      ? attempt.phase === "building" || attempt.phase === "fixing"
        ? attempt.validationPlan === true
          ? REVIEW_VALIDATION_PLAN_SCHEMA
          : REVIEW_PREPARATION_RESULT_JSON_SCHEMA
        : attempt.phase === "reviewing"
          ? STRUCTURED_REVIEW_REPORT_JSON_SCHEMA
          : attempt.phase === "verifying"
            ? VERIFICATION_SCHEMA
            : attempt.phase === "addressing"
              ? REVIEW_FIX_RESULT_JSON_SCHEMA
              : undefined
      : undefined;
    // A real stage has to carry the selection its session was opened with:
    // Claude and OpenCode take the model per prompt, so omitting it would retry
    // on the connection default. Pre-upgrade sessions have no persisted
    // selection and fall back field-by-field. Stage-less recovery attempts stay
    // unpinned because no pipeline step owns their prompt.
    const sessionPhase = sessionPhaseFor(attempt.phase);
    const session = pipeline.sessions.find(
      (candidate) => candidate.sdkSessionId === attempt.sessionId,
    );
    const resultKind = this.ctx.workflowResultKind(attempt.phase, attempt.validationPlan === true);
    if (attempt.resultTransport === "tool-v1") {
      if (!resultKind || !this.ctx.options.workflowResults || !session) {
        throw new Error("Tool-mode prompt attempt lost its result-slot binding");
      }
      await this.ctx.options.workflowResults.prepare({
        resultKey: attempt.requestId,
        kind: resultKind,
        environmentId: pipeline.environmentId,
        projectId: pipeline.projectId,
        provider: sessionAgent(pipeline, session),
        schema,
      });
    }
    const fallbackStep =
      sessionPhase &&
      (!session ||
        (session.model === undefined && !session.modelSelectionResolved) ||
        session.reasoningEffort === undefined ||
        session.fastMode === undefined)
        ? await this.agents.stepSettings(pipeline, sessionPhase)
        : undefined;
    const step = !sessionPhase
      ? undefined
      : session
        ? {
            agent: sessionAgent(pipeline, session),
            model: session.modelSelectionResolved
              ? session.model
              : (session.model ?? fallbackStep?.model),
            effort: session.reasoningEffort ?? fallbackStep?.effort,
            fastMode: session.fastMode ?? fallbackStep?.fastMode,
          }
        : fallbackStep;
    // Re-state the mode the session was opened with so a redispatch cannot land
    // in a different sandbox. Addressing is a writable, independent session; a
    // packaged review stays read-only for repairs, reminders and user messages.
    const readOnlyReview = sessionPhase ? readsReviewPackage(pipeline, sessionPhase) : false;
    const mode =
      executionModeOverrideForPhase(attempt.phase) ??
      (readOnlyReview
        ? ("plan" as const)
        : sessionPhase && step
          ? executionModeForSessionPhase(sessionPhase, step.agent)
          : undefined);
    // Resolved before the dispatch window opens: once it is saved, the next
    // fallible call must be the send.
    const reviewPolicy =
      readOnlyReview && step?.agent === "opencode"
        ? await this.ctx.executionPolicy(pipeline)
        : undefined;
    const agentMcp =
      attempt.resultTransport === "tool-v1"
        ? await this.ctx.workflowAgentMcp(
            pipeline,
            attempt.requestId,
            step?.agent,
            `build pipeline ${attempt.phase} step`,
          )
        : undefined;
    const artifactTurn = this.ctx.beginArtifactTurn(
      pipeline,
      session,
      attempt.requestId,
      step?.agent ?? (session ? sessionAgent(pipeline, session) : undefined),
      agentMcp,
    );
    const turnAgentMcp = artifactTurn?.agentMcp ?? agentMcp;
    await attachBeforeDispatch(
      provider,
      attempt.sessionId,
      turnAgentMcp
        ? {
            agentMcp: turnAgentMcp,
            ...(resultKind ? { workflowResultTool: workflowResultToolName(resultKind) } : {}),
          }
        : undefined,
    );
    try {
      await this.openDispatchWindow(pipeline, attempt.requestId);
    } catch (error) {
      this.ctx.settleArtifactTurn(pipeline, session, attempt.requestId);
      throw error;
    }
    try {
      await provider.send(
        attempt.sessionId,
        attempt.resultTransport === "tool-v1" && resultKind
          ? `${attempt.prompt}\n\n${workflowResultInstruction(resultKind, attempt.requestId, {
              capability: agentMcp?.workflowResultCapability,
            })}`
          : attempt.prompt,
        {
          requestId: attempt.requestId,
          images: attempt.useTaskImages ? pipeline.taskSnapshot.images : [],
          schema: attempt.resultTransport === "tool-v1" ? undefined : schema,
          mode,
          ...(readOnlyReview && step ? readOnlyReviewSendOptions(step.agent, reviewPolicy) : {}),
          model: step?.model,
          effort: step?.effort,
          ...(typeof step?.fastMode === "boolean" ? { fastMode: step.fastMode } : {}),
          ...(turnAgentMcp ? { agentMcp: turnAgentMcp } : {}),
          ...(artifactTurn?.artifactGrant ? { artifactGrant: artifactTurn.artifactGrant } : {}),
          ...(agentMcp && resultKind
            ? { workflowResultTool: workflowResultToolName(resultKind) }
            : {}),
        },
      );
      const dispatchedSession = pipeline.sessions.find(
        (candidate) => candidate.sdkSessionId === attempt.sessionId,
      );
      if (dispatchedSession) dispatchedSession.status = "running";
      delete pipeline.pendingPromptAttempt;
      delete pipeline.reconnectAttempt;
      delete pipeline.error;
      await this.ctx.save(pipeline, pipeline.backendRevision);
    } catch (error) {
      if (error instanceof AmbiguousPromptDispatchError) return;
      this.ctx.settleArtifactTurn(pipeline, session, attempt.requestId);
      await this.closeDispatchWindow(pipeline, attempt.requestId);
      throw error;
    }
  }

  /**
   * The at-most-once window opens here, durably and just before the send:
   * from now on a later pass re-sends this id only on the provider's proof
   * that it never arrived. Every preparation step before it stays retryable.
   */
  async openDispatchWindow(pipeline: BuildPipeline, requestId: string): Promise<void> {
    const attempt = pipeline.pendingPromptAttempt;
    if (attempt?.requestId !== requestId) return;
    attempt.dispatchingAt = new Date().toISOString();
    await this.ctx.save(pipeline, pipeline.backendRevision);
  }

  /**
   * A send refused before the prompt was written: a retry is a first send.
   * A failed save leaves the mark, which only costs a proof read.
   */
  async closeDispatchWindow(pipeline: BuildPipeline, requestId: string): Promise<void> {
    const attempt = pipeline.pendingPromptAttempt;
    if (attempt?.requestId !== requestId || attempt.dispatchingAt === undefined) return;
    attempt.dispatchVersion = 1;
    delete attempt.dispatchingAt;
    await this.ctx.save(pipeline, pipeline.backendRevision).catch(() => undefined);
  }

  /**
   * Whether a prompt attempt that may already have reached the provider can be
   * sent again under its id. Only the provider's proof that it never arrived
   * (`absent`) allows it; acceptance settles the attempt as sent, `lost` fails
   * the stage, and anything else waits within the reconnect deadline and then
   * fails closed, as the fan-out does (0223). Bridges deduplicate a resend only
   * while they still hold the id, which a restart or eviction can end.
   */
  private async resendProvenSafe(
    pipeline: BuildPipeline,
    provider: BuildPipelineProvider,
  ): Promise<boolean> {
    const attempt = pipeline.pendingPromptAttempt!;
    const session = pipeline.sessions.find(
      (candidate) => candidate.sdkSessionId === attempt.sessionId,
    );
    const label = session?.label.toLowerCase() ?? `${attempt.phase} step`;
    const acceptance = await recoveredDispatchAcceptance(
      provider,
      attempt.sessionId,
      attempt.requestId,
      attempt.resultTransport === "tool-v1"
        ? () => this.ctx.options.workflowResults?.structured<unknown>(attempt.requestId)
        : undefined,
    );
    if (acceptance === "absent") return true;
    if (acceptance === "dispatched" || acceptance === "pending") {
      if (session) session.status = "running";
      delete pipeline.pendingPromptAttempt;
      delete pipeline.reconnectAttempt;
      delete pipeline.error;
      await this.ctx.save(pipeline, pipeline.backendRevision);
      return false;
    }
    if (acceptance === "lost") {
      this.ctx.settleArtifactTurn(pipeline, session, attempt.requestId);
      throw new Error(
        `The ${label} dispatch was lost in a provider restart and cannot be resent safely`,
      );
    }
    const elapsed = Date.now() - Date.parse(attempt.dispatchingAt ?? attempt.startedAt);
    if (elapsed >= this.ctx.reconnectDeadlineMs) {
      this.ctx.settleArtifactTurn(pipeline, session, attempt.requestId);
      throw new Error(`The ${label} dispatch acceptance could not be confirmed`);
    }
    return false;
  }
}

/**
 * Whether a session of this phase reviews the immutable package: the turn
 * Multi Review would run as a read-only reviewer.
 */
export function readsReviewPackage(
  pipeline: BuildPipeline,
  sessionPhase: PipelineSessionPhase,
): boolean {
  return (
    buildPipelineSessionStage(sessionPhase).turn === "read-only" &&
    pipeline.reviewPackage !== undefined
  );
}

/**
 * The per-turn read-only boundary for a packaged review, as Multi Review
 * reviewers send it. OpenCode also gets its constrained reviewer shell, which
 * it applies only to a session created as a reviewer.
 */
export function readOnlyReviewSendOptions(
  agent: BuildPipelineAgent,
  policy: NativeAgentExecutionPolicy | undefined,
): { readOnly: true; reviewShellPolicy?: NativeAgentExecutionPolicy } {
  return {
    readOnly: true,
    ...(agent === "opencode" && policy ? { reviewShellPolicy: policy } : {}),
  };
}
