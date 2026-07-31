import { useCallback, useMemo } from "react";
import {
  QuestionCard,
  type QuestionCardQuestion,
  type SubmitAnswersHandler,
} from "@/components/chat/QuestionCard";
import {
  fetchPendingInteractions,
  respondToInteraction,
  type CodexClient,
  type CodexInteraction,
} from "@/lib/codex-client";
import { useCodexStore } from "@/stores/codexStore";
import { codexInteractionDraftKey } from "@/stores/promptDraftStore";

interface CodexQuestionCardProps {
  interaction: CodexInteraction;
  client: CodexClient;
  sessionId: string;
  sessionKey: string;
}

/** Adapts Codex's exact question response map to the shared wizard. */
export function CodexQuestionCard({
  interaction,
  client,
  sessionId,
  sessionKey,
}: CodexQuestionCardProps) {
  const remove = useCodexStore((state) => state.removePendingInteraction);
  const sourceQuestions = interaction.questions ?? [];
  const questions = useMemo<QuestionCardQuestion[]>(
    () => sourceQuestions.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      // The app-server response is an array and permits more than one selected
      // option. Keep that fidelity instead of forcing a radio-button answer.
      multiSelect: true,
      allowCustomAnswer: question.isOther || !question.options?.length,
      secret: question.isSecret,
      options: question.options?.map((option, index) => ({
        id: `${question.id}:option:${index}`,
        label: option.label,
        description: option.description,
        // Option identity is separate from the exact provider value. Duplicate
        // labels remain two controls even though Codex receives the label.
        value: option.label,
      })),
    })),
    [sourceQuestions],
  );

  const submit = useCallback<SubmitAnswersHandler>(async (answers) => {
    const answerMap = Object.fromEntries(
      sourceQuestions.map((question, index) => [question.id, answers[index] ?? []]),
    );
    const result = await respondToInteraction(
      client,
      sessionId,
      interaction.interactionId,
      { action: "accept", answers: answerMap },
    );
    if (result === "applied" || result === "stale") {
      remove(sessionKey, interaction.interactionId);
      return true;
    }
    if (result === "unknown") {
      try {
        const pending = await fetchPendingInteractions(client, sessionId);
        if (!pending.some((candidate) => candidate.interactionId === interaction.interactionId)) {
          remove(sessionKey, interaction.interactionId);
          return true;
        }
        return {
          applied: false,
          message: "The connection dropped, but Codex is still waiting. It is safe to retry.",
        };
      } catch {
        return {
          applied: false,
          retryable: false,
          message: "The response outcome is unknown. Reconnect or refresh Codex before trying again.",
        };
      }
    }
    return {
      applied: false,
      message: result === "forbidden"
        ? "Codex refused this response. The interaction may have been reassigned or the session locked."
        : "Could not send your response to Codex. Check the bridge connection and try again.",
    };
  }, [client, interaction.interactionId, remove, sessionId, sessionKey, sourceQuestions]);

  const dismiss = useCallback(async () => {
    const result = await respondToInteraction(
      client,
      sessionId,
      interaction.interactionId,
      { action: "cancel" },
    );
    if (result === "applied" || result === "stale") {
      remove(sessionKey, interaction.interactionId);
      return true;
    }
    if (result === "unknown") {
      try {
        const pending = await fetchPendingInteractions(client, sessionId);
        if (!pending.some((candidate) => candidate.interactionId === interaction.interactionId)) {
          remove(sessionKey, interaction.interactionId);
          return true;
        }
      } catch {
        // Keep the authoritative card until the normal snapshot path can
        // establish whether the cancel reached Codex.
      }
    }
    return false;
  }, [client, interaction.interactionId, remove, sessionId, sessionKey]);

  return (
    <QuestionCard
      agentLabel="Codex"
      title="Codex has a question"
      questions={questions}
      onSubmit={submit}
      onDismiss={dismiss}
      dismissLabel="Cancel"
      customAnswerPlaceholder="Type your answer"
      draftKey={codexInteractionDraftKey(sessionKey, interaction.interactionId)}
      expiresAt={interaction.expiresAt}
    />
  );
}
