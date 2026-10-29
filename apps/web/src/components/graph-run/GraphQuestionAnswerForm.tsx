import { useId, useState } from "react";
import { CircleHelp, Loader2, Send, X } from "lucide-react";
import {
  GRAPH_AGENT_QUESTION_BOUNDS,
  type GraphAgentAnswerKind,
  type GraphAgentQuestion,
} from "@orkestrator/protocol/graphs/run";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * Answers a question a graph run waits on (D15): an agent's `ask_human`
 * question (item 204), and human nodes (item 208) reuse it with their own
 * `onSubmit`. The user picks one of the offered choices, writes an answer,
 * or declines, in which case the agent decides and says what it assumed.
 *
 * Nothing is sent until the user submits; a refusal (a stale question, an
 * answer over the bound) keeps the draft and shows the backend's message.
 * An answered question shows its answer and takes no more input.
 */

export interface GraphQuestionAnswer {
  kind: GraphAgentAnswerKind;
  text?: string;
  choice?: string;
}

export interface GraphQuestionAnswerFormProps {
  question: Pick<GraphAgentQuestion, "id" | "text" | "choices" | "answer">;
  /** Who asks, for the heading: "Review · Panel 1 asks". */
  asker: string;
  onSubmit: (answer: GraphQuestionAnswer) => Promise<void>;
  /** The run cannot take an answer now (cancelling, finished). */
  disabled?: boolean;
  className?: string;
}

export function GraphQuestionAnswerForm({
  question,
  asker,
  onSubmit,
  disabled = false,
  className,
}: GraphQuestionAnswerFormProps) {
  const headingId = useId();
  const [text, setText] = useState("");
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [sending, setSending] = useState<GraphAgentAnswerKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answered = question.answer;
  const choices = question.choices ?? [];

  const submit = async (kind: GraphAgentAnswerKind) => {
    if (sending || disabled || answered) return;
    const trimmed = text.trim();
    if (kind === "answered" && !trimmed && choice === undefined) {
      setError("Choose an option or write an answer, or decline.");
      return;
    }
    setSending(kind);
    setError(null);
    try {
      await onSubmit(
        kind === "declined"
          ? { kind, ...(trimmed ? { text: trimmed } : {}) }
          : {
              kind,
              ...(trimmed ? { text: trimmed } : {}),
              ...(choice !== undefined ? { choice } : {}),
            },
      );
      setText("");
      setChoice(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(null);
    }
  };

  return (
    <section
      aria-labelledby={headingId}
      data-graph-question={question.id}
      data-graph-question-answered={answered ? "" : undefined}
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border p-3",
        answered ? "border-border" : "border-amber-400/50 bg-amber-400/5",
        className,
      )}
    >
      <h3 id={headingId} className="flex items-center gap-1.5 text-xs font-semibold">
        <CircleHelp className="size-3.5 text-amber-300" aria-hidden />
        {answered ? `${asker} asked` : `${asker} asks`}
      </h3>
      <p className="text-sm break-words whitespace-pre-wrap">{question.text}</p>
      {answered ? (
        <p className="text-xs text-muted-foreground" data-graph-question-answer="">
          {answered.kind === "declined"
            ? "Declined"
            : [answered.choice, answered.text].filter(Boolean).join(" — ")}
          {answered.by === "coordinator" ? " (answered by the coordinator)" : ""}
        </p>
      ) : (
        <>
          {choices.length > 0 ? (
            <div role="radiogroup" aria-label="Choices" className="flex flex-wrap gap-1.5">
              {choices.map((option) => (
                <Button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={choice === option}
                  size="sm"
                  variant={choice === option ? "default" : "outline"}
                  className="h-7 text-xs"
                  disabled={disabled || sending !== null}
                  onClick={() => setChoice((current) => (current === option ? undefined : option))}
                >
                  {option}
                </Button>
              ))}
            </div>
          ) : null}
          <Textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={GRAPH_AGENT_QUESTION_BOUNDS.maxAnswerChars}
            rows={3}
            disabled={disabled || sending !== null}
            aria-label={choices.length > 0 ? "Answer (optional with a choice)" : "Answer"}
            placeholder={choices.length > 0 ? "Add details (optional)" : "Write your answer"}
            className="min-h-0 resize-y text-sm"
          />
          {error ? (
            <p role="alert" className="text-xs text-failure">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              className="h-7 gap-1.5 text-xs"
              disabled={disabled || sending !== null}
              onClick={() => void submit("answered")}
            >
              {sending === "answered" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Send className="size-3.5" />
              )}
              Send answer
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1.5 text-xs"
              disabled={disabled || sending !== null}
              onClick={() => void submit("declined")}
            >
              {sending === "declined" ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <X className="size-3.5" />
              )}
              Decline
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
