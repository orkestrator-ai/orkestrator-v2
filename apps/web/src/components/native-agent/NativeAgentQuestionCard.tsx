import { useEffect, useRef } from "react";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  MessageCircleQuestion,
  PencilLine,
} from "lucide-react";
import type {
  AgentInteractionApplyOutcome,
  AgentInteractionQuestion,
  AgentInteractionRequest,
  AgentInteractionResolution,
} from "@orkestrator/protocol/agent-interactions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { usePromptDeadline } from "@/hooks/usePromptDeadline";
import { cn } from "@/lib/utils";
import {
  nativeAgentInteractionDraftKey,
  usePromptDraftField,
} from "@/stores/promptDraftStore";
import { useInteractionResolver } from "@/components/native-agent/use-interaction-resolver";

type Answer = { optionIds: string[]; freeText: string };

const EMPTY_ANSWER: Answer = { optionIds: [], freeText: "" };

/**
 * Label shown on the question's tab.
 *
 * Both Claude and Codex map their short question header onto `description`, so
 * it is the only human-authored short label available. Anything longer than a
 * chip is the prompt restated, which a tab strip cannot show.
 */
function tabLabel(question: AgentInteractionQuestion, index: number): string {
  const header = question.description?.trim();
  return header && header.length <= 32 ? header : `Question ${index + 1}`;
}

function isAnswered(answer: Answer): boolean {
  return answer.optionIds.length > 0 || answer.freeText.trim().length > 0;
}

/**
 * A question the agent is blocked on, rendered in the transcript.
 *
 * Unlike approvals — which stay pinned above the composer because they gate a
 * command that is about to run — a question is part of the conversation and is
 * laid out like one: an opaque transcript card at the end of the transcript,
 * not a translucent panel floating over the messages behind it.
 *
 * One question is shown at a time. Multi-question requests get a tab strip that
 * both navigates and reports which questions still need an answer, so nothing
 * is submitted with a question the user never saw.
 */
