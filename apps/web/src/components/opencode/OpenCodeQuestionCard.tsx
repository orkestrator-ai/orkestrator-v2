import { useCallback, useMemo } from "react";
import type { OpencodeClient, QuestionRequest } from "@/lib/opencode-client";
import { replyToQuestion, rejectQuestion } from "@/lib/opencode-client";
import { useOpenCodeStore } from "@/stores/openCodeStore";
import { openCodeQuestionDraftKey } from "@/stores/promptDraftStore";
import {
  QuestionCard,
  type QuestionCardQuestion,
} from "@/components/chat/QuestionCard";

interface OpenCodeQuestionCardProps {
  question: QuestionRequest;
  client: OpencodeClient;
}

export function OpenCodeQuestionCard({
  question,
  client,
}: OpenCodeQuestionCardProps) {
  const removePendingQuestion = useOpenCodeStore(
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
        // OpenCode names these `multiple` and `custom`; `custom` defaults to true.
        multiSelect: info.multiple,
        allowCustomAnswer: info.custom !== false,
      })),
    [question.questions],
  );

  const handleSubmit = useCallback(
    async (answers: string[][]) => {
      const result = await replyToQuestion(client, question.id, answers);
      if (result === "applied" || result === "gone") {
        removePendingQuestion(question.id);
        return true;
      }
      if (result === "unknown") {
        return {
          applied: false,
          retryable: false,
          message: "The response outcome is unknown. Reconnect or refresh OpenCode before trying again.",
        };
      }
      return false;
    },
    [client, question.id, removePendingQuestion],
  );

  const handleDismiss = useCallback(async () => {
    const result = await rejectQuestion(client, question.id);
    if (result === "applied" || result === "gone") {
      // The loading state is cleared by SSE events in OpenCodeChatTab.
      removePendingQuestion(question.id);
      return true;
    }
    if (result === "unknown") {
      return {
        applied: false,
        retryable: false,
        message: "The dismissal outcome is unknown. Reconnect or refresh OpenCode before trying again.",
      };
    }
    return false;
  }, [client, question.id, removePendingQuestion]);

  return (
    <QuestionCard
      agentLabel="OpenCode"
      title="OpenCode needs your input"
      questions={questions}
      onSubmit={handleSubmit}
      onDismiss={handleDismiss}
      // `multiple: false` means exactly one answer on this protocol, so a
      // custom answer replaces the selected option instead of joining it.
      exclusiveSingleSelect
      // Cleared by `openCodeStore.removePendingQuestion` when the request
      // resolves, so in-progress answers survive tab switches until then.
      draftKey={openCodeQuestionDraftKey(question.sessionId, question.id)}
    />
  );
}
