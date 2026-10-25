import { useCallback, useMemo } from "react";
import type { ClaudeQuestionRequest } from "@/lib/claude-types";
import {
  QuestionCard,
  type QuestionCardQuestion,
  type SubmitAnswersHandler,
} from "@/components/chat/QuestionCard";
import type { PromptHoldHandler } from "@/hooks/usePromptHold";
import { useTmuxPromptDeadline } from "./tmux-prompt-deadline";

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
  /** Pauses or resumes the countdown, for a request whose `hold` allows it. */
  onHold?: PromptHoldHandler;
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
  onHold,
}: ClaudeQuestionCardProps) {
  const { deadline, error: holdError } = useTmuxPromptDeadline(question, onHold);
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

  const card = (
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
      deadline={deadline}
    />
  );
  if (!holdError) return card;
  return (
    <div>
      {card}
      <div role="alert" className="mt-1 px-1 text-xs text-destructive">
        {holdError}
      </div>
    </div>
  );
}
