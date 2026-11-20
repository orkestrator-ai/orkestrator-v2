import { useState } from "react";
import { Check, Maximize2, Star } from "lucide-react";
import type {
  ChoiceOption,
  ChoiceResult,
  ChoiceSpec,
} from "@orkestrator/protocol/rich-interactions";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  ActionBar,
  ContentRefPreview,
  SourcePreview,
  textareaClass,
  type KindProps,
} from "../shared";

interface ChoiceDraft {
  answers: Record<string, { optionIds: string[]; other?: string }>;
  constraints?: string;
}

/**
 * Feature 1: visual decision cards. Opening, zooming and comparing previews is
 * local; only "Use this direction" commits the option ids (never labels).
 */
export function ChoiceCard({
  view,
  spec,
  draft,
  setDraft,
  act,
  disabled,
  actions,
}: KindProps<ChoiceSpec>) {
  const value = (draft as ChoiceDraft | undefined) ?? { answers: {} };
  const [expanded, setExpanded] = useState<{ questionId: string; option: ChoiceOption } | null>(
    null,
  );
  const update = (next: ChoiceDraft) => setDraft(next);
  const toggle = (questionId: string, optionId: string, multiple: boolean) => {
    const current = value.answers[questionId]?.optionIds ?? [];
    const optionIds = multiple
      ? current.includes(optionId)
        ? current.filter((id) => id !== optionId)
        : [...current, optionId]
      : [optionId];
    update({
      ...value,
      answers: {
        ...value.answers,
        [questionId]: {
          ...value.answers[questionId],
          optionIds,
          ...(multiple ? {} : { other: undefined }),
        },
      },
    });
  };
  const missing = spec.questions.find(
    (q) =>
      q.required && !(value.answers[q.id]?.optionIds.length || value.answers[q.id]?.other?.trim()),
  );
  const result = (): ChoiceResult => ({
    answers: spec.questions
      .filter((q) => value.answers[q.id])
      .map((q) => ({
        questionId: q.id,
        optionIds: value.answers[q.id]!.optionIds,
        ...(value.answers[q.id]!.other?.trim()
          ? { other: value.answers[q.id]!.other!.trim() }
          : {}),
      })),
    ...(value.constraints?.trim() ? { constraints: value.constraints.trim() } : {}),
  });
  const answered = view.receipts.at(-1)?.result as ChoiceResult | undefined;

  return (
    <div className="flex flex-col gap-4">
      {spec.questions.map((question) => {
        const selected =
          (disabled && answered
            ? answered.answers?.find((a) => a.questionId === question.id)?.optionIds
            : value.answers[question.id]?.optionIds) ?? [];
        return (
          <fieldset key={question.id} className="flex flex-col gap-2" disabled={disabled}>
            <legend className="mb-1 text-sm leading-relaxed">{question.prompt}</legend>
            <div
              className="grid gap-2 sm:grid-cols-2"
              role={question.multiple ? "group" : "radiogroup"}
              aria-label={question.prompt}
            >
              {question.options.map((option) => {
                const isSelected = selected.includes(option.id);
                const recommended = question.recommendedOptionId === option.id;
                return (
                  <div
                    key={option.id}
                    className={cn(
                      "flex min-w-0 flex-col overflow-hidden rounded-md border",
                      isSelected ? "border-primary/50 bg-primary/10" : "border-border/60",
                    )}
                  >
                    {option.preview ? (
                      <div className="relative border-b border-border/50 bg-black/20 p-1">
                        {option.preview.kind === "text" ||
                        option.preview.kind === "diagram" ||
                        option.preview.kind === "diff" ? (
                          <div className="max-h-56 overflow-hidden">
                            <SourcePreview
                              kind={option.preview.kind}
                              source={option.preview.source ?? ""}
                              blockKey={`${view.request.interactionId}:${option.id}`}
                            />
                          </div>
                        ) : (
                          <ContentRefPreview
                            reference={option.preview.ref!}
                            description={option.preview.description}
                            compact
                          />
                        )}
                        <button
                          type="button"
                          className="absolute right-2 bottom-2 rounded bg-black/70 p-1 text-white focus-hairline"
                          aria-label={`Expand preview of ${option.label}`}
                          onClick={() => setExpanded({ questionId: question.id, option })}
                        >
                          <Maximize2 className="size-3.5" />
                        </button>
                      </div>
                    ) : null}
                    <button
                      type="button"
                      role={question.multiple ? "checkbox" : "radio"}
                      aria-checked={isSelected}
                      className={cn(
                        "flex w-full items-start gap-2.5 px-3 py-2 text-left transition-colors focus-hairline",
                        !disabled && "hover:bg-white/[0.03]",
                        disabled && "cursor-not-allowed opacity-80",
                      )}
                      onClick={() => toggle(question.id, option.id, question.multiple)}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-4 shrink-0 items-center justify-center border",
                          question.multiple ? "rounded-[4px]" : "rounded-full",
                          isSelected
                            ? "border-primary bg-primary-fill text-primary-foreground"
                            : "border-border",
                        )}
                      >
                        {isSelected ? <Check className="size-3" /> : null}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          {option.label}
                          {recommended ? (
                            <span className="inline-flex items-center gap-0.5 rounded bg-primary/15 px-1 text-[10px] font-medium text-primary">
                              <Star className="size-2.5" aria-hidden />
                              Recommended
                            </span>
                          ) : null}
                        </span>
                        {option.description ? (
                          <span className="block text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                        {option.tradeoffs?.length ? (
                          <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
                            {option.tradeoffs.map((t) => (
                              <li key={t}>{t}</li>
                            ))}
                          </ul>
                        ) : null}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
            {question.recommendedOptionId && question.recommendationRationale ? (
              <p className="text-xs text-muted-foreground">
                Why the agent recommends it: {question.recommendationRationale}
              </p>
            ) : null}
            {question.allowOther ? (
              <input
                className="w-full rounded-md border border-dashed border-border/70 bg-input-surface px-3 py-1.5 text-sm focus-hairline"
                placeholder="Something else…"
                aria-label={`${question.prompt}: something else`}
                value={value.answers[question.id]?.other ?? ""}
                onChange={(event) =>
                  update({
                    ...value,
                    answers: {
                      ...value.answers,
                      [question.id]: {
                        optionIds: question.multiple
                          ? (value.answers[question.id]?.optionIds ?? [])
                          : [],
                        other: event.target.value,
                      },
                    },
                  })
                }
              />
            ) : null}
          </fieldset>
        );
      })}
      {spec.allowConstraints && !disabled ? (
        <textarea
          className={textareaClass}
          rows={2}
          placeholder="Add a constraint (optional)"
          aria-label="Additional constraint"
          value={value.constraints ?? ""}
          onChange={(event) => update({ ...value, constraints: event.target.value })}
        />
      ) : null}
      {!disabled ? (
        <ActionBar
          actions={actions}
          disabled={disabled}
          primaryDisabledReason={
            missing ? `Choose an answer for "${missing.prompt.slice(0, 60)}"` : null
          }
          onAction={(a) => act(a.id, result())}
        />
      ) : null}
      <Dialog open={expanded !== null} onOpenChange={(open) => !open && setExpanded(null)}>
        <DialogContent className="max-w-5xl">
          <DialogTitle>{expanded?.option.label}</DialogTitle>
          <DialogDescription>{expanded?.option.preview?.description}</DialogDescription>
          {expanded?.option.preview ? (
            expanded.option.preview.ref ? (
              <ContentRefPreview
                reference={expanded.option.preview.ref}
                description={expanded.option.preview.description}
              />
            ) : (
              <SourcePreview
                kind={expanded.option.preview.kind as "text"}
                source={expanded.option.preview.source ?? ""}
                blockKey={`${view.request.interactionId}:${expanded.option.id}:expanded`}
              />
            )
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}
