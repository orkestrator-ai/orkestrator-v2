import { useContext, useEffect, useMemo, useState } from "react";
import { MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { NativeAsyncQuestionPart } from "@/lib/chat/native-message-types";
import {
  nativeAsyncQuestionDraftKey,
  usePromptDraftField,
  usePromptDraftStore,
} from "@/stores/promptDraftStore";
import { AsyncQuestionResponseContext } from "./NativeMessage.shared";
import { TextPart } from "./NativeMessage.file-parts";

interface Answer {
  option: string;
  freeText: string;
}

export function serializeAsyncQuestionAnswers(
  questions: NativeAsyncQuestionPart["asyncQuestion"]["questions"],
  answers: Record<string, Answer>,
): string {
  return [
    "Answers to your questions:",
    "",
    ...questions.map((question) => {
      const answer = answers[question.id];
      return `- ${question.title}: ${answer?.freeText.trim() || answer?.option || ""}`;
    }),
  ].join("\n");
}

const normalizeWhitespace = (text: string) => text.trim().replace(/\s+/g, " ");

/**
 * Codex fills the message text with a plain-text fallback of its structured
 * questions (`title\n- option\n- option`). Returns true when the text holds
 * nothing beyond that restatement, so the card can rely on its own controls.
 */
export function asyncQuestionContentRepeatsQuestions(
  content: string,
  questions: NativeAsyncQuestionPart["asyncQuestion"]["questions"],
): boolean {
  let remaining = normalizeWhitespace(content);
  // Prefer full titles/options over shorter candidates sharing a word prefix.
  const candidates = questions
    .map((question) => ({
      title: normalizeWhitespace(question.title),
      options: question.options.map(normalizeWhitespace).sort((a, b) => b.length - a.length),
    }))
    .sort((a, b) => b.title.length - a.title.length);
  const consume = (token: string) => {
    if (!token || !remaining.startsWith(token)) return false;
    const rest = remaining.slice(token.length);
    if (rest && !rest.startsWith(" ")) return false;
    remaining = rest.trimStart();
    return true;
  };
  while (remaining) {
    const question = candidates.find((candidate) => consume(candidate.title));
    if (!question) return false;
    let consumedOption = true;
    while (consumedOption) {
      consumedOption = question.options.some((option) =>
        ["-", "*", "•"].some((bullet) => consume(`${bullet} ${option}`)),
      );
    }
  }
  return true;
}

export function NativeAsyncQuestionCard({ part }: { part: NativeAsyncQuestionPart }) {
  const { responses, respond, draftScope } = useContext(AsyncQuestionResponseContext);
  const questions = part.asyncQuestion.questions;
  // Keep the fieldset legend as the question's accessible label and show only
  // context the agent added beyond restating the questions and options.
  const showContent =
    part.content.trim().length > 0 &&
    !asyncQuestionContentRepeatsQuestions(part.content, questions);
  const draftKey = draftScope
    ? nativeAsyncQuestionDraftKey(draftScope, part.asyncQuestion.itemId)
    : undefined;
  const [answers, setAnswers] = usePromptDraftField<Record<string, Answer>>(
    draftKey,
    "answers",
    () =>
      Object.fromEntries(
        questions.map((question) => [
          question.id,
          { option: question.options[0] ?? "", freeText: "" },
        ]),
      ),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const response = responses.find((candidate) => candidate.itemId === part.asyncQuestion.itemId);
  const canSubmit = questions.every((question) => {
    const answer = answers[question.id];
    return Boolean(answer?.option || answer?.freeText.trim());
  });
  const status = useMemo(() => {
    if (!response) return null;
    if (response.state === "queued") return "Your answer is queued for Codex.";
    if (response.state === "dispatching") return "Sending your answer to Codex…";
    if (response.state === "sent") return "Your answer was sent to Codex.";
    return "Your answer could not be sent. Use the queued-prompts recovery controls to retry.";
  }, [response]);
  const disabled = submitting || Boolean(response);

  useEffect(() => {
    if (response && draftKey) usePromptDraftStore.getState().clearDraft(draftKey);
  }, [draftKey, response]);

  return (
    <div className="my-2 rounded-lg border border-primary/25 bg-primary/[0.035] p-3">
      <div className="mb-3 flex items-center gap-2 text-sm font-medium">
        <MessageCircleQuestion className="size-4 text-primary" />
        Codex has a question
      </div>
      {showContent ? (
        <div className="mb-3">
          <TextPart
            content={part.content}
            showCopy={false}
            expansionKey={`async-question:${part.asyncQuestion.itemId}`}
          />
        </div>
      ) : null}
      <div className="space-y-4">
        {questions.map((question) => {
          const answer = answers[question.id] ?? { option: "", freeText: "" };
          return (
            <fieldset key={question.id} disabled={disabled} className="space-y-2">
              <legend className="text-sm text-foreground">{question.title}</legend>
              {question.options.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {question.options.map((option, optionIndex) => (
                    <Button
                      key={`${optionIndex}:${option}`}
                      type="button"
                      size="sm"
                      aria-pressed={answer.option === option && !answer.freeText}
                      variant={answer.option === option && !answer.freeText ? "default" : "outline"}
                      onClick={() =>
                        setAnswers((current) => ({
                          ...current,
                          [question.id]: { option, freeText: "" },
                        }))
                      }
                    >
                      {option}
                    </Button>
                  ))}
                </div>
              ) : null}
              <textarea
                aria-label={`Custom answer for ${question.title}`}
                value={answer.freeText}
                placeholder="Or type your own answer"
                rows={2}
                maxLength={16_384}
                className={cn(
                  "flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm",
                  "placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                )}
                onChange={(event) =>
                  setAnswers((current) => ({
                    ...current,
                    [question.id]: { option: "", freeText: event.target.value },
                  }))
                }
              />
            </fieldset>
          );
        })}
      </div>
      {status ? (
        <p role="status" className="mt-3 text-xs text-muted-foreground">
          {status}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-3 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {!response ? (
        <div className="mt-3 flex justify-end">
          <Button
            type="button"
            size="sm"
            disabled={!respond || !canSubmit || submitting}
            onClick={() => {
              if (!respond) return;
              setSubmitting(true);
              setError(null);
              void respond(
                part.asyncQuestion.itemId,
                serializeAsyncQuestionAnswers(questions, answers),
              )
                .then(() => {
                  if (draftKey) usePromptDraftStore.getState().clearDraft(draftKey);
                })
                .catch((reason: unknown) => {
                  setError(reason instanceof Error ? reason.message : "Failed to queue answer");
                })
                .finally(() => setSubmitting(false));
            }}
          >
            {submitting ? "Sending…" : "Send answer"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
