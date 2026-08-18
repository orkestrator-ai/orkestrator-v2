import { useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import {
  AGENT_INTERACTION_CONTRACT_VERSION,
  type AgentInteractionApplyOutcome,
  type AgentInteractionRequest,
  type AgentInteractionResolution,
  type AgentInteractionResolutionAction,
} from "@orkestrator/protocol/agent-interactions";
import { BlockingPromptCard } from "@/components/chat/BlockingPromptCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageMarkdown } from "@/components/chat/MessageMarkdown";
import { usePromptDeadline } from "@/hooks/usePromptDeadline";
import { openInBrowser } from "@/lib/backend";
import {
  nativeAgentInteractionDraftKey,
  usePromptDraftField,
  usePromptDraftStore,
} from "@/stores/promptDraftStore";

type Answer = { optionIds: string[]; freeText: string };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeExternalUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function coerceNativeFormFieldValue(raw: string, type: unknown): string | number {
  if (type !== "number" && type !== "integer") return raw;
  if (raw === "") return "";
  const value = Number(raw);
  return Number.isFinite(value) ? value : "";
}

export function NativeAgentInteractionCard({
  interaction,
  onResolve,
  planContent,
}: {
  interaction: AgentInteractionRequest;
  planContent?: string;
  onResolve: (resolution: AgentInteractionResolution) => Promise<AgentInteractionApplyOutcome>;
}) {
  const draftKey = nativeAgentInteractionDraftKey(interaction.sessionId, interaction.id);
  const [answers, setAnswers] = usePromptDraftField<Record<string, Answer>>(
    draftKey,
    "answers",
    () => ({}),
  );
  const [form, setForm] = usePromptDraftField<Record<string, unknown>>(
    draftKey,
    "form",
    () => ({}),
  );
  const [feedback, setFeedback] = usePromptDraftField<string>(draftKey, "feedback", () => "");
  const [secretAnswers, setSecretAnswers] = useState<Record<string, Answer>>({});
  const [secretForm, setSecretForm] = useState<Record<string, unknown>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { remaining, expired } = usePromptDeadline(interaction.expiresAt);
  const questions = interaction.presentation.questions;
  const externalUrl = safeExternalUrl(interaction.presentation.url);
  const mcpQuestion = interaction.kind === "mcp-form" ? questions[0] : undefined;
  const schema = useMemo(() => {
    if (!mcpQuestion?.description) return {};
    try {
      return record(JSON.parse(mcpQuestion.description));
    } catch {
      return {};
    }
  }, [mcpQuestion?.description]);
  const properties = record(schema.properties);
  const requiredFields = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const resolvedForm = useMemo(() => ({ ...form, ...secretForm }), [form, secretForm]);
  const isSensitiveField = (key: string, definition: Record<string, unknown>) =>
    definition.writeOnly === true ||
    (typeof definition.format === "string" && /password|secret|token/i.test(definition.format)) ||
    /password|secret|token/i.test(key);
  const answerFor = (questionId: string, secret: boolean): Answer =>
    (secret ? secretAnswers : answers)[questionId] ?? { optionIds: [], freeText: "" };
  const canSubmit =
    interaction.kind === "mcp-form"
      ? [...requiredFields].every((key) => {
          const value = resolvedForm[key];
          return value !== undefined && value !== "";
        })
      : questions.every((question) => {
          if (!question.required) return true;
          const answer = answerFor(question.id, question.secret);
          return Boolean(answer.optionIds.length || answer.freeText.trim());
        });

  const resolve = async (action: AgentInteractionResolutionAction, resolutionFeedback?: string) => {
    if (submitting || expired) return;
    setSubmitting(true);
    setError(null);
    try {
      const resolution: AgentInteractionResolution = {
        version: AGENT_INTERACTION_CONTRACT_VERSION,
        interactionId: interaction.id,
        sessionId: interaction.sessionId,
        action,
        ...(action === "answer"
          ? {
              answer: {
                version: AGENT_INTERACTION_CONTRACT_VERSION,
                interactionId: interaction.id,
                sessionId: interaction.sessionId,
                answers:
                  interaction.kind === "mcp-form" && mcpQuestion
                    ? [{ questionId: mcpQuestion.id, freeText: JSON.stringify(resolvedForm) }]
                    : questions.map((question) => {
                        const answer = answerFor(question.id, question.secret);
                        return {
                          questionId: question.id,
                          ...(answer.optionIds.length ? { optionIds: answer.optionIds } : {}),
                          ...(answer.freeText.trim() ? { freeText: answer.freeText.trim() } : {}),
                        };
                      }),
              },
            }
          : {}),
        ...(resolutionFeedback?.trim() ? { feedback: resolutionFeedback.trim() } : {}),
        resolvedAt: Date.now(),
      };
      const outcome = await onResolve(resolution);
      if (
        outcome.result === "applied" ||
        outcome.result === "stale" ||
        outcome.result === "already-resolved"
      ) {
        usePromptDraftStore.getState().clearDraft(draftKey);
      } else {
        setError(
          outcome.result === "rejected"
            ? "The agent rejected that response."
            : "The agent is temporarily unavailable. It is safe to retry.",
        );
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const setQuestionAnswer = (
    questionId: string,
    secret: boolean,
    update: (answer: Answer) => Answer,
  ) => {
    const setter = secret ? setSecretAnswers : setAnswers;
    setter((current) => ({
      ...current,
      [questionId]: update(current[questionId] ?? { optionIds: [], freeText: "" }),
    }));
  };

  const actions = (
    <>
      {interaction.kind === "plan-approval" ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            disabled={submitting || expired}
            onClick={() => {
              void resolve("deny");
            }}
          >
            Dismiss
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={submitting || expired}
            onClick={() => {
              void resolve("decline", feedback);
            }}
          >
            Request changes
          </Button>
        </>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={submitting || expired}
          onClick={() => {
            void resolve("deny");
          }}
        >
          {interaction.presentation.declineLabel ?? "Deny"}
        </Button>
      )}
      {interaction.kind === "command-approval" ||
      interaction.kind === "file-approval" ||
      interaction.kind === "permission" ||
      interaction.kind === "mcp-form" ||
      interaction.kind === "mcp-url" ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={submitting || expired}
          onClick={() => {
            void resolve("cancel");
          }}
        >
          Cancel turn
        </Button>
      ) : null}
      {interaction.presentation.approveForSessionLabel ? (
        <Button
          size="sm"
          variant="ghost"
          disabled={submitting || expired || interaction.presentation.confirmDisabled}
          onClick={() => {
            void resolve("approve-for-session");
          }}
        >
          {interaction.presentation.approveForSessionLabel}
        </Button>
      ) : null}
      <Button
        size="sm"
        disabled={submitting || expired || !canSubmit || interaction.presentation.confirmDisabled}
        onClick={() => {
          void resolve("answer");
        }}
      >
        {interaction.presentation.confirmLabel ?? "Continue"}
      </Button>
    </>
  );

  return (
    /*
     * The same shell every blocking prompt has used since the three provider
     * cards were unified: one amber treatment, one arrival announcement for
     * screen readers, and one place that renders expiry and retry.
     */
    <BlockingPromptCard
      state={
        submitting ? "submitting" : expired ? "expired" : error ? "retryable-error" : "pending"
      }
      error={error}
      title={interaction.presentation.title}
      description={interaction.presentation.body}
      meta={remaining && !expired ? remaining : undefined}
      arrivalAnnouncement={`${interaction.presentation.title} needs a response.`}
      role="group"
      actions={actions}
    >
      <div className="px-4 py-3 text-sm">
        {interaction.kind === "plan-approval" && planContent ? (
          <details open className="mt-3 rounded-md border border-border/60 bg-muted/20">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium">
              Implementation plan
            </summary>
            <MessageMarkdown
              content={planContent}
              className="max-h-72 overflow-y-auto border-t border-border/60 px-3 py-2 text-xs"
            />
          </details>
        ) : null}
        {interaction.presentation.url ? (
          externalUrl ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="mt-3 gap-2"
              onClick={() =>
                void openInBrowser(externalUrl).catch(() =>
                  setError("Could not open the authorization page."),
                )
              }
            >
              Open authorization page <ExternalLink className="size-3.5" />
            </Button>
          ) : (
            <p className="mt-2 text-xs text-destructive">The authorization URL is invalid.</p>
          )
        ) : null}

        {interaction.kind === "mcp-form" ? (
          <div className="mt-3 max-h-72 space-y-3 overflow-y-auto">
            {Object.entries(properties).map(([key, rawDefinition]) => {
              const definition = record(rawDefinition);
              const sensitive = isSensitiveField(key, definition);
              const value = (sensitive ? secretForm : form)[key];
              const options = Array.isArray(definition.enum)
                ? definition.enum.filter((item): item is string => typeof item === "string")
                : [];
              const setValue = (next: unknown) => {
                const setter = sensitive ? setSecretForm : setForm;
                setter((current) => ({ ...current, [key]: next }));
              };
              return (
                <label key={key} className="block space-y-1.5">
                  <span className="text-xs font-medium">
                    {typeof definition.title === "string" ? definition.title : key}
                    {requiredFields.has(key) ? " *" : ""}
                  </span>
                  {typeof definition.description === "string" ? (
                    <span className="block text-xs text-muted-foreground">
                      {definition.description}
                    </span>
                  ) : null}
                  {definition.type === "boolean" ? (
                    <input
                      aria-label={typeof definition.title === "string" ? definition.title : key}
                      type="checkbox"
                      checked={value === true}
                      disabled={submitting || expired}
                      onChange={(event) => setValue(event.target.checked)}
                    />
                  ) : options.length ? (
                    <select
                      aria-label={typeof definition.title === "string" ? definition.title : key}
                      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={String(value ?? "")}
                      disabled={submitting || expired}
                      onChange={(event) => setValue(event.target.value)}
                    >
                      <option value="">Select…</option>
                      {options.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      aria-label={typeof definition.title === "string" ? definition.title : key}
                      type={
                        sensitive
                          ? "password"
                          : definition.type === "number" || definition.type === "integer"
                            ? "number"
                            : "text"
                      }
                      value={String(value ?? "")}
                      disabled={submitting || expired}
                      onChange={(event) =>
                        setValue(coerceNativeFormFieldValue(event.target.value, definition.type))
                      }
                    />
                  )}
                  {sensitive ? (
                    <span className="block text-[11px] text-muted-foreground">
                      Secret input is discarded when you leave this tab.
                    </span>
                  ) : null}
                </label>
              );
            })}
          </div>
        ) : (
          questions.map((question) => {
            const answer = answerFor(question.id, question.secret);
            return (
              <fieldset key={question.id} className="mt-3 space-y-2">
                <legend className="text-xs font-medium">{question.prompt}</legend>
                {question.description ? (
                  <p className="text-xs text-muted-foreground">{question.description}</p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {question.options.map((option) => {
                    const selected = answer.optionIds.includes(option.id);
                    return (
                      <Button
                        key={option.id}
                        type="button"
                        size="sm"
                        variant={selected ? "default" : "outline"}
                        disabled={submitting || expired}
                        aria-pressed={selected}
                        onClick={() =>
                          setQuestionAnswer(question.id, question.secret, (current) => ({
                            ...current,
                            optionIds: question.multiple
                              ? selected
                                ? current.optionIds.filter((id) => id !== option.id)
                                : [...current.optionIds, option.id]
                              : [option.id],
                            ...(!question.multiple ? { freeText: "" } : {}),
                          }))
                        }
                      >
                        {option.label}
                      </Button>
                    );
                  })}
                </div>
                {question.allowFreeText ? (
                  question.secret ? (
                    <Input
                      type="password"
                      autoComplete="off"
                      value={answer.freeText}
                      disabled={submitting || expired}
                      aria-label={`${question.prompt} response`}
                      onChange={(event) =>
                        setQuestionAnswer(question.id, true, (current) => ({
                          ...current,
                          freeText: event.target.value,
                          ...(!question.multiple && event.target.value ? { optionIds: [] } : {}),
                        }))
                      }
                    />
                  ) : (
                    <textarea
                      value={answer.freeText}
                      disabled={submitting || expired}
                      aria-label={`${question.prompt} response`}
                      rows={3}
                      className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-xs"
                      onChange={(event) =>
                        setQuestionAnswer(question.id, false, (current) => ({
                          ...current,
                          freeText: event.target.value,
                          ...(!question.multiple && event.target.value ? { optionIds: [] } : {}),
                        }))
                      }
                    />
                  )
                ) : null}
              </fieldset>
            );
          })
        )}

        {interaction.kind === "plan-approval" ? (
          <label className="mt-3 block space-y-1.5">
            <span className="text-xs font-medium">What changes would you like? (optional)</span>
            <textarea
              value={feedback}
              disabled={submitting || expired}
              aria-label="Plan revision feedback"
              rows={3}
              className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-xs"
              onChange={(event) => setFeedback(event.target.value)}
            />
          </label>
        ) : null}
      </div>
    </BlockingPromptCard>
  );
}
