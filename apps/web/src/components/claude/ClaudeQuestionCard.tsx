import { useCallback, useMemo } from "react";
import type { ClaudeQuestionRequest } from "@/lib/claude-types";
import {
  QuestionCard,
  type QuestionCardQuestion,
  type SubmitAnswersHandler,
} from "@/components/chat/QuestionCard";

/**
 * Renders a Claude AskUserQuestion request. The caller owns the pending request
 * and supplies the submit/dismiss handlers: ClaudeTmuxChatTab answers
 * backend-owned hook and screen-detected questions this way.
 */
interface ClaudeQuestionCardProps {
  question: ClaudeQuestionRequest;
  initialAnswers?: string[][];
  allowCustomAnswer?: boolean;
  allowOptionDeselect?: boolean;
  submitOnOptionSelect?: boolean;
  onSubmitAnswers: SubmitAnswersHandler;
  onDismiss?: () => Promise<boolean | void> | boolean | void;
  hideDismiss?: boolean;
  /**
   * Draft-store key for in-progress answers (see `QuestionCard.draftKey`).
   * Callers whose pending request is durable (e.g. the tmux tab) pass a key
   * their store clears on resolution; those without one pass none.
   */
  draftKey?: string;
}

export function ClaudeQuestionCard({
  question,
  initialAnswers,
  allowCustomAnswer = true,
  allowOptionDeselect = true,
  submitOnOptionSelect = false,
  onSubmitAnswers,
  onDismiss,
  hideDismiss = false,
  draftKey,
}: ClaudeQuestionCardProps) {
  const questions = useMemo<QuestionCardQuestion[]>(
    () =>
      question.questions.map((info, questionIndex) => ({
        id: `${question.id}:question:${questionIndex}`,
        question: info.question,
        header: info.header,
        options: info.options.map((option, optionIndex) => ({
          ...option,
          id: `${question.id}:question:${questionIndex}:option:${optionIndex}`,
        })),
        multiSelect: info.multiSelect,
      })),
    [question.id, question.questions],
  );

  // The card always offers Dismiss unless hidden; with no handler it reports
  // the dismissal as not applied.
  const handleDismiss = useCallback(
    async () => (onDismiss ? await onDismiss() : false),
    [onDismiss],
  );

  return (
    <QuestionCard
      agentLabel="Claude"
      title="Claude needs your input"
      questions={questions}
      onSubmit={onSubmitAnswers}
      onDismiss={handleDismiss}
      initialAnswers={initialAnswers}
      allowCustomAnswer={allowCustomAnswer}
      allowOptionDeselect={allowOptionDeselect}
      submitOnOptionSelect={submitOnOptionSelect}
      hideDismiss={hideDismiss}
      draftKey={draftKey}
      expiresAt={question.expiresAt}
    />
  );
}
