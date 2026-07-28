import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Check, Circle, HelpCircle, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { BlockingPromptCard } from "@/components/chat/BlockingPromptCard";
import { usePromptDraftField } from "@/stores/promptDraftStore";
import { usePromptDeadline } from "@/hooks/usePromptDeadline";

/** Agent-neutral option shape. `value` falls back to `label` when absent. */
export interface QuestionCardOption {
  label: string;
  description?: string;
  value?: string;
}

/** Agent-neutral question shape. */
export interface QuestionCardQuestion {
  question: string;
  header?: string;
  options?: QuestionCardOption[];
  multiSelect?: boolean;
  /** Per-question override of the card-level `allowCustomAnswer`. */
  allowCustomAnswer?: boolean;
}

/**
 * Receives the answers the user submitted.
 *
 * The card never removes itself: every wrapper owns its lifecycle (via
 * `removePendingQuestion` and friends) because the reply has to be accepted by
 * the agent before the prompt stops blocking the turn. Returning `false` leaves
 * the card retryable and produces a user-visible delivery failure.
 */
export type SubmitAnswersHandler = (
  answers: string[][],
) => Promise<boolean | void> | boolean | void;

interface QuestionCardProps {
  agentLabel: string;
  /** Header copy, e.g. "Claude needs your input". */
  title: string;
  questions: QuestionCardQuestion[];
  onSubmit: SubmitAnswersHandler;
  onDismiss?: () => Promise<boolean | void> | boolean | void;
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
}: {
  info: QuestionCardQuestion;
  answer: string[];
  customText: string;
  onAnswerChange: (newAnswer: string[]) => void;
  onCustomTextChange: (newText: string) => void;
  onOptionSelect?: (label: string, nextAnswer: string[]) => void;
  allowCustomAnswer: boolean;
  allowOptionDeselect: boolean;
  exclusiveSingleSelect: boolean;
  disabled: boolean;
}) {
  const hasOptions = !!info.options && info.options.length > 0;
  const isMultiple = info.multiSelect ?? false;
  const optionValues = useMemo(
    () => new Set((info.options ?? []).map(optionValue)),
    [info.options],
  );
  // Custom answers committed via Enter that are not in the option list.
  const committedCustomAnswers = useMemo(
    () => answer.filter((a) => !optionValues.has(a)),
    [answer, optionValues],
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
    (value: string) => {
      let nextAnswer: string[];
      if (isMultiple) {
        nextAnswer = answer.includes(value)
          ? answer.filter((a) => a !== value)
          : [...answer, value];
      } else if (draftSupersedesAnswer) {
        // The draft is the current answer and the selection is drawn as
        // cleared, so a click picks the option rather than toggling a
        // selection the user cannot see.
        nextAnswer = [value];
        onCustomTextChange("");
      } else if (answer.includes(value)) {
        nextAnswer = allowOptionDeselect ? [] : answer;
      } else if (exclusiveSingleSelect) {
        nextAnswer = [value];
      } else {
        // Preserve committed custom answers when switching option in single-select.
        nextAnswer = [...committedCustomAnswers, value];
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
    if (answer.includes(trimmed)) {
      onCustomTextChange("");
      return;
    }
    if (isMultiple) {
      onAnswerChange([...answer, trimmed]);
    } else if (exclusiveSingleSelect) {
      // The question asked for one answer, so the custom text replaces the
      // selected option rather than joining it.
      onAnswerChange([trimmed]);
    } else {
      // Single-select allows one custom chip at a time; keep the selected
      // option alongside it, mirroring handleOptionClick.
      const selectedOption = answer.filter((a) => optionValues.has(a));
      onAnswerChange([...selectedOption, trimmed]);
    }
    onCustomTextChange("");
  }, [
    customText,
    answer,
    isMultiple,
    exclusiveSingleSelect,
    onAnswerChange,
    onCustomTextChange,
    optionValues,
  ]);

  const handleRemoveCustomAnswer = useCallback(
    (label: string) => {
      onAnswerChange(answer.filter((a) => a !== label));
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
            const value = optionValue(option);
            const isSelected = !draftSupersedesAnswer && answer.includes(value);
            return (
              <button
                key={optIndex}
                type="button"
                disabled={disabled}
                onClick={() => handleOptionClick(value)}
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
          {committedCustomAnswers.map((label) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs text-primary"
            >
              <Check className="h-3 w-3" />
              <span className="max-w-[28ch] truncate">{label}</span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => handleRemoveCustomAnswer(label)}
                className={cn(
                  "-mr-0.5 ml-0.5 rounded-full p-0.5 hover:bg-primary/20",
                  disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
                )}
                aria-label={`Remove ${label}`}
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
            placeholder={
              hasOptions
                ? "Type your own answer (press Enter to add)"
                : "Type your answer"
            }
            value={customText}
            onChange={(e) => onCustomTextChange(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            className="h-9 border-muted-foreground/20 bg-transparent text-sm focus:border-primary"
          />
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
  draftKey,
  expiresAt,
}: QuestionCardProps) {
  const [answers, setAnswers] = usePromptDraftField<string[][]>(
    draftKey,
    "answers",
    () => questions.map((_, i) => [...(initialAnswers?.[i] ?? [])]),
  );
  /**
   * In-progress custom text per question, lifted here so it survives navigation
   * between questions (QuestionItem remounts on index change) and so it can be
   * included at submit even if the user never pressed Enter.
   */
  const [customTexts, setCustomTexts] = usePromptDraftField<string[]>(
    draftKey,
    "customTexts",
    () => questions.map(() => ""),
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentQuestionIndex, setCurrentQuestionIndex] =
    usePromptDraftField<number>(draftKey, "currentQuestionIndex", () => 0);
  const { remaining, expired } = usePromptDeadline(expiresAt);

  const questionCount = questions.length;
  const currentQuestion = questions[currentQuestionIndex];
  const currentAnswer = answers[currentQuestionIndex] || [];
  const currentCustomText = customTexts[currentQuestionIndex] ?? "";

  const mergeAnswerForIndex = useCallback(
    (i: number): string[] => {
      const committed = answers[i] ?? [];
      const draft = (customTexts[i] ?? "").trim();
      if (!draft || committed.includes(draft)) return committed;
      // Uncommitted text obeys the same exclusivity rule as a committed chip,
      // or a never-pressed-Enter draft would smuggle a second answer through.
      // `QuestionItem` draws the superseded option and chip as cleared while the
      // draft is present, so the card shows exactly what this returns.
      if (exclusiveSingleSelect && !(questions[i]?.multiSelect ?? false)) {
        return [draft];
      }
      return [...committed, draft];
    },
    [answers, customTexts, exclusiveSingleSelect, questions],
  );

  const questionHasAnswer = useCallback(
    (i: number): boolean =>
      (answers[i]?.length ?? 0) > 0 || (customTexts[i] ?? "").trim().length > 0,
    [answers, customTexts],
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
    (newAnswer: string[]) => {
      setAnswers((prev) => {
        const updated = [...prev];
        updated[currentQuestionIndex] = newAnswer;
        return updated;
      });
    },
    [currentQuestionIndex],
  );

  const handleCustomTextChange = useCallback(
    (newText: string) => {
      setCustomTexts((prev) => {
        const updated = [...prev];
        updated[currentQuestionIndex] = newText;
        return updated;
      });
    },
    [currentQuestionIndex],
  );

  const submitAnswers = useCallback(
    async (effectiveAnswers: string[][]) => {
      if (expired) return;
      setIsSubmitting(true);
      try {
        const submitted = await onSubmit(effectiveAnswers);
        if (submitted === false) {
          toast.error("Failed to send your answer", {
            description: `${agentLabel} is still waiting for a response. Please try again.`,
          });
        }
      } catch (error) {
        console.error(`[${agentLabel}QuestionCard] Failed to submit answer:`, error);
        toast.error("Failed to send your answer", {
          description: `${agentLabel} is still waiting for a response. Please try again.`,
        });
      } finally {
        setIsSubmitting(false);
      }
    },
    [agentLabel, expired, onSubmit],
  );

  const handleNext = useCallback(async () => {
    if (currentQuestionIndex < questionCount - 1) {
      setCurrentQuestionIndex((prev) => prev + 1);
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
    (_label: string, nextAnswer: string[]) => {
      if (!submitOnOptionSelect || isSubmitting || expired || nextAnswer.length === 0) return;
      if (questionCount !== 1) return;
      void submitAnswers([nextAnswer]);
    },
    [submitOnOptionSelect, isSubmitting, expired, questionCount, submitAnswers],
  );

  const handleDismiss = useCallback(async () => {
    if (isSubmitting || expired || !onDismiss) return;
    setIsSubmitting(true);
    try {
      const dismissed = await onDismiss();
      if (dismissed === false) {
        toast.error("Failed to dismiss this question", {
          description: `${agentLabel} is still waiting for a response. Please try again.`,
        });
      }
    } catch (error) {
      console.error(`[${agentLabel}QuestionCard] Failed to dismiss question:`, error);
      toast.error("Failed to dismiss this question", {
        description: `${agentLabel} is still waiting for a response. Please try again.`,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [agentLabel, expired, isSubmitting, onDismiss]);

  const isLastQuestion = currentQuestionIndex === questionCount - 1;
  const nextButtonText = isSubmitting
    ? "Submitting..."
    : isLastQuestion
      ? "Submit"
      : "Next";

  // Placed after all hooks to satisfy the rules-of-hooks.
  if (!currentQuestion) {
    return null;
  }

  return (
    <BlockingPromptCard>
      <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-4 py-2.5">
        <HelpCircle className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">{title}</span>
        {questionCount === 1 ? (
          <span className="text-xs text-muted-foreground">1 question</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {answeredCount}/{questionCount} answered
          </span>
        )}
        {questionCount > 1 && answeredCount === questionCount && (
          <Check className="ml-auto h-3.5 w-3.5 text-green-500" />
        )}
        {!expired && remaining && (
          <span className="ml-auto text-xs tabular-nums text-muted-foreground" aria-live="off">
            {remaining}
          </span>
        )}
      </div>

      {questionCount > 1 && (
        <div className="flex items-center gap-1 border-b border-border bg-muted/20 px-4 py-2">
          {questions.map((q, index) => {
            const isAnswered = questionHasAnswer(index);
            const isActive = index === currentQuestionIndex;
            return (
              <button
                key={index}
                type="button"
                onClick={() => setCurrentQuestionIndex(index)}
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
        <QuestionItem
          key={currentQuestionIndex}
          info={currentQuestion}
          answer={currentAnswer}
          customText={currentCustomText}
          onAnswerChange={handleAnswerChange}
          onCustomTextChange={handleCustomTextChange}
          onOptionSelect={handleOptionSelect}
          allowCustomAnswer={currentQuestion.allowCustomAnswer ?? allowCustomAnswer}
          allowOptionDeselect={allowOptionDeselect}
          exclusiveSingleSelect={exclusiveSingleSelect}
          disabled={isSubmitting || expired}
        />
      </div>

      {expired ? (
        <div className="flex items-center gap-1.5 border-t border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
          This request expired and was declined.
        </div>
      ) : (
        <div className="flex items-center justify-between border-t border-border bg-muted/30 px-4 py-3">
        {!hideDismiss && onDismiss && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDismiss}
            disabled={isSubmitting}
            className="text-muted-foreground hover:text-foreground"
          >
            Dismiss
          </Button>
        )}
        <div className="flex items-center gap-2">
          {questionCount > 1 && currentQuestionIndex > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentQuestionIndex((prev) => prev - 1)}
              disabled={isSubmitting}
            >
              Back
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleNext}
            disabled={!hasCurrentAnswer || isSubmitting}
          >
            {nextButtonText}
          </Button>
        </div>
        </div>
      )}
    </BlockingPromptCard>
  );
}
