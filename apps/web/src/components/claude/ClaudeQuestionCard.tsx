import { useCallback, useMemo } from "react";
import type { ClaudeClient, ClaudeQuestionRequest } from "@/lib/claude-client";
import { answerQuestion, dismissQuestion } from "@/lib/claude-client";
import { useClaudeStore } from "@/stores/claudeStore";
import { claudeQuestionDraftKey } from "@/stores/promptDraftStore";
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
  onDismiss?: () => Promise<boolean | void> | boolean | void;
  hideDismiss?: boolean;
  /**
   * Draft-store key for in-progress answers (see `QuestionCard.draftKey`).
   * The bridge-backed variant derives it from the pending request id, which
   * `claudeStore.removePendingQuestion` clears on resolution. Callback-mode
   * callers whose pending request lives elsewhere (e.g. the tmux tab) pass
   * their own key; those without a durable request pass none.
   */
  draftKey?: string;
}

/**
 * Either the card answers through the bridge itself (client + sessionId), or
 * the caller supplies its own submit handler. ClaudeTmuxChatTab uses callback
 * mode for backend-owned hook and screen-detected questions; the feature
 * planner deliberately remains a prose-based discovery flow.
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
  draftKey,
}: ClaudeQuestionCardProps) {
  const removePendingQuestion = useClaudeStore(
    (state) => state.removePendingQuestion,
  );

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
      if (result === "unknown") {
        return {
          applied: false,
          retryable: false,
          message: "The response outcome is unknown. Reconnect or refresh Claude before trying again.",
        };
      }
      return false;
    },
    [client, onSubmitAnswers, question.id, removePendingQuestion, sessionId],
  );

  const handleDismiss = useCallback(async () => {
    if (onDismiss) {
      return await onDismiss();
    }
    if (!client || !sessionId) return false;
    const result = await dismissQuestion(client, sessionId, question.id);
    if (result === "applied" || result === "stale") {
      removePendingQuestion(question.id);
      return true;
    }
    if (result === "unknown") {
      return {
        applied: false,
        retryable: false,
        message: "The dismissal outcome is unknown. Reconnect or refresh Claude before trying again.",
      };
    }
    return false;
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
      draftKey={
        draftKey ?? (client ? claudeQuestionDraftKey(sessionId!, question.id) : undefined)
      }
      expiresAt={question.expiresAt}
    />
  );
}
