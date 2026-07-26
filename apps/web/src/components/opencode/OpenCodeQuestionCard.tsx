import { useCallback, useMemo } from "react";
import type { OpencodeClient, QuestionRequest } from "@/lib/opencode-client";
import { replyToQuestion, rejectQuestion } from "@/lib/opencode-client";
import { useOpenCodeStore } from "@/stores/openCodeStore";
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
  const { removePendingQuestion } = useOpenCodeStore();

  const questions = useMemo<QuestionCardQuestion[]>(
    () =>
      question.questions.map((info) => ({
        question: info.question,
        header: info.header,
        options: info.options,
        // OpenCode names these `multiple` and `custom`; `custom` defaults to true.
        multiSelect: info.multiple,
        allowCustomAnswer: info.custom !== false,
      })),
    [question.questions],
  );

  const handleSubmit = useCallback(
    async (answers: string[][]) => {
      const success = await replyToQuestion(client, question.id, answers);
      if (success) {
        removePendingQuestion(question.id);
      }
      return success;
    },
    [client, question.id, removePendingQuestion],
  );

  const handleDismiss = useCallback(async () => {
    const success = await rejectQuestion(client, question.id);
    if (success) {
      // The loading state is cleared by SSE events in OpenCodeChatTab.
      removePendingQuestion(question.id);
    }
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
    />
  );
}
