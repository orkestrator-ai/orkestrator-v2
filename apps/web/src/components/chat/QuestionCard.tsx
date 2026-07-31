import { useCallback, useMemo, useState } from "react";
import { Check, Circle, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { BlockingPromptCard } from "@/components/chat/BlockingPromptCard";
import { usePromptDraftField } from "@/stores/promptDraftStore";
import { usePromptDeadline } from "@/hooks/usePromptDeadline";

/** Agent-neutral option shape. `value` falls back to `label` when absent. */
export interface QuestionCardOption {
  /** Stable presentation identity, distinct from label and provider value. */
  id?: string;
  label: string;
  description?: string;
  value?: string;
}

/** Agent-neutral question shape. */
export interface QuestionCardQuestion {
  /** Stable provider question identity used to namespace its draft fields. */
  id?: string;
  question: string;
  header?: string;
  options?: QuestionCardOption[];
  multiSelect?: boolean;
  /** Per-question override of the card-level `allowCustomAnswer`. */
  allowCustomAnswer?: boolean;
  /** Secret answers stay in component memory and never enter the draft store. */
  secret?: boolean;
}

/**
 * Receives the answers the user submitted.
 *
 * The card never removes itself: every wrapper owns its lifecycle (via
 * `removePendingQuestion` and friends) because the reply has to be accepted by
 * the agent before the prompt stops blocking the turn. Returning `false` leaves
 * the card retryable and produces a user-visible delivery failure.
 */
export type SubmitAnswersOutcome = boolean | void | {
  applied: boolean;
  message?: string;
  /** False when the transport outcome could not be reconciled safely. */
  retryable?: boolean;
};

export type SubmitAnswersHandler = (
  answers: string[][],
) => Promise<SubmitAnswersOutcome> | SubmitAnswersOutcome;

type DismissOutcome = boolean | void | {
  applied: boolean;
  message?: string;
  retryable?: boolean;
};

interface QuestionCardProps {
  agentLabel: string;
  /** Header copy, e.g. "Claude needs your input". */
  title: string;
  questions: QuestionCardQuestion[];
  onSubmit: SubmitAnswersHandler;
  onDismiss?: () => Promise<DismissOutcome> | DismissOutcome;
  initialAnswers?: string[][];
  allowCustomAnswer?: boolean;
  allowOptionDeselect?: boolean;
  /** Submit immediately on picking an option — single-question cards only. */
  submitOnOptionSelect?: boolean;
  /**
   * Whether a single-select question may only ever hold one answer.
   *
   * Claude's card keeps a committed custom answer alongside the selected option,
   * so it defaults to `false`. OpenCode's protocol treats `multiple: false` as
   * exactly one answer, and replying with two contradicts the question.
   */
  exclusiveSingleSelect?: boolean;
  hideDismiss?: boolean;
  dismissLabel?: string;
  customAnswerPlaceholder?: string;
  /**
   * Stable key for keeping in-progress answers in the prompt-draft store so
   * they survive the card unmounting (environment/tab switches). Wrappers
   * backed by a durable pending request pass their namespaced request id;
   * without one the card falls back to plain component state. The store that
   * owns the pending request clears the draft when the request resolves.
   */
  draftKey?: string;
  /** Absolute bridge deadline in epoch milliseconds, when the protocol exposes one. */
  expiresAt?: number;
}

function optionValue(option: QuestionCardOption): string {
  return option.value ?? option.label;
}

function optionToken(option: QuestionCardOption, index: number): string {
  return `__orkestrator_option__:${index}:${option.id ?? ""}`;
}

type AnswerEntry =
  | { kind: "option"; token: string; value: string }
  | { kind: "custom"; value: string };

function questionDraftId(question: QuestionCardQuestion, index: number): string {
  return question.id ?? `question-${index}`;
}

function initialAnswerEntries(
  question: QuestionCardQuestion,
  initial: string[],
): AnswerEntry[] {
  const unused = new Set((question.options ?? []).map((_, index) => index));
  return initial.map((answer) => {
    const match = (question.options ?? []).findIndex(
      (option, index) => unused.has(index) && optionValue(option) === answer,
    );
    if (match < 0) return { kind: "custom", value: answer };
    unused.delete(match);
    return {
      kind: "option",
      token: optionToken(question.options![match]!, match),
      value: answer,
    };
  });
}

/** Single question item with options and/or a custom text input. */
function QuestionItem({
  info,
  answer,
  customText,
  onAnswerChange,
  onCustomTextChange,
  onOptionSelect,
  allowCustomAnswer,
  allowOptionDeselect,
  exclusiveSingleSelect,
  disabled,
  customAnswerPlaceholder,
}: {
  info: QuestionCardQuestion;
  answer: AnswerEntry[];
  customText: string;
  onAnswerChange: (newAnswer: AnswerEntry[]) => void;
  onCustomTextChange: (newText: string) => void;
  onOptionSelect?: (label: string, nextAnswer: AnswerEntry[]) => void;
  allowCustomAnswer: boolean;
  allowOptionDeselect: boolean;
  exclusiveSingleSelect: boolean;
  disabled: boolean;
  customAnswerPlaceholder?: string;
}) {
  const hasOptions = !!info.options && info.options.length > 0;
  const isMultiple = info.multiSelect ?? false;
  // Custom answers committed via Enter that are not in the option list.
  const committedCustomAnswers = useMemo(
    () => answer.filter(
      (entry): entry is Extract<AnswerEntry, { kind: "custom" }> =>
        entry.kind === "custom",
    ),
    [answer],
  );

  /**
   * In exclusive mode the reply is exactly one answer, and `mergeAnswerForIndex`
   * makes an uncommitted draft that answer — so while the user is typing, the
   * selected option and any committed chip are already gone from what will be
   * submitted. Clear them visually rather than showing a check mark next to
   * something the submit is about to drop. Nothing is destroyed: erasing the
   * draft brings the previous selection straight back.
   */
  const draftSupersedesAnswer =
    exclusiveSingleSelect && !isMultiple && customText.trim().length > 0;

  const handleOptionClick = useCallback(
    (token: string, value: string) => {
      let nextAnswer: AnswerEntry[];
      const isSelected = answer.some(
        (entry) => entry.kind === "option" && entry.token === token,
      );
      if (isMultiple) {
        nextAnswer = isSelected
          ? answer.filter((entry) => entry.kind !== "option" || entry.token !== token)
          : [...answer, { kind: "option", token, value }];
      } else if (draftSupersedesAnswer) {
        // The draft is the current answer and the selection is drawn as
        // cleared, so a click picks the option rather than toggling a
        // selection the user cannot see.
        nextAnswer = [{ kind: "option", token, value }];
        onCustomTextChange("");
      } else if (isSelected) {
        nextAnswer = allowOptionDeselect ? [] : answer;
      } else if (exclusiveSingleSelect) {
        nextAnswer = [{ kind: "option", token, value }];
      } else {
        // Preserve committed custom answers when switching option in single-select.
        nextAnswer = [...committedCustomAnswers, { kind: "option", token, value }];
      }
      onAnswerChange(nextAnswer);
      onOptionSelect?.(value, nextAnswer);
    },
    [
      answer,
      isMultiple,
      onAnswerChange,
      onCustomTextChange,
      onOptionSelect,
      allowOptionDeselect,
      exclusiveSingleSelect,
      committedCustomAnswers,
      draftSupersedesAnswer,
    ],
  );

  // Commit the draft custom text into the answer array so it shows as a chip.
  const handleCustomSubmit = useCallback(() => {
    const trimmed = customText.trim();
    if (!trimmed) return;
    if (committedCustomAnswers.some((entry) => entry.value === trimmed)) {
      onCustomTextChange("");
      return;
    }
    if (isMultiple) {
      onAnswerChange([...answer, { kind: "custom", value: trimmed }]);
    } else if (exclusiveSingleSelect) {
      // The question asked for one answer, so the custom text replaces the
      // selected option rather than joining it.
      onAnswerChange([{ kind: "custom", value: trimmed }]);
    } else {
      // Single-select allows one custom chip at a time; keep the selected
      // option alongside it, mirroring handleOptionClick.
      const selectedOption = answer.filter((entry) => entry.kind === "option");
      onAnswerChange([...selectedOption, { kind: "custom", value: trimmed }]);
    }
    onCustomTextChange("");
  }, [
    customText,
    answer,
    isMultiple,
    exclusiveSingleSelect,
    onAnswerChange,
    onCustomTextChange,
    committedCustomAnswers,
  ]);

  const handleRemoveCustomAnswer = useCallback(
    (target: Extract<AnswerEntry, { kind: "custom" }>) => {
      onAnswerChange(answer.filter((entry) => entry !== target));
    },
    [answer, onAnswerChange],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleCustomSubmit();
      }
    },
    [handleCustomSubmit],
  );

  return (
    <div className="space-y-4">
      <div className="text-sm leading-relaxed text-foreground">
        {info.question}
        {isMultiple && (
          <span className="ml-1 text-muted-foreground">
            (select all that apply)
          </span>
        )}
      </div>

      {hasOptions && (
        <div className="space-y-1">
          {info.options!.map((option, optIndex) => {
            const token = optionToken(option, optIndex);
            const value = optionValue(option);
            const isSelected = !draftSupersedesAnswer && answer.some(
              (entry) => entry.kind === "option" && entry.token === token,
            );
            return (
              <button
                key={optIndex}
                type="button"
                disabled={disabled}
                onClick={() => handleOptionClick(token, value)}
                aria-pressed={isSelected}
                className={cn(
                  "w-full rounded-md px-3 py-2.5 text-left transition-colors",
                  "hover:bg-muted/70 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
                  disabled && "cursor-not-allowed opacity-70 hover:bg-transparent",
                  isSelected ? "bg-muted" : "bg-transparent",
                )}
              >
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 shrink-0">
                    {isSelected ? (
                      <div className="flex h-4 w-4 items-center justify-center rounded-full bg-primary">
                        <Check className="h-3 w-3 text-primary-foreground" />
                      </div>
                    ) : (
                      <Circle className="h-4 w-4 text-muted-foreground/50" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "text-sm font-medium",
                        isSelected ? "text-foreground" : "text-foreground/90",
                      )}
                    >
                      {option.label}
                    </div>
                    {option.description && (
                      <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {option.description}
                      </div>
                    )}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Committed custom answers, so the user can see what will be submitted. */}
      {committedCustomAnswers.length > 0 && !draftSupersedesAnswer && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {committedCustomAnswers.map((entry, index) => (
            <span
              key={info.secret ? index : `${index}:${entry.value}`}
              className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs text-primary"
            >
              <Check className="h-3 w-3" />
              <span className="max-w-[28ch] truncate">
                {info.secret ? "Secret entered" : entry.value}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => handleRemoveCustomAnswer(entry)}
                className={cn(
                  "-mr-0.5 ml-0.5 rounded-full p-0.5 hover:bg-primary/20",
                  disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
                )}
                aria-label={info.secret ? "Remove secret answer" : `Remove ${entry.value}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      {allowCustomAnswer && (
        <div className="pt-2">
          <Input
            type={info.secret ? "password" : "text"}
            placeholder={
              customAnswerPlaceholder ?? (hasOptions
                ? "Type your own answer (press Enter to add)"
                : "Type your answer")
            }
            value={customText}
            onChange={(e) => onCustomTextChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            className="h-9 border-muted-foreground/20 bg-transparent text-sm focus:border-primary"
          />
          {info.secret && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Secret input stays only in this card and is lost if you leave it.
            </p>
          )}
          {customText.trim().length > 0 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Your typed answer will be included when you submit.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Multi-question wizard shared by the native agents.
 *
 * Claude and OpenCode each had their own copy; this is Claude's, which was the
 * richer of the two (option values distinct from labels, uncommitted custom
 * text preserved across question navigation and included at submit, per-question
 * answered indicators). OpenCode's version silently dropped typed-but-not-entered
 * text, so a user who typed an answer and pressed Submit lost it.
 */
export function QuestionCard({
  agentLabel,
  title,
  questions,
  onSubmit,
  onDismiss,
  initialAnswers,
  allowCustomAnswer = true,
  allowOptionDeselect = true,
  submitOnOptionSelect = false,
  exclusiveSingleSelect = false,
  hideDismiss = false,
  dismissLabel = "Dismiss",
  customAnswerPlaceholder,
  draftKey,
  expiresAt,
}: QuestionCardProps) {
  const [answers, setAnswers] = usePromptDraftField<Record<string, AnswerEntry[]>>(
    draftKey,
    "answersByQuestion",
    () => Object.fromEntries(questions.flatMap((question, i) =>
      question.secret
        ? []
        : [[
            questionDraftId(question, i),
            initialAnswerEntries(question, initialAnswers?.[i] ?? []),
          ]],
    )),
  );
  /**
   * In-progress custom text per question, lifted here so it survives navigation
   * between questions (QuestionItem remounts on index change) and so it can be
   * included at submit even if the user never pressed Enter.
   */
  const [customTexts, setCustomTexts] = usePromptDraftField<Record<string, string>>(
    draftKey,
    "customTextsByQuestion",
    () => Object.fromEntries(questions.flatMap((question, i) =>
      question.secret ? [] : [[questionDraftId(question, i), ""]],
    )),
  );
  // Secrets intentionally use component state only. They survive navigation
  // inside this mounted wizard, but not tab/environment unmount or restart.
  const [secretAnswers, setSecretAnswers] = useState<AnswerEntry[][]>(() =>
    questions.map((question, i) =>
      question.secret
        ? initialAnswerEntries(question, initialAnswers?.[i] ?? [])
        : []),
  );
  const [secretCustomTexts, setSecretCustomTexts] = useState<string[]>(() =>
    questions.map(() => ""),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [retryBlocked, setRetryBlocked] = useState(false);
  const [storedQuestionIndex, setCurrentQuestionIndex] =
    usePromptDraftField<number>(draftKey, "currentQuestionIndex", () => 0);
  const { expired } = usePromptDeadline(expiresAt);

  const questionCount = questions.length;
  const currentQuestionIndex = Number.isInteger(storedQuestionIndex)
    && storedQuestionIndex >= 0
    && storedQuestionIndex < questionCount
    ? storedQuestionIndex
    : 0;
  const currentQuestion = questions[currentQuestionIndex];
  const answerForIndex = useCallback(
    (i: number) => {
      const question = questions[i];
      if (!question) return [];
      return question.secret
        ? secretAnswers[i] ?? []
        : answers[questionDraftId(question, i)] ?? [];
    },
    [answers, questions, secretAnswers],
  );
  const customTextForIndex = useCallback(
    (i: number) => {
      const question = questions[i];
      if (!question) return "";
      return question.secret
        ? secretCustomTexts[i] ?? ""
        : customTexts[questionDraftId(question, i)] ?? "";
    },
    [customTexts, questions, secretCustomTexts],
  );
  const currentAnswer = answerForIndex(currentQuestionIndex);
  const currentCustomText = customTextForIndex(currentQuestionIndex);

  const mergeAnswerForIndex = useCallback(
    (i: number): AnswerEntry[] => {
      const committed = answerForIndex(i);
      const draft = customTextForIndex(i).trim();
      if (!draft || committed.some(
        (entry) => entry.kind === "custom" && entry.value === draft,
      )) return committed;
      // Uncommitted text obeys the same exclusivity rule as a committed chip,
      // or a never-pressed-Enter draft would smuggle a second answer through.
      // `QuestionItem` draws the superseded option and chip as cleared while the
      // draft is present, so the card shows exactly what this returns.
      if (exclusiveSingleSelect && !(questions[i]?.multiSelect ?? false)) {
        return [{ kind: "custom", value: draft }];
      }
      return [...committed, { kind: "custom", value: draft }];
    },
    [answerForIndex, customTextForIndex, exclusiveSingleSelect, questions],
  );

  const serializeAnswer = useCallback(
    (answer: AnswerEntry[]): string[] => answer.map((entry) => entry.value),
    [],
  );

  const questionHasAnswer = useCallback(
    (i: number): boolean =>
      answerForIndex(i).length > 0 || customTextForIndex(i).trim().length > 0,
    [answerForIndex, customTextForIndex],
  );

  const hasCurrentAnswer = questionHasAnswer(currentQuestionIndex);

  const canSubmit = useMemo(
    () => questions.every((_, i) => questionHasAnswer(i)),
    [questions, questionHasAnswer],
  );

  const answeredCount = useMemo(
    () => questions.reduce((acc, _, i) => acc + (questionHasAnswer(i) ? 1 : 0), 0),
    [questions, questionHasAnswer],
  );

  const handleAnswerChange = useCallback(
    (newAnswer: AnswerEntry[]) => {
      if (questions[currentQuestionIndex]?.secret) {
        setSecretAnswers((prev) => {
          const updated = [...prev];
          updated[currentQuestionIndex] = newAnswer;
          return updated;
        });
        return;
      }
      setAnswers((prev) => {
        return {
          ...prev,
          [questionDraftId(questions[currentQuestionIndex]!, currentQuestionIndex)]: newAnswer,
        };
      });
    },
    [currentQuestionIndex, questions],
  );

  const handleCustomTextChange = useCallback(
    (newText: string) => {
      if (questions[currentQuestionIndex]?.secret) {
        setSecretCustomTexts((prev) => {
          const updated = [...prev];
          updated[currentQuestionIndex] = newText;
          return updated;
        });
        return;
      }
      setCustomTexts((prev) => {
        return {
          ...prev,
          [questionDraftId(questions[currentQuestionIndex]!, currentQuestionIndex)]: newText,
        };
      });
    },
    [currentQuestionIndex, questions],
  );

  const submitAnswers = useCallback(
    async (effectiveAnswers: AnswerEntry[][]) => {
      if (expired) return;
      setInlineError(null);
      setRetryBlocked(false);
      setIsSubmitting(true);
      try {
        const submitted = await onSubmit(
          effectiveAnswers.map(serializeAnswer),
        );
        const applied = typeof submitted === "object" ? submitted.applied : submitted !== false;
        if (!applied) {
          const message = typeof submitted === "object" && submitted.message
            ? submitted.message
            : `${agentLabel} is still waiting for a response. Please try again.`;
          setInlineError(message);
          setRetryBlocked(
            typeof submitted === "object" && submitted.retryable === false,
          );
          toast.error("Failed to send your answer", {
            description: `${agentLabel} is still waiting for a response. Please try again.`,
          });
        }
      } catch (error) {
        console.error(`[${agentLabel}QuestionCard] Failed to submit answer:`, error);
        setInlineError(`${agentLabel} is still waiting for a response. Please try again.`);
        setRetryBlocked(true);
        toast.error("Failed to send your answer", {
          description: `${agentLabel} is still waiting for a response. Please try again.`,
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [agentLabel, expired, onSubmit, serializeAnswer],
  );

  const handleNext = useCallback(async () => {
    if (currentQuestionIndex < questionCount - 1) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
      return;
    }
    /**
     * The button is enabled on the *current* question's answer, but submitting
     * needs every question answered — and the tab strip lets the user jump
     * straight here. Returning would leave an enabled button that does nothing
     * and a turn blocked with no explanation, so show them what is missing.
     */
    if (!canSubmit) {
      const missingIndex = questions.findIndex((_, i) => !questionHasAnswer(i));
      if (missingIndex !== -1) setCurrentQuestionIndex(missingIndex);
      return;
    }
    // Include any uncommitted custom text so nothing typed is lost.
    await submitAnswers(questions.map((_, i) => mergeAnswerForIndex(i)));
  }, [
    currentQuestionIndex,
    questionCount,
    canSubmit,
    questions,
    questionHasAnswer,
    mergeAnswerForIndex,
    submitAnswers,
  ]);

  const handleOptionSelect = useCallback(
    (_label: string, nextAnswer: AnswerEntry[]) => {
      if (!submitOnOptionSelect || isSubmitting || expired || nextAnswer.length === 0) return;
      if (questionCount !== 1) return;
      void submitAnswers([nextAnswer]);
    },
    [submitOnOptionSelect, isSubmitting, expired, questionCount, submitAnswers],
  );

  const handleDismiss = useCallback(async () => {
    if (isSubmitting || expired || !onDismiss) return;
    setInlineError(null);
    setRetryBlocked(false);
    setIsSubmitting(true);
    try {
      const dismissed = await onDismiss();
      const applied = typeof dismissed === "object" ? dismissed.applied : dismissed !== false;
      if (!applied) {
        const message = typeof dismissed === "object" && dismissed.message
          ? dismissed.message
          : `${agentLabel} is still waiting for a response. Please try again.`;
        setInlineError(message);
        setRetryBlocked(typeof dismissed === "object" && dismissed.retryable === false);
        toast.error("Failed to dismiss this question", {
          description: message,
        });
      }
    } catch (error) {
      console.error(`[${agentLabel}QuestionCard] Failed to dismiss question:`, error);
      setInlineError(`${agentLabel} is still waiting for a response. Please try again.`);
      setRetryBlocked(true);
      toast.error("Failed to dismiss this question", {
        description: `${agentLabel} is still waiting for a response. Please try again.`,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [agentLabel, expired, isSubmitting, onDismiss]);

  const isLastQuestion = currentQuestionIndex === questionCount - 1;
  const nextButtonText = isLastQuestion
      ? "Submit"
      : "Next";

  // Placed after all hooks to satisfy the rules-of-hooks.
  if (!currentQuestion) {
    return null;
  }

  return (
    <BlockingPromptCard
      title={title}
      meta={
        <span className="inline-flex items-center gap-1.5">
          {questionCount === 1
            ? "1 question"
            : `${answeredCount}/${questionCount} answered`}
          {questionCount > 1 && answeredCount === questionCount && (
            <Check className="ml-auto h-3.5 w-3.5 text-green-500" aria-hidden />
          )}
        </span>
      }
      expiresAt={expiresAt}
      state={expired ? "invalid" : isSubmitting ? "submitting" : inlineError ? "retryable-error" : "pending"}
      error={inlineError}
      role="group"
      aria-label={title}
      arrivalAnnouncement={`${title}. ${questionCount} ${questionCount === 1 ? "question" : "questions"}.`}
      actions={
        <>
          {!hideDismiss && onDismiss && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              disabled={isSubmitting || expired || retryBlocked}
              className="mr-auto text-muted-foreground hover:text-foreground"
            >
              {dismissLabel}
            </Button>
          )}
          {questionCount > 1 && currentQuestionIndex > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentQuestionIndex(currentQuestionIndex - 1)}
              disabled={isSubmitting || expired || retryBlocked}
            >
              Back
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleNext}
            disabled={!hasCurrentAnswer || isSubmitting || expired || retryBlocked}
          >
            {nextButtonText}
          </Button>
        </>
      }
    >
      {questionCount > 1 && (
        <div
          className="flex max-w-full items-center gap-1 overflow-x-auto border-b border-border bg-muted/20 px-3 py-2 sm:px-4"
          aria-label="Questions"
        >
          {questions.map((q, index) => {
            const isAnswered = questionHasAnswer(index);
            const isActive = index === currentQuestionIndex;
            return (
              <button
                key={q.id ?? index}
                type="button"
                aria-current={isActive ? "step" : undefined}
                aria-controls={`question-panel-${q.id ?? index}`}
                onClick={() => setCurrentQuestionIndex(index)}
                disabled={isSubmitting || expired || retryBlocked}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs transition-colors",
                  isActive
                    ? "bg-background font-medium text-foreground shadow-sm"
                    : isAnswered
                      ? "text-foreground/80 hover:bg-muted/50 hover:text-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                {isAnswered && !isActive && (
                  <Check className="h-3 w-3 text-green-500" />
                )}
                {q.header || `Question ${index + 1}`}
              </button>
            );
          })}
          <span className="ml-auto text-xs text-muted-foreground">
            {currentQuestionIndex + 1} of {questionCount}
          </span>
        </div>
      )}

      {questionCount === 1 && currentQuestion?.header && (
        <div className="border-b border-border bg-muted/20 px-4 py-2">
          <span className="text-xs font-medium tracking-wider text-muted-foreground uppercase">
            {currentQuestion.header}
          </span>
        </div>
      )}

      <div className="p-4">
        <div
          id={`question-panel-${currentQuestion.id ?? currentQuestionIndex}`}
          role={questionCount > 1 ? "tabpanel" : undefined}
        >
          <QuestionItem
            key={currentQuestion.id ?? currentQuestionIndex}
            info={currentQuestion}
            answer={currentAnswer}
            customText={currentCustomText}
            onAnswerChange={handleAnswerChange}
            onCustomTextChange={handleCustomTextChange}
            onOptionSelect={handleOptionSelect}
            allowCustomAnswer={currentQuestion.allowCustomAnswer ?? allowCustomAnswer}
            allowOptionDeselect={allowOptionDeselect}
            exclusiveSingleSelect={exclusiveSingleSelect}
            disabled={isSubmitting || expired || retryBlocked}
            customAnswerPlaceholder={customAnswerPlaceholder}
          />
        </div>
      </div>
    </BlockingPromptCard>
  );
}
