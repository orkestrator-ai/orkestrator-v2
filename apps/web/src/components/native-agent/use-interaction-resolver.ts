import { useState } from "react";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionApplyOutcome,
  type AgentInteractionQuestionAnswer,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentInteractionResolutionAction,
} from "@orkestrator/protocol/agent-interactions";
import { usePromptDraftStore } from "@/stores/promptDraftStore";

interface InteractionResolverOptions {
  interaction: AgentInteractionRequest;
  /** Draft namespace cleared once the interaction reaches a terminal result. */
  draftKey: string;
  onResolve: (
    resolution: AgentInteractionResolution,
  ) => Promise<AgentInteractionApplyOutcome>;
  /** Read at submit time, so an uncommitted edit is never left behind. */
  buildAnswers: () => AgentInteractionQuestionAnswer[];
  /** Refuses every action, e.g. once the deadline has passed. */
  blocked?: boolean;
}

/**
 * The one place a blocking interaction is resolved.
 *
 * Every card that answers an interaction shares this: the same contract
 * version, the same terminal-result set that clears the draft, and the same
 * distinction between "the agent said no" and "the agent could not be reached,
 * so retrying is safe". Two copies of that would drift.
 */
export function useInteractionResolver({
  interaction,
  draftKey,
  onResolve,
  buildAnswers,
  blocked = false,
}: InteractionResolverOptions) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (
    action: AgentInteractionResolutionAction,
    feedback?: string,
  ) => {
    if (submitting || blocked) return;
    setSubmitting(true);
    setError(null);
    try {
      const resolution: AgentInteractionResolution = {
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        interactionId: interaction.id,
        sessionId: interaction.sessionId,
        action,
        ...(action === "answer" ? {
          answer: {
            version: AGENT_INTERACTION_CONTRACT_VERSION,
            interactionId: interaction.id,
            sessionId: interaction.sessionId,
            answers: buildAnswers(),
          },
        } : {}),
        ...(feedback?.trim() ? { feedback: feedback.trim() } : {}),
        resolvedAt: Date.now(),
      };
      const outcome = await onResolve(resolution);
      if (
        outcome.result === "applied"
        || outcome.result === "stale"
        || outcome.result === "already-resolved"
      ) {
        usePromptDraftStore.getState().clearDraft(draftKey);
      } else {
        setError(outcome.result === "rejected"
          ? "The agent rejected that response."
          : "The agent is temporarily unavailable. It is safe to retry.");
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return { submitting, error, setError, resolve };
}
