/**
 * The user talking to a pipeline's running agent: the durable message queue, and
 * steering a message into the turn the agent is running now.
 */
import { randomUUID } from "node:crypto";
import {
  MAX_PIPELINE_USER_MESSAGES,
  MAX_PIPELINE_USER_MESSAGE_LENGTH,
  usesReviewFanout,
  type BuildPipeline,
  type PipelineQueuedSteerDelivery,
} from "@orkestrator/protocol/build-pipeline";
import {
  nativeAgentSteerRejectionMessage,
  type NativeAgentSessionActionOutcome,
} from "@orkestrator/protocol/native-agent";
import type { BuildPipelineContext } from "./build-pipeline-context.js";
import { PromptRejectedError } from "./build-pipeline-provider.js";
import type { BuildPipelineAgents } from "./build-pipeline-service-agents.js";
import {
  discardPreparationResult,
  resumablePhase,
  sessionAgent,
  sessionForCurrentPhase,
} from "./build-pipeline-service-helpers.js";
import type { BuildPipelineSupervisor } from "./build-pipeline-service-supervisor.js";

function validatedUserMessage(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Message must not be blank");
  if (trimmed.length > MAX_PIPELINE_USER_MESSAGE_LENGTH) {
    throw new Error(`Message exceeds the ${MAX_PIPELINE_USER_MESSAGE_LENGTH} character limit`);
  }
  return trimmed;
}

/** Why a pipeline in this state cannot take a user message or steer, if it cannot. */
function userMessageRejection(pipeline: BuildPipeline): Error | undefined {
  if (pipeline.phase === "complete" || pipeline.phase === "failed") {
    return new Error("This build has finished");
  }
  if (
    usesReviewFanout(pipeline) &&
    (pipeline.phase === "reviewing" ||
      (pipeline.phase === "paused" && pipeline.pausedFromPhase === "reviewing"))
  ) {
    return new Error("Messages cannot be sent during a multi-model review");
  }
  if (pipeline.validationRun && !pipeline.reviewPackage) {
    return new Error(
      "Validation is running against a fixed snapshot. Pause or cancel preparation before changing the work.",
    );
  }
  return undefined;
}

/** Appends to the durable queue; an error means the queue is full and nothing was added. */
function enqueueUserMessage(pipeline: BuildPipeline, text: string): Error | undefined {
  const queue = pipeline.pendingUserMessages ?? [];
  if (queue.length >= MAX_PIPELINE_USER_MESSAGES) {
    return new Error(`Only ${MAX_PIPELINE_USER_MESSAGES} queued messages are allowed`);
  }
  pipeline.pendingUserMessages = [
    ...queue,
    { id: randomUUID(), text, createdAt: new Date().toISOString() },
  ];
  return undefined;
}

/** Takes one message out of the durable queue; `false` when it had already left. */
function removeUserMessage(pipeline: BuildPipeline, messageId: string): boolean {
  const queue = pipeline.pendingUserMessages ?? [];
  const rest = queue.filter((message) => message.id !== messageId);
  if (rest.length === queue.length) return false;
  if (rest.length > 0) {
    pipeline.pendingUserMessages = rest;
  } else {
    delete pipeline.pendingUserMessages;
  }
  return true;
}

/**
 * What became of an attempt to steer the running turn. `not-sent` and `refused`
 * are definite: nothing reached the agent. `unconfirmed` may have, so the text
 * is not safe to deliver a second time.
 */
type LiveSteerResult =
  | { kind: "steered" }
  | { kind: "not-sent" }
  | { kind: "refused"; error: Error }
  | { kind: "unconfirmed"; error: Error };