export function NativeAgentQuestionCard({
  interaction,
  onResolve,
}: {
  interaction: AgentInteractionRequest;
  onResolve: (
    resolution: AgentInteractionResolution,
  ) => Promise<AgentInteractionApplyOutcome>;
}) {
  const draftKey = nativeAgentInteractionDraftKey(
    interaction.sessionId,
    interaction.id,
  );
  const questions = interaction.presentation.questions;
  const [answers, setAnswers] = usePromptDraftField<Record<string, Answer>>(
    draftKey,
    "answers",
    () => ({}),
  );
  /**
   * Which questions have the free-text field revealed. Kept beside the answers
   * rather than derived from them: a user who picks "Something else" and has
   * not typed yet must still see the field they just opened.
   */
  const [customOpen, setCustomOpen] = usePromptDraftField<Record<string, boolean>>(
    draftKey,
    "customOpen",
    () => ({}),
  );
  const [storedIndex, setStoredIndex] = usePromptDraftField<number>(
    draftKey,
    "questionIndex",
    () => 0,
  );
  const { remaining, expired } = usePromptDeadline(interaction.expiresAt);

  const freeTextRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const wantsFreeTextFocus = useRef(false);
  useEffect(() => {
    if (!wantsFreeTextFocus.current) return;
    wantsFreeTextFocus.current = false;
    freeTextRef.current?.focus();
  });

  const answerFor = (questionId: string): Answer =>
    answers[questionId] ?? EMPTY_ANSWER;

  const { submitting, error, resolve } = useInteractionResolver({
    interaction,
    draftKey,
    onResolve,
    blocked: expired,
    buildAnswers: () => questions.map((question) => {
      const answer = answerFor(question.id);
      return {
        questionId: question.id,
        ...(answer.optionIds.length ? { optionIds: answer.optionIds } : {}),
        ...(answer.freeText.trim() ? { freeText: answer.freeText.trim() } : {}),
      };
    }),
  });

  const count = questions.length;
  // A stale draft index survives a request replacing another in place, so it is
  // clamped rather than trusted.
  const index = Number.isInteger(storedIndex) && storedIndex >= 0 && storedIndex < count
    ? storedIndex
    : 0;
  const question = questions[index];
  const disabled = submitting || expired;
  const answeredCount = questions.filter((entry) =>
    isAnswered(answerFor(entry.id)),
  ).length;
  const canSubmit = questions.every((entry) =>
    !entry.required || isAnswered(answerFor(entry.id)),
  );

  const updateAnswer = (questionId: string, update: (answer: Answer) => Answer) => {
    setAnswers((current) => ({
      ...current,
      [questionId]: update(current[questionId] ?? EMPTY_ANSWER),
    }));
  };

  if (!question) return null;

  const answer = answerFor(question.id);
  // A question with no options has nothing to choose between, so its field is
  // the answer and is shown unconditionally.
  const hasOptions = question.options.length > 0;
  const showFreeText = question.allowFreeText
    && (!hasOptions || customOpen[question.id] === true);
  const isLast = index === count - 1;

  const selectOption = (optionId: string) => {
    const selected = answer.optionIds.includes(optionId);
    updateAnswer(question.id, (current) => question.multiple
      ? {
          ...current,
          optionIds: selected
            ? current.optionIds.filter((id) => id !== optionId)
            : [...current.optionIds, optionId],
        }
      // The question asked for one answer, so a pick replaces both the previous
      // option and anything typed under "Something else".
      : { optionIds: [optionId], freeText: "" });
    if (!question.multiple) {
      setCustomOpen((current) => ({ ...current, [question.id]: false }));
    }
  };

  const toggleCustom = () => {
    const open = customOpen[question.id] === true;
    setCustomOpen((current) => ({ ...current, [question.id]: !open }));
    if (open) {
      // Closing discards the draft text, or an invisible answer would be sent.
      updateAnswer(question.id, (current) => ({ ...current, freeText: "" }));
      return;
    }
    wantsFreeTextFocus.current = true;
    if (!question.multiple) {
      updateAnswer(question.id, (current) => ({ ...current, optionIds: [] }));
    }
  };

  const responseLabel = `${question.prompt} response`;

  return (
    <div
      data-testid="agent-question-card"
      role="group"
      aria-label={interaction.presentation.title}
      aria-busy={submitting || undefined}
      className="overflow-hidden rounded-lg border border-border/70 bg-zinc-900/90 shadow-sm shadow-black/15"
    >
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {`${interaction.presentation.title}. ${count} ${count === 1 ? "question" : "questions"}.`}
      </span>

      <div className="flex items-center gap-2 border-b border-border/60 bg-white/[0.02] px-3 py-2">
        <MessageCircleQuestion className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 truncate text-xs font-medium text-foreground">
          {interaction.presentation.title}
        </span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {count > 1 ? `${answeredCount}/${count} answered` : null}
          {count > 1 && remaining && !expired ? " · " : null}
          {remaining && !expired ? remaining : null}
        </span>
      </div>

      {count > 1 ? (
        <div className="flex items-center gap-1 border-b border-border/60 bg-white/[0.02] px-2 py-1.5">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            aria-label="Previous question"
            disabled={index === 0}
            onClick={() => setStoredIndex(index - 1)}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div
            role="tablist"
            aria-label="Questions"
            aria-orientation="horizontal"
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          >
            {questions.map((entry, entryIndex) => {
              const active = entryIndex === index;
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  id={`question-tab-${interaction.id}-${entry.id}`}
                  aria-selected={active}
                  aria-controls={`question-panel-${interaction.id}-${entry.id}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setStoredIndex(entryIndex)}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] transition-colors",
                    active
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                  )}
                >
                  {isAnswered(answerFor(entry.id)) ? (
                    <Check className="size-3 text-emerald-400" aria-label="Answered" />
                  ) : null}
                  {tabLabel(entry, entryIndex)}
                </button>
              );
            })}
          </div>
          <span className="shrink-0 px-1 text-[11px] tabular-nums text-muted-foreground">
            {index + 1} of {count}
          </span>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-6 shrink-0"
            aria-label="Next question"
            disabled={isLast}
            onClick={() => setStoredIndex(index + 1)}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      ) : null}

      <div
        id={`question-panel-${interaction.id}-${question.id}`}
        role={count > 1 ? "tabpanel" : undefined}
        aria-labelledby={
          count > 1 ? `question-tab-${interaction.id}-${question.id}` : undefined
        }
        className="px-3 py-3"
      >
        {count === 1 && question.description ? (
          <div className="mb-1.5 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            {question.description}
          </div>
        ) : null}
        <p className="text-sm leading-relaxed text-foreground">
          {question.prompt}
          {question.multiple ? (
            <span className="ml-1.5 text-xs text-muted-foreground">
              (select all that apply)
            </span>
          ) : null}
        </p>

        {hasOptions ? (
          <div className="mt-3 flex flex-col gap-1.5">
            {question.options.map((option) => {
              const selected = answer.optionIds.includes(option.id);
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={disabled}
                  aria-pressed={selected}
                  onClick={() => selectOption(option.id)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                    selected
                      ? "border-primary/50 bg-primary/10"
                      : "border-border/60 hover:bg-white/[0.03]",
                    disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                      question.multiple ? "rounded-[4px]" : "rounded-full",
                      selected
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground/40",
                    )}
                    aria-hidden
                  >
                    {selected ? <Check className="size-3" /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-foreground">{option.label}</span>
                    {option.description ? (
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}

            {question.allowFreeText ? (
              <button
                type="button"
                disabled={disabled}
                aria-pressed={showFreeText}
                aria-expanded={showFreeText}
                onClick={toggleCustom}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  showFreeText
                    ? "border-primary/50 bg-primary/10"
                    : "border-dashed border-border/60 hover:bg-white/[0.03]",
                  disabled && "cursor-not-allowed opacity-60 hover:bg-transparent",
                )}
              >
                <PencilLine className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-sm text-foreground">Something else</span>
              </button>
            ) : null}
          </div>
        ) : null}

        {showFreeText ? (
          <div className="mt-2">
            {question.secret ? (
              <Input
                ref={(element) => { freeTextRef.current = element; }}
                type="password"
                autoComplete="off"
                aria-label={responseLabel}
                value={answer.freeText}
                disabled={disabled}
                onChange={(event) => updateAnswer(question.id, (current) => ({
                  ...current,
                  freeText: event.target.value,
                  ...(question.multiple ? {} : { optionIds: [] }),
                }))}
              />
            ) : (
              <textarea
                ref={(element) => { freeTextRef.current = element; }}
                aria-label={responseLabel}
                rows={3}
                value={answer.freeText}
                disabled={disabled}
                placeholder="Type your answer"
                className="w-full resize-y rounded-md border border-border/60 bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                onChange={(event) => updateAnswer(question.id, (current) => ({
                  ...current,
                  freeText: event.target.value,
                  ...(question.multiple ? {} : { optionIds: [] }),
                }))}
              />
            )}
            {question.secret ? (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Secret input is discarded when you leave this tab.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      {expired || error ? (
        <div
          role={error ? "alert" : "status"}
          className={cn(
            "flex items-center gap-1.5 border-t px-3 py-2 text-xs",
            error
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : "border-border/60 bg-muted/30 text-muted-foreground",
          )}
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            {error
              ?? "This question has an invalid deadline and cannot be answered safely."}
          </span>
        </div>
      ) : null}

      {expired ? null : (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border/60 bg-white/[0.02] px-3 py-2.5">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="mr-auto text-muted-foreground hover:text-foreground"
            disabled={disabled}
            onClick={() => { void resolve("deny"); }}
          >
            {interaction.presentation.declineLabel ?? "Dismiss"}
          </Button>
          {index > 0 ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setStoredIndex(index - 1)}
            >
              Back
            </Button>
          ) : null}
          {isLast ? (
            <Button
              type="button"
              size="sm"
              disabled={disabled || !canSubmit}
              onClick={() => { void resolve("answer"); }}
            >
              {interaction.presentation.confirmLabel ?? "Submit"}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              disabled={disabled}
              onClick={() => setStoredIndex(index + 1)}
            >
              Next
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
