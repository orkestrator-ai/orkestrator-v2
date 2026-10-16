import { Check, Circle, MessageSquareText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { QuestionToolAnsweredQuestion } from "@/lib/question-tool";

/**
 * Expanded body of a question tool row: each question with its options, the
 * chosen ones marked, in place of the raw `{ questions: [...] }` arguments.
 */
export function QuestionToolDetails({
  questions,
}: {
  questions: readonly QuestionToolAnsweredQuestion[];
}) {
  return (
    <div
      className="divide-y divide-border/30 border-b border-border/30"
      data-testid="question-tool"
    >
      {questions.map((question, questionIndex) => (
        <section
          key={questionIndex}
          aria-label={question.header ?? `Question ${questionIndex + 1}`}
          className="space-y-2 px-3 py-2.5"
        >
          <div className="space-y-1">
            {(question.header || question.multiSelect) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {question.header && (
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    {question.header}
                  </span>
                )}
                {question.multiSelect && (
                  <span className="text-[10px] text-muted-foreground/70">multi-select</span>
                )}
              </div>
            )}
            <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
              {question.question}
            </p>
          </div>

          {question.options.length > 0 && (
            <ul className="space-y-0.5">
              {question.options.map((option, optionIndex) => {
                const selected = question.selectedLabels.includes(option.label);
                return (
                  <li
                    key={optionIndex}
                    data-selected={selected || undefined}
                    className={cn(
                      "flex items-start gap-2.5 rounded-md px-2 py-1.5",
                      selected && "bg-muted",
                    )}
                  >
                    <span className="mt-0.5 shrink-0">
                      {selected ? (
                        <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary">
                          <Check
                            className="h-2.5 w-2.5 text-primary-foreground"
                            aria-label="Selected"
                          />
                        </span>
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground/40" aria-hidden />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block text-xs font-medium break-words",
                          selected
                            ? "text-foreground"
                            : question.answered
                              ? "text-muted-foreground"
                              : "text-foreground/90",
                        )}
                      >
                        {option.label}
                      </span>
                      {option.description && (
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
                          {option.description}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {question.customAnswers.map((answer, answerIndex) => (
            <div
              key={answerIndex}
              className="flex items-start gap-2.5 rounded-md bg-muted px-2 py-1.5"
            >
              <MessageSquareText
                className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary"
                aria-label="Answer"
              />
              <span className="min-w-0 flex-1 text-xs text-foreground whitespace-pre-wrap break-words">
                {answer}
              </span>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