export class BuildPipelineUserMessages {
  constructor(
    private readonly ctx: BuildPipelineContext,
    private readonly agents: BuildPipelineAgents,
    private readonly stageSupervisor: BuildPipelineSupervisor,
  ) {}

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
    const trimmed = validatedUserMessage(text);
    let rejection: Error | undefined;
    const pipeline = await this.ctx.mutate(pipelineId, (candidate) => {
      rejection = userMessageRejection(candidate);
      if (rejection) return;
      rejection = enqueueUserMessage(candidate, trimmed);
    });
    if (rejection) throw rejection;
    void this.stageSupervisor.runLocked(pipelineId);
    return pipeline;
  }

  /**
   * Injects an instruction into the turn the pipeline's agent is running now.
   *
   * A queued message waits for the agent to go idle, but a pipeline agent
   * going idle is what advances the pipeline to its next stage — so a queued
   * redirect would only ever run after the work it was meant to change had been
   * handed to review. This takes the same path as `/steer` in an ordinary
   * session instead: delivery into the live turn, never a new one.
   *
   * Runs inside the pipeline lock, so no supervisor pass can advance the stage
   * between reading the turn and steering it. When there is no live turn to
   * steer — the stage is between turns, the pipeline is paused, or the provider
   * cannot steer — the instruction is queued exactly as a message would be, and
   * `delivery` says so. A steer the bridge refuses, or whose delivery cannot be
   * confirmed, is an error rather than a queue entry: the first was not sent and
   * the second may have been, so neither is safe to deliver a second time.
   */
  async steerMessage(
    pipelineId: string,
    text: string,
  ): Promise<{ pipeline: BuildPipeline; delivery: "steered" | "queued" }> {
    const trimmed = validatedUserMessage(text);
    let rejection: Error | undefined;
    let delivery: "steered" | "queued" = "queued";
    const pipeline = await this.ctx.mutate(pipelineId, async (candidate) => {
      rejection = userMessageRejection(candidate);
      if (rejection) return;
      let result: LiveSteerResult;
      try {
        result = await this.steerLiveTurn(candidate, trimmed);
      } catch (error) {
        rejection = error instanceof Error ? error : new Error(String(error));
        return;
      }
      switch (result.kind) {
        case "steered":
          delivery = "steered";
          return;
        case "not-sent":
          rejection = enqueueUserMessage(candidate, trimmed);
          return;
        default:
          rejection = result.error;
      }
    });
    if (rejection) throw rejection;
    // A queued fallback needs the supervisor to notice it; a steer is already
    // in the turn and the next pass observes the turn as it always does.
    if (delivery === "queued") void this.stageSupervisor.runLocked(pipelineId);
    return { pipeline, delivery };
  }

  /**
   * Steers one queued message into the running turn, taking it out of the queue:
   * the queue's Steer button, and Auto-steer once it has queued a new message.
   *
   * Runs inside the pipeline lock, so the message cannot be dispatched as the
   * next turn while it is being steered. Anything that definitely did not reach
   * the agent leaves it queued, in its place. A delivery that cannot be confirmed
   * takes it out, because the queue would otherwise deliver it a second time.
   */
  async steerQueuedMessage(
    pipelineId: string,
    messageId: string,
  ): Promise<{
    pipeline: BuildPipeline;
    delivery: PipelineQueuedSteerDelivery;
    notice?: string;
  }> {
    let rejection: Error | undefined;
    let delivery: PipelineQueuedSteerDelivery = "queued";
    let notice: string | undefined;
    const pipeline = await this.ctx.mutate(pipelineId, async (candidate) => {
      const message = candidate.pendingUserMessages?.find((entry) => entry.id === messageId);
      if (!message) {
        delivery = "gone";
        return;
      }
      rejection = userMessageRejection(candidate);
      if (rejection) return;
      let result: LiveSteerResult;
      try {
        result = await this.steerLiveTurn(candidate, message.text);
      } catch (error) {
        rejection = error instanceof Error ? error : new Error(String(error));
        return;
      }
      switch (result.kind) {
        case "steered":
          removeUserMessage(candidate, messageId);
          delivery = "steered";
          return;
        case "unconfirmed":
          removeUserMessage(candidate, messageId);
          delivery = "unconfirmed";
          notice = result.error.message;
          return;
        case "refused":
          notice = result.error.message;
          return;
        default:
          return;
      }
    });
    if (rejection) throw rejection;
    // The turn may have just ended, in which case this message is now next.
    if (delivery === "queued") void this.stageSupervisor.runLocked(pipelineId);
    return { pipeline, delivery, ...(notice ? { notice } : {}) };
  }

  /**
   * Takes a queued message back. `removed` is false when it had already left the
   * queue as the agent's next turn, so the caller must not treat it as withdrawn.
   */
  async removeQueuedMessage(
    pipelineId: string,
    messageId: string,
  ): Promise<{ pipeline: BuildPipeline; removed: boolean }> {
    let removed = false;
    const pipeline = await this.ctx.mutate(pipelineId, (candidate) => {
      removed = removeUserMessage(candidate, messageId);
    });
    return { pipeline, removed };
  }

  /**
   * Steers the current session's running turn. `not-sent` means there is no turn
   * that can be steered right now.
   */
  private async steerLiveTurn(pipeline: BuildPipeline, text: string): Promise<LiveSteerResult> {
    const phase = resumablePhase(pipeline.phase);
    const session = sessionForCurrentPhase(pipeline);
    if (!phase || !session || session.status !== "running" || !pipeline.environmentId) {
      return { kind: "not-sent" };
    }
    // A prompt whose dispatch is unconfirmed has not started its turn; steering
    // now would target the previous one.
    if (pipeline.pendingPromptAttempt) return { kind: "not-sent" };
    const provider = await this.agents.provider(pipeline, sessionAgent(pipeline, session));
    if (!provider.steerSupported || !provider.activeSteerRun || !provider.performSessionAction) {
      return { kind: "not-sent" };
    }
    if (!(await provider.steerSupported(session.sdkSessionId).catch(() => false))) {
      return { kind: "not-sent" };
    }
    const active = await provider.activeSteerRun(session.sdkSessionId).catch(() => undefined);
    if (active?.state !== "running") return { kind: "not-sent" };

    const requestId = randomUUID();
    const unconfirmed = (): LiveSteerResult => {
      if (phase === "building" || phase === "fixing") discardPreparationResult(session);
      return {
        kind: "unconfirmed",
        error: new Error(
          "The steering instruction may have reached the agent, but delivery could not be confirmed. Check the transcript before sending it again.",
        ),
      };
    };
    let outcome: NativeAgentSessionActionOutcome;
    try {
      outcome = await provider.performSessionAction(session.sdkSessionId, {
        kind: "steer",
        text,
        requestId,
        expectedRunId: active.runId,
      });
    } catch (error) {
      // A provider's explicit pre-delivery refusal is still definitive.
      if (error instanceof PromptRejectedError) return { kind: "refused", error };
      // A transport error cannot prove the bridge did not deliver the steer.
      // Persist invalidation under the lock just as for an unknown response.
      return unconfirmed();
    }
    switch (outcome.outcome) {
      case "applied":
        if (phase === "building" || phase === "fixing") discardPreparationResult(session);
        return { kind: "steered" };
      case "rejected":
        return { kind: "refused", error: new Error(nativeAgentSteerRejectionMessage(outcome)) };
      case "unknown":
        // The bridge may have delivered it. Resending under a new request id
        // could steer the turn twice.
        return unconfirmed();
      default:
        // `idle` and `mismatch`: the turn ended or moved on before delivery, so
        // nothing was sent and the queue is the right place for it.
        return { kind: "not-sent" };
    }
  }
}
