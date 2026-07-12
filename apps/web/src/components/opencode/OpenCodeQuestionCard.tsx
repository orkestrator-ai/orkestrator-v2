import { useState, useCallback, useMemo } from "react";
import { HelpCircle, Check, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { QuestionRequest, QuestionInfo, QuestionAnswer, OpencodeClient } from "@/lib/opencode-client";
import { replyToQuestion, rejectQuestion } from "@/lib/opencode-client";
import { useOpenCodeStore } from "@/stores/openCodeStore";

interface OpenCodeQuestionCardProps {
  question: QuestionRequest;
  client: OpencodeClient;
}

/** Single question item with options or text input */
function QuestionItem({
  info,
  answer,
  onAnswerChange,
}: {
  info: QuestionInfo;
  answer: string[];
  onAnswerChange: (newAnswer: string[]) => void;
}) {
  const [customText, setCustomText] = useState("");

  // Determine if this question allows custom input
  const allowsCustom = info.custom !== false; // Default is true
  const hasOptions = info.options && info.options.length > 0;
  const isMultiple = info.multiple ?? false;

  // Handle option selection
  const handleOptionClick = useCallback(
    (label: string) => {
      if (isMultiple) {
        // Toggle selection for multiple choice
        if (answer.includes(label)) {
          onAnswerChange(answer.filter((a) => a !== label));
        } else {
          onAnswerChange([...answer, label]);
        }
      } else {
        // Single selection - replace any existing selection
        if (answer.includes(label)) {
          onAnswerChange([]);
        } else {
          onAnswerChange([label]);
        }
      }
    },
    [answer, isMultiple, onAnswerChange]
  );

  // Handle custom text submission
  const handleCustomSubmit = useCallback(() => {
    if (customText.trim()) {
      if (isMultiple) {
        // Add to existing answers
        if (!answer.includes(customText.trim())) {
          onAnswerChange([...answer, customText.trim()]);
        }
      } else {
        // Replace existing answer
        onAnswerChange([customText.trim()]);
      }
      setCustomText("");
    }
  }, [customText, answer, isMultiple, onAnswerChange]);

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
            const isSelected = answer.includes(option.label);
            return (
              <button
                key={optIndex}
                type="button"
                onClick={() => handleOptionClick(option.label)}
                className={cn(
                  "w-full text-left px-3 py-2.5 rounded-md transition-colors",
                  "hover:bg-muted/70 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1",
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

      {/* Custom text input */}
      {allowsCustom && (
        <div className="pt-2">
          <Input
            placeholder="Type your own answer"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={handleKeyDown}
            onBlur={() => {
              if (customText.trim()) {
                handleCustomSubmit();
              }
            }}
            className="h-9 text-sm bg-transparent border-muted-foreground/20 focus:border-primary"
          />
        </div>
      )}
    </div>
  );
}

export function OpenCodeQuestionCard({
  question,
  client,
}: OpenCodeQuestionCardProps) {
  const { removePendingQuestion } = useOpenCodeStore();

  // Track answers for each question
  const [answers, setAnswers] = useState<QuestionAnswer[]>(
    () => question.questions.map(() => [])
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Track which question we're currently viewing (for multi-question support)
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);

  const questionCount = question.questions.length;
  const currentQuestion = question.questions[currentQuestionIndex]!;
  const currentAnswer = answers[currentQuestionIndex] || [];

  // Safety check - should never happen but TypeScript wants it
  if (!currentQuestion) {
    return null;
  }

  // Check if current question has an answer
  const hasCurrentAnswer = currentAnswer.length > 0;

  // Check if all questions have answers
  const canSubmit = useMemo(() => {
    return question.questions.every((_, i) => {
      return answers[i] && answers[i].length > 0;
    });
  }, [question.questions, answers]);

  // Handle answer change for current question
  const handleAnswerChange = useCallback((newAnswer: string[]) => {
    setAnswers((prev) => {
      const updated = [...prev];
      updated[currentQuestionIndex] = newAnswer;
      return updated;
    });
  }, [currentQuestionIndex]);

  // Handle next question or submit
  const handleNext = useCallback(async () => {
    if (currentQuestionIndex < questionCount - 1) {
      // Go to next question
      setCurrentQuestionIndex((prev) => prev + 1);
    } else {
      // Submit all answers
      if (!canSubmit) return;

      setIsSubmitting(true);
      try {
        const success = await replyToQuestion(client, question.id, answers);
        if (success) {
          removePendingQuestion(question.id);
        }
      } catch (error) {
        console.error("[OpenCodeQuestionCard] Failed to submit answer:", error);
      } finally {
        setIsSubmitting(false);
      }
    }
  }, [currentQuestionIndex, questionCount, canSubmit, client, question.id, answers, removePendingQuestion]);

  // Handle dismiss
  const handleDismiss = useCallback(async () => {
    setIsSubmitting(true);
    try {
      const success = await rejectQuestion(client, question.id);
      if (success) {
        removePendingQuestion(question.id);
        // Note: Loading state is managed by SSE events in OpenCodeChatTab
      }
    } catch (error) {
      console.error("[OpenCodeQuestionCard] Failed to dismiss question:", error);
    } finally {
      setIsSubmitting(false);
    }
  }, [client, question.id, removePendingQuestion]);

  // Determine button text
  const isLastQuestion = currentQuestionIndex === questionCount - 1;
  const nextButtonText = isSubmitting
    ? "Submitting..."
    : isLastQuestion
      ? "Submit"
      : "Next";

  return (
    <div className="mx-4 my-3 rounded-lg border border-border bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-2.5 bg-muted/50 border-b border-border">
        <HelpCircle className="w-4 h-4 text-muted-foreground" />
        <span className="text-sm font-medium text-foreground">Questions</span>
        <span className="text-xs text-muted-foreground">
          {questionCount} {questionCount === 1 ? "question" : "questions"}
        </span>
      </div>

      {/* Question tabs (if multiple questions) */}
      {questionCount > 1 && (
        <div className="flex items-center gap-1 px-4 py-2 border-b border-border bg-muted/20">
          {question.questions.map((q, index) => (
            <button
              key={index}
              type="button"
              onClick={() => setCurrentQuestionIndex(index)}
              className={cn(
                "px-3 py-1 text-xs rounded-md transition-colors",
                index === currentQuestionIndex
                  ? "bg-background text-foreground font-medium shadow-sm"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
              )}
            >
              {q.header || `Question ${index + 1}`}
            </button>
          ))}
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
          info={currentQuestion}
          answer={currentAnswer}
          onAnswerChange={handleAnswerChange}
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 px-4 py-3 bg-muted/30 border-t border-border">
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDismiss}
          disabled={isSubmitting}
          className="text-muted-foreground hover:text-foreground"
        >
          Dismiss
        </Button>
        <Button
          size="sm"
          onClick={handleNext}
          disabled={!hasCurrentAnswer || isSubmitting}
        >
          {nextButtonText}
        </Button>
      </div>
    </div>
  );
}
