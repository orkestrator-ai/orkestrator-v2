import { useCallback, useMemo, useState } from "react";
import { Check, Circle, HelpCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { ClaudeClient, ClaudeQuestionRequest, QuestionInfo, QuestionOption } from "@/lib/claude-client";
import { answerQuestion } from "@/lib/claude-client";
import { useClaudeStore } from "@/stores/claudeStore";

type SubmitAnswersHandler = (
  answers: string[][]
) => Promise<boolean | void> | boolean | void;

function optionValue(option: QuestionOption): string {
  return option.value ?? option.label;
}

interface ClaudeQuestionCardBaseProps {
  question: ClaudeQuestionRequest;
  initialAnswers?: string[][];
  allowCustomAnswer?: boolean;
  allowOptionDeselect?: boolean;
  submitOnOptionSelect?: boolean;
  onDismiss?: () => Promise<void> | void;
  hideDismiss?: boolean;
}

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

/** Single question item with options or text input */
function QuestionItem({
  info,
  answer,
  customText,
  onAnswerChange,
  onCustomTextChange,
  onOptionSelect,
  allowCustomAnswer,
  allowOptionDeselect,
  disabled,
}: {
  info: QuestionInfo;
  answer: string[];
  customText: string;
  onAnswerChange: (newAnswer: string[]) => void;
  onCustomTextChange: (newText: string) => void;
  onOptionSelect?: (label: string, nextAnswer: string[]) => void;
  allowCustomAnswer: boolean;
  allowOptionDeselect: boolean;
  disabled: boolean;
}) {
  // Determine if this question allows custom input
  const hasOptions = info.options && info.options.length > 0;
  const isMultiple = info.multiSelect ?? false;
  const optionValues = useMemo(
    () => new Set((info.options ?? []).map(optionValue)),
    [info.options]
  );
  // Custom answers that have been committed (via Enter) and are not in the option list
  const committedCustomAnswers = useMemo(
    () => answer.filter((a) => !optionValues.has(a)),
    [answer, optionValues]
  );

  // Handle option selection
  const handleOptionClick = useCallback(
    (value: string) => {
      let nextAnswer: string[];
      if (isMultiple) {
        // Toggle selection for multiple choice
        if (answer.includes(value)) {
          nextAnswer = answer.filter((a) => a !== value);
        } else {
          nextAnswer = [...answer, value];
        }
      } else {
        // Single selection - replace any existing selection
        if (answer.includes(value)) {
          nextAnswer = allowOptionDeselect ? [] : answer;
        } else {
          // Preserve any committed custom answers when switching option in single-select
          nextAnswer = [...committedCustomAnswers, value];
        }
      }
      onAnswerChange(nextAnswer);
      onOptionSelect?.(value, nextAnswer);
    },
    [
      answer,
      isMultiple,
      onAnswerChange,
      onOptionSelect,
      allowOptionDeselect,
      committedCustomAnswers,
    ]
  );

  // Commit current draft customText into the answer array (so it shows as a chip).
  // Returning the resulting answer makes Enter behavior easy to reason about.
  const handleCustomSubmit = useCallback(() => {
    const trimmed = customText.trim();
    if (!trimmed) return;
    if (answer.includes(trimmed)) {
      onCustomTextChange("");
      return;
    }
    if (isMultiple) {
      onAnswerChange([...answer, trimmed]);
    } else {
      // Single-select: only one custom chip allowed at a time. Drop any prior
      // chips and keep the currently-selected option (if any) alongside the
      // new chip, mirroring how handleOptionClick keeps chips alongside
      // the option.
      const selectedOption = answer.filter((a) => optionValues.has(a));
      onAnswerChange([...selectedOption, trimmed]);
    }
    onCustomTextChange("");
  }, [customText, answer, isMultiple, onAnswerChange, onCustomTextChange, optionValues]);

  const handleRemoveCustomAnswer = useCallback(
    (label: string) => {
      onAnswerChange(answer.filter((a) => a !== label));
    },
    [answer, onAnswerChange]
  );

  // Handle custom text input key press
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleCustomSubmit();
      }
    },
    [handleCustomSubmit]
  );

  return (
    <div className="space-y-4">
      {/* Question text */}
      <div className="text-sm text-foreground leading-relaxed">
        {info.question}
        {isMultiple && (
          <span className="text-muted-foreground ml-1">(select all that apply)</span>
        )}
      </div>

      {/* Options as selectable rows */}
      {hasOptions && (
        <div className="space-y-1">
          {info.options.map((option, optIndex) => {
            const value = optionValue(option);
            const isSelected = answer.includes(value);
            return (
              <button
                key={optIndex}
                type="button"
                disabled={disabled}
                onClick={() => handleOptionClick(value)}
                className={cn(
                  "w-full text-left px-3 py-2.5 rounded-md transition-colors",
                  "hover:bg-muted/70 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
                  disabled && "opacity-70 cursor-not-allowed hover:bg-transparent",
                  isSelected ? "bg-muted" : "bg-transparent"
                )}
              >
                <div className="flex items-start gap-3">
                  {/* Selection indicator */}
                  <div className="mt-0.5 shrink-0">
                    {isSelected ? (
                      <div className="w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                        <Check className="w-3 h-3 text-primary-foreground" />
                      </div>
                    ) : (
                      <Circle className="w-4 h-4 text-muted-foreground/50" />
                    )}
                  </div>
                  {/* Label and description */}
                  <div className="flex-1 min-w-0">
                    <div className={cn(
                      "text-sm font-medium",
                      isSelected ? "text-foreground" : "text-foreground/90"
                    )}>
                      {option.label}
                    </div>
                    {option.description && (
                      <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
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

      {/* Committed custom answers - shown so the user can see what will be submitted */}
      {committedCustomAnswers.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {committedCustomAnswers.map((label) => (
            <span
              key={label}
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 text-primary text-xs px-2.5 py-1 border border-primary/20"
            >
              <Check className="w-3 h-3" />
              <span className="max-w-[28ch] truncate">{label}</span>
              <button
                type="button"
                onClick={() => handleRemoveCustomAnswer(label)}
                className="ml-0.5 -mr-0.5 rounded-full hover:bg-primary/20 p-0.5"
                aria-label={`Remove ${label}`}
              >
                <X className="w-3 h-3" />
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
            className="h-9 text-sm bg-transparent border-muted-foreground/20 focus:border-primary"
          />
          {customText.trim().length > 0 && (
            <p className="text-[11px] text-muted-foreground mt-1">
              Your typed answer will be included when you submit.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

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
}: ClaudeQuestionCardProps) {
  const { removePendingQuestion } = useClaudeStore();

  // Track answers for each question (committed option selections + Enter-committed custom answers)
  const [answers, setAnswers] = useState<string[][]>(
    () => question.questions.map((_, i) => [...(initialAnswers?.[i] ?? [])])
  );
  // Track in-progress (uncommitted) custom text per question. Lifted to parent so it
  // survives navigation between questions (the QuestionItem remounts on index change),
  // and so it can be included at submit even if the user never pressed Enter.
  const [customTexts, setCustomTexts] = useState<string[]>(
    () => question.questions.map(() => "")
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Track which question we're currently viewing (for multi-question support)
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);

  const questionCount = question.questions.length;
  const currentQuestion = question.questions[currentQuestionIndex];
  const currentAnswer = answers[currentQuestionIndex] || [];
  const currentCustomText = customTexts[currentQuestionIndex] ?? "";

  // Merge committed answers with any uncommitted custom text for the given index
  const mergeAnswerForIndex = useCallback(
    (i: number): string[] => {
      const committed = answers[i] ?? [];
      const draft = (customTexts[i] ?? "").trim();
      if (!draft || committed.includes(draft)) return committed;
      return [...committed, draft];
    },
    [answers, customTexts]
  );

  const questionHasAnswer = useCallback(
    (i: number): boolean => {
      return (answers[i]?.length ?? 0) > 0 || (customTexts[i] ?? "").trim().length > 0;
    },
    [answers, customTexts]
  );

  // Check if current question has an answer (committed OR typed-but-not-committed)
  const hasCurrentAnswer = questionHasAnswer(currentQuestionIndex);

  // Check if all questions have answers
  const canSubmit = useMemo(() => {
    return question.questions.every((_, i) => questionHasAnswer(i));
  }, [question.questions, questionHasAnswer]);

  // Count answered questions for progress display
  const answeredCount = useMemo(() => {
    return question.questions.reduce(
      (acc, _, i) => acc + (questionHasAnswer(i) ? 1 : 0),
      0
    );
  }, [question.questions, questionHasAnswer]);

  // Handle answer change for current question
  const handleAnswerChange = useCallback((newAnswer: string[]) => {
    setAnswers((prev) => {
      const updated = [...prev];
      updated[currentQuestionIndex] = newAnswer;
      return updated;
    });
  }, [currentQuestionIndex]);

  // Handle custom text change for current question
  const handleCustomTextChange = useCallback((newText: string) => {
    setCustomTexts((prev) => {
      const updated = [...prev];
      updated[currentQuestionIndex] = newText;
      return updated;
    });
  }, [currentQuestionIndex]);

  const submitAnswers = useCallback(async (effectiveAnswers: string[][]) => {
    setIsSubmitting(true);
    try {
      const success = onSubmitAnswers
        ? (await onSubmitAnswers(effectiveAnswers)) !== false
        : await answerQuestion(client, sessionId, question.id, effectiveAnswers);
      if (success && !onSubmitAnswers) {
        removePendingQuestion(question.id);
      }
    } catch (error) {
      console.error("[ClaudeQuestionCard] Failed to submit answer:", error);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    client,
    sessionId,
    onSubmitAnswers,
    question.id,
    removePendingQuestion,
  ]);

  // Handle next question or submit
  const handleNext = useCallback(async () => {
    if (currentQuestionIndex < questionCount - 1) {
      // Go to next question
      setCurrentQuestionIndex((prev) => prev + 1);
      return;
    }
    // Submit all answers — include any uncommitted custom text so nothing is lost
    if (!canSubmit) return;

    const effectiveAnswers = question.questions.map((_, i) => mergeAnswerForIndex(i));
    await submitAnswers(effectiveAnswers);
  }, [
    currentQuestionIndex,
    questionCount,
    canSubmit,
    question.questions,
    mergeAnswerForIndex,
    submitAnswers,
  ]);

  const handleOptionSelect = useCallback(
    (_label: string, nextAnswer: string[]) => {
      if (!submitOnOptionSelect || isSubmitting || nextAnswer.length === 0) return;
      if (questionCount !== 1) return;
      void submitAnswers([nextAnswer]);
    },
    [submitOnOptionSelect, isSubmitting, questionCount, submitAnswers],
  );

  // Handle dismiss - just remove the question locally (server will handle timeout)
  const handleDismiss = useCallback(() => {
    if (onDismiss) {
      void onDismiss();
      return;
    }
    removePendingQuestion(question.id);
  }, [onDismiss, question.id, removePendingQuestion]);

  // Determine button text
  const isLastQuestion = currentQuestionIndex === questionCount - 1;
  const nextButtonText = isSubmitting
    ? "Submitting..."
    : isLastQuestion
      ? "Submit"
      : "Next";

  // Safety check - should never happen but TypeScript wants it. Placed after
  // all hooks to satisfy the rules-of-hooks.
  if (!currentQuestion) {
    return null;
  }

  return (
    <div className="mx-4 my-3 rounded-lg border border-border bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/50 border-b border-border">
        <HelpCircle className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Claude needs your input</span>
        {questionCount === 1 ? (
          <span className="text-xs text-muted-foreground">1 question</span>
        ) : (
          <span className="text-xs text-muted-foreground">
            {answeredCount}/{questionCount} answered
          </span>
        )}
        {questionCount > 1 && answeredCount === questionCount && (
          <Check className="w-3.5 h-3.5 text-green-500 ml-auto" />
        )}
      </div>

      {/* Question tabs (if multiple questions) */}
      {questionCount > 1 && (
        <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-muted/20">
          {question.questions.map((q, index) => {
            const isAnswered = questionHasAnswer(index);
            const isActive = index === currentQuestionIndex;
            return (
              <button
                key={index}
                type="button"
                onClick={() => setCurrentQuestionIndex(index)}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1 text-xs rounded-md transition-colors",
                  isActive
                    ? "bg-background text-foreground font-medium shadow-sm"
                    : isAnswered
                      ? "text-foreground/80 hover:text-foreground hover:bg-muted/50"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
              >
                {isAnswered && !isActive && (
                  <Check className="w-3 h-3 text-green-500" />
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

      {/* Single question header (if only one question with header) */}
      {questionCount === 1 && currentQuestion?.header && (
        <div className="px-4 py-2 border-b border-border bg-muted/20">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {currentQuestion.header}
          </span>
        </div>
      )}

      {/* Question content */}
      <div className="p-4">
        <QuestionItem
          key={currentQuestionIndex}
          info={currentQuestion}
          answer={currentAnswer}
          customText={currentCustomText}
          onAnswerChange={handleAnswerChange}
          onCustomTextChange={handleCustomTextChange}
          onOptionSelect={handleOptionSelect}
          allowCustomAnswer={allowCustomAnswer}
          allowOptionDeselect={allowOptionDeselect}
          disabled={isSubmitting}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-between px-4 py-3 bg-muted/30 border-t border-border">
        {!hideDismiss && (
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
    </div>
  );
}
