import { useCallback, useMemo } from "react";
import type { ClaudeClient, ClaudeQuestionRequest } from "@/lib/claude-client";
import { answerQuestion, dismissQuestion } from "@/lib/claude-client";
import { useClaudeStore } from "@/stores/claudeStore";
import {
  QuestionCard,
  type QuestionCardQuestion,
  type SubmitAnswersHandler,
} from "@/components/chat/QuestionCard";

interface ClaudeQuestionCardBaseProps {
  question: ClaudeQuestionRequest;
  initialAnswers?: string[][];
  allowCustomAnswer?: boolean;
  allowOptionDeselect?: boolean;
  submitOnOptionSelect?: boolean;
  onDismiss?: () => Promise<void> | void;
  hideDismiss?: boolean;
}

/**
 * Either the card answers through the bridge itself (client + sessionId), or
 * the caller supplies its own submit handler — the feature planner and build
 * pipeline reuse this card without a live Claude session behind it.
 */
type ClaudeQuestionCardProps =
  | (ClaudeQuestionCardBaseProps & {
      client: ClaudeClient;
      sessionId: string;
      onSubmitAnswers?: never;
    })
  | (ClaudeQuestionCardBaseProps & {
      client?: never;
      sessionId?: never;
      onSubmitAnswers: SubmitAnswersHandler;
    });

export function ClaudeQuestionCard({
  question,
  initialAnswers,
  allowCustomAnswer = true,
  allowOptionDeselect = true,
  submitOnOptionSelect = false,
  client,
  sessionId,
  onSubmitAnswers,
  onDismiss,
  hideDismiss = false,
}: ClaudeQuestionCardProps) {
  const removePendingQuestion = useClaudeStore(
    (state) => state.removePendingQuestion,
  );

  const questions = useMemo<QuestionCardQuestion[]>(
    () =>
      question.questions.map((info) => ({
        question: info.question,
        header: info.header,
        options: info.options,
        multiSelect: info.multiSelect,
      })),
    [question.questions],
  );

  const handleSubmit = useCallback<SubmitAnswersHandler>(
    async (answers) => {
      if (onSubmitAnswers) {
        return onSubmitAnswers(answers);
      }
      const result = await answerQuestion(
        client!,
        sessionId!,
        question.id,
        answers,
      );
      // `stale` removes the card just like `applied`: the window closed while
      // the user was deciding, so there is nothing left to answer and nothing
      // useful a retry could do. Only a real failure leaves the card retryable.
      if (result === "applied" || result === "stale") {
        removePendingQuestion(question.id);
        return true;
      }
      return false;
    },
    [client, onSubmitAnswers, question.id, removePendingQuestion, sessionId],
  );

  const handleDismiss = useCallback(async () => {
    if (onDismiss) {
      await onDismiss();
      return;
    }
    if (!client || !sessionId) return;
    const result = await dismissQuestion(client, sessionId, question.id);
    if (result === "applied" || result === "stale") {
      removePendingQuestion(question.id);
    }
  }, [client, onDismiss, question.id, removePendingQuestion, sessionId]);

  return (
    <QuestionCard
      agentLabel="Claude"
      title="Claude needs your input"
      questions={questions}
      onSubmit={handleSubmit}
      onDismiss={handleDismiss}
      initialAnswers={initialAnswers}
      allowCustomAnswer={allowCustomAnswer}
      allowOptionDeselect={allowOptionDeselect}
      submitOnOptionSelect={submitOnOptionSelect}
      hideDismiss={hideDismiss}
      expiresAt={question.expiresAt}
    />
  );
}
